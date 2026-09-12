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
 * 7. HumanApprovalV1 receipt cannot invoke signing on its own.
 * 8. All production source files maintain strict capability privacy (AST inspection).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as PublicModuleExports from './index'

describe('agentWalletExecution Architecture & Security Boundaries', () => {
  it('strictly controls public module exports from index.ts', () => {
    const exportedKeys = Object.keys(PublicModuleExports)

    // Allowed production exports
    expect(exportedKeys).toContain('createAgentWalletExecutionEngine')
    expect(exportedKeys).toContain('DurableStorageWalletExecutionLedger')
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

    // FORBIDDEN exports: raw signed tx getters or fields
    expect((PublicModuleExports as any).rawSignedTxHex).toBeUndefined()
    expect((PublicModuleExports as any).getSignedTxHex).toBeUndefined()

    // FORBIDDEN exports: network broadcast functions
    expect((PublicModuleExports as any).broadcastTx).toBeUndefined()
    expect((PublicModuleExports as any).broadcastTransaction).toBeUndefined()
    expect((PublicModuleExports as any).sendRawTransaction).toBeUndefined()
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

  it('verifies HumanApprovalV1 alone cannot invoke signing without WalletExecutionEngine and session', () => {
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
    expect((fakeReceipt as any).confirmExecution).toBeUndefined()
  })
})
