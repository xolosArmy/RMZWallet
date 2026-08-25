import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const BASE = 'd1c3472c760cd33b968054e96df965902f05ebe0'
const PHASE_HEAD = 'daabb8b3426421d1e4244a213c1471006a1d2b2f'
const CLOSED_PATHS = [
  'src/features/externalSign/core.ts',
  'src/integrations/tonalliMemo/tm1RegtestPublicationOrchestrator.ts',
  'src/integrations/tonalliMemo/tm1RegtestRuntimeComposition.ts',
  'src/integrations/tonalliMemo/tm1RegtestDualAuthorizationComposition.ts',
  'src/integrations/tonalliMemo/tm1RegtestAuthorizationAdapter.ts',
  'src/integrations/tonalliMemo/tm1RegtestBroadcastAuthorizationAdapter.ts',
  'src/integrations/tonalliMemo/tm1Draft02RegtestP2pkhSigner.ts',
  'src/integrations/tonalliMemo/tm1ChronikRegtestDeliveryTransport.ts'
]
const PRODUCTION_FILES = [
  './tm1PublicationRecoveryModel.ts',
  './tm1PublicationRecoveryStore.ts',
  './tm1PublicationApplicationPort.ts',
  './tm1ChronikRecoveryObserver.ts',
  './tm1DurablePublicationController.ts'
]

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 conservative recovery architectural boundaries', () => {
  test('contains no signer, private material, or signing route', () => {
    const combined = PRODUCTION_FILES.map(source).join('\n')

    expect(combined).not.toMatch(/from ['"].*(P2pkhSigner|SignedTransaction)/i)
    expect(combined).not.toMatch(/signTm1Draft02RegtestCandidate|TM1_REGTEST_FIXTURE_WIF/)
    expect(combined).not.toMatch(/authorizeAndSign\s*\(|\.sign\s*\(/)
  })

  test('contains no transport, submit, broadcast, or rebroadcast route', () => {
    const combined = PRODUCTION_FILES.map(source).join('\n')

    expect(combined).not.toMatch(
      /Tm1ChronikRegtestDeliveryTransport|Tm1InMemoryDeliveryTransport|broadcastTx|rebroadcast/i
    )
    expect(combined).not.toMatch(/\.submit\s*\(|\.broadcast\s*\(/)
  })

  test('depends on a narrow read-only observation source without owning Chronik', () => {
    const observer = source('./tm1ChronikRecoveryObserver.ts')

    expect(observer).toContain('Tm1ChronikTransactionObservationSource')
    expect(observer).toContain('observeTransaction(')
    expect(observer).not.toMatch(/ChronikClient|chronik-client|blockchainInfo\(|broadcastTx/)
  })

  test('does not own the runtime or expose it to the future UI boundary', () => {
    const combined = PRODUCTION_FILES.map(source).join('\n')
    const applicationPort = source('./tm1PublicationApplicationPort.ts')

    expect(combined).not.toContain('createTm1RegtestRuntime(')
    expect(combined).not.toMatch(/Tm1RegtestPublicationOrchestrator/)
    expect(applicationPort).toContain('getPublication(')
    expect(applicationPort).toContain('listRecoverablePublications(')
    expect(applicationPort).toContain('abandonInterruptedPublication(')
    expect(applicationPort).toContain('reconcile(')
    expect(applicationPort).toContain('observeConfirmation(')
    expect(applicationPort).not.toMatch(/approve|authorize|signer|transport|runtime:/i)
  })

  test('has no React, route, wallet, session, browser-store, or mainnet dependency', () => {
    const combined = PRODUCTION_FILES.map(source).join('\n')

    expect(combined).not.toMatch(
      /from ['"].*(react|hooks|routes|components)|WalletContext|XolosWalletService/i
    )
    expect(combined).not.toMatch(
      /WalletConnect|localStorage|sessionStorage|indexedDB|mainnet|Firma Alpha|x402/i
    )
  })

  test('makes dispatch intent and returned acknowledgement specialized store operations', () => {
    const store = source('./tm1PublicationRecoveryStore.ts')
    const controller = source('./tm1DurablePublicationController.ts')
    const applicationPort = source('./tm1PublicationApplicationPort.ts')

    expect(store).toContain('commitDispatchIntent(')
    expect(store).toContain('commitTransportAcknowledgement(')
    expect(store).toContain('must finish durably before the closed runtime')
    expect(store).toContain('already-executed dispatch')
    expect(store).toContain('commitRecoveryTransition')
    expect(controller).not.toContain('.commitDispatchIntent(')
    expect(controller).not.toContain('.commitTransportAcknowledgement(')
    expect(controller).not.toContain('.commitExecutionEvidence(')
    expect(applicationPort).not.toContain('commitTransportAcknowledgement')
  })

  test('requires revision CAS, fencing, and globally unique capability consumption', () => {
    const store = source('./tm1PublicationRecoveryStore.ts')
    const model = source('./tm1PublicationRecoveryModel.ts')

    expect(store).toContain('expectedRevision: number')
    expect(store).toContain('expectedOwnerEpoch: number')
    expect(store).toContain('claimOwnership(')
    expect(store).toContain('DUPLICATE_CAPABILITY_CONSUMPTION')
    expect(model).toContain('consumedCapabilityIds(')
    expect(model).toContain('assertTm1OwnershipTransition(')
  })

  test('keeps the state machine monotonic and outcomeUnknown observation-only', () => {
    const model = source('./tm1PublicationRecoveryModel.ts')

    expect(model).toContain("previous.phase === 'outcomeUnknown'")
    expect(model).toContain("next.phase !== 'outcomeUnknown'")
    expect(model).toContain("next.phase !== 'submittedObserved'")
    expect(model).toContain("next.phase !== 'confirmedObserved'")
    expect(model).not.toMatch(/outcomeUnknown[^}]+next\.phase\s*=\s*['"]preDispatch/s)
  })

  test('keeps all closed Phase 6-B through 6-H authority files byte-for-byte unchanged', () => {
    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const diff = execFileSync('git', ['diff', BASE, '--', ...CLOSED_PATHS], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    })

    expect(diff).toBe('')
  })

  test('does not change package manifests during closed Phase 6-I-A', () => {
    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const diff = execFileSync('git', [
      'diff',
      BASE,
      PHASE_HEAD,
      '--',
      'package.json',
      'package-lock.json'
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    })

    expect(diff).toBe('')
  })

  test('enforces the reviewed Node runtime policy without a direct SQLite dependency', () => {
    const packageJson = JSON.parse(source('../../../../package.json')) as Record<string, unknown>
    const packageLock = JSON.parse(source('../../../../package-lock.json')) as Record<string, unknown>
    const packageLockRoot = (
      packageLock.packages as Record<string, Record<string, unknown>>
    )['']

    expect(packageJson.engines).toEqual({ node: '>=24.18.0 <25' })
    expect((packageJson.scripts as Record<string, unknown>).pretest)
      .toBe('node scripts/assert-supported-node-runtime.mjs')
    expect(packageLockRoot.engines)
      .toEqual({ node: '>=24.18.0 <25' })

    const packageDependencies = {
      ...((packageJson.dependencies ?? {}) as Record<string, unknown>),
      ...((packageJson.devDependencies ?? {}) as Record<string, unknown>)
    }
    const lockDependencies = {
      ...((packageLockRoot.dependencies ?? {}) as Record<string, unknown>),
      ...((packageLockRoot.devDependencies ?? {}) as Record<string, unknown>)
    }
    const directDependencyNames = [
      ...Object.keys(packageDependencies),
      ...Object.keys(lockDependencies)
    ].join('\n')

    expect(directDependencyNames).not.toMatch(
      /(^|\n)(better-sqlite3|sqlite3|sql\.js|@sqlite\.org\/sqlite-wasm)(\n|$)/
    )
  })

  test('preserves the canonical Tonalli Core pin', () => {
    const packageJson = JSON.parse(source('../../../../package.json')) as {
      dependencies: Record<string, string>
    }
    const lock = source('../../../../package-lock.json')

    expect(packageJson.dependencies['@xolosarmy/tonalli-core']).toBe(
      'github:xolosArmy/tonalli-core#cfe4cb1575b22ed258565717c000ac535aa98c67'
    )
    expect(lock).toContain('"version": "0.2.0"')
    expect(lock).toContain('cfe4cb1575b22ed258565717c000ac535aa98c67')
  })

  test('documents the conservative scope without claiming completed durability', () => {
    const documentation = source('../../../../docs/tonalli-memo-tm1-conservative-durable-recovery.md')

    expect(documentation).toContain('Phase 6-I-A')
    expect(documentation).toContain('Conservative Durable Recovery')
    expect(documentation).toContain('ABANDONED')
    expect(documentation).toContain('outcomeUnknown')
    expect(documentation).toContain('observation-only')
    expect(documentation).toContain('No automatic rebroadcast')
    expect(documentation).toContain('does not complete durable crash recovery')
    expect(documentation).toContain('PREPARED/SIGNED hydration is deferred')
  })
})
