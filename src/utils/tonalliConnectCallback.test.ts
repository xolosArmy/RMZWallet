import { describe, expect, test } from 'vitest'
import { parseTonalliConnectCallback } from './tonalliConnectCallback'

describe('Tonalli Connect callback validation', () => {
  test('accepts matching HTTPS callback origins', () => {
    const parsed = parseTonalliConnectCallback(
      'https://gateway.ecash.mx/tonalli-callback',
      'https://gateway.ecash.mx'
    )
    expect(parsed.toString()).toBe('https://gateway.ecash.mx/tonalli-callback')
  })

  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://gateway.ecash.mx/1234',
    'file:///tmp/callback'
  ])('rejects script-capable or opaque callbacks: %s', (callback) => {
    expect(() => parseTonalliConnectCallback(callback, 'null')).toThrow()
  })

  test('rejects HTTP outside explicit loopback development', () => {
    expect(() =>
      parseTonalliConnectCallback('http://example.com/cb', 'http://example.com')
    ).toThrow('UNSAFE_CALLBACK_PROTOCOL')
  })

  test('permits HTTP loopback only when explicitly enabled', () => {
    expect(
      parseTonalliConnectCallback('http://127.0.0.1:4173/cb', 'http://127.0.0.1:4173', true).origin
    ).toBe('http://127.0.0.1:4173')
  })

  test('rejects credentials and origin mismatches', () => {
    expect(() =>
      parseTonalliConnectCallback('https://user:pass@example.com/cb', 'https://example.com')
    ).toThrow('CREDENTIALS_NOT_ALLOWED')
    expect(() =>
      parseTonalliConnectCallback('https://evil.example/cb', 'https://gateway.ecash.mx')
    ).toThrow('CALLBACK_ORIGIN_MISMATCH')
  })

  test('rejects non-origin values in the origin parameter', () => {
    expect(() =>
      parseTonalliConnectCallback('https://gateway.ecash.mx/cb', 'https://gateway.ecash.mx/path')
    ).toThrow('INVALID_EXPECTED_ORIGIN')
  })
})
