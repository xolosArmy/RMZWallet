import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const source = (relativePath: string) => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('external-sign P0 architectural boundaries', () => {
  test('the signer cannot import Chronik or reach broadcast', () => {
    const signer = source('./signOnly.ts')
    expect(signer).not.toMatch(/Chronik|getChronik|broadcastTx|broadcastTxs/)
    expect(signer).toContain('builder.sign()')
  })

  test('the finalizer revalidates and consumes before invoking the signer', () => {
    const session = source('./session.ts')
    const reviewIndex = session.indexOf('await dependencies.reviewAgain()')
    const hashIndex = session.indexOf('await calculateExternalSignContentHash')
    const consumeIndex = session.indexOf('await capability.consume')
    const signerIndex = session.indexOf('return signExternalTransactionOnly')
    expect(reviewIndex).toBeGreaterThan(-1)
    expect(hashIndex).toBeGreaterThan(reviewIndex)
    expect(consumeIndex).toBeGreaterThan(hashIndex)
    expect(signerIndex).toBeGreaterThan(consumeIndex)
  })

  test('the route signs only from the explicit approval handler', () => {
    const route = source('../../routes/ExternalSign.tsx')
    expect(route).not.toContain('signExternalRequest')
    expect(route).toContain("onClick={() => void approveAndSign()}")
    expect(route).not.toMatch(/broadcastTx|broadcastTxs/)
  })

  test('approval capability has no persistence or logging dependency', () => {
    const approval = source('./approval.ts')
    expect(approval).not.toMatch(/sessionStorage|localStorage|indexedDB|console\./)
    expect(approval).toContain("private currentState: ExternalSignApprovalState = 'fresh'")
  })

  test('production configuration is disabled and has an empty allowlist', () => {
    const environment = source('../../../.env.example')
    expect(environment).toContain('VITE_EXTERNAL_SIGN_P0_ENABLED=false')
    expect(environment).toContain('VITE_EXTERNAL_SIGN_ALLOWED_ORIGINS=\n')
  })

  test('external-sign modules do not log raw or signed transaction data', () => {
    for (const file of [
      './approval.ts',
      './contentHash.ts',
      './contract.ts',
      './origin.ts',
      './replayStore.ts',
      './review.ts',
      './session.ts',
      './signOnly.ts'
    ]) {
      expect(source(file)).not.toMatch(/console\.(log|info|warn|error)/)
    }
  })
})
