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
import { FEE_RATE_SATS_PER_BYTE, XEC_DUST_SATS } from '../config/xecFees'

export const COMMUNITY_PARENT_TOKEN_TYPE = 129
export const COMMUNITY_PARENT_DECIMALS = 0
export const COMMUNITY_PARENT_INITIAL_QUANTITY = 1n
export const COMMUNITY_PARENT_MINT_BATON_VOUT = 2
export const COMMUNITY_PARENT_TOKEN_NAME = 'xolosArmy Community'
export const COMMUNITY_PARENT_TOKEN_TICKER = 'RMZCOMM'
export const COMMUNITY_PARENT_DUST_SATS = BigInt(XEC_DUST_SATS)

const MAX_SLP_ATOMS = 0xffffffffffffffffn
const MAX_STANDARD_OP_RETURN_BYTES = 223
const P2PKH_SIGNED_INPUT_BYTES = 148
const TX_FIXED_BYTES = 8
const FEE_PER_KB = BigInt(Math.round(FEE_RATE_SATS_PER_BYTE * 1000))
const CANONICAL_HEX_32 = /^[0-9a-f]{64}$/
const DOCUMENT_URI = /^ipfs:\/\/[A-Za-z0-9]{20,120}$/

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
  readonly documentHash: string
  readonly metadataBytes: Uint8Array
  readonly tokenType: number
  readonly tokenName: string
  readonly tokenTicker: string
  readonly decimals: number
  readonly initialQuantity: unknown
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
  readonly initialQuantity: bigint
  readonly mintBatonVout: typeof COMMUNITY_PARENT_MINT_BATON_VOUT
  readonly documentUri: string
  readonly documentHash: string
  readonly selectedInputs: readonly CommunityParentFundingUtxo[]
  readonly outputs: readonly CommunityParentGenesisOutput[]
  readonly estimatedFeeSats: bigint
  readonly opReturnHex: string
}

export type CommunityParentExecutionEnvironment = Readonly<{
  BROADCAST?: string
  CONFIRM_COMMUNITY_PARENT_GENESIS?: string
}>

export type CommunityParentExecutionPorts = {
  readonly revalidateFunding: () => Promise<readonly CommunityParentFundingUtxo[]>
  readonly sign: (plan: CommunityParentGenesisPlan) => Promise<{ readonly rawTxHex: string }>
  readonly broadcast: (rawTxHex: string) => Promise<{ readonly txid: string }>
}

export type CommunityParentExecutionResult =
  | { readonly mode: 'dry-run'; readonly plan: CommunityParentGenesisPlan }
  | { readonly mode: 'broadcast'; readonly txid: string }

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

export const validateCommunityParentInitialQuantity = (value: unknown): bigint => {
  let quantity: bigint
  if (typeof value === 'bigint') {
    quantity = value
  } else if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    quantity = BigInt(value)
  } else {
    throw new Error('Initial quantity must be an unambiguous positive integer.')
  }
  if (quantity < 1n || quantity > MAX_SLP_ATOMS) {
    throw new Error(`Initial quantity must be between 1 and ${MAX_SLP_ATOMS.toString()} atoms.`)
  }
  return quantity
}

const validateFundingUtxo = (
  utxo: CommunityParentFundingUtxo,
  fundingScriptHex: string
): void => {
  if (
    !CANONICAL_HEX_32.test(utxo.outpoint.txid) ||
    !Number.isSafeInteger(utxo.outpoint.outIdx) ||
    utxo.outpoint.outIdx < 0
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
  if (config.tokenType !== COMMUNITY_PARENT_TOKEN_TYPE) {
    throw new Error('Community Parent must use SLP NFT1 Group token type 129.')
  }
  if (config.decimals !== COMMUNITY_PARENT_DECIMALS) {
    throw new Error('Community Parent must use zero decimals.')
  }
  if (config.tokenName !== COMMUNITY_PARENT_TOKEN_NAME || config.tokenTicker !== COMMUNITY_PARENT_TOKEN_TICKER) {
    throw new Error('Community Parent name or ticker does not match the reviewed administrative convention.')
  }
  if (!DOCUMENT_URI.test(config.documentUri)) {
    throw new Error('An explicit canonical ipfs:// document URI is required.')
  }
  if (!CANONICAL_HEX_32.test(config.documentHash)) {
    throw new Error('Document hash must be 32 canonical lowercase hex bytes.')
  }
  requireMetadataShape(config.metadataBytes)
  const actualDocumentHash = sha256MetadataBytes(config.metadataBytes)
  if (actualDocumentHash !== config.documentHash) {
    throw new Error('Document hash does not match the exact metadata file bytes.')
  }
  const initialQuantity = validateCommunityParentInitialQuantity(config.initialQuantity)

  const fundingAddress = validateAddress(config.fundingAddress, config.network, 'Funding address')
  const tokenAddress = validateAddress(config.tokenDestinationAddress, config.network, 'Token destination')
  const batonAddress = validateAddress(config.batonDestinationAddress, config.network, 'Baton destination')
  const changeAddress = validateAddress(config.changeAddress, config.network, 'Change address')
  const fundingScript = fundingAddress.toScript()
  const tokenScript = tokenAddress.toScript()
  const batonScript = batonAddress.toScript()
  const changeScript = changeAddress.toScript()

  const genesisInfo: GenesisInfo = {
    tokenTicker: config.tokenTicker,
    tokenName: config.tokenName,
    url: config.documentUri,
    hash: config.documentHash,
    decimals: config.decimals
  }
  const opReturn = slpGenesis(
    config.tokenType,
    genesisInfo,
    initialQuantity,
    COMMUNITY_PARENT_MINT_BATON_VOUT
  )
  if (opReturn.bytecode.length > MAX_STANDARD_OP_RETURN_BYTES) {
    throw new Error(`SLP GENESIS OP_RETURN exceeds ${MAX_STANDARD_OP_RETURN_BYTES} bytes.`)
  }
  const parsed = parseSlp(opReturn)
  if (
    parsed?.txType !== 'GENESIS' ||
    parsed.tokenType !== COMMUNITY_PARENT_TOKEN_TYPE ||
    parsed.genesisInfo.decimals !== COMMUNITY_PARENT_DECIMALS ||
    parsed.initialAtoms !== initialQuantity ||
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
      tokenAtoms: initialQuantity
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
    initialQuantity,
    mintBatonVout: COMMUNITY_PARENT_MINT_BATON_VOUT,
    documentUri: config.documentUri,
    documentHash: config.documentHash,
    selectedInputs: funding.selected,
    outputs,
    estimatedFeeSats: funding.fee,
    opReturnHex: toHex(opReturn.bytecode)
  }
}

export const isCommunityParentBroadcastEnabled = (
  environment: CommunityParentExecutionEnvironment
): boolean =>
  environment.BROADCAST === '1' &&
  environment.CONFIRM_COMMUNITY_PARENT_GENESIS === 'YES'

export const revalidateCommunityParentFunding = (
  selectedInputs: readonly CommunityParentFundingUtxo[],
  freshCandidates: readonly CommunityParentFundingUtxo[]
): void => {
  const freshByOutpoint = new Map(
    freshCandidates.map((utxo) => [`${utxo.outpoint.txid}:${utxo.outpoint.outIdx}`, utxo])
  )
  for (const selected of selectedInputs) {
    const key = `${selected.outpoint.txid}:${selected.outpoint.outIdx}`
    const fresh = freshByOutpoint.get(key)
    if (!fresh) throw new Error(`Funding UTXO disappeared before signing: ${key}.`)
    validateFundingUtxo(fresh, selected.outputScript)
    if (fresh.sats !== selected.sats) {
      throw new Error(`Funding UTXO amount changed before signing: ${key}.`)
    }
  }
}

export const executeCommunityParentGenesis = async (params: {
  readonly plan: CommunityParentGenesisPlan
  readonly environment: CommunityParentExecutionEnvironment
  readonly signingSecretAvailable: boolean
  readonly ports?: CommunityParentExecutionPorts
}): Promise<CommunityParentExecutionResult> => {
  if (!isCommunityParentBroadcastEnabled(params.environment)) {
    return { mode: 'dry-run', plan: params.plan }
  }
  if (params.signingSecretAvailable !== true) {
    throw new Error('Broadcast requested but no signing secret is available through an audited wallet integration.')
  }
  if (!params.ports) {
    throw new Error('Broadcast requested but signing, revalidation, and broadcast ports are not configured.')
  }

  const freshFunding = await params.ports.revalidateFunding()
  revalidateCommunityParentFunding(params.plan.selectedInputs, freshFunding)
  const signed = await params.ports.sign(params.plan)
  if (!/^[0-9a-f]+$/.test(signed.rawTxHex) || signed.rawTxHex.length % 2 !== 0) {
    throw new Error('Signer returned malformed transaction bytes.')
  }
  const result = await params.ports.broadcast(signed.rawTxHex)
  if (!CANONICAL_HEX_32.test(result.txid)) {
    throw new Error('Broadcast port returned a malformed transaction ID.')
  }
  return { mode: 'broadcast', txid: result.txid }
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
