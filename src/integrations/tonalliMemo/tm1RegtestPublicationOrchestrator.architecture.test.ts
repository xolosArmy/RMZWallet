import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 regtest publication orchestrator architectural boundaries', () => {
  test('has no React, browser persistence, wallet singleton, WalletConnect, or mainnet dependency', () => {
    const runtime = source('./tm1RegtestPublicationOrchestrator.ts')

    expect(runtime).not.toMatch(
      /react|react-router|MemoDraftPreview|XolosWalletService|WalletContext|getChronik|WalletConnect/
    )
    expect(runtime).not.toMatch(/localStorage|sessionStorage|window|document/)
    expect(runtime).not.toMatch(/mainnet|chronik\.e\.cash|chronik\.xolosarmy\.xyz|DEFAULT_CHRONIK_URLS/)
    expect(runtime).not.toMatch(/from ['"].*services\//)
    expect(runtime).not.toMatch(/run-tm1-regtest-e2e/)
  })

  test('depends on typed ports instead of UI, product wallet, or Chronik singletons', () => {
    const runtime = source('./tm1RegtestPublicationOrchestrator.ts')

    expect(runtime).toContain('Tm1RegtestPublicationDependencies')
    expect(runtime).toContain('signingAuthorization: Tm1SigningAuthorizationPort')
    expect(runtime).toContain('broadcastAuthorization: Tm1BroadcastAuthorizationPort')
    expect(runtime).toContain('deliveryTransport: Tm1DeliveryTransportPort')
    expect(runtime).toContain('confirmationObserver: Tm1ConfirmationObserverPort')
    expect(runtime).not.toMatch(/new ChronikClient|new UniversalAuthorizationCore|xolosWalletService/)
  })

  test('is not mounted in application routes, preview UI, authorization registry, or CLI harness runtime', () => {
    const symbol = 'Tm1RegtestPublicationOrchestrator'
    const app = source('../../App.tsx')
    const route = source('../../routes/ExternalSign.tsx')
    const registry = source('../../features/externalSign/profileRegistry.ts')
    const harness = source('../../../scripts/run-tm1-regtest-e2e.ts')

    expect(app).not.toContain(symbol)
    expect(route).not.toContain(symbol)
    expect(registry).not.toContain(symbol)
    expect(harness).not.toContain(symbol)
    expect(app).toContain('<Route path="/external-sign" element={<ExternalSignDisabled />} />')
    expect(route).toContain('EXTERNAL_SIGN_DISABLED')
  })
})
