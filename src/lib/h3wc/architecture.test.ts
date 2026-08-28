import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { createH3wcSigningDisabledResponse } from './transport'

const source = (name: string) => readFileSync(
  fileURLToPath(new URL(`./${name}`, import.meta.url)),
  'utf8'
)

describe('H3WC pre-crypto and flag boundaries', () => {
  test('transport never reaches a signing or payment primitive', () => {
    const runtime = source('transport.ts')
    expect(runtime).not.toMatch(/signMsg|getSignatory|withPrivateKey|signAndBroadcast|PAYMENT-SIGNATURE|Chronik|broadcast/i)
    expect(runtime).toContain('H3WC_SIGNING_NOT_ENABLED')
    expect(runtime).toContain('@xolosarmy/h3wc-walletkit')
    expect(runtime).toContain('@xolosarmy/h3wc-core')
  })

  test('ownership has no alternate election primitive', () => {
    const runtime = source('ownership.ts')
    expect(runtime).not.toMatch(/localStorage|sessionStorage|heartbeat|timestamp takeover|BroadcastChannel/i)
    expect(runtime).toContain('H3WC_OWNER_LOCK_NAME')
    expect(runtime).toContain('tonalli:wc:request:')
  })

  test('journal is separate and non-secret', () => {
    const runtime = source('journal.ts')
    expect(runtime).toContain('H3WC_JOURNAL_DATABASE')
    expect(runtime).not.toMatch(/mnemonic|privateKey|WIF|seed|password|decrypted|signature|proof/i)
    expect(runtime).not.toContain('indexedDB.deleteDatabase')
  })

  test('startup is dynamically loaded only behind the hard flag', () => {
    const runtime = source('../../main.tsx')
    expect(runtime).toContain("import('./lib/h3wc/bootstrap')")
    expect(runtime).toContain('VITE_X402_H3WC_ENABLED')
    expect(runtime).not.toContain('VITE_WALLETCONNECT_PROJECT_ID')
    expect(runtime).not.toContain('VITE_WC_PROJECT_ID')
    const env = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8')
    expect(env).toContain('VITE_X402_H3WC_ENABLED=false')
    expect(env).toContain('VITE_X402_H3WC_PROJECT_ID=""')
  })

  test('signing boundary is an explicit error and never a fabricated result', () => {
    const response = createH3wcSigningDisabledResponse(42)
    expect(response).toEqual({
      id: 42,
      jsonrpc: '2.0',
      error: { code: -32098, message: 'H3WC_SIGNING_NOT_ENABLED' }
    })
    expect(response).not.toHaveProperty('result')
  })
})
