import {
  Address,
  Script,
  Tx,
  calcTxFee,
  fromHex,
  parseSlp,
  sha256,
  toHex
} from 'ecash-lib'
import { FEE_RATE_SATS_PER_BYTE } from '../config/xecFees'
import {
  COMMUNITY_PARENT_DECIMALS,
  COMMUNITY_PARENT_DOCUMENT_HASH,
  COMMUNITY_PARENT_DUST_SATS,
  COMMUNITY_PARENT_INITIAL_QUANTITY,
  COMMUNITY_PARENT_MINT_BATON_VOUT,
  COMMUNITY_PARENT_TOKEN_NAME,
  COMMUNITY_PARENT_TOKEN_TICKER,
  COMMUNITY_PARENT_TOKEN_TYPE,
  buildCommunityParentGenesisPlan
} from './communityParentGenesis'
import type {
  CommunityParentFundingUtxo,
  CommunityParentGenesisConfig,
  CommunityParentGenesisPlan
} from './communityParentGenesis'

const CANONICAL_TXID = /^[0-9a-f]{64}$/
const UINT32_MAX = 0xffffffff
const P2PKH_SIGNED_INPUT_BYTES = 148
const TX_FIXED_BYTES = 8
const FEE_PER_KB = BigInt(Math.round(FEE_RATE_SATS_PER_BYTE * 1000))

export const COMMUNITY_PARENT_EXECUTION_FEE_PER_KB = FEE_PER_KB
export const COMMUNITY_PARENT_MAX_FEE_OVERPAY_SATS = COMMUNITY_PARENT_DUST_SATS - 1n

export type CommunityParentExecutionGates = Readonly<{
  BROADCAST?: string
  CONFIRM_COMMUNITY_PARENT_GENESIS?: string
  CONFIRM_PLAN_SHA256?: string
}>

export interface CommunityParentChronikReader {
  readonly endpointLabel: string
  addressUtxos(address: string): Promise<unknown>
  validateRawTx(rawTx: Uint8Array): Promise<unknown>
  tx(txid: string): Promise<unknown>
}

export interface CommunityParentSigner {
  sign(candidate: CommunityParentExecutionCandidate): Promise<Uint8Array>
}

export interface CommunityParentBroadcaster {
  broadcast(rawTx: Uint8Array): Promise<unknown>
}

export type CommunityParentExecutionCandidate = Readonly<{
  plan: CommunityParentGenesisPlan
  chronikEndpoint: string
  unsignedTxHex: string
  maximumFeeSats: bigint
  fingerprint: string
}>

export type CommunityParentExecutionResult =
  | Readonly<{
      status: 'dry-run'
      candidate: CommunityParentExecutionCandidate
    }>
  | Readonly<{
      status: 'broadcast-confirmed' | 'broadcast-accepted-chain-verification-pending'
      candidate: CommunityParentExecutionCandidate
      signedTxid: string
    }>
  | Readonly<{
      status: 'broadcast-status-ambiguous'
      candidate: CommunityParentExecutionCandidate
      signedTxid: string
    }>

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is malformed.`)
  }
  return value as Record<string, unknown>
}

const compactSizeLength = (value: number): number => {
  if (value < 0xfd) return 1
  if (value <= 0xffff) return 3
  if (value <= 0xffffffff) return 5
  return 9
}

const outputSizeFromHex = (scriptHex: string): number => {
  const scriptBytes = fromHex(scriptHex).length
  return 8 + compactSizeLength(scriptBytes) + scriptBytes
}

const maximumFeeForPlan = (plan: CommunityParentGenesisPlan): bigint => {
  const signedSize =
    TX_FIXED_BYTES +
    compactSizeLength(plan.selectedInputs.length) +
    plan.selectedInputs.length * P2PKH_SIGNED_INPUT_BYTES +
    compactSizeLength(plan.outputs.length) +
    plan.outputs.reduce((total, output) => total + outputSizeFromHex(output.scriptHex), 0)
  return calcTxFee(signedSize, FEE_PER_KB) + COMMUNITY_PARENT_MAX_FEE_OVERPAY_SATS
}

const sumInputSats = (plan: CommunityParentGenesisPlan): bigint =>
  plan.selectedInputs.reduce((total, input) => total + input.sats, 0n)

const sumOutputSats = (plan: CommunityParentGenesisPlan): bigint =>
  plan.outputs.reduce((total, output) => total + output.sats, 0n)

const assertCanonicalPlan = (plan: CommunityParentGenesisPlan): void => {
  if (
    plan.tokenType !== COMMUNITY_PARENT_TOKEN_TYPE ||
    plan.tokenName !== COMMUNITY_PARENT_TOKEN_NAME ||
    plan.tokenTicker !== COMMUNITY_PARENT_TOKEN_TICKER ||
    plan.decimals !== COMMUNITY_PARENT_DECIMALS ||
    plan.initialQuantity !== COMMUNITY_PARENT_INITIAL_QUANTITY ||
    plan.mintBatonVout !== COMMUNITY_PARENT_MINT_BATON_VOUT ||
    plan.documentHash !== COMMUNITY_PARENT_DOCUMENT_HASH
  ) {
    throw new Error('Community Parent canonical invariants changed before execution.')
  }
  if (plan.outputs.length !== 3 && plan.outputs.length !== 4) {
    throw new Error('Community Parent output layout is not canonical.')
  }
  const [genesis, token, baton, change] = plan.outputs
  if (
    genesis?.vout !== 0 ||
    genesis.kind !== 'slp-genesis' ||
    genesis.sats !== 0n ||
    genesis.scriptHex !== plan.opReturnHex ||
    token?.vout !== 1 ||
    token.kind !== 'initial-group-quantity' ||
    token.sats !== COMMUNITY_PARENT_DUST_SATS ||
    token.tokenAtoms !== COMMUNITY_PARENT_INITIAL_QUANTITY ||
    token.address !== plan.tokenDestinationAddress ||
    baton?.vout !== COMMUNITY_PARENT_MINT_BATON_VOUT ||
    baton.kind !== 'mint-baton' ||
    baton.sats !== COMMUNITY_PARENT_DUST_SATS ||
    baton.address !== plan.batonDestinationAddress
  ) {
    throw new Error('Community Parent fixed outputs are not canonical.')
  }
  if (
    (change !== undefined &&
      (change.vout !== 3 ||
        change.kind !== 'xec-change' ||
        change.sats < COMMUNITY_PARENT_DUST_SATS ||
        change.address !== plan.changeAddress)) ||
    plan.outputs.some((output, index) => output.vout !== index)
  ) {
    throw new Error('Community Parent change output is not canonical.')
  }
  const parsed = parseSlp(new Script(fromHex(plan.opReturnHex)))
  if (
    parsed?.txType !== 'GENESIS' ||
    parsed.tokenType !== COMMUNITY_PARENT_TOKEN_TYPE ||
    parsed.genesisInfo.tokenTicker !== COMMUNITY_PARENT_TOKEN_TICKER ||
    parsed.genesisInfo.tokenName !== COMMUNITY_PARENT_TOKEN_NAME ||
    parsed.genesisInfo.url !== plan.documentUri ||
    parsed.genesisInfo.hash !== COMMUNITY_PARENT_DOCUMENT_HASH ||
    parsed.genesisInfo.decimals !== COMMUNITY_PARENT_DECIMALS ||
    parsed.initialAtoms !== COMMUNITY_PARENT_INITIAL_QUANTITY ||
    parsed.mintBatonOutIdx !== COMMUNITY_PARENT_MINT_BATON_VOUT
  ) {
    throw new Error('Community Parent SLP GENESIS semantics are not canonical.')
  }
  const fundingScriptHex = toHex(Address.parse(plan.fundingAddress).toScript().bytecode)
  if (
    plan.selectedInputs.length === 0 ||
    plan.selectedInputs.some(
      (input) =>
        input.outputScript !== fundingScriptHex ||
        input.token !== undefined ||
        input.isCoinbase !== false
    )
  ) {
    throw new Error('Community Parent execution inputs are not pure XEC funding.')
  }
  const fee = sumInputSats(plan) - sumOutputSats(plan)
  if (fee < 0n || fee !== plan.estimatedFeeSats) {
    throw new Error('Community Parent fee or change accounting is inconsistent.')
  }
  if (fee > maximumFeeForPlan(plan)) {
    throw new Error('Community Parent fee exceeds the maximum policy guard.')
  }
}

const parseLiveFunding = (
  response: unknown,
  expectedScriptHex: string
): readonly CommunityParentFundingUtxo[] => {
  const payload = asRecord(response, 'Chronik UTXO response')
  if (payload.outputScript !== expectedScriptHex || !Array.isArray(payload.utxos)) {
    throw new Error('Chronik UTXO response does not match the funding address.')
  }
  const seen = new Set<string>()
  const pureXec: CommunityParentFundingUtxo[] = []
  for (const raw of payload.utxos) {
    const utxo = asRecord(raw, 'Chronik UTXO')
    const outpoint = asRecord(utxo.outpoint, 'Chronik UTXO outpoint')
    if (
      typeof outpoint.txid !== 'string' ||
      !CANONICAL_TXID.test(outpoint.txid) ||
      typeof outpoint.outIdx !== 'number' ||
      !Number.isInteger(outpoint.outIdx) ||
      outpoint.outIdx < 0 ||
      outpoint.outIdx > UINT32_MAX ||
      typeof utxo.sats !== 'bigint' ||
      utxo.sats <= 0n ||
      typeof utxo.isCoinbase !== 'boolean'
    ) {
      throw new Error('Chronik returned a malformed funding UTXO.')
    }
    const key = `${outpoint.txid}:${outpoint.outIdx}`
    if (seen.has(key)) throw new Error(`Chronik returned duplicate UTXO ${key}.`)
    seen.add(key)
    if (utxo.isCoinbase) continue
    if (utxo.token !== undefined) {
      asRecord(utxo.token, 'Chronik token annotation')
      continue
    }
    pureXec.push({
      outpoint: { txid: outpoint.txid, outIdx: outpoint.outIdx },
      sats: utxo.sats,
      outputScript: expectedScriptHex,
      isCoinbase: false
    })
  }
  return pureXec
}

const readLivePureXecFunding = async (
  config: CommunityParentGenesisConfig,
  reader: CommunityParentChronikReader
): Promise<readonly CommunityParentFundingUtxo[]> => {
  const expectedScriptHex = toHex(Address.parse(config.fundingAddress).toScript().bytecode)
  try {
    const response = await reader.addressUtxos(config.fundingAddress)
    return parseLiveFunding(response, expectedScriptHex)
  } catch {
    throw new Error('Chronik live UTXO revalidation failed closed.')
  }
}

const buildUnsignedTx = (plan: CommunityParentGenesisPlan): Tx =>
  new Tx({
    inputs: plan.selectedInputs.map((input) => ({
      prevOut: input.outpoint,
      signData: {
        sats: input.sats,
        outputScript: new Script(fromHex(input.outputScript))
      }
    })),
    outputs: plan.outputs.map((output) => ({
      sats: output.sats,
      script: new Script(fromHex(output.scriptHex))
    }))
  })

const canonicalFingerprintBytes = (params: {
  readonly plan: CommunityParentGenesisPlan
  readonly chronikEndpoint: string
  readonly unsignedTxHex: string
  readonly maximumFeeSats: bigint
}): Uint8Array => {
  const { plan } = params
  const commitment = {
    schema: 'xolosarmy-community-parent-execution/1',
    network: plan.network,
    chronikEndpoint: params.chronikEndpoint,
    fundingAddress: plan.fundingAddress,
    tokenDestinationAddress: plan.tokenDestinationAddress,
    batonDestinationAddress: plan.batonDestinationAddress,
    changeAddress: plan.changeAddress,
    selectedInputs: plan.selectedInputs.map((input) => ({
      txid: input.outpoint.txid,
      outIdx: input.outpoint.outIdx,
      sats: input.sats.toString(),
      outputScript: input.outputScript
    })),
    tokenType: plan.tokenType,
    tokenName: plan.tokenName,
    tokenTicker: plan.tokenTicker,
    decimals: plan.decimals,
    initialQuantity: plan.initialQuantity.toString(),
    mintBatonVout: plan.mintBatonVout,
    documentUri: plan.documentUri,
    documentHash: plan.documentHash,
    opReturnHex: plan.opReturnHex,
    outputs: plan.outputs.map((output) => ({
      vout: output.vout,
      kind: output.kind,
      sats: output.sats.toString(),
      scriptHex: output.scriptHex,
      address: output.address ?? null,
      tokenAtoms: output.tokenAtoms?.toString() ?? null
    })),
    feeRateSatsPerKb: FEE_PER_KB.toString(),
    estimatedFeeSats: plan.estimatedFeeSats.toString(),
    maximumFeeSats: params.maximumFeeSats.toString(),
    unsignedTxHex: params.unsignedTxHex
  }
  return new TextEncoder().encode(JSON.stringify(commitment))
}

const freezeCandidate = (
  candidate: CommunityParentExecutionCandidate
): CommunityParentExecutionCandidate => {
  for (const input of candidate.plan.selectedInputs) {
    Object.freeze(input.outpoint)
    Object.freeze(input)
  }
  for (const output of candidate.plan.outputs) Object.freeze(output)
  Object.freeze(candidate.plan.selectedInputs)
  Object.freeze(candidate.plan.outputs)
  Object.freeze(candidate.plan)
  return Object.freeze(candidate)
}

export const prepareCommunityParentExecution = async (params: {
  readonly config: CommunityParentGenesisConfig
  readonly reader: CommunityParentChronikReader
}): Promise<CommunityParentExecutionCandidate> => {
  if (
    typeof params.reader.endpointLabel !== 'string' ||
    params.reader.endpointLabel.length === 0 ||
    params.reader.endpointLabel.trim() !== params.reader.endpointLabel ||
    [...params.reader.endpointLabel].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 0x20 || code === 0x7f
    })
  ) {
    throw new Error('Chronik endpoint label must be explicit.')
  }
  const fundingUtxos = await readLivePureXecFunding(params.config, params.reader)
  const plan = buildCommunityParentGenesisPlan({ config: params.config, fundingUtxos })
  assertCanonicalPlan(plan)
  const unsignedTxHex = buildUnsignedTx(plan).toHex()
  const maximumFeeSats = maximumFeeForPlan(plan)
  const fingerprint = toHex(
    sha256(
      canonicalFingerprintBytes({
        plan,
        chronikEndpoint: params.reader.endpointLabel,
        unsignedTxHex,
        maximumFeeSats
      })
    )
  )
  return freezeCandidate({
    plan,
    chronikEndpoint: params.reader.endpointLabel,
    unsignedTxHex,
    maximumFeeSats,
    fingerprint
  })
}

const assertExecutionGates = (
  gates: CommunityParentExecutionGates,
  fingerprint: string
): 'dry-run' | 'execute' => {
  const supplied =
    gates.BROADCAST !== undefined ||
    gates.CONFIRM_COMMUNITY_PARENT_GENESIS !== undefined ||
    gates.CONFIRM_PLAN_SHA256 !== undefined
  if (!supplied) return 'dry-run'
  if (
    gates.BROADCAST !== '1' ||
    gates.CONFIRM_COMMUNITY_PARENT_GENESIS !== 'YES' ||
    gates.CONFIRM_PLAN_SHA256 !== fingerprint
  ) {
    throw new Error('Execution authorization is incomplete or the plan fingerprint does not match.')
  }
  return 'execute'
}

const assertSignedTxMatchesCandidate = (
  rawTx: Uint8Array,
  candidate: CommunityParentExecutionCandidate
): Tx => {
  let tx: Tx
  try {
    tx = Tx.deser(rawTx)
  } catch {
    throw new Error('Signer returned a malformed transaction.')
  }
  if (toHex(tx.ser()) !== toHex(rawTx)) {
    throw new Error('Signer returned non-canonical transaction bytes.')
  }
  const unsigned = Tx.fromHex(candidate.unsignedTxHex)
  const txidHex = (txid: string | Uint8Array): string =>
    typeof txid === 'string' ? txid : toHex(txid.slice().reverse())
  if (
    tx.version !== unsigned.version ||
    tx.locktime !== unsigned.locktime ||
    tx.inputs.length !== unsigned.inputs.length ||
    tx.outputs.length !== unsigned.outputs.length
  ) {
    throw new Error('Signed transaction changed the canonical transaction shape.')
  }
  for (let index = 0; index < tx.inputs.length; index += 1) {
    const actual = tx.inputs[index]
    const expected = unsigned.inputs[index]
    if (
      actual === undefined ||
      expected === undefined ||
      txidHex(actual.prevOut.txid) !== txidHex(expected.prevOut.txid) ||
      actual.prevOut.outIdx !== expected.prevOut.outIdx ||
      (actual.sequence ?? UINT32_MAX) !== (expected.sequence ?? UINT32_MAX) ||
      actual.script === undefined ||
      actual.script.bytecode.length === 0
    ) {
      throw new Error('Signed transaction changed a canonical input.')
    }
  }
  for (let index = 0; index < tx.outputs.length; index += 1) {
    const actual = tx.outputs[index]
    const expected = unsigned.outputs[index]
    if (
      actual === undefined ||
      expected === undefined ||
      actual.sats !== expected.sats ||
      toHex(actual.script.bytecode) !== toHex(expected.script.bytecode)
    ) {
      throw new Error('Signed transaction changed a canonical output.')
    }
  }
  const fee = sumInputSats(candidate.plan) - tx.outputs.reduce((sum, output) => sum + output.sats, 0n)
  const minimumFee = calcTxFee(tx.serSize(), FEE_PER_KB)
  if (
    fee !== candidate.plan.estimatedFeeSats ||
    fee < minimumFee ||
    fee > candidate.maximumFeeSats
  ) {
    throw new Error('Signed transaction fee violates the canonical fee policy.')
  }
  return tx
}

const expectTokenType = (value: unknown, number: number): void => {
  const tokenType = asRecord(value, 'Chronik token type')
  if (tokenType.protocol !== 'SLP' || tokenType.number !== number) {
    throw new Error('Chronik token type does not match the canonical transaction.')
  }
}

const assertChronikTxMatchesCandidate = (
  value: unknown,
  candidate: CommunityParentExecutionCandidate,
  signedTxid: string
): void => {
  try {
    const tx = asRecord(value, 'Chronik transaction')
    if (
      tx.txid !== signedTxid ||
      tx.tokenStatus !== 'TOKEN_STATUS_NORMAL' ||
      !Array.isArray(tx.inputs) ||
      !Array.isArray(tx.outputs) ||
      !Array.isArray(tx.tokenEntries) ||
      !Array.isArray(tx.tokenFailedParsings) ||
      tx.tokenFailedParsings.length !== 0 ||
      tx.inputs.length !== candidate.plan.selectedInputs.length ||
      tx.outputs.length !== candidate.plan.outputs.length ||
      tx.tokenEntries.length !== 1
    ) {
      throw new Error('Chronik transaction summary is not canonical.')
    }
    for (let index = 0; index < tx.inputs.length; index += 1) {
      const input = asRecord(tx.inputs[index], 'Chronik transaction input')
      const prevOut = asRecord(input.prevOut, 'Chronik transaction input outpoint')
      const expected = candidate.plan.selectedInputs[index]
      if (
        expected === undefined ||
        prevOut.txid !== expected.outpoint.txid ||
        prevOut.outIdx !== expected.outpoint.outIdx ||
        input.sats !== expected.sats ||
        input.outputScript !== expected.outputScript ||
        input.token !== undefined
      ) {
        throw new Error('Chronik transaction input is not canonical pure XEC funding.')
      }
    }
    for (let index = 0; index < tx.outputs.length; index += 1) {
      const output = asRecord(tx.outputs[index], 'Chronik transaction output')
      const expected = candidate.plan.outputs[index]
      if (
        expected === undefined ||
        output.sats !== expected.sats ||
        output.outputScript !== expected.scriptHex
      ) {
        throw new Error('Chronik transaction output is not canonical.')
      }
    }
    const entry = asRecord(tx.tokenEntries[0], 'Chronik token entry')
    expectTokenType(entry.tokenType, COMMUNITY_PARENT_TOKEN_TYPE)
    if (
      entry.tokenId !== signedTxid ||
      entry.txType !== 'GENESIS' ||
      entry.isInvalid !== false ||
      entry.actualBurnAtoms !== 0n ||
      entry.burnsMintBatons !== false
    ) {
      throw new Error('Chronik rejected the canonical NFT1 Group GENESIS semantics.')
    }
    const tokenOutput = asRecord(asRecord(tx.outputs[1], 'Chronik Group output').token, 'Chronik Group token')
    const batonOutput = asRecord(asRecord(tx.outputs[2], 'Chronik baton output').token, 'Chronik baton token')
    expectTokenType(tokenOutput.tokenType, COMMUNITY_PARENT_TOKEN_TYPE)
    expectTokenType(batonOutput.tokenType, COMMUNITY_PARENT_TOKEN_TYPE)
    if (
      tokenOutput.tokenId !== signedTxid ||
      tokenOutput.atoms !== COMMUNITY_PARENT_INITIAL_QUANTITY ||
      tokenOutput.isMintBaton !== false ||
      batonOutput.tokenId !== signedTxid ||
      batonOutput.atoms !== 0n ||
      batonOutput.isMintBaton !== true
    ) {
      throw new Error('Chronik NFT1 Group outputs are not canonical.')
    }
  } catch {
    throw new Error('Chronik transaction validation failed closed.')
  }
}

export const formatCommunityParentExecutionPreview = (
  candidate: CommunityParentExecutionCandidate
): string => {
  const { plan } = candidate
  const inputs = plan.selectedInputs
    .map((input) => `  - ${input.outpoint.txid}:${input.outpoint.outIdx} (${input.sats.toString()} sats)`)
    .join('\n')
  const outputs = plan.outputs
    .map((output) => `  - vout ${output.vout}: ${output.kind}; ${output.sats.toString()} sats; ${output.scriptHex}`)
    .join('\n')
  return [
    'Community Parent guarded execution preview',
    'MODE: DRY_RUN',
    `NETWORK: ${plan.network}`,
    `CHRONIK ENDPOINT: ${candidate.chronikEndpoint}`,
    `funding address: ${plan.fundingAddress}`,
    `token destination: ${plan.tokenDestinationAddress}`,
    `baton destination: ${plan.batonDestinationAddress}`,
    `change destination: ${plan.changeAddress}`,
    `canonical metadata hash: ${plan.documentHash}`,
    `documentUri: ${plan.documentUri}`,
    'selected live UTXOs:',
    inputs,
    `SLP type: ${plan.tokenType}`,
    `name: ${plan.tokenName}`,
    `ticker: ${plan.tokenTicker}`,
    `decimals: ${plan.decimals}`,
    `initial quantity: ${plan.initialQuantity.toString()}`,
    `baton vout: ${plan.mintBatonVout}`,
    'outputs:',
    outputs,
    `estimated fee: ${plan.estimatedFeeSats.toString()} sats`,
    `maximum fee: ${candidate.maximumFeeSats.toString()} sats`,
    `change: ${(plan.outputs.find((output) => output.kind === 'xec-change')?.sats ?? 0n).toString()} sats`,
    `PLAN FINGERPRINT: ${candidate.fingerprint}`,
    'NO SIGNING PERFORMED',
    'NO BROADCAST PERFORMED'
  ].join('\n')
}

export const executeCommunityParentGenesis = async (params: {
  readonly config: CommunityParentGenesisConfig
  readonly reader: CommunityParentChronikReader
  readonly gates: CommunityParentExecutionGates
  readonly signer?: CommunityParentSigner
  readonly broadcaster?: CommunityParentBroadcaster
  readonly onPreview?: (preview: string) => void
  readonly onSignedTxCandidate?: (txid: string) => void
}): Promise<CommunityParentExecutionResult> => {
  const previewCandidate = await prepareCommunityParentExecution({
    config: params.config,
    reader: params.reader
  })
  params.onPreview?.(formatCommunityParentExecutionPreview(previewCandidate))
  if (assertExecutionGates(params.gates, previewCandidate.fingerprint) === 'dry-run') {
    return { status: 'dry-run', candidate: previewCandidate }
  }
  if (params.signer === undefined || params.broadcaster === undefined) {
    throw new Error('Signing and broadcasting ports are required only for authorized execution.')
  }

  const candidate = await prepareCommunityParentExecution({
    config: params.config,
    reader: params.reader
  })
  if (
    candidate.fingerprint !== previewCandidate.fingerprint ||
    candidate.fingerprint !== params.gates.CONFIRM_PLAN_SHA256
  ) {
    throw new Error('Live re-plan changed after preview; signing is forbidden.')
  }

  const signerResult = await params.signer.sign(candidate)
  if (!(signerResult instanceof Uint8Array)) {
    throw new Error('Signer returned malformed transaction bytes.')
  }
  const signedBytes = signerResult.slice()
  const signedTx = assertSignedTxMatchesCandidate(signedBytes, candidate)
  const signedTxid = signedTx.txid()
  params.onSignedTxCandidate?.(signedTxid)

  let chronikPreflight: unknown
  try {
    chronikPreflight = await params.reader.validateRawTx(signedBytes.slice())
  } catch {
    throw new Error('Chronik pre-broadcast validation failed closed.')
  }
  assertChronikTxMatchesCandidate(chronikPreflight, candidate, signedTxid)

  let broadcastResponse: unknown
  try {
    broadcastResponse = await params.broadcaster.broadcast(signedBytes.slice())
  } catch {
    return { status: 'broadcast-status-ambiguous', candidate, signedTxid }
  }
  let returnedTxid: unknown
  try {
    returnedTxid = asRecord(broadcastResponse, 'Chronik broadcast response').txid
  } catch {
    return { status: 'broadcast-status-ambiguous', candidate, signedTxid }
  }
  if (returnedTxid !== signedTxid) {
    throw new Error('Chronik returned a txid different from the signed transaction candidate.')
  }

  let observed: unknown
  try {
    observed = await params.reader.tx(signedTxid)
  } catch {
    return {
      status: 'broadcast-accepted-chain-verification-pending',
      candidate,
      signedTxid
    }
  }
  assertChronikTxMatchesCandidate(observed, candidate, signedTxid)
  return { status: 'broadcast-confirmed', candidate, signedTxid }
}
