import { MAX_EFFECTIVE_CONTENT_BYTES } from './constants'
import { AgentWalletHandoffCodecError } from './errors'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const CANONICAL_DECIMAL = /^[1-9][0-9]*$/
const CANONICAL_HASH = /^[0-9a-f]{64}$/

const assertSafeUnsignedInteger = (value: number, maximum: number): void => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new AgentWalletHandoffCodecError('INVALID_INTEGER')
  }
}

const validateAscii = (value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) {
      throw new AgentWalletHandoffCodecError('INVALID_ASCII')
    }
  }
}

const validatedUtf8Length = (value: string): number => {
  let byteLength = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x7f) byteLength += 1
    else if (codeUnit <= 0x7ff) byteLength += 2
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) {
        throw new AgentWalletHandoffCodecError('INVALID_UTF8')
      }
      byteLength += 4
      index += 1
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new AgentWalletHandoffCodecError('INVALID_UTF8')
    } else byteLength += 3

    if (byteLength > MAX_EFFECTIVE_CONTENT_BYTES) {
      throw new AgentWalletHandoffCodecError('CONTENT_TOO_LARGE')
    }
  }
  return byteLength
}

const asciiBytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index)
  }
  return bytes
}

export const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index]
  }
  return difference === 0
}

export class AgentWalletHandoffWriter {
  private readonly chunks: Uint8Array[] = []
  private totalLength = 0

  private assertCapacity(additionalLength: number): void {
    assertSafeUnsignedInteger(additionalLength, MAX_EFFECTIVE_CONTENT_BYTES)
    if (additionalLength > MAX_EFFECTIVE_CONTENT_BYTES - this.totalLength) {
      throw new AgentWalletHandoffCodecError('CONTENT_TOO_LARGE')
    }
  }

  private appendValidated(bytes: Uint8Array): void {
    this.assertCapacity(bytes.length)
    this.chunks.push(bytes)
    this.totalLength += bytes.length
  }

  private writeLength(length: number): void {
    assertSafeUnsignedInteger(length, 0xffff_ffff)
    const prefix = new Uint8Array(4)
    new DataView(prefix.buffer).setUint32(0, length, false)
    this.appendValidated(prefix)
  }

  writeFixedAscii(value: string): void {
    validateAscii(value)
    this.assertCapacity(value.length)
    this.appendValidated(asciiBytes(value))
  }

  writeLpAscii(value: string): void {
    validateAscii(value)
    this.assertCapacity(4 + value.length)
    this.writeLength(value.length)
    this.appendValidated(asciiBytes(value))
  }

  writeLpUtf8(value: string): void {
    const byteLength = validatedUtf8Length(value)
    this.assertCapacity(4 + byteLength)
    const bytes = textEncoder.encode(value)
    if (bytes.length !== byteLength) {
      throw new AgentWalletHandoffCodecError('INVALID_UTF8')
    }
    this.writeLength(byteLength)
    this.appendValidated(bytes)
  }

  writeDecimal(value: string): void {
    if (!CANONICAL_DECIMAL.test(value)) {
      throw new AgentWalletHandoffCodecError('NON_CANONICAL_DECIMAL')
    }
    this.writeLpAscii(value)
  }

  writePresence(present: boolean): void {
    this.appendValidated(Uint8Array.of(present ? 1 : 0))
  }

  writeUint16(value: number): void {
    assertSafeUnsignedInteger(value, 0xffff)
    const bytes = new Uint8Array(2)
    new DataView(bytes.buffer).setUint16(0, value, false)
    this.appendValidated(bytes)
  }

  writeUint64(value: number): void {
    assertSafeUnsignedInteger(value, Number.MAX_SAFE_INTEGER)
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false)
    this.appendValidated(bytes)
  }

  writeHash(value: string): void {
    if (!CANONICAL_HASH.test(value)) {
      throw new AgentWalletHandoffCodecError('INVALID_ASCII')
    }
    this.assertCapacity(32)
    const bytes = new Uint8Array(32)
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
    }
    this.appendValidated(bytes)
  }

  finish(): Uint8Array {
    const result = new Uint8Array(this.totalLength)
    let offset = 0
    for (const chunk of this.chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    return result
  }
}

export class AgentWalletHandoffReader {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private offset = 0

  constructor(bytes: Uint8Array) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  private remaining(): number {
    return this.bytes.length - this.offset
  }

  private readFixedBytes(length: number): Uint8Array {
    assertSafeUnsignedInteger(length, MAX_EFFECTIVE_CONTENT_BYTES)
    if (length > this.remaining()) {
      throw new AgentWalletHandoffCodecError('TRUNCATED')
    }
    const start = this.offset
    this.offset += length
    return this.bytes.slice(start, this.offset)
  }

  private readLpBytes(): Uint8Array {
    const length = this.readUint32()
    if (length > MAX_EFFECTIVE_CONTENT_BYTES || length > this.remaining()) {
      throw new AgentWalletHandoffCodecError('INVALID_LENGTH')
    }
    const start = this.offset
    this.offset += length
    return this.bytes.slice(start, this.offset)
  }

  readAndMatchMagic(expected: string): void {
    validateAscii(expected)
    const actual = this.readFixedBytes(expected.length)
    if (!equalBytes(actual, asciiBytes(expected))) {
      throw new AgentWalletHandoffCodecError('BAD_MAGIC')
    }
  }

  readUint16(): number {
    if (2 > this.remaining()) throw new AgentWalletHandoffCodecError('TRUNCATED')
    const value = this.view.getUint16(this.offset, false)
    this.offset += 2
    return value
  }

  private readUint32(): number {
    if (4 > this.remaining()) throw new AgentWalletHandoffCodecError('TRUNCATED')
    const value = this.view.getUint32(this.offset, false)
    this.offset += 4
    return value
  }

  readUint64(): number {
    if (8 > this.remaining()) throw new AgentWalletHandoffCodecError('TRUNCATED')
    const value = this.view.getBigUint64(this.offset, false)
    this.offset += 8
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new AgentWalletHandoffCodecError('INVALID_INTEGER')
    }
    return Number(value)
  }

  readLpAscii(): string {
    const bytes = this.readLpBytes()
    let value = ''
    for (const byte of bytes) {
      if (byte > 0x7f) throw new AgentWalletHandoffCodecError('INVALID_ASCII')
      value += String.fromCharCode(byte)
    }
    return value
  }

  readLpUtf8(): string {
    const bytes = this.readLpBytes()
    let value: string
    try {
      value = textDecoder.decode(bytes)
    } catch (cause) {
      throw new AgentWalletHandoffCodecError('INVALID_UTF8', cause)
    }
    if (!equalBytes(textEncoder.encode(value), bytes)) {
      throw new AgentWalletHandoffCodecError('INVALID_UTF8')
    }
    return value
  }

  readDecimal(): string {
    const value = this.readLpAscii()
    if (!CANONICAL_DECIMAL.test(value)) {
      throw new AgentWalletHandoffCodecError('NON_CANONICAL_DECIMAL')
    }
    return value
  }

  readPresence(): boolean {
    const value = this.readFixedBytes(1)[0]
    if (value === 0) return false
    if (value === 1) return true
    throw new AgentWalletHandoffCodecError('INVALID_PRESENCE_TAG')
  }

  readHash(): string {
    const bytes = this.readFixedBytes(32)
    let value = ''
    for (const byte of bytes) value += byte.toString(16).padStart(2, '0')
    return value
  }

  assertEof(): void {
    if (this.remaining() !== 0) {
      throw new AgentWalletHandoffCodecError('TRAILING_BYTES')
    }
  }
}
