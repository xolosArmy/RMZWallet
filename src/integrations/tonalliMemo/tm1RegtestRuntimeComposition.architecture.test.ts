import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const BASE = '6bea5199e6d824258c03ab6b626587f5a79ecbd1'
const CLOSED_PATHS = [
  'src/features/externalSign/core.ts',
  'src/integrations/tonalliMemo/tm1RegtestPublicationOrchestrator.ts',
  'src/integrations/tonalliMemo/tm1RegtestAuthorizationAdapter.ts',
  'src/integrations/tonalliMemo/tm1RegtestBroadcastAuthorizationAdapter.ts',
  'src/integrations/tonalliMemo/tm1RegtestDualAuthorizationComposition.ts',
  'scripts/run-tm1-regtest-e2e.ts'
]

const source = (relativePath: string): string => readFileSync(
  fileURLToPath(new URL(relativePath, import.meta.url)),
  'utf8'
)

describe('TM1 concrete regtest runtime architectural boundaries', () => {
  test('imports only closed TM1 boundaries, generic authorization contracts, Chronik, and eCash crypto', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')
    const imports = Array.from(
      runtime.matchAll(/from\s+['"]([^'"]+)['"]/g),
      match => match[1]
    )

    expect(imports).toEqual([
      'chronik-client',
      'ecash-lib',
      '../../features/externalSign/approval',
      '../../features/externalSign/contract',
      '../../features/externalSign/lock',
      './tm1ChronikRegtestDeliveryTransport',
      './tm1Draft02Plan',
      './tm1Draft02RegtestP2pkhSigner',
      './tm1RegtestDualAuthorizationComposition',
      './tm1RegtestPublicationOrchestrator'
    ])
  })

  test('has no UI, wallet, session, mainnet, browser-storage, or product-state imports', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')

    expect(runtime).not.toMatch(
      /react|routes\/|hooks\/|components\/|WalletContext|XolosWalletService/i
    )
    expect(runtime).not.toMatch(
      /WalletConnect|WcWallet|x402|Firma Alpha|localStorage|sessionStorage|mainnet/i
    )
  })

  test('does not import or mutate the legacy E2E harness', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')
    const script = source('../../../scripts/run-tm1-regtest-e2e.ts')

    expect(runtime).not.toMatch(/run-tm1-regtest-e2e/)
    expect(script).not.toContain('createTm1RegtestRuntime')
  })

  test('uses the concrete regtest transport and never the in-memory transport', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')

    expect(runtime).toContain('new Tm1ChronikRegtestDeliveryTransport')
    expect(runtime).not.toContain('Tm1InMemoryDeliveryTransport')
    expect(runtime).toContain('deliveryBackend.submit(signedArtifact)')
  })

  test('delegates dual consent to the closed 6-E composition exactly once', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')

    expect(runtime.match(/createTm1RegtestDualAuthorizationPorts\(/g)).toHaveLength(1)
    expect(runtime).toContain('signingAuthorization: authorization.signingAuthorization')
    expect(runtime).toContain('broadcastAuthorization: authorization.broadcastAuthorization')
    expect(runtime).not.toMatch(/alwaysApprove|defaultApproval|implicitDecision/i)
  })

  test('accepts no injected signer, audit, transport, client, core, lock, ledger, or ID allocator', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')
    const config = runtime.slice(
      runtime.indexOf('export type Tm1RegtestRuntimeConfig'),
      runtime.indexOf('export type Tm1RegtestRuntimeCompositionErrorCode')
    )

    expect(config).toContain('chronikEndpointUrl: string')
    expect(config).toContain('authorization: Tm1RegtestRuntimeAuthorizationConfig')
    expect(config).not.toMatch(
      /signer|audit|transport|client|core|lock|ledger|capability|clock|allocator|environment|wif|private/i
    )
  })

  test('keeps fixture signing and pure audit as private concrete wrappers', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')

    expect(runtime).toContain('signTm1Draft02RegtestCandidate({')
    expect(runtime).toContain('auditTm1Draft02RegtestSignedTransaction({')
    expect(runtime).toContain('Tx.fromHex(artifact.rawTransactionHex)')
    expect(runtime).not.toMatch(/export (?:class|function) .*Signer|export .*signedArtifactAudit/)
  })

  test('uses Web Crypto for operation and publication IDs and native core capabilities', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')

    expect(runtime).toContain('globalThis.crypto')
    expect(runtime).toContain('getRandomValues')
    expect(runtime).toContain('createOperationIdSuffix: () => randomHex')
    expect(runtime).toContain('createId: prefix => `${prefix}:${randomHex')
    expect(runtime).not.toContain('Math.random')
    expect(runtime).not.toContain('createCapabilityId:')
  })

  test('creates runtime-local private one-lease lock and global capability-ID ledger', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')

    expect(runtime).toContain('class RuntimeAuthorizationLock')
    expect(runtime).toContain('private activeLease')
    expect(runtime).toContain("'OPERATION_ALREADY_ACTIVE'")
    expect(runtime).toContain('class RuntimeApprovalLedger')
    expect(runtime).toContain('private readonly consumedCapabilityIds = new Set<string>()')
    expect(runtime).toContain("'APPROVAL_ALREADY_CONSUMED'")
    expect(runtime).not.toMatch(/export class RuntimeAuthorization|export class RuntimeApproval/)
  })

  test('UTXO authority is fixed to the fixture P2PKH and has no cache', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')

    expect(runtime).toContain("chronik.script('p2pkh', FIXTURE_P2PKH_HASH_HEX).utxos()")
    expect(runtime).toContain('TM1_REGTEST_FIXTURE_LOCKING_SCRIPT_HEX')
    expect(runtime).toContain('REGTEST_COINBASE_MATURITY = 100')
    expect(runtime).not.toMatch(/cachedUtxo|utxoCache|caller.*script/i)
  })

  test('confirmation is a one-shot observation with no polling, sleep, or transport access', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')
    const observer = runtime.slice(
      runtime.indexOf('function createConfirmationObserver'),
      runtime.indexOf('function unconfirmed')
    )

    expect(observer).toContain('chronik.tx(input.txid)')
    expect(observer).toContain('chronik.blockchainInfo()')
    expect(observer).not.toMatch(/setTimeout|setInterval|while\s*\(|broadcast|submit|delivery/)
  })

  test('constructs a separate exact method-only facade with closure-safe delegation', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')

    expect(runtime).toContain('const facade: Tm1RegtestPublicationOrchestrator = {')
    expect(runtime).toContain('return Object.freeze(facade)')
    expect(runtime).not.toMatch(/Object\.freeze\(orchestrator\)|Object\.assign\([^)]*orchestrator|\.\.\.orchestrator/)
  })

  test('exports no direct signing, broadcast, transport, client, lock, ledger, or core authority', () => {
    const runtime = source('./tm1RegtestRuntimeComposition.ts')
    const exported = Array.from(
      runtime.matchAll(/^export\s+(?:type|class|function)\s+([A-Za-z0-9_]+)/gm),
      match => match[1]
    )

    expect(exported).toEqual([
      'Tm1RegtestRuntimeAuthorizationConfig',
      'Tm1RegtestRuntimeConfig',
      'Tm1RegtestRuntimeCompositionErrorCode',
      'Tm1RegtestRuntimeCompositionError',
      'createTm1RegtestRuntime'
    ])
  })

  test('canonical dependency remains tonalli-core 0.2.0 at the approved commit', () => {
    const packageJson = JSON.parse(source('../../../package.json')) as {
      dependencies: Record<string, string>
    }
    const lock = source('../../../package-lock.json')

    expect(packageJson.dependencies['@xolosarmy/tonalli-core']).toBe(
      'github:xolosArmy/tonalli-core#cfe4cb1575b22ed258565717c000ac535aa98c67'
    )
    expect(lock).toContain('"version": "0.2.0"')
    expect(lock).toContain('cfe4cb1575b22ed258565717c000ac535aa98c67')
  })

  test('all closed Phase 6-B through 6-E files and the legacy script remain unchanged', () => {
    const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const diff = execFileSync('git', ['diff', BASE, '--', ...CLOSED_PATHS], {
      cwd: repositoryRoot,
      encoding: 'utf8'
    })

    expect(diff).toBe('')
  })

  test('documents regtest-only process lifetime and deferred CLI migration limits', () => {
    const documentation = source('../../../docs/tonalli-memo-tm1-regtest-runtime-composition.md')

    expect(documentation).toContain('REGTEST ONLY')
    expect(documentation).toContain('NOT PRODUCTION / NOT MAINNET DURABILITY')
    expect(documentation).toContain('process restart')
    expect(documentation).toContain('Phase 6-G')
    expect(documentation).toContain('legacy fixture harness')
  })
})
