import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const runtimeSource = readFileSync(
  fileURLToPath(new URL('./tm1Draft02Candidate.ts', import.meta.url)),
  'utf8'
)

describe('TM1 Draft 0.2 candidate architectural boundary', () => {
  it('has no imports or dependencies on wallet, network, keys, signing or delivery', () => {
    expect(runtimeSource).not.toMatch(/^\s*import\s/m)
    expect(runtimeSource).not.toMatch(/Chronik|getChronik|XolosWalletService|WalletContext|useWallet/)
    expect(runtimeSource).not.toMatch(/privateKey|mnemonic|signatory|P2PKHSignatory|TxBuilder|signTxBuilder/)
    expect(runtimeSource).not.toMatch(/broadcastTx|broadcastTxs|WalletConnect|externalSign|UniversalAuthorization/)
  })

  it('contains no operational mainnet identifier or production endpoint', () => {
    expect(runtimeSource).not.toMatch(/ecash:1|chronik\.e\.cash|chronik\.xolosarmy\.xyz/)
    expect(runtimeSource).not.toMatch(/['"`]mainnet['"`]/)
  })

  it('closes the environment and sighash policy to explicit literals', () => {
    expect(runtimeSource).toContain("TM1_DRAFT_02_CANDIDATE_ENVIRONMENT = 'deterministic-regtest-fixture'")
    expect(runtimeSource).toContain("TM1_DRAFT_02_SIGHASH_POLICY = 'ALL_BIP143'")
    expect(runtimeSource).toContain("authorInputIndex: typeof TM1_DRAFT_02_AUTHOR_INPUT_INDEX")
  })
})
