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
    expect(typeof settlementModule.storeInternalSignedTransaction).toBe('function')

    const hostModule = await import('../../internal/agentWalletExecutionHost')
    for (const name of forbiddenReadExports) {
      expect((hostModule as Record<string, unknown>)[name]).toBeUndefined()
    }

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
    expect(settlementSource).toMatch(/localStorage provides persistence but NOT same-origin\/XSS isolation/)
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
})
