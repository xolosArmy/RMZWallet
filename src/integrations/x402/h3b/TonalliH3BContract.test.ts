import { describe, expect, test } from 'vitest'
import {
  canonicalizeJson,
  decodeCanonicalBase64Url,
  encodeCanonicalBase64Url,
  parseTonalliH3BRequest,
  type TonalliH3BRequest
} from './TonalliH3BContract'

const NOW = 1_800_000_000
const CHALLENGE = 'AQIDBAUGBwgJCgsMDQ4PEA'

const canonicalRequest = (): TonalliH3BRequest => ({
  type: 'x402ecash-h3b-request',
  version: 1,
  targetGate: 'H3B',
  sourceOrigin: 'https://x402.ecash.mx',
  returnUrl: 'https://x402.ecash.mx/experiments/webmcp/',
  challengeId: CHALLENGE,
  issuedAt: NOW - 10,
  expiresAt: NOW + 240,
  paymentRequired: {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: {
      url: 'https://api.x402.ecash.mx/v1/resource/demo',
      description: 'x402eCash WebMCP Challenge demo resource',
      mimeType: 'application/json',
      serviceName: 'x402eCash'
    },
    accepts: [{
      scheme: 'xec-prepaid-utxo',
      network: 'xec:mainnet',
      amount: '10000',
      asset: 'XEC',
      payTo: 'ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w',
      maxTimeoutSeconds: 60,
      extra: {
        displayAmount: '100 XEC',
        experimental: true,
        gate: 'H2A'
      }
    }],
    extensions: {}
  },
  approval: {
    status: 'payment_approved',
    gate: 'H3A',
    approved: true,
    performed: false
  }
})

const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(canonicalRequest()))
const transport = (request: unknown = canonicalRequest()) => ({
  hash: `#request=${encodeCanonicalBase64Url(request)}`,
  search: '',
  nowSeconds: NOW
})
const expectInvalid = (request: unknown) => {
  expect(() => parseTonalliH3BRequest(transport(request))).toThrow('H3B_REQUEST_INVALID')
}
const encodeBytes = (bytes: readonly number[]) => {
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

describe('Tonalli H3B request contract', () => {
  test('accepts and freezes the canonical short-lived request', () => {
    const request = parseTonalliH3BRequest(transport())

    expect(request).toEqual(canonicalRequest())
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.paymentRequired.accepts[0].extra)).toBe(true)
  })

  test('rejects missing, query, duplicate, unknown and empty request transports', () => {
    expect(() => parseTonalliH3BRequest({ hash: '', search: '', nowSeconds: NOW })).toThrow()
    expect(() => parseTonalliH3BRequest({ hash: '', search: '?request=value', nowSeconds: NOW })).toThrow()
    expect(() => parseTonalliH3BRequest({ hash: '#request=a&request=b', search: '', nowSeconds: NOW })).toThrow()
    expect(() => parseTonalliH3BRequest({ hash: '#request=a&other=b', search: '', nowSeconds: NOW })).toThrow()
    expect(() => parseTonalliH3BRequest({ hash: '#request=', search: '', nowSeconds: NOW })).toThrow()
  })

  test('rejects malformed, padded and non-canonical Base64URL', () => {
    expect(() => parseTonalliH3BRequest({ hash: '#request=abc+', search: '', nowSeconds: NOW })).toThrow()
    expect(() => parseTonalliH3BRequest({ hash: '#request=YWJj=', search: '', nowSeconds: NOW })).toThrow()
    expect(() => decodeCanonicalBase64Url('AR')).toThrow()
  })

  test('rejects an oversized request before decoding it', () => {
    expect(() => parseTonalliH3BRequest({
      hash: `#request=${'A'.repeat(16_388)}`,
      search: '',
      nowSeconds: NOW
    })).toThrow('H3B_REQUEST_INVALID')
  })

  test('rejects invalid UTF-8 and malformed JSON', () => {
    expect(() => parseTonalliH3BRequest({ hash: `#request=${encodeBytes([0xc3, 0x28])}`, search: '', nowSeconds: NOW })).toThrow()
    expect(() => parseTonalliH3BRequest({ hash: `#request=${encodeBytes([...new TextEncoder().encode('{')])}`, search: '', nowSeconds: NOW })).toThrow()
  })

  test.each([
    ['type', 'wrong'],
    ['version', 2],
    ['targetGate', 'H3C'],
    ['sourceOrigin', 'http://localhost'],
    ['returnUrl', 'https://x402.ecash.mx/experiments/webmcp/?next=evil'],
    ['challengeId', 'invalid+challenge'],
    ['challengeId', 'c2hvcnQ'],
    ['issuedAt', 'not-a-number'],
    ['expiresAt', 1.5]
  ])('rejects invalid root field %s', (field, value) => {
    const request = clone()
    request[field] = value
    expectInvalid(request)
  })

  test('rejects expired, future-dated and excessively long-lived requests', () => {
    const expired = clone()
    expired.expiresAt = NOW
    expectInvalid(expired)

    const future = clone()
    future.issuedAt = NOW + 61
    future.expiresAt = NOW + 120
    expectInvalid(future)

    const stale = clone()
    stale.issuedAt = NOW - 301
    stale.expiresAt = NOW + 1
    expectInvalid(stale)

    const longLived = clone()
    longLived.issuedAt = NOW
    longLived.expiresAt = NOW + 301
    expectInvalid(longLived)
  })

  test('rejects missing and invalid H3A approval invariants', () => {
    const missing = clone()
    delete missing.approval
    expectInvalid(missing)

    for (const [field, value] of [
      ['status', 'payment_rejected'],
      ['gate', 'H2A'],
      ['approved', false],
      ['performed', true]
    ] as const) {
      const request = clone()
      ;(request.approval as Record<string, unknown>)[field] = value
      expectInvalid(request)
    }
  })

  test('rejects unknown fields in the closed request contract', () => {
    const request = clone()
    request.unreviewed = true
    expectInvalid(request)
  })

  test.each([
    ['x402Version', 1],
    ['error', 'wrong']
  ])('rejects PaymentRequired %s mismatch', (field, value) => {
    const request = clone()
    ;(request.paymentRequired as Record<string, unknown>)[field] = value
    expectInvalid(request)
  })

  test.each([
    ['url', 'https://example.com'],
    ['description', 'wrong'],
    ['mimeType', 'text/plain'],
    ['serviceName', 'wrong']
  ])('rejects PaymentRequired resource.%s mismatch', (field, value) => {
    const request = clone()
    const paymentRequired = request.paymentRequired as Record<string, unknown>
    ;(paymentRequired.resource as Record<string, unknown>)[field] = value
    expectInvalid(request)
  })

  test('rejects invalid accepts container lengths and types', () => {
    for (const accepts of [{}, [], [canonicalRequest().paymentRequired.accepts[0], canonicalRequest().paymentRequired.accepts[0]]]) {
      const request = clone()
      ;(request.paymentRequired as Record<string, unknown>).accepts = accepts
      expectInvalid(request)
    }
  })

  test.each([
    ['scheme', 'wrong'],
    ['network', 'xec:testnet'],
    ['amount', '100'],
    ['asset', 'BCH'],
    ['payTo', 'ecash:wrong'],
    ['maxTimeoutSeconds', 61]
  ])('rejects PaymentRequired acceptance.%s mismatch', (field, value) => {
    const request = clone()
    const paymentRequired = request.paymentRequired as Record<string, unknown>
    const acceptance = (paymentRequired.accepts as Record<string, unknown>[])[0]
    acceptance[field] = value
    expectInvalid(request)
  })

  test.each([
    ['displayAmount', '101 XEC'],
    ['experimental', false],
    ['gate', 'H2B']
  ])('rejects PaymentRequired acceptance.extra.%s mismatch', (field, value) => {
    const request = clone()
    const paymentRequired = request.paymentRequired as Record<string, unknown>
    const acceptance = (paymentRequired.accepts as Record<string, unknown>[])[0]
    ;(acceptance.extra as Record<string, unknown>)[field] = value
    expectInvalid(request)
  })

  test('rejects non-empty extensions', () => {
    const request = clone()
    ;(request.paymentRequired as Record<string, unknown>).extensions = { nonce: 'not-allowed' }
    expectInvalid(request)
  })
})

describe('H3B canonical JSON', () => {
  test('sorts object keys recursively while preserving array order', () => {
    expect(canonicalizeJson({ z: 1, a: { y: true, b: ['second', 'first'] } }))
      .toBe('{"a":{"b":["second","first"],"y":true},"z":1}')
  })

  test('rejects non-JSON and non-finite values', () => {
    expect(() => canonicalizeJson(undefined)).toThrow('H3B_CANONICAL_JSON_INVALID')
    expect(() => canonicalizeJson({ invalid: Number.NaN })).toThrow('H3B_CANONICAL_JSON_INVALID')
  })
})

export { canonicalRequest, CHALLENGE, NOW }
