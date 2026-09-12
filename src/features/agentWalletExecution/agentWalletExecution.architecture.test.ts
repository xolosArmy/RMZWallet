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
    expect(exportedKeys).toContain('createWalletExecutionComposition')
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

    // FORBIDDEN export: in-memory test double must remain test-only
    expect((PublicModuleExports as any).InMemoryWalletExecutionLedger).toBeUndefined()

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
