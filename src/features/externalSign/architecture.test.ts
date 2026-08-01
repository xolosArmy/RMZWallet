import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { UNIVERSAL_STATE_TRANSITIONS } from './core'
import { REGISTERED_PRODUCT_AUTHORIZATION_PROFILES } from './profileRegistry'

const source = (relativePath: string) => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('universal authorization architectural boundaries', () => {
  test('the lifecycle graph contains only explicit transitions', () => {
    expect(UNIVERSAL_STATE_TRANSITIONS).toEqual({
      disabled: ['receiving', 'expired', 'aborted', 'failed'],
      receiving: ['preparing', 'expired', 'aborted', 'failed'],
      preparing: ['reviewReady', 'expired', 'aborted', 'failed'],
      reviewReady: ['approving', 'rejected', 'expired', 'aborted', 'failed'],
      approving: ['revalidating', 'rejected', 'expired', 'aborted', 'failed'],
      revalidating: ['signing', 'rejected', 'expired', 'aborted', 'failed'],
      signing: ['completed', 'failed'],
      completed: [],
      rejected: [],
      expired: [],
      aborted: [],
      failed: []
    })
  })

  test('runtime core has no protocol, wallet, indexer, or transmission dependency', () => {
    const runtime = [
      './adapters.ts',
      './approval.ts',
      './contentHash.ts',
      './contract.ts',
      './core.ts',
      './lock.ts',
      './profileRegistry.ts'
    ].map(source).join('\n')
    expect(runtime).not.toMatch(/Chronik|getChronik|XolosWalletService|ecash-lib/)
    expect(runtime).not.toMatch(/broadcastTx|broadcastTxs|sign-and-broadcast|postMessage/)
    expect(runtime).not.toMatch(/P2PKH|P2SH|\bALP\b|\bSLP\b|\bNFT\b|OP_RETURN/)
  })

  test('production route is statically disabled and exposes no approval handler', () => {
    const app = source('../../App.tsx')
    const route = source('../../routes/ExternalSign.tsx')
    const environment = source('../../../.env.example')
    expect(app).toContain('<Route path="/external-sign" element={<ExternalSignDisabled />} />')
    expect(route).toContain('EXTERNAL_SIGN_DISABLED')
    expect(route).not.toMatch(/onClick|approve|signApprovedContent/)
    expect(environment).toContain('VITE_EXTERNAL_SIGN_P0_ENABLED=false')
    expect(environment).toContain('VITE_EXTERNAL_SIGN_ALLOWED_ORIGINS=\n')
  })

  test('no product authorization profile is registered', () => {
    expect(REGISTERED_PRODUCT_AUTHORIZATION_PROFILES).toEqual([])
  })
})
