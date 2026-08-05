import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { REGISTERED_PRODUCT_AUTHORIZATION_PROFILES } from '../../features/externalSign/profileRegistry'
import { TM1_DRAFT_02_FIXTURE_AUTHORIZATION_PROFILE_ID } from './tm1Draft02FixtureAuthorizationAdapter'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 Draft 0.2 fixture authorization architectural boundaries', () => {
  test('the fixture profile exists only as an unregistered integration constant', () => {
    expect(TM1_DRAFT_02_FIXTURE_AUTHORIZATION_PROFILE_ID).toBe(
      'tonalli.tm1-draft02.fixture-authorization.v1'
    )
    expect(REGISTERED_PRODUCT_AUTHORIZATION_PROFILES).toEqual([])
    expect(source('../../features/externalSign/profileRegistry.ts'))
      .not.toContain('tm1-draft02.fixture-authorization')
  })

  test('runtime modules have no wallet, key, indexer, transmission, or production dependency', () => {
    const runtime = [
      './tm1Draft02FixtureAuthorizationAdapter.ts',
      './tm1Draft02FixtureSignedTransaction.ts'
    ].map(source).join('\n')

    expect(runtime).not.toMatch(
      /XolosWalletService|getChronik|ChronikClient|chronik-client|WalletConnect|WcWallet/
    )
    expect(runtime).not.toMatch(
      /privateKey|mnemonic|\bwif\b|P2PKHSignatory|TxBuilder|ecash-lib/
    )
    expect(runtime).not.toMatch(
      /broadcastTx|broadcastTxs|signAndBroadcast|mainnet|chronik\.e\.cash/
    )
    expect(runtime).not.toMatch(/from ['"].*services\//)
  })

  test('the integration is not mounted in application routes or externalSign runtime registry', () => {
    const app = source('../../App.tsx')
    const route = source('../../routes/ExternalSign.tsx')
    const registry = source('../../features/externalSign/profileRegistry.ts')

    expect(app).not.toContain('Tm1Draft02FixtureAuthorizationAdapter')
    expect(route).not.toContain('Tm1Draft02FixtureAuthorizationAdapter')
    expect(registry).not.toContain('Tm1Draft02FixtureAuthorizationAdapter')
    expect(app).toContain('<Route path="/external-sign" element={<ExternalSignDisabled />} />')
    expect(route).toContain('EXTERNAL_SIGN_DISABLED')
  })
})
