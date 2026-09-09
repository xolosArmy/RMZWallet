/**
 * @file ledger.ts
 *
 * Wallet Approval Ledger interface and in-memory test implementation.
 *
 * INVARIANTS:
 * - Production REQUIRES explicit injection of a durable, transactional ledger.
 * - Global default singleton fallback is REMOVED to prevent silent in-memory production deployment.
 * - Enforces atomic uniqueness across requestId, approvalId, AND capabilityId.
 */

import { WalletApprovalReceiverError } from './types'
import type { WalletApprovalLedger, WalletApprovalLedgerRecord } from './types'

/**
 * In-memory ledger implementation STRICTLY FOR TESTING and development.
 *
 * WARNING: This implementation does NOT provide persistence, durability across restarts,
 * multi-process synchronization, or distributed consensus. It must NOT be used for real
 * financial production.
 */
export class InMemoryWalletApprovalLedger implements WalletApprovalLedger {
  private readonly recordsByRequestId = new Map<string, WalletApprovalLedgerRecord>()
  private readonly recordsByApprovalId = new Map<string, WalletApprovalLedgerRecord>()
  private readonly recordsByCapabilityId = new Map<string, WalletApprovalLedgerRecord>()

  async recordApprovalAtomic(record: WalletApprovalLedgerRecord): Promise<void> {
    if (!record || typeof record !== 'object') {
      throw new WalletApprovalReceiverError('ATOMIC_RECORDING_FAILED', 'Invalid record payload')
    }

    if (this.recordsByRequestId.has(record.requestId)) {
      throw new WalletApprovalReceiverError(
        'DUPLICATE_APPROVAL_RECORD',
        `An approval record with requestId "${record.requestId}" already exists.`
      )
    }

    if (this.recordsByApprovalId.has(record.approvalId)) {
      throw new WalletApprovalReceiverError(
        'DUPLICATE_APPROVAL_RECORD',
        `An approval record with approvalId "${record.approvalId}" already exists.`
      )
    }

    if (this.recordsByCapabilityId.has(record.capabilityId)) {
      throw new WalletApprovalReceiverError(
        'DUPLICATE_APPROVAL_RECORD',
        `An approval record with capabilityId "${record.capabilityId}" already exists.`
      )
    }

    // Atomic commit into all indexes
    const frozenRecord = Object.freeze({ ...record })
    this.recordsByRequestId.set(record.requestId, frozenRecord)
    this.recordsByApprovalId.set(record.approvalId, frozenRecord)
    this.recordsByCapabilityId.set(record.capabilityId, frozenRecord)
  }

  async has(requestId: string): Promise<boolean> {
    return this.recordsByRequestId.has(requestId)
  }

  async get(requestId: string): Promise<WalletApprovalLedgerRecord | undefined> {
    return this.recordsByRequestId.get(requestId)
  }

  // Helper for test cleanup
  clear(): void {
    this.recordsByRequestId.clear()
    this.recordsByApprovalId.clear()
    this.recordsByCapabilityId.clear()
  }
}
