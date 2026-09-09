import { parseWalletApprovalRequestV1 } from '@xolosarmy/tonalli-core'
import { describe, expect, test } from 'vitest'
import {
  AGENT_WALLET_HANDOFF_B0,
  AGENT_WALLET_HANDOFF_B0_HEX,
  AGENT_WALLET_HANDOFF_B1,
  AGENT_WALLET_HANDOFF_B2,
  AGENT_WALLET_HANDOFF_B3,
  AGENT_WALLET_HANDOFF_B4
} from './__fixtures__/agentWalletHandoffV1.golden'
import {
  AgentWalletHandoffCodecError,
  type AgentWalletHandoffCodecErrorCode,
  decodeAgentWalletHandoffV1,
  encodeAgentWalletHandoffV1
} from './index'

const fromHex = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
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

const withPolicyVersion = (policyVersion: unknown): unknown => ({
  ...AGENT_WALLET_HANDOFF_B0,
  policyDecision: {
    ...AGENT_WALLET_HANDOFF_B0.policyDecision,
    policyVersion
  }
})

describe('Agent Wallet Handoff v1 policyVersion UTF-8 encoding and security', () => {
  test('preserves backwards compatibility with all certified ASCII golden vectors', () => {
    for (const fixture of [
      AGENT_WALLET_HANDOFF_B0,
      AGENT_WALLET_HANDOFF_B1,
      AGENT_WALLET_HANDOFF_B2,
      AGENT_WALLET_HANDOFF_B3,
      AGENT_WALLET_HANDOFF_B4
    ]) {
      const parsed = parseWalletApprovalRequestV1(fixture)
      const encoded = encodeAgentWalletHandoffV1(parsed)
      const decoded = decodeAgentWalletHandoffV1(encoded)
      expect(decoded).toEqual(parsed)
      expect(encodeAgentWalletHandoffV1(decoded)).toEqual(encoded)
    }
  })

  test('encodes and decodes multibyte Unicode policyVersion including "constitución-2026"', () => {
    const candidate = withPolicyVersion('constitución-2026')
    const parsed = parseWalletApprovalRequestV1(candidate)
    const encoded = encodeAgentWalletHandoffV1(parsed)

    // Verify wire contains length prefix 18 (0x00000012) followed by 18 UTF-8 bytes
    // 'constitución-2026' is 17 code units / characters, but 18 UTF-8 bytes because 'ó' is 0xc3 0xb3
    const utf8Bytes = new TextEncoder().encode('constitución-2026')
    expect(utf8Bytes.length).toBe(18)
    expect('constitución-2026'.length).toBe(17)

    const expectedLp = new Uint8Array(4 + 18)
    new DataView(expectedLp.buffer).setUint32(0, 18, false)
    expectedLp.set(utf8Bytes, 4)
    findUnique(encoded, expectedLp)

    const decoded = decodeAgentWalletHandoffV1(encoded)
    expect(decoded.policyDecision.policyVersion).toBe('constitución-2026')
    expect(decoded).toEqual(parsed)

    // Strict canonical re-encoding roundtrip
    expect(encodeAgentWalletHandoffV1(decoded)).toEqual(encoded)
  })

  test('distinguishes byte length from code point count for diverse Unicode values', () => {
    const vectors = [
      { version: 'constitución-2026', chars: 17, bytes: 18 },
      { version: 'política-🛡️-v1', chars: 15, bytes: 20 },
      { version: '日本語ポリシー-2026', chars: 12, bytes: 26 },
      { version: 'café-ñ-ü-2026', chars: 13, bytes: 16 }
    ]

    for (const { version, chars, bytes } of vectors) {
      expect(version.length).toBe(chars)
      const encodedText = new TextEncoder().encode(version)
      expect(encodedText.length).toBe(bytes)

      const candidate = withPolicyVersion(version)
      const parsed = parseWalletApprovalRequestV1(candidate)
      const wire = encodeAgentWalletHandoffV1(parsed)
      const decoded = decodeAgentWalletHandoffV1(wire)

      expect(decoded.policyDecision.policyVersion).toBe(version)
      expect(encodeAgentWalletHandoffV1(decoded)).toEqual(wire)
    }
  })

  test('validates boundary conditions N-1, N, and rejects N+1 (Core max=64 characters)', () => {
    // N-1 = 63 characters ASCII
    const ascii63 = 'a'.repeat(63)
    const parsed63 = parseWalletApprovalRequestV1(withPolicyVersion(ascii63))
    const wire63 = encodeAgentWalletHandoffV1(parsed63)
    expect(decodeAgentWalletHandoffV1(wire63).policyDecision.policyVersion).toBe(ascii63)

    // N = 64 characters ASCII
    const ascii64 = 'a'.repeat(64)
    const parsed64 = parseWalletApprovalRequestV1(withPolicyVersion(ascii64))
    const wire64 = encodeAgentWalletHandoffV1(parsed64)
    expect(decodeAgentWalletHandoffV1(wire64).policyDecision.policyVersion).toBe(ascii64)

    // N+1 = 65 characters ASCII -> rejected on encode and decode
    const ascii65 = 'a'.repeat(65)
    expect(() => encodeAgentWalletHandoffV1(withPolicyVersion(ascii65))).toThrow(
      AgentWalletHandoffCodecError
    )

    // N-1 = 63 characters multibyte (63 * 2 = 126 bytes)
    const mb63 = 'ñ'.repeat(63)
    expect(mb63.length).toBe(63)
    const parsedMb63 = parseWalletApprovalRequestV1(withPolicyVersion(mb63))
    const wireMb63 = encodeAgentWalletHandoffV1(parsedMb63)
    expect(decodeAgentWalletHandoffV1(wireMb63).policyDecision.policyVersion).toBe(mb63)

    // N = 64 characters multibyte (64 * 2 = 128 bytes)
    const mb64 = 'ñ'.repeat(64)
    expect(mb64.length).toBe(64)
    const parsedMb64 = parseWalletApprovalRequestV1(withPolicyVersion(mb64))
    const wireMb64 = encodeAgentWalletHandoffV1(parsedMb64)
    expect(decodeAgentWalletHandoffV1(wireMb64).policyDecision.policyVersion).toBe(mb64)

    // N+1 = 65 characters multibyte
    const mb65 = 'ñ'.repeat(65)
    expect(() => encodeAgentWalletHandoffV1(withPolicyVersion(mb65))).toThrow(
      AgentWalletHandoffCodecError
    )

    // Lower bound: N=1 character
    const singleChar = 'x'
    const parsed1 = parseWalletApprovalRequestV1(withPolicyVersion(singleChar))
    const wire1 = encodeAgentWalletHandoffV1(parsed1)
    expect(decodeAgentWalletHandoffV1(wire1).policyDecision.policyVersion).toBe(singleChar)
  })

  test('rejects empty string (Core contract specifies min: 1)', () => {
    // Empty string rejected by Core validation on encode
    expect(() => encodeAgentWalletHandoffV1(withPolicyVersion(''))).toThrow(
      AgentWalletHandoffCodecError
    )

    // Crafted wire binary with empty policyVersion (LP = 0x00000000)
    // Replace 'constitution-2026-07' LP (20 bytes) with 0-length LP
    const baseWire = fromHex(AGENT_WALLET_HANDOFF_B0_HEX)
    const policyVersionLp = new Uint8Array(4 + 20)
    new DataView(policyVersionLp.buffer).setUint32(0, 20, false)
    policyVersionLp.set(new TextEncoder().encode('constitution-2026-07'), 4)

    const offset = findUnique(baseWire, policyVersionLp)
    const crafted = new Uint8Array(baseWire.length - 20)
    crafted.set(baseWire.subarray(0, offset))
    // 4 bytes of 0 length prefix
    new DataView(crafted.buffer).setUint32(offset, 0, false)
    crafted.set(baseWire.subarray(offset + 24), offset + 4)

    expectDecodeError(crafted, 'DECODED_VALUE_INVALID')
  })

  test('rejects wire binary with malformed UTF-8 in policyVersion', () => {
    const validWire = encodeAgentWalletHandoffV1(
      parseWalletApprovalRequestV1(withPolicyVersion('constitución-2026'))
    )
    const utf8Bytes = new TextEncoder().encode('constitución-2026')
    const lpNeedle = new Uint8Array(4 + utf8Bytes.length)
    new DataView(lpNeedle.buffer).setUint32(0, utf8Bytes.length, false)
    lpNeedle.set(utf8Bytes, 4)
    const offset = findUnique(validWire, lpNeedle)

    // Corrupt the 'ó' sequence (0xc3 0xb3) by replacing 0xb3 with invalid continuation 0x20
    const malformed = new Uint8Array(validWire)
    const oOffset = offset + 4 + 'constituci'.length
    expect(malformed[oOffset]).toBe(0xc3)
    malformed[oOffset + 1] = 0x20 // not a valid UTF-8 continuation byte
    expectDecodeError(malformed, 'INVALID_UTF8')

    // Corrupt with lone continuation byte 0x80
    const loneContinuation = new Uint8Array(validWire)
    loneContinuation[offset + 4] = 0x80
    expectDecodeError(loneContinuation, 'INVALID_UTF8')

    // Corrupt with invalid byte 0xff
    const invalidByte = new Uint8Array(validWire)
    invalidByte[offset + 4] = 0xff
    expectDecodeError(invalidByte, 'INVALID_UTF8')
  })

  test('rejects wire binary with truncated policyVersion payload or length prefix', () => {
    const validWire = encodeAgentWalletHandoffV1(
      parseWalletApprovalRequestV1(withPolicyVersion('constitución-2026'))
    )
    const utf8Bytes = new TextEncoder().encode('constitución-2026')
    const lpNeedle = new Uint8Array(4 + utf8Bytes.length)
    new DataView(lpNeedle.buffer).setUint32(0, utf8Bytes.length, false)
    lpNeedle.set(utf8Bytes, 4)
    const offset = findUnique(validWire, lpNeedle)

    // Truncate inside the 4-byte length prefix
    expectDecodeError(validWire.slice(0, offset + 2), 'TRUNCATED')

    // Truncate inside the UTF-8 content bytes
    expectDecodeError(validWire.slice(0, offset + 4 + 10), 'INVALID_LENGTH')

    // Declared length greater than available bytes
    const oversizedLength = new Uint8Array(validWire)
    new DataView(oversizedLength.buffer).setUint32(offset, 9999, false)
    expectDecodeError(oversizedLength, 'INVALID_LENGTH')
  })

  test('does not silently normalize or alter Unicode policyVersion', () => {
    // NFC vs NFD: 'constitución' in NFC is '\u0063\u006f\u006e\u0073\u0074\u0069\u0074\u0075\u0063\u0069\u00f3\u006e'
    // in NFD 'o\u0301': '\u0063\u006f\u006e\u0073\u0074\u0069\u0074\u0075\u0063\u0069\u006f\u0301\u006e'
    const nfc = 'constitución-2026'.normalize('NFC')
    const nfd = 'constitución-2026'.normalize('NFD')
    expect(nfc).not.toEqual(nfd)

    const wireNfc = encodeAgentWalletHandoffV1(parseWalletApprovalRequestV1(withPolicyVersion(nfc)))
    const wireNfd = encodeAgentWalletHandoffV1(parseWalletApprovalRequestV1(withPolicyVersion(nfd)))

    // Distinct encodings preserved without silent normalization
    expect(wireNfc).not.toEqual(wireNfd)

    const decodedNfc = decodeAgentWalletHandoffV1(wireNfc)
    const decodedNfd = decodeAgentWalletHandoffV1(wireNfd)

    expect(decodedNfc.policyDecision.policyVersion).toBe(nfc)
    expect(decodedNfd.policyDecision.policyVersion).toBe(nfd)
  })
})
