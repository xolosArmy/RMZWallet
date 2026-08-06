import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 Chronik regtest transport architectural boundaries', () => {
  test('does not reuse wallet Chronik, wallet state, services, or production endpoints', () => {
    const runtime = source('./tm1ChronikRegtestDeliveryTransport.ts')

    expect(runtime).not.toMatch(
      /getChronik|XolosWalletService|WalletContext|WalletConnect|WcWallet|chronik\.e\.cash|chronik\.xolosarmy\.xyz/
    )
    expect(runtime).not.toMatch(/from ['"].*services\//)
    expect(runtime).not.toMatch(/VITE_CHRONIK_URL|CHRONIK_URL|DEFAULT_CHRONIK_URLS/)
    expect(runtime).not.toMatch(/mainnet|ecash:mainnet|signAndBroadcast/)
  })

  test('uses one injected local endpoint with no fallback or ambient configuration', () => {
    const runtime = source('./tm1ChronikRegtestDeliveryTransport.ts')

    expect(runtime).toContain('constructor(endpointUrl: string)')
    expect(runtime).toContain('new ChronikClient([this.endpointUrl])')
    expect(runtime).toContain('LOCAL_CHRONIK_HOSTNAMES')
    expect(runtime).toContain('ENDPOINT_PORT_REQUIRED')
    expect(runtime).toContain('NON_LOCAL_ENDPOINT_FORBIDDEN')
    expect(runtime).not.toMatch(/import\.meta\.env|process\.env|localStorage|sessionStorage/)
  })

  test('is not mounted in routes, application startup, or authorization registry', () => {
    const symbol = 'Tm1ChronikRegtestDeliveryTransport'
    const app = source('../../App.tsx')
    const route = source('../../routes/ExternalSign.tsx')
    const registry = source('../../features/externalSign/profileRegistry.ts')
    const walletChronik = source('../../services/ChronikClient.ts')

    expect(app).not.toContain(symbol)
    expect(route).not.toContain(symbol)
    expect(registry).not.toContain(symbol)
    expect(walletChronik).not.toContain(symbol)
    expect(app).toContain('<Route path="/external-sign" element={<ExternalSignDisabled />} />')
    expect(route).toContain('EXTERNAL_SIGN_DISABLED')
  })
})
