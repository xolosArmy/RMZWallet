import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 Draft 0.2 in-memory delivery architectural boundaries', () => {
  test('has no wallet, indexer, network, broadcast, route, registry, or production dependency', () => {
    const runtime = source('./tm1RegtestDeliveryTransport.ts')

    expect(runtime).not.toMatch(
      /XolosWalletService|getChronik|ChronikClient|chronik-client|WalletConnect|WcWallet|WalletContext/
    )
    expect(runtime).not.toMatch(
      /broadcastTx|broadcastTxs|signAndBroadcast|fetch\(|axios|WebSocket|XMLHttpRequest/
    )
    expect(runtime).not.toMatch(/from ['"].*services\//)
    expect(runtime).not.toMatch(/chronik\.e\.cash|mainnet|xec-mainnet|ecash:mainnet/)
  })

  test('is not mounted in application routes or externalSign runtime registry', () => {
    const app = source('../../App.tsx')
    const route = source('../../routes/ExternalSign.tsx')
    const registry = source('../../features/externalSign/profileRegistry.ts')

    expect(app).not.toContain('Tm1InMemoryDeliveryTransport')
    expect(route).not.toContain('Tm1InMemoryDeliveryTransport')
    expect(registry).not.toContain('Tm1InMemoryDeliveryTransport')
    expect(app).toContain('<Route path="/external-sign" element={<ExternalSignDisabled />} />')
    expect(route).toContain('EXTERNAL_SIGN_DISABLED')
  })

  test('consumes only the typed signed fixture artifact and performs no signing', () => {
    const runtime = source('./tm1RegtestDeliveryTransport.ts')

    expect(runtime).toContain('type RegtestSignedTransaction')
    expect(runtime).toContain('TM1_REGTEST_SIGNED_TRANSACTION_FORMAT')
    expect(runtime).toContain('TRANSACTION_ID_MISMATCH')
    expect(runtime).toContain('DUPLICATE_SUBMISSION')
    expect(runtime).not.toMatch(/P2PKHSignatory|TxBuilder|derivePubkey|secretKey|privateKey|mnemonic/)
  })
})
