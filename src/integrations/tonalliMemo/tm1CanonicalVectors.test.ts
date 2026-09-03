import { describe, expect, it } from 'vitest'
import vectors from '@xolosarmy/tonalli-memo-protocol/tm1-test-vectors.json' with { type: 'json' }
import {
  isTm1CandidateScript,
  isTm1ProtocolError,
  parseTm1Output,
  encodeTm1Post,
  TM1_LOKAD_ID_HEX,
  TM1_VERSION,
  TM1_POST_EVENT_TYPE
} from '@xolosarmy/tonalli-memo-protocol'
import {
  validateTm1CanonicalScript,
  Tm1Draft02CandidateError
} from './tm1Draft02Candidate'
import {
  encodeTm1Draft02Post,
  TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES
} from './tm1Draft02'

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/u.test(hex)) {
    throw new Error(`Invalid lowercase even-length hex: ${hex}`)
  }
  const result = new Uint8Array(hex.length / 2)
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return result
}

describe('TM1 canonical wire protocol test vectors (Anti-Drift Gate)', () => {
  it('declares protocol metadata aligning with canonical TM1 Draft 0.2', () => {
    expect(vectors.schemaVersion).toBe(1)
    expect(vectors.protocol).toBe('TM1')
    expect(vectors.specDraft).toBe('0.2')
    expect(vectors.lokadIdHex).toBe(TM1_LOKAD_ID_HEX)
    expect(vectors.valid.length).toBeGreaterThan(0)
    expect(vectors.invalid.length).toBeGreaterThan(0)
  })

  describe('valid vectors byte-for-byte conformance', () => {
    for (const vector of vectors.valid) {
      it(`encodes and parses valid vector byte-for-byte: ${vector.name}`, () => {
        const script = hexToBytes(vector.scriptHex)

        // Candidacy gate
        expect(isTm1CandidateScript(script)).toBe(true)

        // Structural parser conformance
        const parsed = parseTm1Output({ valueSats: 0n, script })
        expect(parsed.protocol).toBe('TM1')
        expect(parsed.version).toBe(TM1_VERSION)
        expect(parsed.eventType).toBe('POST')
        expect(parsed.eventTypeCode).toBe(TM1_POST_EVENT_TYPE)
        expect(parsed.authorInputIndex).toBe(vector.authorInputIndex)
        expect(parsed.eventData).toBe(vector.eventDataUtf8)
        expect(parsed.eventDataByteLength).toBe(vector.eventDataByteLength)
        expect(parsed.scriptByteLength).toBe(script.length)

        // Canonical encoder produces the exact identical wire script bytes
        const encoded = encodeTm1Post({
          eventData: vector.eventDataUtf8,
          authorInputIndex: vector.authorInputIndex
        })
        expect(encoded.scriptHex).toBe(vector.scriptHex)

        // RMZWallet candidate validation passes
        const validated = validateTm1CanonicalScript(vector.scriptHex, vector.authorInputIndex)
        expect(validated.eventData).toBe(vector.eventDataUtf8)
        expect(validated.authorInputIndex).toBe(vector.authorInputIndex)

        // If within wallet limit (<= 80 bytes), RMZWallet's encodeTm1Draft02Post produces identical scriptHex
        if (vector.eventDataByteLength <= TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES) {
          const walletPreview = encodeTm1Draft02Post({
            eventData: vector.eventDataUtf8,
            authorInputIndex: vector.authorInputIndex
          })
          expect(walletPreview.scriptHex).toBe(vector.scriptHex)
        }
      })
    }
  })

  describe('invalid vectors rejection conformance', () => {
    for (const vector of vectors.invalid) {
      it(`rejects invalid vector with expected protocol error: ${vector.name}`, () => {
        const script = hexToBytes(vector.scriptHex)
        const expectedCode = vector.expected.errorCode

        // Must fail canonical structural parser with the exact expected code
        let caughtError: unknown
        try {
          parseTm1Output({ valueSats: 0n, script })
        } catch (error) {
          caughtError = error
        }

        expect(isTm1ProtocolError(caughtError)).toBe(true)
        if (isTm1ProtocolError(caughtError)) {
          expect(caughtError.code).toBe(expectedCode)
        }

        // RMZWallet candidate validation must reject it
        expect(() => {
          validateTm1CanonicalScript(
            vector.scriptHex,
            (vector as { authorInputIndex?: number }).authorInputIndex ?? 0
          )
        }).toThrow(Tm1Draft02CandidateError)
      })
    }
  })
})
