import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 Draft 0.2 regtest signer architectural boundaries', () => {
  test('has no wallet, indexer, transport, route, registry, or production dependency', () => {
    const runtime = source('./tm1Draft02RegtestP2pkhSigner.ts')

    expect(runtime).not.toMatch(
      /XolosWalletService|getChronik|ChronikClient|chronik-client|WalletConnect|WcWallet|WalletContext/
    )
    expect(runtime).not.toMatch(
      /broadcastTx|broadcastTxs|signAndBroadcast|profileRegistry|chronik\.e\.cash/
    )
    expect(runtime).not.toMatch(/from ['"].*services\//)
    expect(runtime).not.toMatch(/mainnet|xec-mainnet|ecash:mainnet/)
  })

  test('is not mounted in application routes or the externalSign registry', () => {
    const app = source('../../App.tsx')
    const route = source('../../routes/ExternalSign.tsx')
    const registry = source('../../features/externalSign/profileRegistry.ts')

    expect(app).not.toContain('signTm1Draft02RegtestCandidate')
    expect(route).not.toContain('signTm1Draft02RegtestCandidate')
    expect(registry).not.toContain('signTm1Draft02RegtestCandidate')
    expect(app).toContain('<Route path="/external-sign" element={<ExternalSignDisabled />} />')
    expect(route).toContain('EXTERNAL_SIGN_DISABLED')
  })

  test('uses only the public deterministic fixture WIF and real ecash-lib signing primitives', () => {
    const runtime = source('./tm1Draft02RegtestP2pkhSigner.ts')

    expect(runtime).toContain('TM1_REGTEST_FIXTURE_WIF')
    expect(runtime).toContain('P2PKHSignatory')
    expect(runtime).toContain('TxBuilder')
    expect(runtime).toContain('ALL_BIP143')
    expect(runtime).toContain('schnorrVerify')
    expect(runtime).not.toMatch(/mnemonic|seedPhrase|privateKeyHex|wallet\.state|localStorage/)
  })
})
