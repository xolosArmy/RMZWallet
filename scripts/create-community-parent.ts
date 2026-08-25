import { readFile } from 'node:fs/promises'
import {
  COMMUNITY_PARENT_DECIMALS,
  COMMUNITY_PARENT_DOCUMENT_HASH,
  COMMUNITY_PARENT_INITIAL_QUANTITY,
  COMMUNITY_PARENT_MINT_BATON_VOUT,
  COMMUNITY_PARENT_TOKEN_NAME,
  COMMUNITY_PARENT_TOKEN_TICKER,
  COMMUNITY_PARENT_TOKEN_TYPE,
  assertCanonicalCommunityParentMetadata,
  assertCommunityParentPlannerEnvironment,
  buildCommunityParentGenesisPlan,
  formatCommunityParentGenesisPreview
} from '../src/services/communityParentGenesis'
import type {
  CommunityParentFundingUtxo,
  CommunityParentNetwork
} from '../src/services/communityParentGenesis'

const requireEnvironment = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for an offline dry-run preview.`)
  return value
}

const parseNetwork = (value: string): CommunityParentNetwork => {
  if (value !== 'mainnet' && value !== 'testnet' && value !== 'regtest') {
    throw new Error('COMMUNITY_PARENT_NETWORK must be mainnet, testnet, or regtest.')
  }
  return value
}

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

const parseFundingUtxos = (json: string): readonly CommunityParentFundingUtxo[] => {
  const value: unknown = JSON.parse(json)
  if (!Array.isArray(value)) throw new Error('Funding UTXO file must contain a JSON array.')
  return value.map((entry, index) => {
    const utxo = asObject(entry, `Funding UTXO ${index}`)
    const outpoint = asObject(utxo.outpoint, `Funding UTXO ${index} outpoint`)
    if (
      typeof outpoint.txid !== 'string' ||
      typeof outpoint.outIdx !== 'number' ||
      typeof utxo.sats !== 'string' ||
      !/^[1-9][0-9]*$/.test(utxo.sats) ||
      typeof utxo.outputScript !== 'string' ||
      utxo.isCoinbase !== false
    ) {
      throw new Error(`Funding UTXO ${index} has malformed fields.`)
    }
    return {
      outpoint: { txid: outpoint.txid, outIdx: outpoint.outIdx },
      sats: BigInt(utxo.sats),
      outputScript: utxo.outputScript,
      isCoinbase: false,
      token: utxo.token
    }
  })
}

const cliArgs = process.argv.slice(2)
if (cliArgs.length !== 0) {
  throw new Error('This tool accepts no CLI arguments; secrets must never be supplied on the command line.')
}

assertCommunityParentPlannerEnvironment({
  BROADCAST: process.env.BROADCAST,
  CONFIRM_COMMUNITY_PARENT_GENESIS: process.env.CONFIRM_COMMUNITY_PARENT_GENESIS
})

const metadataBytes = new Uint8Array(
  await readFile(new URL('./metadata/community-parent.json', import.meta.url))
)
assertCanonicalCommunityParentMetadata(metadataBytes)
const fundingUtxosPath = requireEnvironment('COMMUNITY_PARENT_UTXOS_FILE')
const fundingUtxos = parseFundingUtxos(await readFile(fundingUtxosPath, 'utf8'))
const plan = buildCommunityParentGenesisPlan({
  config: {
    network: parseNetwork(requireEnvironment('COMMUNITY_PARENT_NETWORK')),
    fundingAddress: requireEnvironment('COMMUNITY_PARENT_FUNDING_ADDRESS'),
    tokenDestinationAddress: requireEnvironment('COMMUNITY_PARENT_TOKEN_ADDRESS'),
    batonDestinationAddress: requireEnvironment('COMMUNITY_PARENT_BATON_ADDRESS'),
    changeAddress: requireEnvironment('COMMUNITY_PARENT_CHANGE_ADDRESS'),
    documentUri: requireEnvironment('COMMUNITY_PARENT_DOCUMENT_URI')
  },
  fundingUtxos
})

if (
  plan.documentHash !== COMMUNITY_PARENT_DOCUMENT_HASH ||
  plan.tokenType !== COMMUNITY_PARENT_TOKEN_TYPE ||
  plan.tokenName !== COMMUNITY_PARENT_TOKEN_NAME ||
  plan.tokenTicker !== COMMUNITY_PARENT_TOKEN_TICKER ||
  plan.decimals !== COMMUNITY_PARENT_DECIMALS ||
  plan.initialQuantity !== COMMUNITY_PARENT_INITIAL_QUANTITY ||
  plan.mintBatonVout !== COMMUNITY_PARENT_MINT_BATON_VOUT
) {
  throw new Error('Planner returned a non-canonical Community Parent plan.')
}

console.log(formatCommunityParentGenesisPreview(plan))
