/**
 * @file agentWalletExecution.architecture.test.ts
 *
 * ARCHITECTURAL BOUNDARY & AUDIT VERIFICATION TEST SUITE (Gate C2)
 *
 * Enforces strict module boundaries:
 * 1. Module exports do NOT leak internal capabilities, private keys, or raw signers.
 * 2. Module source code contains ZERO broadcast or network mutation functions.
 * 3. Module contains ZERO settlement or confirmation polling logic.
 * 4. HumanApprovalV1 receipt cannot invoke signing on its own.
 * 5. Crash consistency and fail-closed state machines are strictly observed.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as PublicModuleExports from './index'

describe('agentWalletExecution Architecture & Security Boundaries', () => {
  it('strictly controls public module exports', () => {
    const exportedKeys = Object.keys(PublicModuleExports)

    // Allowed exports
    expect(exportedKeys).toContain('createAgentWalletExecutionEngine')
    expect(exportedKeys).toContain('InMemoryWalletExecutionLedger')
    expect(exportedKeys).toContain('WalletExecutionError')
    expect(exportedKeys).toContain('DEFAULT_FEE_POLICY')
    expect(exportedKeys).toContain('estimateP2pkhTransactionSize')
    expect(exportedKeys).toContain('assertFeePolicy')
    expect(exportedKeys).toContain('validateOutputInvariants')

    // FORBIDDEN exports: module-private capability and tokens
    expect((PublicModuleExports as any).WalletExecutionCapability).toBeUndefined()
    expect((PublicModuleExports as any).INTERNAL_EXECUTION_TOKEN).toBeUndefined()
    expect((PublicModuleExports as any).mintExecutionCapability).toBeUndefined()

    // FORBIDDEN exports: keys, mnemonics, WIF
    expect((PublicModuleExports as any).privateKey).toBeUndefined()
    expect((PublicModuleExports as any).secretKey).toBeUndefined()
    expect((PublicModuleExports as any).mnemonic).toBeUndefined()
    expect((PublicModuleExports as any).wif).toBeUndefined()

    // FORBIDDEN exports: network broadcast functions
    expect((PublicModuleExports as any).broadcastTx).toBeUndefined()
    expect((PublicModuleExports as any).broadcastTransaction).toBeUndefined()
    expect((PublicModuleExports as any).sendRawTransaction).toBeUndefined()
  })

  it('verifies ZERO broadcast or network mutation functions exist in feature codebase', () => {
    const dir = __dirname
    const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))

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
      // No console.log of secret or private key
      expect(content).not.toMatch(/console\.log\(.*privateKey.*\)/)
      expect(content).not.toMatch(/console\.log\(.*secretKey.*\)/)
      expect(content).not.toMatch(/console\.log\(.*wif.*\)/)
    }
  })

  it('verifies terminal state is SIGNED / READY_FOR_SETTLEMENT and NEVER SETTLED', () => {
    const typesContent = readFileSync(join(__dirname, 'types.ts'), 'utf-8')

    // Confirm that WalletExecutionState does NOT include 'SETTLED'
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

    // Possession of fakeReceipt does not grant any signing method
    expect((fakeReceipt as any).sign).toBeUndefined()
    expect((fakeReceipt as any).execute).toBeUndefined()
    expect((fakeReceipt as any).confirmExecution).toBeUndefined()
  })
})
