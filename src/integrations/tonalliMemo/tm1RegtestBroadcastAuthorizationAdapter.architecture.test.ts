import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { REGISTERED_PRODUCT_AUTHORIZATION_PROFILES } from '../../features/externalSign/profileRegistry'
import { TM1_REGTEST_BROADCAST_AUTHORIZATION_PROFILE_ID } from './tm1RegtestBroadcastAuthorizationAdapter'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 regtest broadcast authorization adapter architectural boundaries', () => {
  test('keeps the broadcast-only profile unregistered and separate from signing', () => {
    expect(TM1_REGTEST_BROADCAST_AUTHORIZATION_PROFILE_ID).toBe(
      'tonalli.tm1-regtest.broadcast-authorization.v1'
    )
    expect(REGISTERED_PRODUCT_AUTHORIZATION_PROFILES).toEqual([])
    expect(source('../../features/externalSign/profileRegistry.ts'))
      .not.toContain('tm1-regtest.broadcast-authorization')
  })

  test('imports only generic authorization and the unchanged TM1 port contract', () => {
    const runtime = source('./tm1RegtestBroadcastAuthorizationAdapter.ts')
    const imports = Array.from(
      runtime.matchAll(/from\s+['"]([^'"]+)['"]/g),
      match => match[1]
    )

    expect(imports).toEqual([
      '../../features/externalSign/adapters',
      '../../features/externalSign/contentHash',
      '../../features/externalSign/contract',
      '../../features/externalSign/core',
      './tm1RegtestPublicationOrchestrator'
    ])
  })

  test('has no UI, browser persistence, wallet, session, key, signer, or mainnet dependency', () => {
    const runtime = source('./tm1RegtestBroadcastAuthorizationAdapter.ts')

    expect(runtime).not.toMatch(
      /react|react-router|routes\/|hooks\/|components\/|WalletContext|XolosWalletService/i
    )
    expect(runtime).not.toMatch(
      /localStorage|sessionStorage|WalletConnect|WcWallet|x402|Firma Alpha/i
    )
    expect(runtime).not.toMatch(
      /privateKey|secretKey|mnemonic|\bwif\b|P2PKHSignatory|TxBuilder|signTm1/i
    )
    expect(runtime).not.toMatch(/mainnet|xec-mainnet|ecash:mainnet/i)
  })

  test('has no chain-state, semantic audit, signing, or transmission capability', () => {
    const runtime = source('./tm1RegtestBroadcastAuthorizationAdapter.ts')

    expect(runtime).not.toMatch(
      /ChronikClient|chronik-client|getChronik|readUtxos|utxoProvider|mempool/i
    )
    expect(runtime).not.toMatch(
      /deliveryTransport|broadcastTx|broadcastTxs|signAndBroadcast|signApprovedContent/i
    )
    expect(runtime).not.toMatch(/\bTx\b|TxBuilder|fromHex|sha256d|auditSignedArtifact/)
    expect(runtime).not.toMatch(/from ['"].*services\//)
    expect(runtime).not.toMatch(/new UniversalAuthorizationCore/)
  })

  test('is not mounted in routes, startup, registry, or CLI harness', () => {
    const symbol = 'Tm1RegtestBroadcastAuthorizationAdapter'
    const app = source('../../App.tsx')
    const route = source('../../routes/ExternalSign.tsx')
    const registry = source('../../features/externalSign/profileRegistry.ts')
    const harness = source('../../../scripts/run-tm1-regtest-e2e.ts')

    expect(app).not.toContain(symbol)
    expect(route).not.toContain(symbol)
    expect(registry).not.toContain(symbol)
    expect(harness).not.toContain(symbol)
  })

  test('does not expose signingAuthorizationId or authority-bearing dependencies to provider', () => {
    const runtime = source('./tm1RegtestBroadcastAuthorizationAdapter.ts')
    const providerContract = runtime.slice(
      runtime.indexOf('export type Tm1RegtestBroadcastAuthorizationDecisionRequest'),
      runtime.indexOf('export type Tm1RegtestBroadcastAuthorizationRequester')
    )

    expect(providerContract).toContain('operationId: string')
    expect(providerContract).toContain('signedId: string')
    expect(providerContract).toContain('txid: string')
    expect(providerContract).toContain('signedArtifactHash: string')
    expect(providerContract).toContain('review: Tm1RegtestBroadcastAuthorizationReviewSnapshot')
    expect(providerContract).toContain('expiresAt: number')
    expect(providerContract).toContain('contentHash: UniversalContentHash')
    expect(providerContract).not.toContain('signingAuthorizationId')
    expect(providerContract).not.toMatch(/wallet|transport|broadcastTx|private|chronik|signer/i)
  })

  test('leaves UniversalAuthorizationCore, 6-B orchestrator, and 6-C adapter untouched', () => {
    const runtime = source('./tm1RegtestBroadcastAuthorizationAdapter.ts')

    expect(runtime).toContain('implements Tm1BroadcastAuthorizationPort')
    expect(runtime).toContain('startAuthorization')
    expect(runtime).not.toContain('requestSigningAuthorization(')
  })
})
