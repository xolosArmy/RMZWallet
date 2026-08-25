import {
  Address,
  Script,
  calcTxFee,
  parseSlp,
  sha256,
  slpGenesis,
  toHex
} from 'ecash-lib'
import type { GenesisInfo } from 'chronik-client'
import { CID } from 'multiformats'
import { FEE_RATE_SATS_PER_BYTE, XEC_DUST_SATS } from '../config/xecFees'

export const COMMUNITY_PARENT_TOKEN_TYPE = 129
export const COMMUNITY_PARENT_DECIMALS = 0
export const COMMUNITY_PARENT_INITIAL_QUANTITY = 1n
export const COMMUNITY_PARENT_MINT_BATON_VOUT = 2
export const COMMUNITY_PARENT_TOKEN_NAME = 'xolosArmy Community'
export const COMMUNITY_PARENT_TOKEN_TICKER = 'RMZCOMM'
export const COMMUNITY_PARENT_DOCUMENT_HASH =
  '03cd44ce490769d5646b39c84b488d2894b2b6c4958b085f2cc906c1d36a09a6'
export const COMMUNITY_PARENT_DUST_SATS = BigInt(XEC_DUST_SATS)

const MAX_STANDARD_OP_RETURN_BYTES = 223
const P2PKH_SIGNED_INPUT_BYTES = 148
const TX_FIXED_BYTES = 8
const FEE_PER_KB = BigInt(Math.round(FEE_RATE_SATS_PER_BYTE * 1000))
const CANONICAL_HEX_32 = /^[0-9a-f]{64}$/
const UINT32_MAX = 0xffffffff

export type CommunityParentNetwork = 'mainnet' | 'testnet' | 'regtest'

export type CommunityParentFundingUtxo = {
  readonly outpoint: {
    readonly txid: string
    readonly outIdx: number
  }
  readonly sats: bigint
  readonly outputScript: string
  readonly isCoinbase: false
  readonly token?: unknown
}

export type CommunityParentGenesisConfig = {
  readonly network: CommunityParentNetwork
  readonly fundingAddress: string
  readonly tokenDestinationAddress: string
  readonly batonDestinationAddress: string
  readonly changeAddress: string
  readonly documentUri: string
}

export type CommunityParentGenesisOutput = {
  readonly vout: number
  readonly kind: 'slp-genesis' | 'initial-group-quantity' | 'mint-baton' | 'xec-change'
  readonly sats: bigint
  readonly scriptHex: string
  readonly address?: string
  readonly tokenAtoms?: bigint
}

export type CommunityParentGenesisPlan = {
  readonly network: CommunityParentNetwork
  readonly fundingAddress: string
  readonly tokenDestinationAddress: string
  readonly batonDestinationAddress: string
  readonly changeAddress: string
  readonly tokenType: typeof COMMUNITY_PARENT_TOKEN_TYPE
  readonly tokenName: typeof COMMUNITY_PARENT_TOKEN_NAME
  readonly tokenTicker: typeof COMMUNITY_PARENT_TOKEN_TICKER
  readonly decimals: typeof COMMUNITY_PARENT_DECIMALS
  readonly initialQuantity: typeof COMMUNITY_PARENT_INITIAL_QUANTITY
  readonly mintBatonVout: typeof COMMUNITY_PARENT_MINT_BATON_VOUT
  readonly documentUri: string
  readonly documentHash: typeof COMMUNITY_PARENT_DOCUMENT_HASH
  readonly selectedInputs: readonly CommunityParentFundingUtxo[]
  readonly outputs: readonly CommunityParentGenesisOutput[]
  readonly estimatedFeeSats: bigint
  readonly opReturnHex: string
}

export type CommunityParentPlannerEnvironment = Readonly<{
  BROADCAST?: string
  CONFIRM_COMMUNITY_PARENT_GENESIS?: string
}>

const compactSizeLength = (value: number): number => {
  if (value < 0xfd) return 1
  if (value <= 0xffff) return 3
  if (value <= 0xffffffff) return 5
  return 9
}

const outputSize = (script: Script): number =>
  8 + compactSizeLength(script.bytecode.length) + script.bytecode.length

const estimateFee = (inputCount: number, scripts: readonly Script[]): bigint => {
  const txBytes =
    TX_FIXED_BYTES +
    compactSizeLength(inputCount) +
    inputCount * P2PKH_SIGNED_INPUT_BYTES +
    compactSizeLength(scripts.length) +
    scripts.reduce((total, script) => total + outputSize(script), 0)
  return calcTxFee(txBytes, FEE_PER_KB)
}

const expectedPrefix = (network: CommunityParentNetwork): string => {
  if (network === 'mainnet') return 'ecash'
  if (network === 'testnet') return 'ectest'
  return 'ecregtest'
}

const validateAddress = (address: string, network: CommunityParentNetwork, label: string): Address => {
  let parsed: Address
  try {
    parsed = Address.parse(address)
  } catch {
    throw new Error(`${label} must be a valid eCash cashaddr.`)
  }
  if (
    parsed.encoding !== 'cashaddr' ||
    parsed.prefix !== expectedPrefix(network) ||
    parsed.type !== 'p2pkh'
  ) {
    throw new Error(`${label} must be a P2PKH cashaddr for the explicit ${network} network.`)
  }
  return parsed
}

const requireMetadataShape = (metadataBytes: Uint8Array): void => {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes))
  } catch {
    throw new Error('Metadata bytes must be valid UTF-8 JSON.')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Metadata must be a JSON object.')
  }
  const metadata = parsed as Record<string, unknown>
  const collection = metadata.collection
  if (collection === null || typeof collection !== 'object' || Array.isArray(collection)) {
    throw new Error('Metadata collection descriptor is missing.')
  }
  const descriptor = collection as Record<string, unknown>
  if (
    metadata.schema !== 'xolosarmy-nft/1' ||
    descriptor.type !== 'community' ||
    descriptor.verification !== 'unverified' ||
    descriptor.name !== COMMUNITY_PARENT_TOKEN_NAME
  ) {
    throw new Error('Metadata must remain a descriptive, unverified community descriptor.')
  }
}

export const sha256MetadataBytes = (metadataBytes: Uint8Array): string =>
  toHex(sha256(metadataBytes))

export const assertCanonicalCommunityParentMetadata = (metadataBytes: Uint8Array): void => {
  requireMetadataShape(metadataBytes)
  if (sha256MetadataBytes(metadataBytes) !== COMMUNITY_PARENT_DOCUMENT_HASH) {
    throw new Error('Metadata bytes do not match the canonical Community Parent artifact.')
  }
}

const validateDocumentUri = (documentUri: string): string => {
  if (!documentUri.startsWith('ipfs://')) {
    throw new Error('An explicit canonical ipfs:// document URI is required.')
  }
  const cidText = documentUri.slice('ipfs://'.length)
  let cid: CID
  try {
    cid = CID.parse(cidText)
  } catch {
    throw new Error('Document URI must contain a structurally valid IPFS CIDv0 or CIDv1.')
  }
  if ((cid.version !== 0 && cid.version !== 1) || cid.toString() !== cidText) {
    throw new Error('Document URI must use the canonical encoding of an IPFS CIDv0 or CIDv1.')
  }
  return `ipfs://${cid.toString()}`
}

export const assertCommunityParentPlannerEnvironment = (
  environment: CommunityParentPlannerEnvironment
): void => {
  if (
    environment.BROADCAST !== undefined ||
    environment.CONFIRM_COMMUNITY_PARENT_GENESIS !== undefined
  ) {
    throw new Error(
      'Broadcast is not supported by this planner. This command only produces an offline preview.'
    )
  }
}

const validateFundingUtxo = (
  utxo: CommunityParentFundingUtxo,
  fundingScriptHex: string
): void => {
  if (
    !CANONICAL_HEX_32.test(utxo.outpoint.txid) ||
    !Number.isInteger(utxo.outpoint.outIdx) ||
    utxo.outpoint.outIdx < 0 ||
    utxo.outpoint.outIdx > UINT32_MAX
  ) {
    throw new Error('Funding UTXO outpoint is malformed.')
  }
  if (typeof utxo.sats !== 'bigint' || utxo.sats <= 0n) {
    throw new Error('Funding UTXO sats must be a positive bigint.')
  }
  if (utxo.isCoinbase !== false) {
    throw new Error('Coinbase UTXOs are not accepted as community Parent funding.')
  }
  if (utxo.token !== undefined) {
    throw new Error('Token-bearing UTXOs are forbidden as community Parent funding.')
  }
  if (utxo.outputScript !== fundingScriptHex) {
    throw new Error('Funding UTXO is not controlled by the explicit funding address.')
  }
}

const selectFunding = (params: {
  readonly candidates: readonly CommunityParentFundingUtxo[]
  readonly fundingScriptHex: string
  readonly fixedScripts: readonly Script[]
  readonly fixedSats: bigint
  readonly changeScript: Script
}): {
  readonly selected: readonly CommunityParentFundingUtxo[]
  readonly includeChange: boolean
  readonly fee: bigint
  readonly change: bigint
} => {
  if (params.candidates.length === 0) {
    throw new Error('At least one pure-XEC funding UTXO is required.')
  }
  const seen = new Set<string>()
  for (const utxo of params.candidates) {
    validateFundingUtxo(utxo, params.fundingScriptHex)
    const key = `${utxo.outpoint.txid}:${utxo.outpoint.outIdx}`
    if (seen.has(key)) throw new Error(`Duplicate funding UTXO: ${key}.`)
    seen.add(key)
  }

  const sorted = [...params.candidates].sort((left, right) => {
    if (left.sats !== right.sats) return left.sats > right.sats ? -1 : 1
    const txidOrder = left.outpoint.txid.localeCompare(right.outpoint.txid)
    return txidOrder !== 0 ? txidOrder : left.outpoint.outIdx - right.outpoint.outIdx
  })
  const selected: CommunityParentFundingUtxo[] = []
  let inputSats = 0n

  for (const utxo of sorted) {
    selected.push(utxo)
    inputSats += utxo.sats
    const feeWithChange = estimateFee(selected.length, [...params.fixedScripts, params.changeScript])
    const change = inputSats - params.fixedSats - feeWithChange
    if (change >= COMMUNITY_PARENT_DUST_SATS) {
      return { selected, includeChange: true, fee: feeWithChange, change }
    }

    const minimumFeeWithoutChange = estimateFee(selected.length, params.fixedScripts)
    const remainder = inputSats - params.fixedSats
    if (remainder >= minimumFeeWithoutChange) {
      return { selected, includeChange: false, fee: remainder, change: 0n }
    }
  }
  throw new Error('Insufficient pure XEC funding for dust and the estimated network fee.')
}

export const buildCommunityParentGenesisPlan = (params: {
  readonly config: CommunityParentGenesisConfig
  readonly fundingUtxos: readonly CommunityParentFundingUtxo[]
}): CommunityParentGenesisPlan => {
  const config = params.config
  if (!(['mainnet', 'testnet', 'regtest'] as const).includes(config.network)) {
    throw new Error('Network must be explicitly set to mainnet, testnet, or regtest.')
  }
  const documentUri = validateDocumentUri(config.documentUri)

  const fundingAddress = validateAddress(config.fundingAddress, config.network, 'Funding address')
  const tokenAddress = validateAddress(config.tokenDestinationAddress, config.network, 'Token destination')
  const batonAddress = validateAddress(config.batonDestinationAddress, config.network, 'Baton destination')
  const changeAddress = validateAddress(config.changeAddress, config.network, 'Change address')
  const fundingScript = fundingAddress.toScript()
  const tokenScript = tokenAddress.toScript()
  const batonScript = batonAddress.toScript()
  const changeScript = changeAddress.toScript()

  const genesisInfo: GenesisInfo = {
    tokenTicker: COMMUNITY_PARENT_TOKEN_TICKER,
    tokenName: COMMUNITY_PARENT_TOKEN_NAME,
    url: documentUri,
    hash: COMMUNITY_PARENT_DOCUMENT_HASH,
    decimals: COMMUNITY_PARENT_DECIMALS
  }
  const opReturn = slpGenesis(
    COMMUNITY_PARENT_TOKEN_TYPE,
    genesisInfo,
    COMMUNITY_PARENT_INITIAL_QUANTITY,
    COMMUNITY_PARENT_MINT_BATON_VOUT
  )
  if (opReturn.bytecode.length > MAX_STANDARD_OP_RETURN_BYTES) {
    throw new Error(`SLP GENESIS OP_RETURN exceeds ${MAX_STANDARD_OP_RETURN_BYTES} bytes.`)
  }
  const parsed = parseSlp(opReturn)
  if (
    parsed?.txType !== 'GENESIS' ||
    parsed.tokenType !== COMMUNITY_PARENT_TOKEN_TYPE ||
    parsed.genesisInfo.tokenTicker !== COMMUNITY_PARENT_TOKEN_TICKER ||
    parsed.genesisInfo.tokenName !== COMMUNITY_PARENT_TOKEN_NAME ||
    parsed.genesisInfo.url !== documentUri ||
    parsed.genesisInfo.hash !== COMMUNITY_PARENT_DOCUMENT_HASH ||
    parsed.genesisInfo.decimals !== COMMUNITY_PARENT_DECIMALS ||
    parsed.initialAtoms !== COMMUNITY_PARENT_INITIAL_QUANTITY ||
    parsed.mintBatonOutIdx !== COMMUNITY_PARENT_MINT_BATON_VOUT
  ) {
    throw new Error('ecash-lib did not produce the required NFT1 Group GENESIS semantics.')
  }

  const fixedScripts = [opReturn, tokenScript, batonScript]
  const fixedSats = COMMUNITY_PARENT_DUST_SATS * 2n
  const funding = selectFunding({
    candidates: params.fundingUtxos,
    fundingScriptHex: toHex(fundingScript.bytecode),
    fixedScripts,
    fixedSats,
    changeScript
  })
  const outputs: CommunityParentGenesisOutput[] = [
    {
      vout: 0,
      kind: 'slp-genesis',
      sats: 0n,
      scriptHex: toHex(opReturn.bytecode)
    },
    {
      vout: 1,
      kind: 'initial-group-quantity',
      sats: COMMUNITY_PARENT_DUST_SATS,
      scriptHex: toHex(tokenScript.bytecode),
      address: tokenAddress.toString(),
      tokenAtoms: COMMUNITY_PARENT_INITIAL_QUANTITY
    },
    {
      vout: COMMUNITY_PARENT_MINT_BATON_VOUT,
      kind: 'mint-baton',
      sats: COMMUNITY_PARENT_DUST_SATS,
      scriptHex: toHex(batonScript.bytecode),
      address: batonAddress.toString()
    }
  ]
  if (funding.includeChange) {
    outputs.push({
      vout: outputs.length,
      kind: 'xec-change',
      sats: funding.change,
      scriptHex: toHex(changeScript.bytecode),
      address: changeAddress.toString()
    })
  }

  return {
    network: config.network,
    fundingAddress: fundingAddress.toString(),
    tokenDestinationAddress: tokenAddress.toString(),
    batonDestinationAddress: batonAddress.toString(),
    changeAddress: changeAddress.toString(),
    tokenType: COMMUNITY_PARENT_TOKEN_TYPE,
    tokenName: COMMUNITY_PARENT_TOKEN_NAME,
    tokenTicker: COMMUNITY_PARENT_TOKEN_TICKER,
    decimals: COMMUNITY_PARENT_DECIMALS,
    initialQuantity: COMMUNITY_PARENT_INITIAL_QUANTITY,
    mintBatonVout: COMMUNITY_PARENT_MINT_BATON_VOUT,
    documentUri,
    documentHash: COMMUNITY_PARENT_DOCUMENT_HASH,
    selectedInputs: funding.selected,
    outputs,
    estimatedFeeSats: funding.fee,
    opReturnHex: toHex(opReturn.bytecode)
  }
}

export const formatCommunityParentGenesisPreview = (
  plan: CommunityParentGenesisPlan
): string => {
  const inputs = plan.selectedInputs
    .map((utxo) => `  - ${utxo.outpoint.txid}:${utxo.outpoint.outIdx} (${utxo.sats.toString()} sats)`)
    .join('\n')
  const outputs = plan.outputs
    .map((output) => {
      const destination = output.address ? ` -> ${output.address}` : ''
      const atoms = output.tokenAtoms === undefined ? '' : `; ${output.tokenAtoms.toString()} atoms`
      return `  - vout ${output.vout}: ${output.kind}; ${output.sats.toString()} sats${atoms}${destination}`
    })
    .join('\n')
  return [
    'Community Parent SLP NFT1 Group preparation',
    'mode: DRY_RUN',
    `network: ${plan.network}`,
    `fundingAddress: ${plan.fundingAddress}`,
    `tokenDestinationAddress: ${plan.tokenDestinationAddress}`,
    `batonAddress: ${plan.batonDestinationAddress}`,
    `changeAddress: ${plan.changeAddress}`,
    `tokenType: ${plan.tokenType} (SLP NFT1 Group)`,
    `name: ${plan.tokenName}`,
    `ticker: ${plan.tokenTicker}`,
    `decimals: ${plan.decimals}`,
    `initialQuantity: ${plan.initialQuantity.toString()}`,
    `documentUri: ${plan.documentUri}`,
    `documentHash: ${plan.documentHash}`,
    'selectedPureXecInputs:',
    inputs,
    'expectedOutputs:',
    outputs,
    `estimatedFeeSats: ${plan.estimatedFeeSats.toString()}`,
    'broadcastExecuted: NO'
  ].join('\n')
}
