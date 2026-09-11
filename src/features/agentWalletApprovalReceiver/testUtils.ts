/**
 * @file testUtils.ts
 *
 * TEST-ONLY UTILITIES FOR agentWalletApprovalReceiver.
 *
 * WARNING:
 * Strictly for unit and integration testing.
 * NEVER export these classes or functions from production index.ts.
 */

import {
  type WalletApprovalLedger,
  type WalletApprovalLedgerRecord,
  type WalletHumanSessionVerifier,
  type WalletHumanSessionVerificationResult,
  WalletApprovalReceiverError
} from './types'

/**
 * In-memory approval ledger STRICTLY FOR TESTING.
 * Enforces atomic uniqueness across requestId, approvalId, AND capabilityId.
 */
export class InMemoryWalletApprovalLedger implements WalletApprovalLedger {
  private readonly recordsByRequestId = new Map<string, WalletApprovalLedgerRecord>()
  private readonly recordsByApprovalId = new Map<string, WalletApprovalLedgerRecord>()
  private readonly recordsByCapabilityId = new Map<string, WalletApprovalLedgerRecord>()

  async recordApprovalAtomic(record: WalletApprovalLedgerRecord): Promise<void> {
    if (!record.requestId || !record.approvalId || !record.capabilityId) {
      throw new WalletApprovalReceiverError(
        'ATOMIC_RECORDING_FAILED',
        'Record is missing mandatory identification fields.'
      )
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

  clear(): void {
    this.recordsByRequestId.clear()
    this.recordsByApprovalId.clear()
    this.recordsByCapabilityId.clear()
  }
}

/**
 * Creates a mock session verifier for unit tests.
 */
export function createMockSessionVerifier(
  defaultActiveAddress = 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2',
  authenticated = true
): WalletHumanSessionVerifier {
  const isAuth = authenticated
  const address = defaultActiveAddress

  return {
    async verifyActiveSession(): Promise<WalletHumanSessionVerificationResult> {
      if (!isAuth) {
        return {
          authenticated: false,
          error: 'No active session found'
        }
      }
      return {
        authenticated: true,
        activeAddress: address,
        approverId: 'wallet_custodian_primary'
      }
    }
  }
}
