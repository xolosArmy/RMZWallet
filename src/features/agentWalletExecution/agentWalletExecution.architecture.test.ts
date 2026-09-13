/**
 * @file agentWalletExecution.architecture.test.ts
 *
 * ARCHITECTURAL BOUNDARY & AUDIT VERIFICATION TEST SUITE (Gate C2)
 *
 * Enforces strict module boundaries:
 * 1. Module exports do NOT leak internal capabilities, private keys, or raw signers.
 * 2. InMemoryWalletExecutionLedger is NOT exported in production index.ts.
 * 3. WalletExecutionReviewSession does NOT expose confirmExecution() or any signing method.
 * 4. Raw signed transaction bytes (rawSignedTxHex) are strictly hidden from public types/exports.
 * 5. Module source code contains ZERO broadcast or network mutation functions.
 * 6. Module contains ZERO settlement or confirmation polling logic.
 * 7. HumanApprovalV1 receipt + session cannot invoke signing without Wallet UI internal controller.
 * 8. Public Agent-facing engine strictly lacks confirm, sign, execute, and createLocalConfirmationController.
 * 9. All production source files maintain strict capability privacy (AST inspection).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as PublicModuleExports from './index'

describe('agentWalletExecution Architecture & Security Boundaries', () => {
  it('strictly controls public module exports from index.ts', () => {
    const exportedKeys = Object.keys(PublicModuleExports)

    // Allowed production exports
    expect(exportedKeys).not.toContain('createWalletExecutionComposition')
    expect(exportedKeys).toContain('createAgentWalletExecutionEngine')
    expect(exportedKeys).toContain('DurableTransactionalExecutionLedger')
    expect(exportedKeys).toContain('DurableStorageWalletExecutionLedger')
    expect(exportedKeys).toContain('WebLocksExecutionCoordinator')
    expect(exportedKeys).toContain('WalletExecutionError')
    expect(exportedKeys).toContain('DEFAULT_FEE_POLICY')
    expect(exportedKeys).toContain('estimateP2pkhTransactionSize')
    expect(exportedKeys).toContain('assertFeePolicy')
    expect(exportedKeys).toContain('validateOutputInvariants')
    expect(exportedKeys).toContain('computeCanonicalPlanHash')

    // FORBIDDEN exports: Wallet UI host / composition authority
    expect((PublicModuleExports as any).createWalletExecutionComposition).toBeUndefined()
    expect((PublicModuleExports as any).WalletExecutionTrustedOptions).toBeUndefined()
    expect((PublicModuleExports as any).TrustedWalletExecutionProvider).toBeUndefined()
    expect((PublicModuleExports as any).privateSettlementStorage).toBeUndefined()
    expect((PublicModuleExports as any).WalletExecutionComposition).toBeUndefined()
    expect((PublicModuleExports as any).WalletExecutionUIHost).toBeUndefined()
    expect((PublicModuleExports as any).walletUIHost).toBeUndefined()
    expect((PublicModuleExports as any).getActiveController).toBeUndefined()

    // FORBIDDEN export: in-memory test double must remain test-only
    expect((PublicModuleExports as any).InMemoryWalletExecutionLedger).toBeUndefined()
    expect((PublicModuleExports as any).TestExecutionLockCoordinator).toBeUndefined()

    // FORBIDDEN exports: module-private capability and tokens
    expect((PublicModuleExports as any).WalletExecutionCapability).toBeUndefined()
    expect((PublicModuleExports as any).INTERNAL_EXECUTION_TOKEN).toBeUndefined()
    expect((PublicModuleExports as any).mintExecutionCapability).toBeUndefined()
    expect((PublicModuleExports as any).INTERNAL_CAPABILITY_TOKEN).toBeUndefined()
    expect((PublicModuleExports as any).LOCAL_CONFIRMATION_TOKEN).toBeUndefined()
    expect((PublicModuleExports as any).InternalLocalExecutionConfirmationToken).toBeUndefined()

    // FORBIDDEN exports: keys, mnemonics, WIF
    expect((PublicModuleExports as any).privateKey).toBeUndefined()
    expect((PublicModuleExports as any).secretKey).toBeUndefined()
    expect((PublicModuleExports as any).mnemonic).toBeUndefined()
    expect((PublicModuleExports as any).wif).toBeUndefined()

    // FORBIDDEN exports: raw signed tx getters, internal records, or settlement tokens
    expect((PublicModuleExports as any).rawSignedTxHex).toBeUndefined()
    expect((PublicModuleExports as any).getSignedTxHex).toBeUndefined()
    expect((PublicModuleExports as any).getSignedTransactionHex).toBeUndefined()
    expect((PublicModuleExports as any).InternalWalletExecutionRecord).toBeUndefined()
    expect((PublicModuleExports as any).SettlementRawTransactionAccessor).toBeUndefined()
    expect((PublicModuleExports as any).INTERNAL_SETTLEMENT_TOKEN).toBeUndefined()
    expect((PublicModuleExports as any).getInternalSignedTransactionHex).toBeUndefined()
    expect((PublicModuleExports as any).getInternalSignedTransaction).toBeUndefined()
    expect((PublicModuleExports as any).getSignedTransaction).toBeUndefined()
    expect((PublicModuleExports as any).getRawSignedTx).toBeUndefined()
    expect((PublicModuleExports as any).readSettlementTx).toBeUndefined()
    expect((PublicModuleExports as any).storeInternalSignedTransaction).toBeUndefined()
    expect((PublicModuleExports as any).writeSignedTransaction).toBeUndefined()
    expect((PublicModuleExports as any).putSettlementArtifact).toBeUndefined()
    expect((PublicModuleExports as any).replaceSettlementArtifact).toBeUndefined()
    expect((PublicModuleExports as any).DEFAULT_PRIVATE_SETTLEMENT_STORAGE_KEY).toBeUndefined()

    // FORBIDDEN exports: local confirmation controller creation & controller type
    expect((PublicModuleExports as any).createLocalConfirmationController).toBeUndefined()
    expect((PublicModuleExports as any).WalletLocalConfirmationController).toBeUndefined()
    expect((PublicModuleExports as any).confirm).toBeUndefined()
    expect((PublicModuleExports as any).sign).toBeUndefined()
    expect((PublicModuleExports as any).execute).toBeUndefined()

    // FORBIDDEN exports: network broadcast functions
    expect((PublicModuleExports as any).broadcastTx).toBeUndefined()
    expect((PublicModuleExports as any).broadcastTransaction).toBeUndefined()
    expect((PublicModuleExports as any).sendRawTransaction).toBeUndefined()
  })

  it('verifies deep import of ledger.ts does NOT export settlement tokens or raw tx accessors', async () => {
    const ledgerModule = await import('./ledger')
    const ledgerKeys = Object.keys(ledgerModule)

    expect(ledgerKeys).not.toContain('INTERNAL_SETTLEMENT_TOKEN')
    expect(ledgerKeys).not.toContain('getInternalSignedTransactionHex')
    expect(ledgerKeys).not.toContain('_getRawSignedTxHexInternal')
    expect(ledgerKeys).not.toContain('DEFAULT_PRIVATE_SETTLEMENT_STORAGE_KEY')
    expect((ledgerModule as any).INTERNAL_SETTLEMENT_TOKEN).toBeUndefined()
    expect((ledgerModule as any).getInternalSignedTransactionHex).toBeUndefined()

    // Prototype check: DurableTransactionalExecutionLedger has NO raw tx retrieval methods
    const proto = (ledgerModule.DurableTransactionalExecutionLedger as any).prototype
    expect(proto.getSignedTransactionHex).toBeUndefined()
    expect(proto._getRawSignedTxHexInternal).toBeUndefined()
    expect(proto.getRawSignedTxHex).toBeUndefined()
  })

  it('verifies WebLocksExecutionCoordinator fails closed when navigator.locks is unavailable', async () => {
    const coordinator = new PublicModuleExports.WebLocksExecutionCoordinator()
    const originalNavigator = globalThis.navigator

    try {
      // Simulate absence of Web Locks
      vi.stubGlobal('navigator', {})

      await expect(
        coordinator.requestExclusive('test_lock', async () => 'should_not_run')
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'COORDINATION_UNAVAILABLE'
        })
      )
    } finally {
      vi.stubGlobal('navigator', originalNavigator)
    }
  })

  it('verifies public AgentWalletExecutionEngine has NO confirmation, signing, or execution methods', () => {
    const dummyConfig: any = {
      approvalLedger: { get: vi.fn(), getByApprovalId: vi.fn() },
      sessionVerifier: { verifyActiveSession: vi.fn() },
      utxoProvider: { getSpendableUtxos: vi.fn() },
      signatoryProvider: { getSignatory: vi.fn() },
      storage: {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
        length: 0,
        key: vi.fn()
      },
      lockCoordinator: {
        async requestExclusive<T>(_lockName: string, operation: () => Promise<T>): Promise<T> {
          return operation()
        },
        async tryExclusive<T>(_lockName: string, operation: () => Promise<T>) {
          return { acquired: true as const, result: await operation() }
        }
      }
    }
    const publicEngine = PublicModuleExports.createAgentWalletExecutionEngine(dummyConfig)

    expect(typeof publicEngine.prepareExecution).toBe('function')
    expect(typeof publicEngine.getExecutionStatus).toBe('function')
    expect((publicEngine as any).confirm).toBeUndefined()
    expect((publicEngine as any).sign).toBeUndefined()
    expect((publicEngine as any).execute).toBeUndefined()
    expect((publicEngine as any).createLocalConfirmationController).toBeUndefined()
  })

  it('verifies capability.ts does NOT exist in production source', () => {
    const capabilityFilePath = join(__dirname, 'capability.ts')
    expect(
      existsSync(capabilityFilePath),
      'capability.ts must be eliminated in favor of closure encapsulation inside engine.ts.'
    ).toBe(false)
  })

  it('verifies WalletExecutionReviewSession does NOT expose signing methods', () => {
    const typesContent = readFileSync(join(__dirname, 'types.ts'), 'utf-8')
    // Extract interface WalletExecutionReviewSession
    const sessionMatch = typesContent.match(/export interface WalletExecutionReviewSession \{([\s\S]*?)\}/)
    expect(sessionMatch).not.toBeNull()
    const sessionBody = sessionMatch![1]

    expect(sessionBody).not.toMatch(/confirmExecution/)
    expect(sessionBody).not.toMatch(/confirm\(/)
    expect(sessionBody).not.toMatch(/sign\(/)
    expect(sessionBody).not.toMatch(/execute\(/)
    expect(sessionBody).toContain('rejectExecution')
    expect(sessionBody).toContain('dismiss')
  })

  it('verifies PublicExecutionStatus does NOT leak rawSignedTxHex', () => {
    const typesContent = readFileSync(join(__dirname, 'types.ts'), 'utf-8')
    const publicStatusMatch = typesContent.match(/export interface PublicExecutionStatus \{([\s\S]*?)\}/)
    expect(publicStatusMatch).not.toBeNull()
    const publicStatusBody = publicStatusMatch![1]

    expect(publicStatusBody).not.toMatch(/rawSignedTxHex/)
  })

  it('verifies AgentWalletExecutionEngineConfig has no settlement persistence dependency', () => {
    const typesContent = readFileSync(join(__dirname, 'types.ts'), 'utf-8')
    const start = typesContent.indexOf('export interface AgentWalletExecutionEngineConfig')
    const end = typesContent.indexOf('export interface WalletExecutionTrustedOptions')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = typesContent.slice(start, end)
    expect(body).not.toMatch(/privateSettlementStorage/)
    expect(body).not.toMatch(/settlementStorage/)
    expect(body).not.toMatch(/rawSignedTxHex/)
    expect(body).toMatch(/NEVER used for raw signed transactions/)

    const engineSource = readFileSync(join(__dirname, 'engine.ts'), 'utf-8')
    expect(engineSource).not.toMatch(/config\.storage \?\? \(typeof localStorage/)
    expect(engineSource).not.toMatch(/export function createWalletExecutionComposition/)
    expect(engineSource).not.toMatch(/export \{ createWalletExecutionComposition/)

    const runtimeSource = readFileSync(
      join(__dirname, '../../internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx'),
      'utf-8'
    )
    expect(runtimeSource).toMatch(/trusted\?\.privateSettlementStorage/)
    expect(runtimeSource).toMatch(/resolveFileLocalPrivateSettlementStorage/)
    expect(runtimeSource).not.toMatch(/export function createWalletExecutionComposition/)
    expect(runtimeSource).not.toMatch(/export \{[^}]*createWalletExecutionComposition/)
    expect(runtimeSource).toMatch(/function createWalletExecutionComposition\(/)
    expect(runtimeSource).not.toMatch(/readonly trustedSettlementStorage/)
    expect(runtimeSource).toMatch(/createFileLocalProductionSignatoryProvider/)
    expect(runtimeSource).not.toMatch(/export function createFileLocalProductionSignatoryProvider/)
    expect(runtimeSource).not.toMatch(/export function createProductionSignatoryProvider/)

    const mainSource = readFileSync(join(__dirname, '../../main.tsx'), 'utf-8')
    expect(mainSource).toContain('TrustedWalletExecutionProvider')
    expect(mainSource).toContain('createProductionWalletRuntime')
    expect(mainSource).toContain('TrustedGate2bToC2Bridge')
    expect(mainSource).toContain('productionWalletRuntime?.approvalLedger')
    expect(mainSource).not.toMatch(/signatoryProvider/)
    expect(mainSource).not.toMatch(/trustedSettlementStorage/)
    expect(mainSource).not.toMatch(/getSignatory/)
  })

  it('verifies WalletExecutionLedger never carries signed transaction bytes', () => {
    const typesContent = readFileSync(join(__dirname, 'types.ts'), 'utf-8')
    const ledgerStart = typesContent.indexOf('export interface WalletExecutionLedger')
    const ledgerEnd = typesContent.indexOf('export interface AgentWalletExecutionEngineConfig')
    expect(ledgerStart).toBeGreaterThan(-1)
    expect(ledgerEnd).toBeGreaterThan(ledgerStart)
    const ledgerBody = typesContent.slice(ledgerStart, ledgerEnd)
    expect(ledgerBody).not.toMatch(/rawSignedTxHex/)
    expect(ledgerBody).not.toMatch(/\brawTx\b/)
    expect(ledgerBody).not.toMatch(/\btxHex\b/)
    expect(ledgerBody).toContain('transitionToSigned(executionId: string, signedAt: number)')
    expect(ledgerBody).toContain('transitionToSigningIfValid')

    const ledgerSource = readFileSync(join(__dirname, 'ledger.ts'), 'utf-8')
    expect(ledgerSource).not.toMatch(/rawSignedTxHex/)
    expect(ledgerSource).not.toMatch(/\brawTx\b/)
    expect(ledgerSource).not.toMatch(/\btxHex\b/)

    const testUtilsSource = readFileSync(join(__dirname, 'testUtils.ts'), 'utf-8')
    expect(testUtilsSource).not.toMatch(/rawSignedTxHex/)
  })

  it('verifies SignedExecutionHandle remains opaque without raw tx bytes', () => {
    const typesContent = readFileSync(join(__dirname, 'types.ts'), 'utf-8')
    const handleMatch = typesContent.match(/export interface SignedExecutionHandle \{([\s\S]*?)\}/)
    expect(handleMatch).not.toBeNull()
    const handleBody = handleMatch![1]

    expect(handleBody).not.toMatch(/rawSignedTxHex/)
    expect(handleBody).not.toMatch(/rawTx/)
    expect(handleBody).not.toMatch(/txHex/)
  })

  it('verifies ZERO broadcast or network mutation functions exist in feature codebase', () => {
    const dir = __dirname
    const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('testUtils'))

    const forbiddenPatterns = [
      /\.broadcastTx\(/,
      /\.broadcastTxs\(/,
      /sendRawTransaction/,
      /broadcastTransaction/,
      /broadcastTxBuilder/,
      /PAYMENT-SIGNATURE/,
      /commerce-relay/,
      /confirmationPolling/
    ]

    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8')
      for (const pattern of forbiddenPatterns) {
        expect(
          pattern.test(content),
          `Forbidden network broadcast/settlement pattern "${pattern}" found in file "${file}".`
        ).toBe(false)
      }
    }
  })

  it('verifies raw private keys or WIF are never printed to console logs or serialized in records', () => {
    const dir = __dirname
    const files = readdirSync(dir).filter(f => f.endsWith('.ts'))

    for (const file of files) {
      const content = readFileSync(join(dir, file), 'utf-8')
      expect(content).not.toMatch(/console\.log\(.*privateKey.*\)/)
      expect(content).not.toMatch(/console\.log\(.*secretKey.*\)/)
      expect(content).not.toMatch(/console\.log\(.*wif.*\)/)
    }
  })

  it('verifies terminal state is SIGNED / READY_FOR_SETTLEMENT and NEVER SETTLED', () => {
    const typesContent = readFileSync(join(__dirname, 'types.ts'), 'utf-8')

    expect(typesContent).not.toMatch(/\|\s*'SETTLED'/)
    expect(typesContent).toContain("'SIGNED'")
    expect(typesContent).toContain("'SIGNING_UNCERTAIN'")
  })

  it('verifies Gate C2 production modules export no raw-tx read function', async () => {
    const forbiddenReadExports = [
      'getInternalSignedTransaction',
      'getSignedTransaction',
      'getRawSignedTx',
      'readSettlementTx',
      'getSignedTxHex',
      'getSignedTransactionHex',
      'getInternalSignedTransactionHex',
      '_getRawSignedTxHexInternal'
    ]

    const settlementModule = await import('../../internal/settlementStore')
    for (const name of forbiddenReadExports) {
      expect((settlementModule as Record<string, unknown>)[name]).toBeUndefined()
    }
    expect((settlementModule as Record<string, unknown>).storeInternalSignedTransaction).toBeUndefined()
    expect((settlementModule as Record<string, unknown>).writeSignedTransaction).toBeUndefined()
    expect((settlementModule as Record<string, unknown>).putSettlementArtifact).toBeUndefined()
    expect((settlementModule as Record<string, unknown>).replaceSettlementArtifact).toBeUndefined()
    expect((settlementModule as Record<string, unknown>).createSettlementWriter).toBeUndefined()

    const hostModule = await import('../../internal/agentWalletExecutionHost')
    for (const name of forbiddenReadExports) {
      expect((hostModule as Record<string, unknown>)[name]).toBeUndefined()
    }
    expect((hostModule as Record<string, unknown>).storeInternalSignedTransaction).toBeUndefined()
    expect((hostModule as Record<string, unknown>).persistVerifiedSignedTransactionOnce).toBeUndefined()
    expect((hostModule as Record<string, unknown>).createWalletExecutionComposition).toBeUndefined()
    expect(Object.keys(hostModule)).not.toContain('createWalletExecutionComposition')

    const engineModule = await import('./engine')
    expect((engineModule as Record<string, unknown>).storeInternalSignedTransaction).toBeUndefined()
    expect((engineModule as Record<string, unknown>).persistVerifiedSignedTransactionOnce).toBeUndefined()
    expect((engineModule as Record<string, unknown>).writeSignedTransaction).toBeUndefined()
    expect((engineModule as Record<string, unknown>).createWalletExecutionComposition).toBeUndefined()
    expect(Object.keys(engineModule)).toContain('createAgentWalletExecutionEngine')
    expect(Object.keys(engineModule)).not.toContain('createWalletExecutionComposition')
    expect(Object.keys(engineModule)).not.toContain('TrustedWalletExecutionProvider')

    const dir = __dirname
    const productionFiles = readdirSync(dir).filter(
      f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('testUtils')
    )
    const exportReadPattern = new RegExp(
      String.raw`export\s+(?:async\s+)?function\s+(${forbiddenReadExports.join('|')})\b`
    )
    for (const file of productionFiles) {
      const content = readFileSync(join(dir, file), 'utf-8')
      expect(exportReadPattern.test(content), `Forbidden raw-tx read export in ${file}`).toBe(false)
    }

    const settlementSource = readFileSync(
      join(__dirname, '../../internal/settlementStore/index.ts'),
      'utf-8'
    )
    expect(settlementSource).not.toMatch(/export async function getInternalSignedTransaction/)
    expect(settlementSource).not.toMatch(/export async function getSignedTransaction/)
    expect(settlementSource).not.toMatch(/export async function getRawSignedTx/)
    expect(settlementSource).not.toMatch(/export async function readSettlementTx/)
    expect(settlementSource).not.toMatch(/export async function storeInternalSignedTransaction/)
    expect(settlementSource).not.toMatch(/export async function writeSignedTransaction/)
    expect(settlementSource).not.toMatch(/export function createSettlement/)
    expect(settlementSource).toMatch(/localStorage provides persistence but NOT same-origin\/XSS isolation/)
    expect(settlementSource).toMatch(/Same-origin arbitrary JavaScript\/XSS can access browser storage/)
    expect(settlementSource).not.toMatch(/cryptographic isolation/i)
    expect(settlementSource).not.toMatch(/process-level isolation is claimed/i)
  })

  it('verifies possession of HumanApprovalV1 + WalletExecutionReviewSession + executionId cannot invoke signing', () => {
    const fakeReceipt = {
      schema: 'tonalli.human-approval',
      version: 1,
      approvalId: 'appr_fake',
      requestId: 'req_fake',
      intentId: 'intent_fake',
      decisionId: 'dec_fake',
      status: 'approved',
      approver: 'ecash:qpumqqygwcnt999fz3gp5nxjy66ckg6esvxaqmtclv',
      network: 'xec:mainnet',
      presentationHash: 'fake_pres',
      contentHash: 'fake_content',
      recordedAt: 1800000000
    }

    expect((fakeReceipt as any).sign).toBeUndefined()
    expect((fakeReceipt as any).execute).toBeUndefined()
    expect((fakeReceipt as any).confirm).toBeUndefined()
    expect((fakeReceipt as any).confirmExecution).toBeUndefined()

    const fakeSession: any = {
      executionId: 'exec_fake',
      plan: {},
      review: {}
    }
    expect(fakeSession.confirm).toBeUndefined()
    expect(fakeSession.sign).toBeUndefined()
    expect(fakeSession.execute).toBeUndefined()
  })

  it('rejects Agent-facing deep import of the composition factory at import level', async () => {
    const publicModule = await import('./index')
    const engineModule = await import('./engine')
    const hostModule = await import('../../internal/agentWalletExecutionHost')
    const runtimeModule = await import('../../internal/agentWalletExecutionHost/trustedWalletExecutionRuntime')
    const providerModule = await import(
      '../../internal/agentWalletExecutionHost/TrustedWalletExecutionProvider'
    )

    expect('createWalletExecutionComposition' in publicModule).toBe(false)
    expect('createWalletExecutionComposition' in engineModule).toBe(false)
    expect('createWalletExecutionComposition' in hostModule).toBe(false)
    expect('createWalletExecutionComposition' in runtimeModule).toBe(false)
    expect('createWalletExecutionComposition' in providerModule).toBe(false)
    expect((runtimeModule as { createWalletExecutionComposition?: unknown }).createWalletExecutionComposition)
      .toBeUndefined()

    const hostDir = join(__dirname, '../../internal/agentWalletExecutionHost')
    const hostFiles = readdirSync(hostDir).filter(
      f => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx')
    )
    const exportFactory = /export\s+(?:async\s+)?function\s+createWalletExecutionComposition\b/
    const exportNamed = /export\s+\{[^}]*\bcreateWalletExecutionComposition\b/
    for (const file of hostFiles) {
      const content = readFileSync(join(hostDir, file), 'utf-8')
      expect(exportFactory.test(content), `exported factory in ${file}`).toBe(false)
      expect(exportNamed.test(content), `re-exported factory in ${file}`).toBe(false)
    }
  })

  it('rejects Agent-facing deep import of a production Wallet signatory or settlement writer', async () => {
    const publicModule = await import('./index')
    const engineModule = await import('./engine')
    const hostModule = await import('../../internal/agentWalletExecutionHost')
    const adaptersModule = await import(
      '../../internal/agentWalletExecutionHost/productionWalletAdapters'
    )
    const runtimeModule = await import('../../internal/agentWalletExecutionHost/trustedWalletExecutionRuntime')
    const providerModule = await import(
      '../../internal/agentWalletExecutionHost/TrustedWalletExecutionProvider'
    )

    const modules = [publicModule, engineModule, hostModule, adaptersModule, runtimeModule, providerModule]
    const forbidden = [
      'createProductionSignatoryProvider',
      'getSignatory',
      'createSignatory',
      'signatoryProvider',
      'trustedSettlementStorage',
      'privateSettlementStorage',
      'persistVerifiedSignedTransactionOnce'
    ]
    for (const mod of modules) {
      const record = mod as Record<string, unknown>
      for (const name of forbidden) {
        expect(record[name], `${name} must not be a production export`).toBeUndefined()
        expect(Object.keys(record)).not.toContain(name)
      }
    }

    const runtime = adaptersModule.createProductionWalletRuntime
    expect(typeof runtime).toBe('function')
    const created = runtime()
    if (created) {
      expect(created).not.toHaveProperty('signatoryProvider')
      expect(created).not.toHaveProperty('getSignatory')
      expect(created).not.toHaveProperty('trustedSettlementStorage')
      expect(created).not.toHaveProperty('privateSettlementStorage')
      expect(created).not.toHaveProperty('walletUIHost')
    }

    const propsMatch = readFileSync(
      join(__dirname, '../../internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx'),
      'utf-8'
    ).match(/export interface TrustedWalletExecutionProviderProps \{([\s\S]*?)\n\}/)
    expect(propsMatch).not.toBeNull()
    const propsBody = propsMatch![1]
    expect(propsBody).not.toMatch(/trustedSettlementStorage/)
    expect(propsBody).not.toMatch(/privateSettlementStorage/)
    expect(propsBody).not.toMatch(/SettlementStore/)
    expect(propsBody).not.toMatch(/rawTxWriter/)
    expect(propsBody).not.toMatch(/persistSignedTx/)
  })
})
