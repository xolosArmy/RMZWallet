import type { UniversalContentHash } from '../../features/externalSign/contentHash'
import {
  TM1_DRAFT_02_AUTHOR_INPUT_INDEX,
  type Tm1Draft02Candidate
} from './tm1Draft02Candidate'

export const TM1_DRAFT_02_FIXTURE_SIGNED_FORMAT =
  'tonalli.tm1-draft02.fixture-attested-transaction.v1'
export const TM1_DRAFT_02_FIXTURE_SIGHASH_BYTE = 0x41

const FIXTURE_ATTESTATION_DOMAIN = new TextEncoder().encode(
  'TONALLI\u0000TM1-DRAFT-02-FIXTURE-ATTESTATION\u0000'
)
const FIXTURE_ATTESTATION_VERSION = 1
const MAX_VECTOR_ITEMS = 1000
const MAX_SCRIPT_BYTES = 10_000
const UINT32_MAX = 0xffffffff
const UINT64_MAX = 0xffffffffffffffffn

export type Tm1Draft02FixtureSignedTransactionErrorCode =
  | 'INVALID_CONTENT_HASH'
  | 'INVALID_FIXTURE_SIGNED_TRANSACTION'
  | 'NON_CANONICAL_FIXTURE_SIGNED_TRANSACTION'
  | 'TRANSACTION_VERSION_MISMATCH'
  | 'LOCKTIME_MISMATCH'
  | 'INPUT_COUNT_MISMATCH'
  | 'INPUT_OUTPOINT_MISMATCH'
  | 'INPUT_SEQUENCE_MISMATCH'
  | 'AUTHOR_INPUT_MISMATCH'
  | 'FIXTURE_ATTESTATION_MISMATCH'
  | 'OUTPUT_COUNT_MISMATCH'
  | 'OUTPUT_SATS_MISMATCH'
  | 'OUTPUT_SCRIPT_MISMATCH'
  | 'TM1_OUTPUT_MISMATCH'
  | 'CHANGE_OUTPUT_MISMATCH'
  | 'FEE_MISMATCH'
  | 'FEE_LIMIT_EXCEEDED'

export class Tm1Draft02FixtureSignedTransactionError extends Error {
  readonly code: Tm1Draft02FixtureSignedTransactionErrorCode

  constructor(code: Tm1Draft02FixtureSignedTransactionErrorCode, message = code) {
    super(message)
    this.name = 'Tm1Draft02FixtureSignedTransactionError'
    this.code = code
  }
}

export type ParsedTm1Draft02FixtureSignedTransaction = Readonly<{
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

export type AuditedTm1Draft02FixtureSignedTransaction = Readonly<{
  transaction: ParsedTm1Draft02FixtureSignedTransaction
  signedTransactionBytes: Uint8Array
  contentHash: UniversalContentHash
  feeSats: bigint
}>

export function createTm1Draft02DeterministicFixtureSignedTransaction(input: Readonly<{
  candidate: Tm1Draft02Candidate
  contentHash: UniversalContentHash
}>): Uint8Array {
  const contentHashBytes = parseContentHash(input.contentHash)
  const writer = new TransactionWriter()
  writer.writeUint32(input.candidate.transactionVersion)
  writer.writeCompactSize(input.candidate.inputs.length)

  for (const candidateInput of input.candidate.inputs) {
    writer.writeBytes(reverseBytes(hexToBytes(candidateInput.txid)))
    writer.writeUint32(candidateInput.outIdx)
    const scriptSig = createFixtureScriptSig(
      candidateInput,
      candidateInput.index,
      contentHashBytes
    )
    writer.writeCompactSize(scriptSig.length)
    writer.writeBytes(scriptSig)
    writer.writeUint32(candidateInput.sequence)
  }

  writer.writeCompactSize(input.candidate.outputs.length)
  for (const output of input.candidate.outputs) {
    writer.writeUint64(output.sats)
    const script = hexToBytes(output.scriptHex)
    writer.writeCompactSize(script.length)
    writer.writeBytes(script)
  }
  writer.writeUint32(input.candidate.locktime)
  return writer.toUint8Array()
}

export function parseTm1Draft02FixtureSignedTransaction(
  bytes: Uint8Array
): ParsedTm1Draft02FixtureSignedTransaction {
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
    const scriptHex = bytesToHex(reader.readBytes(scriptLength))
    return Object.freeze({ index, sats, scriptHex })
  })

  const locktime = reader.readUint32()
  reader.assertFinished()
  const transaction = Object.freeze({
    transactionVersion,
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    locktime
  })
  if (!bytesEqual(serializeParsedTransaction(transaction), bytes)) {
    fail('NON_CANONICAL_FIXTURE_SIGNED_TRANSACTION')
  }
  return transaction
}

export function auditTm1Draft02FixtureSignedTransaction(input: Readonly<{
  candidate: Tm1Draft02Candidate
  contentHash: UniversalContentHash
  signedTransactionBytes: Uint8Array
}>): AuditedTm1Draft02FixtureSignedTransaction {
  const contentHashBytes = parseContentHash(input.contentHash)
  const transaction = parseTm1Draft02FixtureSignedTransaction(input.signedTransactionBytes)

  if (transaction.transactionVersion !== input.candidate.transactionVersion) {
    fail('TRANSACTION_VERSION_MISMATCH')
  }
  if (transaction.locktime !== input.candidate.locktime) fail('LOCKTIME_MISMATCH')
  if (transaction.inputs.length !== input.candidate.inputs.length) {
    fail('INPUT_COUNT_MISMATCH')
  }

  transaction.inputs.forEach((parsedInput, index) => {
    const expectedInput = input.candidate.inputs[index]
    if (
      !expectedInput ||
      parsedInput.txid !== expectedInput.txid ||
      parsedInput.outIdx !== expectedInput.outIdx
    ) fail('INPUT_OUTPOINT_MISMATCH')
    if (parsedInput.sequence !== expectedInput.sequence) fail('INPUT_SEQUENCE_MISMATCH')
    auditFixtureScriptSig(
      hexToBytes(parsedInput.scriptSigHex),
      expectedInput,
      index,
      contentHashBytes
    )
  })

  const parsedAuthor = transaction.inputs[TM1_DRAFT_02_AUTHOR_INPUT_INDEX]
  const expectedAuthor = input.candidate.inputs[TM1_DRAFT_02_AUTHOR_INPUT_INDEX]
  if (
    !parsedAuthor ||
    !expectedAuthor ||
    parsedAuthor.txid !== expectedAuthor.txid ||
    parsedAuthor.outIdx !== expectedAuthor.outIdx
  ) fail('AUTHOR_INPUT_MISMATCH')

  if (transaction.outputs.length !== input.candidate.outputs.length) {
    fail('OUTPUT_COUNT_MISMATCH')
  }
  transaction.outputs.forEach((parsedOutput, index) => {
    const expectedOutput = input.candidate.outputs[index]
    if (!expectedOutput) fail('OUTPUT_COUNT_MISMATCH')
    if (parsedOutput.sats !== expectedOutput.sats) fail('OUTPUT_SATS_MISMATCH')
    if (parsedOutput.scriptHex !== expectedOutput.scriptHex) fail('OUTPUT_SCRIPT_MISMATCH')
  })

  if (transaction.outputs[0]?.scriptHex !== input.candidate.outputs[0].scriptHex) {
    fail('TM1_OUTPUT_MISMATCH')
  }
  if (
    transaction.outputs[1]?.scriptHex !== input.candidate.authorLockingScriptHex ||
    transaction.outputs[1]?.sats !== input.candidate.outputs[1].sats
  ) fail('CHANGE_OUTPUT_MISMATCH')

  const inputSats = input.candidate.inputs.reduce((sum, item) => sum + item.sats, 0n)
  const outputSats = transaction.outputs.reduce((sum, item) => sum + item.sats, 0n)
  const feeSats = inputSats - outputSats
  if (feeSats !== input.candidate.feePolicy.feeSats) fail('FEE_MISMATCH')
  if (feeSats > input.candidate.feePolicy.maxFeeSats) fail('FEE_LIMIT_EXCEEDED')

  const expectedBytes = createTm1Draft02DeterministicFixtureSignedTransaction({
    candidate: input.candidate,
    contentHash: input.contentHash
  })
  if (!bytesEqual(expectedBytes, input.signedTransactionBytes)) {
    fail('NON_CANONICAL_FIXTURE_SIGNED_TRANSACTION')
  }

  return Object.freeze({
    transaction,
    signedTransactionBytes: new Uint8Array(input.signedTransactionBytes),
    contentHash: input.contentHash,
    feeSats
  })
}

function createFixtureScriptSig(
  input: Tm1Draft02Candidate['inputs'][number],
  inputIndex: number,
  contentHashBytes: Uint8Array
): Uint8Array {
  const payload = new ByteWriter()
  payload.writeBytes(FIXTURE_ATTESTATION_DOMAIN)
  payload.writeUint8(FIXTURE_ATTESTATION_VERSION)
  payload.writeUint32(inputIndex)
  payload.writeBytes(contentHashBytes)
  payload.writeBytes(hexToBytes(input.txid))
  payload.writeUint32(input.outIdx)
  payload.writeUint32(input.sequence)
  payload.writeUint64(input.sats)
  const lockingScript = hexToBytes(input.lockingScriptHex)
  payload.writeUint8(lockingScript.length)
  payload.writeBytes(lockingScript)
  payload.writeUint8(TM1_DRAFT_02_FIXTURE_SIGHASH_BYTE)
  return encodeMinimalPush(payload.toUint8Array())
}

function auditFixtureScriptSig(
  scriptSig: Uint8Array,
  expectedInput: Tm1Draft02Candidate['inputs'][number],
  expectedIndex: number,
  expectedContentHashBytes: Uint8Array
): void {
  const payload = decodeSingleMinimalPush(scriptSig)
  const reader = new FixedReader(payload)
  reader.expectBytes(FIXTURE_ATTESTATION_DOMAIN)
  reader.expectUint8(FIXTURE_ATTESTATION_VERSION)
  if (reader.readUint32() !== expectedIndex) fail('FIXTURE_ATTESTATION_MISMATCH')
  if (!bytesEqual(reader.readBytes(32), expectedContentHashBytes)) {
    fail('FIXTURE_ATTESTATION_MISMATCH')
  }
  if (bytesToHex(reader.readBytes(32)) !== expectedInput.txid) {
    fail('FIXTURE_ATTESTATION_MISMATCH')
  }
  if (reader.readUint32() !== expectedInput.outIdx) fail('FIXTURE_ATTESTATION_MISMATCH')
  if (reader.readUint32() !== expectedInput.sequence) fail('FIXTURE_ATTESTATION_MISMATCH')
  if (reader.readUint64() !== expectedInput.sats) fail('FIXTURE_ATTESTATION_MISMATCH')
  const lockingScriptLength = reader.readUint8()
  const lockingScript = reader.readBytes(lockingScriptLength)
  if (bytesToHex(lockingScript) !== expectedInput.lockingScriptHex) {
    fail('FIXTURE_ATTESTATION_MISMATCH')
  }
  reader.expectUint8(TM1_DRAFT_02_FIXTURE_SIGHASH_BYTE)
  reader.assertFinished()
}

function encodeMinimalPush(payload: Uint8Array): Uint8Array {
  if (payload.length <= 75) return new Uint8Array([payload.length, ...payload])
  if (payload.length <= 0xff) return new Uint8Array([0x4c, payload.length, ...payload])
  fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
}

function decodeSingleMinimalPush(script: Uint8Array): Uint8Array {
  if (script.length === 0) fail('FIXTURE_ATTESTATION_MISMATCH')
  const opcode = script[0] as number
  let payloadLength: number
  let payloadOffset: number
  if (opcode <= 75) {
    payloadLength = opcode
    payloadOffset = 1
  } else if (opcode === 0x4c) {
    payloadLength = script[1] as number
    payloadOffset = 2
    if (payloadLength <= 75) fail('FIXTURE_ATTESTATION_MISMATCH')
  } else {
    return fail('FIXTURE_ATTESTATION_MISMATCH')
  }
  if (payloadOffset + payloadLength !== script.length) {
    fail('FIXTURE_ATTESTATION_MISMATCH')
  }
  return script.slice(payloadOffset)
}

function serializeParsedTransaction(
  transaction: ParsedTm1Draft02FixtureSignedTransaction
): Uint8Array {
  const writer = new TransactionWriter()
  writer.writeUint32(transaction.transactionVersion)
  writer.writeCompactSize(transaction.inputs.length)
  for (const input of transaction.inputs) {
    writer.writeBytes(reverseBytes(hexToBytes(input.txid)))
    writer.writeUint32(input.outIdx)
    const scriptSig = hexToBytes(input.scriptSigHex)
    writer.writeCompactSize(scriptSig.length)
    writer.writeBytes(scriptSig)
    writer.writeUint32(input.sequence)
  }
  writer.writeCompactSize(transaction.outputs.length)
  for (const output of transaction.outputs) {
    writer.writeUint64(output.sats)
    const script = hexToBytes(output.scriptHex)
    writer.writeCompactSize(script.length)
    writer.writeBytes(script)
  }
  writer.writeUint32(transaction.locktime)
  return writer.toUint8Array()
}

function parseContentHash(contentHash: UniversalContentHash): Uint8Array {
  const match = /^sha256:([0-9a-f]{64})$/.exec(contentHash)
  if (!match) fail('INVALID_CONTENT_HASH')
  return hexToBytes(match[1])
}

class FixedReader {
  private readonly bytes: Uint8Array
  private offset = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  readUint8(): number {
    return this.readBytes(1)[0] as number
  }

  readUint32(): number {
    const bytes = this.readBytes(4)
    return (((bytes[0] as number) |
      ((bytes[1] as number) << 8) |
      ((bytes[2] as number) << 16) |
      ((bytes[3] as number) << 24)) >>> 0)
  }

  readUint64(): bigint {
    return readUint64Le(this.readBytes(8))
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      fail('FIXTURE_ATTESTATION_MISMATCH')
    }
    const result = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return result
  }

  expectUint8(expected: number): void {
    if (this.readUint8() !== expected) fail('FIXTURE_ATTESTATION_MISMATCH')
  }

  expectBytes(expected: Uint8Array): void {
    if (!bytesEqual(this.readBytes(expected.length), expected)) {
      fail('FIXTURE_ATTESTATION_MISMATCH')
    }
  }

  assertFinished(): void {
    if (this.offset !== this.bytes.length) fail('FIXTURE_ATTESTATION_MISMATCH')
  }
}

class TransactionReader {
  private readonly bytes: Uint8Array
  private offset = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
  }

  readUint32(): number {
    const bytes = this.readBytes(4)
    return (((bytes[0] as number) |
      ((bytes[1] as number) << 8) |
      ((bytes[2] as number) << 16) |
      ((bytes[3] as number) << 24)) >>> 0)
  }

  readUint64(): bigint {
    return readUint64Le(this.readBytes(8))
  }

  readCompactSizeCount(): number {
    const value = this.readCompactSize()
    if (value > BigInt(MAX_VECTOR_ITEMS)) fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
    return Number(value)
  }

  readCompactSizeLength(maximum: number): number {
    const value = this.readCompactSize()
    if (value > BigInt(maximum)) fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
    return Number(value)
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
    }
    const result = this.bytes.slice(this.offset, this.offset + length)
    this.offset += length
    return result
  }

  assertFinished(): void {
    if (this.offset !== this.bytes.length) fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
  }

  private readCompactSize(): bigint {
    const first = this.readBytes(1)[0] as number
    if (first < 0xfd) return BigInt(first)
    if (first === 0xfd) {
      const bytes = this.readBytes(2)
      const value = BigInt((bytes[0] as number) | ((bytes[1] as number) << 8))
      if (value < 0xfdn) fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
      return value
    }
    if (first === 0xfe) {
      const value = BigInt(this.readUint32())
      if (value <= 0xffffn) fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
      return value
    }
    const value = this.readUint64()
    if (value <= 0xffffffffn) fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
    return value
  }
}

class ByteWriter {
  private readonly bytes: number[] = []

  writeUint8(value: number): void {
    this.bytes.push(value & 0xff)
  }

  writeUint32(value: number): void {
    assertUint32(value)
    this.bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff
    )
  }

  writeUint64(value: bigint): void {
    assertUint64(value)
    let remaining = value
    for (let index = 0; index < 8; index += 1) {
      this.bytes.push(Number(remaining & 0xffn))
      remaining >>= 8n
    }
  }

  writeBytes(value: Uint8Array): void {
    this.bytes.push(...value)
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

class TransactionWriter extends ByteWriter {
  writeCompactSize(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
    }
    if (value < 0xfd) this.writeUint8(value)
    else if (value <= 0xffff) {
      this.writeUint8(0xfd)
      this.writeUint8(value)
      this.writeUint8(value >>> 8)
    } else {
      this.writeUint8(0xfe)
      this.writeUint32(value)
    }
  }
}

function assertUint32(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
  }
}

function assertUint64(value: bigint): void {
  if (value < 0n || value > UINT64_MAX) fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
}

function readUint64Le(bytes: Uint8Array): bigint {
  let value = 0n
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index] as number)
  }
  return value
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    fail('INVALID_FIXTURE_SIGNED_TRANSACTION')
  }
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
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
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

function fail(code: Tm1Draft02FixtureSignedTransactionErrorCode): never {
  throw new Tm1Draft02FixtureSignedTransactionError(code)
}
