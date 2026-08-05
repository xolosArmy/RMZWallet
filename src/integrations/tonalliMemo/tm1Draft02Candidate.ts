export const TM1_DRAFT_02_CANDIDATE_SCHEMA = 'tonalli.tm1-candidate'
export const TM1_DRAFT_02_CANDIDATE_ARTIFACT_VERSION = 1
export const TM1_DRAFT_02_CANDIDATE_ENVIRONMENT = 'deterministic-regtest-fixture'
export const TM1_DRAFT_02_SIGHASH_POLICY = 'ALL_BIP143'
export const TM1_DRAFT_02_AUTHOR_INPUT_INDEX = 0
export const TM1_DRAFT_02_TX_VERSION = 2
export const TM1_DRAFT_02_LOCKTIME = 0
export const TM1_DRAFT_02_SEQUENCE = 0xffffffff

const EFFECTIVE_CONTENT_DOMAIN = 'TONALLI\u0000TM1-DRAFT-02-CANDIDATE\u0000'
const TM1_LOKAD_ID_HEX = '544d4d00'
const TM1_VERSION = 0x01
const TM1_POST_EVENT = 0x01
const UINT32_MAX = 0xffffffff
const UINT64_MAX = 0xffffffffffffffffn

export type Tm1Draft02CandidateErrorCode =
  | 'INVALID_ENVIRONMENT'
  | 'INVALID_TRANSACTION_VERSION'
  | 'INVALID_LOCKTIME'
  | 'INVALID_AUTHOR_INPUT_INDEX'
  | 'INVALID_SIGHASH_POLICY'
  | 'INVALID_DUST_LIMIT'
  | 'INVALID_MAX_FEE'
  | 'INVALID_AUTHOR_SCRIPT'
  | 'INVALID_INPUT_COUNT'
  | 'INVALID_TXID'
  | 'INVALID_OUT_IDX'
  | 'INVALID_SEQUENCE'
  | 'INVALID_INPUT_SATS'
  | 'INVALID_INPUT_SCRIPT'
  | 'TOKENIZED_INPUT'
  | 'DUPLICATE_OUTPOINT'
  | 'AUTHOR_IDENTITY_MISMATCH'
  | 'INVALID_OUTPUT_COUNT'
  | 'INVALID_OUTPUT_SATS'
  | 'INVALID_OUTPUT_SCRIPT'
  | 'INVALID_TM1_OUTPUT'
  | 'INVALID_CHANGE_OUTPUT'
  | 'DUST_CHANGE'
  | 'NEGATIVE_FEE'
  | 'ZERO_FEE'
  | 'FEE_LIMIT_EXCEEDED'
  | 'DUPLICATE_FRESH_OUTPOINT'
  | 'PREVOUT_MISSING'
  | 'PREVOUT_SATS_MISMATCH'
  | 'PREVOUT_SCRIPT_MISMATCH'
  | 'PREVOUT_TOKENIZED'

export class Tm1Draft02CandidateError extends Error {
  readonly code: Tm1Draft02CandidateErrorCode

  constructor(code: Tm1Draft02CandidateErrorCode, message = code) {
    super(message)
    this.name = 'Tm1Draft02CandidateError'
    this.code = code
  }
}

export type CreateTm1Draft02CandidateInput = Readonly<{
  environment: typeof TM1_DRAFT_02_CANDIDATE_ENVIRONMENT
  transactionVersion: number
  locktime: number
  authorInputIndex: number
  authorLockingScriptHex: string
  inputs: readonly Readonly<{
    txid: string
    outIdx: number
    sequence: number
    sats: bigint
    lockingScriptHex: string
    token?: unknown | null
  }>[]
  outputs: readonly Readonly<{
    sats: bigint
    scriptHex: string
  }>[]
  dustSats: bigint
  maxFeeSats: bigint
  sighashPolicy: typeof TM1_DRAFT_02_SIGHASH_POLICY
}>

export type Tm1Draft02Candidate = Readonly<{
  schema: typeof TM1_DRAFT_02_CANDIDATE_SCHEMA
  artifactVersion: typeof TM1_DRAFT_02_CANDIDATE_ARTIFACT_VERSION
  environment: typeof TM1_DRAFT_02_CANDIDATE_ENVIRONMENT
  transactionVersion: number
  locktime: number
  authorInputIndex: typeof TM1_DRAFT_02_AUTHOR_INPUT_INDEX
  authorLockingScriptHex: string
  inputs: readonly Readonly<{
    index: number
    role: 'author' | 'funding'
    txid: string
    outIdx: number
    sequence: number
    sats: bigint
    lockingScriptHex: string
  }>[]
  outputs: readonly [
    Readonly<{
      index: 0
      role: 'tm1_op_return'
      sats: 0n
      scriptHex: string
    }>,
    Readonly<{
      index: 1
      role: 'change'
      sats: bigint
      scriptHex: string
    }>
  ]
  feePolicy: Readonly<{
    feeSats: bigint
    dustSats: bigint
    maxFeeSats: bigint
  }>
  sighashPolicy: typeof TM1_DRAFT_02_SIGHASH_POLICY
}>

export type Tm1Draft02FreshUtxo = Readonly<{
  txid: string
  outIdx: number
  sats: bigint
  lockingScriptHex: string
  token?: unknown | null
}>

export function createTm1Draft02Candidate(
  input: CreateTm1Draft02CandidateInput
): Tm1Draft02Candidate {
  if (input.environment !== TM1_DRAFT_02_CANDIDATE_ENVIRONMENT) {
    throw new Tm1Draft02CandidateError('INVALID_ENVIRONMENT')
  }
  assertUint32(input.transactionVersion, 'INVALID_TRANSACTION_VERSION')
  assertUint32(input.locktime, 'INVALID_LOCKTIME')
  if (input.authorInputIndex !== TM1_DRAFT_02_AUTHOR_INPUT_INDEX) {
    throw new Tm1Draft02CandidateError('INVALID_AUTHOR_INPUT_INDEX')
  }
  if (input.sighashPolicy !== TM1_DRAFT_02_SIGHASH_POLICY) {
    throw new Tm1Draft02CandidateError('INVALID_SIGHASH_POLICY')
  }
  assertPositiveUint64(input.dustSats, 'INVALID_DUST_LIMIT')
  assertPositiveUint64(input.maxFeeSats, 'INVALID_MAX_FEE')

  const authorLockingScriptHex = normalizeP2pkhScript(
    input.authorLockingScriptHex,
    'INVALID_AUTHOR_SCRIPT'
  )

  if (input.inputs.length === 0) {
    throw new Tm1Draft02CandidateError('INVALID_INPUT_COUNT')
  }

  const seenOutpoints = new Set<string>()
  const inputs = input.inputs.map((candidateInput, index) => {
    const txid = normalizeTxid(candidateInput.txid)
    assertUint32(candidateInput.outIdx, 'INVALID_OUT_IDX')
    assertUint32(candidateInput.sequence, 'INVALID_SEQUENCE')
    assertPositiveUint64(candidateInput.sats, 'INVALID_INPUT_SATS')
    if (candidateInput.token != null) {
      throw new Tm1Draft02CandidateError('TOKENIZED_INPUT')
    }
    const lockingScriptHex = normalizeP2pkhScript(
      candidateInput.lockingScriptHex,
      'INVALID_INPUT_SCRIPT'
    )
    const outpoint = `${txid}:${candidateInput.outIdx}`
    if (seenOutpoints.has(outpoint)) {
      throw new Tm1Draft02CandidateError('DUPLICATE_OUTPOINT')
    }
    seenOutpoints.add(outpoint)

    if (index === TM1_DRAFT_02_AUTHOR_INPUT_INDEX && lockingScriptHex !== authorLockingScriptHex) {
      throw new Tm1Draft02CandidateError('AUTHOR_IDENTITY_MISMATCH')
    }

    return Object.freeze({
      index,
      role: index === TM1_DRAFT_02_AUTHOR_INPUT_INDEX ? 'author' as const : 'funding' as const,
      txid,
      outIdx: candidateInput.outIdx,
      sequence: candidateInput.sequence,
      sats: candidateInput.sats,
      lockingScriptHex
    })
  })

  if (input.outputs.length !== 2) {
    throw new Tm1Draft02CandidateError('INVALID_OUTPUT_COUNT')
  }

  const opReturnSats = input.outputs[0].sats
  if (opReturnSats !== 0n) {
    throw new Tm1Draft02CandidateError('INVALID_OUTPUT_SATS')
  }
  const opReturnScriptHex = normalizeHex(input.outputs[0].scriptHex, 'INVALID_OUTPUT_SCRIPT')
  assertTm1PostScript(opReturnScriptHex)

  const changeSats = input.outputs[1].sats
  assertUint64(changeSats, 'INVALID_OUTPUT_SATS')
  const changeScriptHex = normalizeP2pkhScript(input.outputs[1].scriptHex, 'INVALID_OUTPUT_SCRIPT')
  if (changeScriptHex !== authorLockingScriptHex) {
    throw new Tm1Draft02CandidateError('INVALID_CHANGE_OUTPUT')
  }
  if (changeSats > 0n && changeSats < input.dustSats) {
    throw new Tm1Draft02CandidateError('DUST_CHANGE')
  }

  const totalInputSats = inputs.reduce((sum, candidateInput) => sum + candidateInput.sats, 0n)
  const totalOutputSats = changeSats
  const feeSats = totalInputSats - totalOutputSats
  if (feeSats < 0n) {
    throw new Tm1Draft02CandidateError('NEGATIVE_FEE')
  }
  if (feeSats === 0n) {
    throw new Tm1Draft02CandidateError('ZERO_FEE')
  }
  if (feeSats > input.maxFeeSats) {
    throw new Tm1Draft02CandidateError('FEE_LIMIT_EXCEEDED')
  }

  const outputs = Object.freeze([
    Object.freeze({
      index: 0 as const,
      role: 'tm1_op_return' as const,
      sats: 0n as const,
      scriptHex: opReturnScriptHex
    }),
    Object.freeze({
      index: 1 as const,
      role: 'change' as const,
      sats: changeSats,
      scriptHex: changeScriptHex
    })
  ]) as Tm1Draft02Candidate['outputs']

  return Object.freeze({
    schema: TM1_DRAFT_02_CANDIDATE_SCHEMA,
    artifactVersion: TM1_DRAFT_02_CANDIDATE_ARTIFACT_VERSION,
    environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
    transactionVersion: input.transactionVersion,
    locktime: input.locktime,
    authorInputIndex: TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
    authorLockingScriptHex,
    inputs: Object.freeze(inputs),
    outputs,
    feePolicy: Object.freeze({
      feeSats,
      dustSats: input.dustSats,
      maxFeeSats: input.maxFeeSats
    }),
    sighashPolicy: TM1_DRAFT_02_SIGHASH_POLICY
  })
}

export function encodeTm1Draft02CandidateEffectiveContent(
  candidate: Tm1Draft02Candidate
): Uint8Array {
  const writer = new CanonicalWriter()
  writer.writeText(EFFECTIVE_CONTENT_DOMAIN)
  writer.writeText(candidate.schema)
  writer.writeUint8(candidate.artifactVersion)
  writer.writeText(candidate.environment)
  writer.writeUint32(candidate.transactionVersion)
  writer.writeUint32(candidate.locktime)
  writer.writeUint8(candidate.authorInputIndex)
  writer.writeText(candidate.authorLockingScriptHex)
  writer.writeText(candidate.sighashPolicy)
  writer.writeUint64(candidate.feePolicy.dustSats)
  writer.writeUint64(candidate.feePolicy.maxFeeSats)
  writer.writeUint64(candidate.feePolicy.feeSats)

  writer.writeUint32(candidate.inputs.length)
  for (const candidateInput of candidate.inputs) {
    writer.writeUint32(candidateInput.index)
    writer.writeUint8(candidateInput.role === 'author' ? 0 : 1)
    writer.writeBytes(hexToBytes(candidateInput.txid))
    writer.writeUint32(candidateInput.outIdx)
    writer.writeUint32(candidateInput.sequence)
    writer.writeUint64(candidateInput.sats)
    writer.writeBytesWithLength(hexToBytes(candidateInput.lockingScriptHex))
  }

  writer.writeUint32(candidate.outputs.length)
  for (const candidateOutput of candidate.outputs) {
    writer.writeUint32(candidateOutput.index)
    writer.writeUint8(candidateOutput.role === 'tm1_op_return' ? 0 : 1)
    writer.writeUint64(candidateOutput.sats)
    writer.writeBytesWithLength(hexToBytes(candidateOutput.scriptHex))
  }

  return writer.toUint8Array()
}

export function revalidateTm1Draft02Candidate(
  candidate: Tm1Draft02Candidate,
  freshUtxos: readonly Tm1Draft02FreshUtxo[]
): void {
  const freshByOutpoint = new Map<string, Tm1Draft02FreshUtxo>()

  for (const freshUtxo of freshUtxos) {
    const txid = normalizeTxid(freshUtxo.txid)
    assertUint32(freshUtxo.outIdx, 'INVALID_OUT_IDX')
    const outpoint = `${txid}:${freshUtxo.outIdx}`
    if (freshByOutpoint.has(outpoint)) {
      throw new Tm1Draft02CandidateError('DUPLICATE_FRESH_OUTPOINT')
    }
    freshByOutpoint.set(outpoint, freshUtxo)
  }

  for (const candidateInput of candidate.inputs) {
    const outpoint = `${candidateInput.txid}:${candidateInput.outIdx}`
    const freshUtxo = freshByOutpoint.get(outpoint)
    if (!freshUtxo) {
      throw new Tm1Draft02CandidateError('PREVOUT_MISSING')
    }
    if (freshUtxo.token != null) {
      throw new Tm1Draft02CandidateError('PREVOUT_TOKENIZED')
    }
    if (freshUtxo.sats !== candidateInput.sats) {
      throw new Tm1Draft02CandidateError('PREVOUT_SATS_MISMATCH')
    }
    const freshScriptHex = normalizeHex(freshUtxo.lockingScriptHex, 'INVALID_INPUT_SCRIPT')
    if (freshScriptHex !== candidateInput.lockingScriptHex) {
      throw new Tm1Draft02CandidateError('PREVOUT_SCRIPT_MISMATCH')
    }
  }
}

function assertTm1PostScript(scriptHex: string): void {
  const bytes = hexToBytes(scriptHex)
  let offset = 0
  if (bytes[offset] !== 0x6a) throw new Tm1Draft02CandidateError('INVALID_TM1_OUTPUT')
  offset += 1

  const firstPush = readMinimalPush(bytes, offset)
  offset = firstPush.nextOffset
  if (bytesToHex(firstPush.data) !== TM1_LOKAD_ID_HEX) {
    throw new Tm1Draft02CandidateError('INVALID_TM1_OUTPUT')
  }

  const secondPush = readMinimalPush(bytes, offset)
  offset = secondPush.nextOffset
  if (offset !== bytes.length || secondPush.data.length < 3) {
    throw new Tm1Draft02CandidateError('INVALID_TM1_OUTPUT')
  }
  if (
    secondPush.data[0] !== TM1_VERSION ||
    secondPush.data[1] !== TM1_POST_EVENT ||
    secondPush.data[2] !== TM1_DRAFT_02_AUTHOR_INPUT_INDEX
  ) {
    throw new Tm1Draft02CandidateError('INVALID_TM1_OUTPUT')
  }
}

function readMinimalPush(bytes: Uint8Array, offset: number): Readonly<{ data: Uint8Array; nextOffset: number }> {
  const opcode = bytes[offset]
  if (opcode == null) throw new Tm1Draft02CandidateError('INVALID_TM1_OUTPUT')

  let length: number
  let headerBytes: number
  if (opcode <= 75) {
    length = opcode
    headerBytes = 1
  } else if (opcode === 0x4c) {
    const pushedLength = bytes[offset + 1]
    if (pushedLength == null || pushedLength <= 75) {
      throw new Tm1Draft02CandidateError('INVALID_TM1_OUTPUT')
    }
    length = pushedLength
    headerBytes = 2
  } else {
    throw new Tm1Draft02CandidateError('INVALID_TM1_OUTPUT')
  }

  const start = offset + headerBytes
  const end = start + length
  if (end > bytes.length) throw new Tm1Draft02CandidateError('INVALID_TM1_OUTPUT')
  return Object.freeze({ data: bytes.slice(start, end), nextOffset: end })
}

function normalizeTxid(value: string): string {
  const normalized = value.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Tm1Draft02CandidateError('INVALID_TXID')
  }
  return normalized
}

function normalizeP2pkhScript(value: string, code: Tm1Draft02CandidateErrorCode): string {
  const normalized = normalizeHex(value, code)
  if (!/^76a914[0-9a-f]{40}88ac$/.test(normalized)) {
    throw new Tm1Draft02CandidateError(code)
  }
  return normalized
}

function normalizeHex(value: string, code: Tm1Draft02CandidateErrorCode): string {
  const normalized = value.toLowerCase()
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
    throw new Tm1Draft02CandidateError(code)
  }
  return normalized
}

function assertUint32(value: number, code: Tm1Draft02CandidateErrorCode): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Tm1Draft02CandidateError(code)
  }
}

function assertUint64(value: bigint, code: Tm1Draft02CandidateErrorCode): void {
  if (value < 0n || value > UINT64_MAX) {
    throw new Tm1Draft02CandidateError(code)
  }
}

function assertPositiveUint64(value: bigint, code: Tm1Draft02CandidateErrorCode): void {
  assertUint64(value, code)
  if (value === 0n) throw new Tm1Draft02CandidateError(code)
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

class CanonicalWriter {
  private readonly bytes: number[] = []

  writeUint8(value: number): void {
    this.bytes.push(value & 0xff)
  }

  writeUint32(value: number): void {
    assertUint32(value, 'INVALID_OUT_IDX')
    this.bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff
    )
  }

  writeUint64(value: bigint): void {
    assertUint64(value, 'INVALID_INPUT_SATS')
    let remaining = value
    for (let index = 0; index < 8; index += 1) {
      this.bytes.push(Number(remaining & 0xffn))
      remaining >>= 8n
    }
  }

  writeText(value: string): void {
    this.writeBytesWithLength(new TextEncoder().encode(value))
  }

  writeBytes(value: Uint8Array): void {
    this.bytes.push(...value)
  }

  writeBytesWithLength(value: Uint8Array): void {
    this.writeUint32(value.length)
    this.writeBytes(value)
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}
