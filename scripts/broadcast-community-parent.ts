import { readFile } from 'node:fs/promises'
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
  assertCanonicalCommunityParentMetadata
} from '../src/services/communityParentGenesis'
import type {
  CommunityParentGenesisConfig,
  CommunityParentNetwork
} from '../src/services/communityParentGenesis'
import {
  COMMUNITY_PARENT_EXECUTION_FEE_PER_KB,
  executeCommunityParentGenesis
} from '../src/services/communityParentExecutor'
import type {
  CommunityParentExecutionCandidate,
  CommunityParentSigner
} from '../src/services/communityParentExecutor'
import { getChronik, getChronikUrls } from '../src/services/ChronikClient'

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

const createSigner = (): CommunityParentSigner => ({
  sign: async (candidate: CommunityParentExecutionCandidate): Promise<Uint8Array> => {
    const secretHex = process.env[SIGNING_SECRET_ENV]
    delete process.env[SIGNING_SECRET_ENV]
    if (typeof secretHex !== 'string' || !CANONICAL_SECRET_HEX.test(secretHex)) {
      throw new Error(`${SIGNING_SECRET_ENV} must contain one canonical 32-byte hex signing secret.`)
    }
    const secret = fromHex(secretHex)
    try {
      const ecc = new Ecc()
      if (!ecc.isValidSeckey(secret)) throw new Error('The supplied signing secret is invalid.')
      const publicKey = ecc.derivePubkey(secret)
      const fundingScript = Script.p2pkh(shaRmd160(publicKey))
      const expectedFundingScript = candidate.plan.selectedInputs[0]?.outputScript
      if (expectedFundingScript === undefined || toHex(fundingScript.bytecode) !== expectedFundingScript) {
        throw new Error('The signing secret does not control the explicit funding address.')
      }
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
    }
  }
})

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

const chronik = getChronik()
const reader = {
  endpointLabel: getChronikUrls().join(','),
  addressUtxos: async (address: string): Promise<unknown> => chronik.address(address).utxos(),
  validateRawTx: async (rawTx: Uint8Array): Promise<unknown> => chronik.validateRawTx(rawTx),
  tx: async (txid: string): Promise<unknown> => chronik.tx(txid)
}

const result = await executeCommunityParentGenesis({
  config,
  reader,
  gates: {
    BROADCAST: process.env.BROADCAST,
    CONFIRM_COMMUNITY_PARENT_GENESIS: process.env.CONFIRM_COMMUNITY_PARENT_GENESIS,
    CONFIRM_PLAN_SHA256: process.env.CONFIRM_PLAN_SHA256
  },
  signer: createSigner(),
  broadcaster: {
    broadcast: async (rawTx: Uint8Array): Promise<unknown> => chronik.broadcastTx(rawTx)
  },
  onPreview: (preview) => console.log(preview),
  onSignedTxCandidate: (txid) => console.log(`SIGNED TXID CANDIDATE: ${txid}`)
})

if (result.status === 'dry-run') {
  console.log('Execution status: DRY_RUN')
} else {
  console.log(`Execution status: ${result.status}`)
  if (result.status === 'broadcast-status-ambiguous') process.exitCode = 2
}
