import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  TM1_REGTEST_BROADCAST_OPERATION_ID_PREFIX,
  TM1_REGTEST_SIGNING_OPERATION_ID_PREFIX
} from './tm1RegtestDualAuthorizationComposition'

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 dual authorization composition architectural boundaries', () => {
  test('uses exactly one core and injects it into both authorization adapters', () => {
    const runtime = source('./tm1RegtestDualAuthorizationComposition.ts')

    expect(runtime.match(/new UniversalAuthorizationCore\(/g)).toHaveLength(1)
    expect(runtime.match(/core: authorizationCore/g)).toHaveLength(2)
    expect(runtime).toContain('new Tm1RegtestAuthorizationAdapter')
    expect(runtime).toContain('new Tm1RegtestBroadcastAuthorizationAdapter')
  })

  test('returns only the two least-authority orchestrator ports', () => {
    const runtime = source('./tm1RegtestDualAuthorizationComposition.ts')
    const returnType = runtime.slice(
      runtime.indexOf('export type Tm1RegtestDualAuthorizationPorts'),
      runtime.indexOf('export type Tm1RegtestDualAuthorizationCompositionErrorCode')
    )
    const finalReturnStart = runtime.lastIndexOf('return Object.freeze({')
    const finalReturnEnd = runtime.indexOf('\n  })', finalReturnStart) + 5
    const finalReturn = runtime.slice(finalReturnStart, finalReturnEnd)

    expect(returnType).toContain('signingAuthorization: Tm1SigningAuthorizationPort')
    expect(returnType).toContain('broadcastAuthorization: Tm1BroadcastAuthorizationPort')
    expect(returnType).not.toMatch(/UniversalAuthorizationCore|ledger|lock|provider/i)
    expect(finalReturn).toContain('signingAuthorization')
    expect(finalReturn).toContain('broadcastAuthorization')
    expect(finalReturn).not.toMatch(/authorizationCore|ledger|lock|createCapabilityId/)
  })

  test('keeps exact valid and distinct operation ID namespaces', () => {
    expect(TM1_REGTEST_SIGNING_OPERATION_ID_PREFIX).toBe(
      'tm1-regtest.signing-authorization:'
    )
    expect(TM1_REGTEST_BROADCAST_OPERATION_ID_PREFIX).toBe(
      'tm1-regtest.broadcast-authorization:'
    )
    expect(TM1_REGTEST_SIGNING_OPERATION_ID_PREFIX)
      .not.toBe(TM1_REGTEST_BROADCAST_OPERATION_ID_PREFIX)
  })

  test('locks provider aliasing and both issued-ID domains at the composition boundary', () => {
    const runtime = source('./tm1RegtestDualAuthorizationComposition.ts')

    expect(runtime).toMatch(
      /signing\.decisionProvider as object ===\s+broadcast\.decisionProvider as object/
    )
    expect(runtime).toContain("'DECISION_PROVIDERS_MUST_BE_DISTINCT'")
    expect(runtime).toContain('const issuedOperationIds = new Set<string>()')
    expect(runtime).toContain('const issuedCapabilityIds = new Set<string>()')
    expect(runtime).toContain("'DUPLICATE_OPERATION_ID'")
    expect(runtime).toContain("'DUPLICATE_CAPABILITY_ID'")
  })

  test('imports only generic authorization and the two closed TM1 adapters and ports', () => {
    const runtime = source('./tm1RegtestDualAuthorizationComposition.ts')
    const imports = Array.from(
      runtime.matchAll(/from\s+['"]([^'"]+)['"]/g),
      match => match[1]
    )

    expect(imports).toEqual([
      '../../features/externalSign/approval',
      '../../features/externalSign/contentHash',
      '../../features/externalSign/core',
      '../../features/externalSign/lock',
      './tm1RegtestAuthorizationAdapter',
      './tm1RegtestBroadcastAuthorizationAdapter',
      './tm1RegtestPublicationOrchestrator'
    ])
  })

  test('has no UI, wallet, session, signing, audit, chain, or transport authority', () => {
    const runtime = source('./tm1RegtestDualAuthorizationComposition.ts')

    expect(runtime).not.toMatch(
      /react|react-router|routes\/|hooks\/|components\/|WalletContext|XolosWalletService/i
    )
    expect(runtime).not.toMatch(
      /localStorage|sessionStorage|WalletConnect|WcWallet|x402|Firma Alpha/i
    )
    expect(runtime).not.toMatch(
      /privateKey|secretKey|mnemonic|\bwif\b|P2PKHSignatory|TxBuilder|signTm1/i
    )
    expect(runtime).not.toMatch(
      /ChronikClient|chronik-client|getChronik|deliveryTransport|broadcastTx|mainnet/i
    )
    expect(runtime).not.toMatch(/auditSignedArtifact|signedArtifactAudit|new Tm1RegtestPublicationOrchestrator/)
  })

  test('is not mounted in routes, startup, registry, or CLI harness', () => {
    const symbol = 'createTm1RegtestDualAuthorizationPorts'

    expect(source('../../App.tsx')).not.toContain(symbol)
    expect(source('../../routes/ExternalSign.tsx')).not.toContain(symbol)
    expect(source('../../features/externalSign/profileRegistry.ts')).not.toContain(symbol)
    expect(source('../../../scripts/run-tm1-regtest-e2e.ts')).not.toContain(symbol)
  })

  test('documents local lock scope and the global capability-ledger contract', () => {
    const runtime = source('./tm1RegtestDualAuthorizationComposition.ts')
    const documentation = source('../../../docs/tonalli-memo-tm1-regtest-dual-authorization-composition.md')

    expect(runtime).toContain('lock must be dedicated to this composition/orchestrator')
    expect(runtime).toContain('capabilityId globally')
    expect(documentation).toContain('composition-local')
    expect(documentation).toMatch(
      /globally across operations,\s+profiles, and publication cycles/
    )
  })
})
