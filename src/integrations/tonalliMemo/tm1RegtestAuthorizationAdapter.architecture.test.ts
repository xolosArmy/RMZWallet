import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { REGISTERED_PRODUCT_AUTHORIZATION_PROFILES } from '../../features/externalSign/profileRegistry'
import { TM1_REGTEST_SIGNING_AUTHORIZATION_PROFILE_ID } from './tm1RegtestAuthorizationAdapter'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 regtest authorization adapter architectural boundaries', () => {
  test('the authorization-only profile remains an unregistered integration constant', () => {
    expect(TM1_REGTEST_SIGNING_AUTHORIZATION_PROFILE_ID).toBe(
      'tonalli.tm1-regtest.signing-authorization.v1'
    )
    expect(REGISTERED_PRODUCT_AUTHORIZATION_PROFILES).toEqual([])
    expect(source('../../features/externalSign/profileRegistry.ts'))
      .not.toContain('tm1-regtest.signing-authorization')
  })

  test('imports only generic authorization and pure TM1 contract material', () => {
    const runtime = source('./tm1RegtestAuthorizationAdapter.ts')
    const imports = Array.from(
      runtime.matchAll(/from\s+['"]([^'"]+)['"]/g),
      match => match[1]
    )

    expect(imports).toEqual([
      'ecash-lib',
      '../../features/externalSign/adapters',
      '../../features/externalSign/contentHash',
      '../../features/externalSign/contract',
      '../../features/externalSign/core',
      './tm1Draft02Candidate',
      './tm1RegtestPublicationOrchestrator'
    ])
  })

  test('has no UI, browser persistence, wallet, session, key, signer, or mainnet dependency', () => {
    const runtime = source('./tm1RegtestAuthorizationAdapter.ts')

    expect(runtime).not.toMatch(
      /react|react-router|routes\/|hooks\/|components\/|WalletContext|XolosWalletService/i
    )
    expect(runtime).not.toMatch(
      /localStorage|sessionStorage|WalletConnect|WcWallet|x402|Firma Alpha/i
    )
    expect(runtime).not.toMatch(
      /privateKey|secretKey|mnemonic|\bwif\b|P2PKHSignatory|TxBuilder|signTm1/i
    )
    expect(runtime).not.toMatch(/mainnet|xec-mainnet|ecash:mainnet|chronik\.e\.cash/i)
  })

  test('has no indexer, chain-state, signing, or transmission capability', () => {
    const runtime = source('./tm1RegtestAuthorizationAdapter.ts')

    expect(runtime).not.toMatch(
      /ChronikClient|chronik-client|getChronik|readUtxos|utxoProvider|deliveryTransport/i
    )
    expect(runtime).not.toMatch(
      /broadcastTx|broadcastTxs|signAndBroadcast|signedArtifact|signApprovedContent/i
    )
    expect(runtime).not.toMatch(/from ['"].*services\//)
    expect(runtime).not.toMatch(/new UniversalAuthorizationCore/)
  })

  test('is not mounted in routes, application startup, registry, or CLI harness', () => {
    const symbol = 'Tm1RegtestAuthorizationAdapter'
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

  test('the injected provider receives review material but no authority-bearing port', () => {
    const runtime = source('./tm1RegtestAuthorizationAdapter.ts')
    const providerContract = runtime.slice(
      runtime.indexOf('export type Tm1RegtestAuthorizationDecisionRequest'),
      runtime.indexOf('export type Tm1RegtestAuthorizationRequester')
    )

    expect(providerContract).toContain('operationId: string')
    expect(providerContract).toContain('preparedId: string')
    expect(providerContract).toContain('bindingHash: string')
    expect(providerContract).toContain('review: Tm1RegtestAuthorizationReviewSnapshot')
    expect(providerContract).toContain('expiresAt: number')
    expect(providerContract).toContain('contentHash: UniversalContentHash')
    expect(providerContract).not.toMatch(/signer|wallet|transport|broadcast|private|chronik/i)
  })
})
