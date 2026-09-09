/**
 * @file ledger.ts
 *
 * In-memory Wallet-local approval ledger for atomic recording of HumanApprovalV1.
 *
 * Architecture boundary:
 * Strictly isolated to approval receipts and bindings. No keys, no transaction construction,
 * no signer, and no broadcast.
 */

import type {
  WalletApprovalLedger,
  WalletApprovalLedgerRecord
} from './types'
import { WalletApprovalReceiverError } from './types'

export class InMemoryWalletApprovalLedger implements WalletApprovalLedger {
  private readonly recordsByRequestId = new Map<string, WalletApprovalLedgerRecord>()
  private readonly recordsByApprovalId = new Map<string, WalletApprovalLedgerRecord>()

  async recordApprovalAtomic(record: WalletApprovalLedgerRecord): Promise<void> {
    if (this.recordsByRequestId.has(record.requestId)) {
      throw new WalletApprovalReceiverError(
        'DUPLICATE_APPROVAL_RECORD',
        `Approval record already exists for requestId: ${record.requestId}`
      )
    }

    if (this.recordsByApprovalId.has(record.approvalId)) {
      throw new WalletApprovalReceiverError(
        'DUPLICATE_APPROVAL_RECORD',
        `Approval record already exists for approvalId: ${record.approvalId}`
      )
    }

    // Atomic stage: insert into both maps
    this.recordsByRequestId.set(record.requestId, record)
    this.recordsByApprovalId.set(record.approvalId, record)
  }

  async has(requestId: string): Promise<boolean> {
    return this.recordsByRequestId.has(requestId)
  }

  async get(requestId: string): Promise<WalletApprovalLedgerRecord | undefined> {
    return this.recordsByRequestId.get(requestId)
  }

  /**
   * Test helper to clear records in isolated test suites.
   */
  clear(): void {
    this.recordsByRequestId.clear()
    this.recordsByApprovalId.clear()
  }
}

export const defaultWalletApprovalLedger = new InMemoryWalletApprovalLedger()
