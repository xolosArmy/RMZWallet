import {
  TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
  TM1_DRAFT_02_CANDIDATE_ARTIFACT_VERSION,
  TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
  TM1_DRAFT_02_CANDIDATE_SCHEMA,
  TM1_DRAFT_02_SIGHASH_POLICY,
  createTm1Draft02Candidate,
  encodeTm1Draft02CandidateEffectiveContent,
  type Tm1Draft02Candidate
} from './tm1Draft02Candidate'

const EFFECTIVE_CONTENT_DOMAIN = 'TONALLI\u0000TM1-DRAFT-02-CANDIDATE\u0000'
const UNSIGNED_TRANSACTION_DOMAIN = 'TONALLI\u0000TM1-DRAFT-02-UNSIGNED-TX\u0000'
const MAX_VECTOR_ITEMS = 1000
const MAX_SCRIPT_BYTES = 10_000
const UINT32_MAX = 0xffffffff

export type Tm1Draft02UnsignedTransactionErrorCode =
  | 'INVALID_EFFECTIVE_CONTENT'
  | 'NON_CANONICAL_EFFECTIVE_CONTENT'
  | 'INVALID_UNSIGNED_TRANSACTION'
  | 'NON_CANONICAL_UNSIGNED_TRANSACTION'
  | 'TRANSACTION_VERSION_MISMATCH'
  | 'LOCKTIME_MISMATCH'
  | 'INPUT_COUNT_MISMATCH'
  | 'INPUT_OUTPOINT_MISMATCH'
  | 'INPUT_SEQUENCE_MISMATCH'
  | 'AUTHOR_INPUT_MISMATCH'
  | 'OUTPUT_COUNT_MISMATCH'
  | 'OUTPUT_SATS_MISMATCH'
  | 'OUTPUT_SCRIPT_MISMATCH'
  | 'TM1_OUTPUT_MISMATCH'
  | 'CHANGE_OUTPUT_MISMATCH'
  | 'FEE_MISMATCH'
  | 'FEE_LIMIT_EXCEEDED'

export class Tm1Draft02UnsignedTransactionError extends Error {
  readonly code: Tm1Draft02UnsignedTransactionErrorCode

  constructor(code: Tm1Draft02UnsignedTransactionErrorCode, message = code) {
    super(message)
    this.name = 'Tm1Draft02UnsignedTransactionError'
    this.code = code
  }
}

export type ParsedTm1Draft02UnsignedTransaction = Readonly<{
  transactionVersion: number
  inputs: readonly Readonly<{
    index: number
    txid: string
    outIdx: number
    sequence: number
    scriptSigHex: string
  }>[]
  outputs: readonly Readonly<{
    index: number
    sats: bigint
    scriptHex: string
  }>[]
  locktime: number
}>

export type AuditedTm1Draft02UnsignedTransaction = Readonly<{
  candidate: Tm1Draft02Candidate
  transaction: ParsedTm1Draft02UnsignedTransaction
  unsignedTransactionBytes: Uint8Array
  unsignedTransactionEnvelope: Uint8Array
  feeSats: bigint
}>

export function decodeTm1Draft02CandidateEffectiveContent(
  effectiveContent: Uint8Array
): Tm1Draft02Candidate {
  const reader = new BinaryReader(effectiveContent, 'INVALID_EFFECTIVE_CONTENT')
  reader.expectText(EFFECTIVE_CONTENT_DOMAIN)
  reader.expectText(TM1_DRAFT_02_CANDIDATE_SCHEMA)
  reader.expectUint8(TM1_DRAFT_02_CANDIDATE_ARTIFACT_VERSION)
  reader.expectText(TM1_DRAFT_02_CANDIDATE_ENVIRONMENT)

  const transactionVersion = reader.readUint32()
  const locktime = reader.readUint32()
  const authorInputIndex = reader.readUint8()
  const authorLockingScriptHex = reader.readText()
  const sighashPolicy = reader.readText()
  const dustSats = reader.readUint64()
  const maxFeeSats = reader.readUint64()
  const encodedFeeSats = reader.readUint64()

  const inputCount = reader.readCount()
  const inputs = Array.from({ length: inputCount }, (_, expectedIndex) => {
    const index = reader.readUint32()
    const role = reader.readUint8()
    if (index !== expectedIndex || role !== (expectedIndex === 0 ? 0 : 1)) {
      throw new Tm1Draft02UnsignedTransactionError('INVALID_EFFECTIVE_CONTENT')
    }
    return Object.freeze({
      txid: bytesToHex(reader.readBytes(32)),
      outIdx: reader.readUint32(),
      sequence: reader.readUint32(),
      sats: reader.readUint64(),
      lockingScriptHex: bytesToHex(reader.readBytesWithLength(MAX_SCRIPT_BYTES))
    })
  })

  const outputCount = reader.readCount()
  const outputs = Array.from({ length: outputCount }, (_, expectedIndex) => {
    const index = reader.readUint32()
    const role = reader.readUint8()
    if (index !== expectedIndex || role !== (expectedIndex === 0 ? 0 : 1)) {
      throw new Tm1Draft02UnsignedTransactionError('INVALID_EFFECTIVE_CONTENT')
    }
    return Object.freeze({
      sats: reader.readUint64(),
      scriptHex: bytesToHex(reader.readBytesWithLength(MAX_SCRIPT_BYTES))
    })
  })
  reader.assertFinished()

  let candidate: Tm1Draft02Candidate
  try {
    candidate = createTm1Draft02Candidate({
      environment: TM1_DRAFT_02_CANDIDATE_ENVIRONMENT,
      transactionVersion,
      locktime,
      authorInputIndex,
      authorLockingScriptHex,
      inputs,
      outputs,
      dustSats,
      maxFeeSats,
      sighashPolicy: sighashPolicy as typeof TM1_DRAFT_02_SIGHASH_POLICY
    })
  } catch {
    throw new Tm1Draft02UnsignedTransactionError('INVALID_EFFECTIVE_CONTENT')
  }

  if (candidate.feePolicy.feeSats !== encodedFeeSats) {
    throw new Tm1Draft02UnsignedTransactionError('INVALID_EFFECTIVE_CONTENT')
  }
  if (!bytesEqual(encodeTm1Draft02CandidateEffectiveContent(candidate), effectiveContent)) {
    throw new Tm1Draft02UnsignedTransactionError('NON_CANONICAL_EFFECTIVE_CONTENT')
  }
  return candidate
}

export function serializeTm1Draft02UnsignedTransaction(
  candidate: Tm1Draft02Candidate
): Uint8Array {
  const writer = new TransactionWriter()
  writer.writeUint32(candidate.transactionVersion)
  writer.writeCompactSize(candidate.inputs.length)
  for (const input of candidate.inputs) {
    writer.writeBytes(reverseBytes(hexToBytes(input.txid)))
    writer.writeUint32(input.outIdx)
    writer.writeCompactSize(0)
    writer.writeUint32(input.sequence)
  }
  writer.writeCompactSize(candidate.outputs.length)
  for (const output of candidate.outputs) {
    writer.writeUint64(output.sats)
    const script = hexToBytes(output.scriptHex)
    writer.writeCompactSize(script.length)
    writer.writeBytes(script)
  }
  writer.writeUint32(candidate.locktime)
  return writer.toUint8Array()
}

export function encodeTm1Draft02UnsignedTransactionEnvelope(
  candidate: Tm1Draft02Candidate,
  unsignedTransactionBytes = serializeTm1Draft02UnsignedTransaction(candidate)
): Uint8Array {
  const writer = new CanonicalWriter()
  writer.writeText(UNSIGNED_TRANSACTION_DOMAIN)
  writer.writeBytesWithLength(encodeTm1Draft02CandidateEffectiveContent(candidate))
  writer.writeBytesWithLength(unsignedTransactionBytes)
  return writer.toUint8Array()
}

export function parseTm1Draft02UnsignedTransaction(
  bytes: Uint8Array
): ParsedTm1Draft02UnsignedTransaction {
  const reader = new TransactionReader(bytes)
  const transactionVersion = reader.readUint32()
  const inputCount = reader.readCompactSizeCount()
  const inputs = Array.from({ length: inputCount }, (_, index) => {
    const txid = bytesToHex(reverseBytes(reader.readBytes(32)))
    const outIdx = reader.readUint32()
    const scriptLength = reader.readCompactSizeLength(MAX_SCRIPT_BYTES)
    const scriptSigHex = bytesToHex(reader.readBytes(scriptLength))
    const sequence = reader.readUint32()
    return Object.freeze({ index, txid, outIdx, sequence, scriptSigHex })
  })
  const outputCount = reader.readCompactSizeCount()
  const outputs = Array.from({ length: outputCount }, (_, index) => {
    const sats = reader.readUint64()
    const scriptLength = reader.readCompactSizeLength(MAX_SCRIPT_BYTES)
    return Object.freeze({
      index,
      sats,
      scriptHex: bytesToHex(reader.readBytes(scriptLength))
    })
  })
  const locktime = reader.readUint32()
  reader.assertFinished()

  const parsed = Object.freeze({
    transactionVersion,
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    locktime
  })
  if (!bytesEqual(serializeParsedUnsignedTransaction(parsed), bytes)) {
    throw new Tm1Draft02UnsignedTransactionError('NON_CANONICAL_UNSIGNED_TRANSACTION')
  }
  return parsed
}

export function auditTm1Draft02UnsignedTransaction(input: Readonly<{
  effectiveContent: Uint8Array
  unsignedTransactionBytes: Uint8Array
}>): AuditedTm1Draft02UnsignedTransaction {
  const candidate = decodeTm1Draft02CandidateEffectiveContent(input.effectiveContent)
  const transaction = parseTm1Draft02UnsignedTransaction(input.unsignedTransactionBytes)

  if (transaction.transactionVersion !== candidate.transactionVersion) {
    throw new Tm1Draft02UnsignedTransactionError('TRANSACTION_VERSION_MISMATCH')
  }
  if (transaction.locktime !== candidate.locktime) {
    throw new Tm1Draft02UnsignedTransactionError('LOCKTIME_MISMATCH')
  }
  if (transaction.inputs.length !== candidate.inputs.length) {
    throw new Tm1Draft02UnsignedTransactionError('INPUT_COUNT_MISMATCH')
  }
  transaction.inputs.forEach((parsedInput, index) => {
    const expected = candidate.inputs[index]
    if (!expected || parsedInput.txid !== expected.txid || parsedInput.outIdx !== expected.outIdx) {
      throw new Tm1Draft02UnsignedTransactionError('INPUT_OUTPOINT_MISMATCH')
    }
    if (parsedInput.sequence !== expected.sequence) {
      throw new Tm1Draft02UnsignedTransactionError('INPUT_SEQUENCE_MISMATCH')
    }
    if (parsedInput.scriptSigHex !== '') {
      throw new Tm1Draft02UnsignedTransactionError('INVALID_UNSIGNED_TRANSACTION')
    }
  })
  const author = transaction.inputs[candidate.authorInputIndex]
  const expectedAuthor = candidate.inputs[TM1_DRAFT_02_AUTHOR_INPUT_INDEX]
  if (!author || !expectedAuthor || author.txid !== expectedAuthor.txid || author.outIdx !== expectedAuthor.outIdx) {
    throw new Tm1Draft02UnsignedTransactionError('AUTHOR_INPUT_MISMATCH')
  }

  if (transaction.outputs.length !== candidate.outputs.length) {
    throw new Tm1Draft02UnsignedTransactionError('OUTPUT_COUNT_MISMATCH')
  }
  transaction.outputs.forEach((parsedOutput, index) => {
    const expected = candidate.outputs[index]
    if (!expected) throw new Tm1Draft02UnsignedTransactionError('OUTPUT_COUNT_MISMATCH')
    if (parsedOutput.sats !== expected.sats) {
      throw new Tm1Draft02UnsignedTransactionError('OUTPUT_SATS_MISMATCH')
    }
    if (parsedOutput.scriptHex !== expected.scriptHex) {
      throw new Tm1Draft02UnsignedTransactionError('OUTPUT_SCRIPT_MISMATCH')
    }
  })
  if (transaction.outputs[0]?.scriptHex !== candidate.outputs[0].scriptHex) {
    throw new Tm1Draft02UnsignedTransactionError('TM1_OUTPUT_MISMATCH')
  }
  if (
    transaction.outputs[1]?.scriptHex !== candidate.authorLockingScriptHex ||
    transaction.outputs[1]?.sats !== candidate.outputs[1].sats
  ) {
    throw new Tm1Draft02UnsignedTransactionError('CHANGE_OUTPUT_MISMATCH')
  }

  const inputSats = candidate.inputs.reduce((sum, item) => sum + item.sats, 0n)
  const outputSats = transaction.outputs.reduce((sum, item) => sum + item.sats, 0n)
  const feeSats = inputSats - outputSats
  if (feeSats !== candidate.feePolicy.feeSats) {
    throw new Tm1Draft02UnsignedTransactionError('FEE_MISMATCH')
  }
  if (feeSats > candidate.feePolicy.maxFeeSats) {
    throw new Tm1Draft02UnsignedTransactionError('FEE_LIMIT_EXCEEDED')
  }

  const expectedBytes = serializeTm1Draft02UnsignedTransaction(candidate)
  if (!bytesEqual(expectedBytes, input.unsignedTransactionBytes)) {
    throw new Tm1Draft02UnsignedTransactionError('NON_CANONICAL_UNSIGNED_TRANSACTION')
  }

  return Object.freeze({
    candidate,
    transaction,
    unsignedTransactionBytes: new Uint8Array(input.unsignedTransactionBytes),
    unsignedTransactionEnvelope: encodeTm1Draft02UnsignedTransactionEnvelope(
      candidate,
      input.unsignedTransactionBytes
    ),
    feeSats
  })
}

function serializeParsedUnsignedTransaction(
  parsed: ParsedTm1Draft02UnsignedTransaction
): Uint8Array {
  const writer = new TransactionWriter()
  writer.writeUint32(parsed.transactionVersion)
  writer.writeCompactSize(parsed.inputs.length)
  for (const input of parsed.inputs) {
    writer.writeBytes(reverseBytes(hexToBytes(input.txid)))
    writer.writeUint32(input.outIdx)
    const scriptSig = hexToBytes(input.scriptSigHex)
    writer.writeCompactSize(scriptSig.length)
    writer.writeBytes(scriptSig)
    writer.writeUint32(input.sequence)
  }
  writer.writeCompactSize(parsed.outputs.length)
  for (const output of parsed.outputs) {
    writer.writeUint64(output.sats)
    const script = hexToBytes(output.scriptHex)
    writer.writeCompactSize(script.length)
    writer.writeBytes(script)
  }
  writer.writeUint32(parsed.locktime)
  return writer.toUint8Array()
}

class BinaryReader {
  private offset = 0

  constructor(
    private readonly bytes: Uint8Array,
    private readonly code: Tm1Draft02UnsignedTransactionErrorCode
  ) {}

  readUint8(): number {
    return this.readBytes(1)[0] as number
  }

  readUint32(): number {
    const bytes = this.readBytes(4)
    return (bytes[0] as number) |
      ((bytes[1] as number) << 8) |
      ((bytes[2] as number) << 16) |
      ((bytes[3] as number) << 24) >>> 0
  }

  readUint64(): bigint {
    const bytes = this.readBytes(8)
    let value = 0n
    for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index] as number)
    return value
  }

  readCount(): number {
    const value = this.readUint32()
    if (value > MAX_VECTOR_ITEMS) this.fail()
    return value
  }

  readText(): string {
    const bytes = this.readBytesWithLength(MAX_SCRIPT_BYTES)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return this.fail()
    }
  }

  readBytesWithLength(maximum: number): Uint8Array {
    const length = this.readUint32()
    if (length > maximum) this.fail()
    return this.readBytes(length)
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) this.fail()
    const result = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return result
  }

  expectText(expected: string): void {
    if (this.readText() !== expected) this.fail()
  }

  expectUint8(expected: number): void {
    if (this.readUint8() !== expected) this.fail()
  }

  assertFinished(): void {
    if (this.offset !== this.bytes.length) this.fail()
  }

  private fail(): never {
    throw new Tm1Draft02UnsignedTransactionError(this.code)
  }
}

class TransactionReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  readUint32(): number {
    const bytes = this.readBytes(4)
    return ((bytes[0] as number) |
      ((bytes[1] as number) << 8) |
      ((bytes[2] as number) << 16) |
      ((bytes[3] as number) << 24)) >>> 0
  }

  readUint64(): bigint {
    const bytes = this.readBytes(8)
    let value = 0n
    for (let index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(bytes[index] as number)
    return value
  }

  readCompactSizeCount(): number {
    const value = this.readCompactSize()
    if (value > BigInt(MAX_VECTOR_ITEMS)) this.fail()
    return Number(value)
  }

  readCompactSizeLength(maximum: number): number {
    const value = this.readCompactSize()
    if (value > BigInt(maximum)) this.fail()
    return Number(value)
  }

  readCompactSize(): bigint {
    const first = this.readBytes(1)[0] as number
    if (first < 0xfd) return BigInt(first)
    if (first === 0xfd) {
      const bytes = this.readBytes(2)
      const value = BigInt((bytes[0] as number) | ((bytes[1] as number) << 8))
      if (value < 0xfdn) this.fail()
      return value
    }
    if (first === 0xfe) {
      const value = BigInt(this.readUint32())
      if (value <= 0xffffn) this.fail()
      return value
    }
    const value = this.readUint64()
    if (value <= 0xffffffffn) this.fail()
    return value
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) this.fail()
    const result = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return result
  }

  assertFinished(): void {
    if (this.offset !== this.bytes.length) this.fail()
  }

  private fail(): never {
    throw new Tm1Draft02UnsignedTransactionError('INVALID_UNSIGNED_TRANSACTION')
  }
}

class TransactionWriter {
  private readonly bytes: number[] = []

  writeUint32(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
      throw new Tm1Draft02UnsignedTransactionError('INVALID_UNSIGNED_TRANSACTION')
    }
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
  }

  writeUint64(value: bigint): void {
    if (value < 0n || value > 0xffffffffffffffffn) {
      throw new Tm1Draft02UnsignedTransactionError('INVALID_UNSIGNED_TRANSACTION')
    }
    let remaining = value
    for (let index = 0; index < 8; index += 1) {
      this.bytes.push(Number(remaining & 0xffn))
      remaining >>= 8n
    }
  }

  writeCompactSize(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Tm1Draft02UnsignedTransactionError('INVALID_UNSIGNED_TRANSACTION')
    }
    if (value < 0xfd) this.bytes.push(value)
    else if (value <= 0xffff) this.bytes.push(0xfd, value & 0xff, (value >>> 8) & 0xff)
    else {
      this.bytes.push(0xfe)
      this.writeUint32(value)
    }
  }

  writeBytes(value: Uint8Array): void {
    this.bytes.push(...value)
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

class CanonicalWriter {
  private readonly bytes: number[] = []

  writeText(value: string): void {
    this.writeBytesWithLength(new TextEncoder().encode(value))
  }

  writeBytesWithLength(value: Uint8Array): void {
    const length = value.length
    this.bytes.push(length & 0xff, (length >>> 8) & 0xff, (length >>> 16) & 0xff, (length >>> 24) & 0xff)
    this.bytes.push(...value)
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Tm1Draft02UnsignedTransactionError('INVALID_UNSIGNED_TRANSACTION')
  }
  const result = new Uint8Array(hex.length / 2)
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return result
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function reverseBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(Array.from(bytes).reverse())
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]
  return difference === 0
}
