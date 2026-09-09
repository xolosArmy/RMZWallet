import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AGENT_WALLET_HANDOFF_B0_HEX,
  AGENT_WALLET_HANDOFF_B2_HEX
} from './__fixtures__/agentWalletHandoffV1.golden'
import { MAX_EFFECTIVE_CONTENT_BYTES } from './constants'
import {
  AgentWalletHandoffCodecError,
  type AgentWalletHandoffCodecErrorCode,
  decodeAgentWalletHandoffV1
} from './index'

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

const encodedText = (value: string): Uint8Array => new TextEncoder().encode(value)

const lpUtf8 = (value: string): Uint8Array => {
  const valueBytes = encodedText(value)
  const result = new Uint8Array(4 + valueBytes.length)
  new DataView(result.buffer).setUint32(0, valueBytes.length, false)
  result.set(valueBytes, 4)
  return result
}

const findOccurrences = (bytes: Uint8Array, needle: Uint8Array): number[] => {
  const offsets: number[] = []
  for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    if (needle.every((value, index) => bytes[offset + index] === value)) {
      offsets.push(offset)
    }
  }
  return offsets
}

const findUnique = (bytes: Uint8Array, needle: Uint8Array): number => {
  const offsets = findOccurrences(bytes, needle)
  expect(offsets).toHaveLength(1)
  const offset = offsets[0]
  if (offset === undefined) throw new Error('Expected a unique byte sequence')
  return offset
}

const expectDecodeError = (
  bytes: Uint8Array,
  expectedCode?: AgentWalletHandoffCodecErrorCode
): void => {
  try {
    decodeAgentWalletHandoffV1(bytes)
    throw new Error('Expected decodeAgentWalletHandoffV1 to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(AgentWalletHandoffCodecError)
    if (!(error instanceof AgentWalletHandoffCodecError)) throw error
    if (expectedCode !== undefined) expect(error.code).toBe(expectedCode)
  }
}

afterEach(() => {
  vi.doUnmock('./encoder')
  vi.resetModules()
})

describe('Agent Wallet Handoff v1 hostile binary handling', () => {
  test('rejects bad magic and unsupported versions', () => {
    const badMagic = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    badMagic[0] ^= 0xff
    expectDecodeError(badMagic, 'BAD_MAGIC')

    const badVersion = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    badVersion[30] = 2
    expectDecodeError(badVersion, 'UNSUPPORTED_VERSION')
  })

  test('rejects truncation at structural boundaries and trailing bytes', () => {
    const bytes = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    for (const boundary of [0, 1, 28, 29, 30, 31, 34, 35, 609]) {
      expectDecodeError(bytes.slice(0, boundary))
    }

    const trailing = new Uint8Array(bytes.length + 1)
    trailing.set(bytes)
    expectDecodeError(trailing, 'TRAILING_BYTES')
  })

  test('rejects impossible and oversized LP lengths before slicing', () => {
    const impossible = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    impossible.set([0xff, 0xff, 0xff, 0xff], 31)
    expectDecodeError(impossible, 'INVALID_LENGTH')

    const oversized = fromHex(AGENT_WALLET_HANDOFF_B0_HEX).slice(0, 35)
    new DataView(oversized.buffer).setUint32(31, MAX_EFFECTIVE_CONTENT_BYTES + 1, false)
    expectDecodeError(oversized, 'INVALID_LENGTH')
  })

  test('rejects invalid presence, UTF-8, ASCII, and decimal encodings', () => {
    const invalidPresence = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    const reason = lpUtf8('Controlled security test')
    invalidPresence[findUnique(invalidPresence, reason) + reason.length] = 2
    expectDecodeError(invalidPresence, 'INVALID_PRESENCE_TAG')

    const invalidUtf8 = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    invalidUtf8[findUnique(invalidUtf8, reason) + 4] = 0xc0
    expectDecodeError(invalidUtf8, 'INVALID_UTF8')

    const nonAscii = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    const contractVersionOffsets = findOccurrences(nonAscii, lpUtf8('1.0'))
    expect(contractVersionOffsets).toHaveLength(3)
    const rootContractVersionOffset = contractVersionOffsets[0]
    if (rootContractVersionOffset === undefined) {
      throw new Error('Expected the root contract version')
    }
    nonAscii[rootContractVersionOffset + 4] = 0x80
    expectDecodeError(nonAscii, 'INVALID_ASCII')

    const noncanonicalDecimal = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    noncanonicalDecimal[findUnique(noncanonicalDecimal, lpUtf8('1000')) + 4] = 0x30
    expectDecodeError(noncanonicalDecimal, 'NON_CANONICAL_DECIMAL')
  })

  test('rejects truncated raw hashes and unsafe uint64 values', () => {
    const withX402 = fromHex(AGENT_WALLET_HANDOFF_B2_HEX)
    const invoiceHashOffset = findUnique(withX402, new Uint8Array(32).fill(0xaa))
    expectDecodeError(withX402.slice(0, invoiceHashOffset + 31), 'TRUNCATED')

    const unsafeTimestamp = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    const timestamp = new Uint8Array(8)
    new DataView(timestamp.buffer).setBigUint64(0, 1_800_000_000n, false)
    const timestampOffset = findUnique(unsafeTimestamp, timestamp)
    new DataView(unsafeTimestamp.buffer).setBigUint64(
      timestampOffset,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      false
    )
    expectDecodeError(unsafeTimestamp, 'INVALID_INTEGER')
  })

  test('rejects a fully decoded value that violates the Core contract', () => {
    const bytes = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    const occurrences = findOccurrences(bytes, encodedText('intent-001'))
    expect(occurrences).toHaveLength(2)
    const policyIntentOffset = occurrences[1]
    if (policyIntentOffset === undefined) throw new Error('Expected policy intent binding')
    bytes[policyIntentOffset + 'intent-001'.length - 1] = '2'.charCodeAt(0)
    expectDecodeError(bytes, 'DECODED_VALUE_INVALID')
  })

  test('rejects content larger than the frozen total-size limit', () => {
    expectDecodeError(
      new Uint8Array(MAX_EFFECTIVE_CONTENT_BYTES + 1),
      'CONTENT_TOO_LARGE'
    )
  })

  test('fails closed if strict decoding has no canonical re-encoding', async () => {
    vi.resetModules()
    vi.doMock('./encoder', () => ({
      encodeAgentWalletHandoffV1: (): Uint8Array => new Uint8Array()
    }))
    const decoder = await import('./decoder')

    try {
      decoder.decodeAgentWalletHandoffV1(fromHex(AGENT_WALLET_HANDOFF_B0_HEX))
      throw new Error('Expected noncanonical content to be rejected')
    } catch (error) {
      expect(error).toMatchObject({
        name: 'AgentWalletHandoffCodecError',
        code: 'NON_CANONICAL_CONTENT'
      })
    }
  })
})
