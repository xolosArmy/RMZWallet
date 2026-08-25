import { readFile } from 'node:fs/promises'
import { ChronikClient } from 'chronik-client'
import {
  ALL_BIP143,
  Ecc,
  P2PKHSignatory,
  Script,
  TxBuilder,
  fromHex,
  shaRmd160,
  toHex
} from 'ecash-lib'
import {
  COMMUNITY_PARENT_DUST_SATS,
  assertCommunityParentGenesisConfig,
  assertCanonicalCommunityParentMetadata
} from '../src/services/communityParentGenesis'
import type {
  CommunityParentGenesisConfig,
  CommunityParentNetwork
} from '../src/services/communityParentGenesis'
import {
  COMMUNITY_PARENT_EXECUTION_FEE_PER_KB,
  classifyChronikClientV3BroadcastFailure,
  executeCommunityParentGenesis
} from '../src/services/communityParentExecutor'
import type {
  CommunityParentBroadcastOutcome,
  CommunityParentExecutionCandidate,
  CommunityParentSigner
} from '../src/services/communityParentExecutor'

const SIGNING_SECRET_ENV = 'COMMUNITY_PARENT_SIGNING_SECRET_HEX'
const CANONICAL_SECRET_HEX = /^[0-9a-f]{64}$/

const requireEnvironment = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const parseNetwork = (value: string): CommunityParentNetwork => {
  if (value !== 'mainnet' && value !== 'testnet' && value !== 'regtest') {
    throw new Error('COMMUNITY_PARENT_NETWORK must be mainnet, testnet, or regtest.')
  }
  return value
}

const parseDedicatedChronikUrl = (value: string): string => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('COMMUNITY_PARENT_CHRONIK_URL must be one canonical HTTPS origin.')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value !== parsed.origin
  ) {
    throw new Error('COMMUNITY_PARENT_CHRONIK_URL must be one canonical HTTPS origin.')
  }
  return parsed.origin
}

type DisposableCommunityParentSigner = CommunityParentSigner & Readonly<{
  dispose(): void
}>

const createSigner = (): DisposableCommunityParentSigner => {
  const secretHex = process.env[SIGNING_SECRET_ENV]
  delete process.env[SIGNING_SECRET_ENV]
  if (typeof secretHex !== 'string' || !CANONICAL_SECRET_HEX.test(secretHex)) {
    throw new Error(`${SIGNING_SECRET_ENV} must contain one canonical 32-byte hex signing secret.`)
  }
  const secret = fromHex(secretHex)
  const ecc = new Ecc()
  let publicKey: Uint8Array
  try {
    if (!ecc.isValidSeckey(secret)) throw new Error('The supplied signing secret is invalid.')
    publicKey = ecc.derivePubkey(secret)
  } catch (error) {
    secret.fill(0)
    throw error
  }
  const fundingScript = Script.p2pkh(shaRmd160(publicKey))
  let disposed = false
  return {
    publicKeyHex: toHex(publicKey),
    dispose: (): void => {
      secret.fill(0)
      disposed = true
    },
    sign: async (candidate: CommunityParentExecutionCandidate): Promise<Uint8Array> => {
      if (disposed) throw new Error('The signing secret has already been cleared.')
      if (
        candidate.plan.selectedInputs.length === 0 ||
        candidate.plan.selectedInputs.some(
          (input) => input.outputScript !== toHex(fundingScript.bytecode)
        )
      ) {
        throw new Error('The signing secret does not control every selected input.')
      }
      try {
        const signatory = P2PKHSignatory(secret, publicKey, ALL_BIP143)
        const builder = new TxBuilder({
          inputs: candidate.plan.selectedInputs.map((input) => ({
            input: {
              prevOut: input.outpoint,
              signData: {
                sats: input.sats,
                outputScript: fundingScript
              }
            },
            signatory
          })),
          outputs: candidate.plan.outputs.map((output) => ({
            sats: output.sats,
            script: new Script(fromHex(output.scriptHex))
          }))
        })
        return builder.sign({
          feePerKb: COMMUNITY_PARENT_EXECUTION_FEE_PER_KB,
          dustSats: COMMUNITY_PARENT_DUST_SATS
        }).ser()
      } finally {
        secret.fill(0)
        disposed = true
      }
    }
  }
}

const broadcastWithChronikSemantics = async (
  chronik: ChronikClient,
  rawTx: Uint8Array
): Promise<CommunityParentBroadcastOutcome> => {
  try {
    const response = await chronik.broadcastTx(rawTx)
    return { status: 'accepted', txid: response.txid }
  } catch (error) {
    if (classifyChronikClientV3BroadcastFailure(error) === 'rejected') {
      return { status: 'rejected' }
    }
    throw error
  }
}

const cliArgs = process.argv.slice(2)
if (cliArgs.length !== 0) {
  throw new Error('This tool accepts no CLI arguments; secrets must not enter shell history.')
}

const metadataBytes = new Uint8Array(
  await readFile(new URL('./metadata/community-parent.json', import.meta.url))
)
assertCanonicalCommunityParentMetadata(metadataBytes)

const config: CommunityParentGenesisConfig = {
  network: parseNetwork(requireEnvironment('COMMUNITY_PARENT_NETWORK')),
  fundingAddress: requireEnvironment('COMMUNITY_PARENT_FUNDING_ADDRESS'),
  tokenDestinationAddress: requireEnvironment('COMMUNITY_PARENT_TOKEN_ADDRESS'),
  batonDestinationAddress: requireEnvironment('COMMUNITY_PARENT_BATON_ADDRESS'),
  changeAddress: requireEnvironment('COMMUNITY_PARENT_CHANGE_ADDRESS'),
  documentUri: requireEnvironment('COMMUNITY_PARENT_DOCUMENT_URI')
}

if (config.network !== 'mainnet') {
  throw new Error('The administrative CLI adapter is intentionally restricted to explicit mainnet.')
}
assertCommunityParentGenesisConfig(config)

const gates = {
  BROADCAST: process.env.BROADCAST,
  CONFIRM_COMMUNITY_PARENT_GENESIS: process.env.CONFIRM_COMMUNITY_PARENT_GENESIS,
  CONFIRM_PLAN_SHA256: process.env.CONFIRM_PLAN_SHA256
}
const executionIntent = Object.values(gates).some((value) => value !== undefined)
const signer = executionIntent ? createSigner() : undefined

const chronikUrl = parseDedicatedChronikUrl(requireEnvironment('COMMUNITY_PARENT_CHRONIK_URL'))
const chronik = new ChronikClient([chronikUrl])
const reader = {
  endpointLabel: chronikUrl,
  block: async (height: number): Promise<unknown> => chronik.block(height),
  addressUtxos: async (address: string): Promise<unknown> => chronik.address(address).utxos(),
  validateRawTx: async (rawTx: Uint8Array): Promise<unknown> => chronik.validateRawTx(rawTx),
  tx: async (txid: string): Promise<unknown> => chronik.tx(txid)
}

let result
try {
  result = await executeCommunityParentGenesis({
    config,
    reader,
    gates,
    signer,
    broadcaster: executionIntent
      ? { broadcast: async (rawTx) => broadcastWithChronikSemantics(chronik, rawTx) }
      : undefined,
    onPreview: (preview) => console.log(preview),
    onSignedTxCandidate: (txid) => console.log(`SIGNED TXID CANDIDATE: ${txid}`)
  })
} finally {
  signer?.dispose()
}

if (result.status === 'dry-run') {
  console.log('Execution status: DRY_RUN')
} else {
  console.log(`Execution status: ${result.status}`)
  if (result.status === 'broadcast-status-ambiguous') process.exitCode = 2
  if (result.status === 'broadcast-rejected') process.exitCode = 3
}
