import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const runtime = readFileSync(
  fileURLToPath(new URL('./tm1Draft02UnsignedTransaction.ts', import.meta.url)),
  'utf8'
)

describe('TM1 unsigned deterministic fixture architectural boundary', () => {
  it('depends only on the pure TM1 candidate module', () => {
    const imports = Array.from(runtime.matchAll(/from\s+['"]([^'"]+)['"]/g), match => match[1])
    expect(imports).toEqual(['./tm1Draft02Candidate'])
  })

  it('has no wallet, network, key, authorization, signing, or transmission dependency', () => {
    expect(runtime).not.toMatch(/Chronik|getChronik|XolosWalletService|WalletContext|useWallet/)
    expect(runtime).not.toMatch(/mnemonic|privateKey|signatory|P2PKHSignatory|TxBuilder|ecash-lib/i)
    expect(runtime).not.toMatch(/externalSign|UniversalAuthorization|profileRegistry|approval/i)
    expect(runtime).not.toMatch(/WalletConnect|WcWallet|broadcastTx|broadcastTxs|postMessage/i)
  })

  it('contains no operational mainnet or production identifier', () => {
    expect(runtime).not.toMatch(/mainnet|production|ecash:1|chronik\.e\.cash/i)
  })
})
