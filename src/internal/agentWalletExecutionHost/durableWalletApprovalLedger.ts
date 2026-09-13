/**
 * @file durableWalletApprovalLedger.ts
 *
 * Production durable WalletApprovalLedger.
 * Gate 2B and Gate C2 MUST share one instance of this ledger.
 */

import {
  WalletApprovalReceiverError,
  type WalletApprovalLedger,
  type WalletApprovalLedgerRecord
} from '../../features/agentWalletApprovalReceiver/types'

export const DEFAULT_WALLET_APPROVAL_LEDGER_STORAGE_KEY = 'rmzwallet_wallet_approval_ledger_v1'
export const DEFAULT_WALLET_APPROVAL_LEDGER_LOCK_NAME = 'rmzwallet:wallet-approval:lock:v1'

interface ApprovalLockCoordinator {
  requestExclusive<T>(lockName: string, operation: () => Promise<T>): Promise<T>
}

class WebLocksApprovalCoordinator implements ApprovalLockCoordinator {
  private assertLocksAvailable(): void {
    if (typeof navigator === 'undefined' || !navigator.locks?.request) {
      throw new WalletApprovalReceiverError(
        'ATOMIC_RECORDING_FAILED',
        'Cross-context coordination primitive (navigator.locks.request) is unavailable. Approval ledger fails closed.'
      )
    }
  }

  async requestExclusive<T>(lockName: string, operation: () => Promise<T>): Promise<T> {
    this.assertLocksAvailable()
    return navigator.locks.request(lockName, { mode: 'exclusive' }, operation)
  }
}

interface DurableApprovalPayloadV1 {
  readonly schemaVersion: 1
  recordsByRequestId: Record<string, WalletApprovalLedgerRecord>
  approvalIdIndex: Record<string, string>
  capabilityIdIndex: Record<string, string>
}

function emptyPayload(): DurableApprovalPayloadV1 {
  return {
    schemaVersion: 1,
    recordsByRequestId: {},
    approvalIdIndex: {},
    capabilityIdIndex: {}
  }
}

export interface DurableWalletApprovalLedgerOptions {
  readonly storage?: Storage | null
  readonly storageKey?: string
  readonly lockName?: string
  readonly lockCoordinator?: ApprovalLockCoordinator
}

export class DurableWalletApprovalLedger implements WalletApprovalLedger {
  private readonly storage: Storage
  private readonly storageKey: string
  private readonly lockName: string
  private readonly coordinator: ApprovalLockCoordinator

  constructor(options?: DurableWalletApprovalLedgerOptions) {
    const resolvedStorage = options?.storage ?? (typeof window !== 'undefined' ? window.localStorage : null)
    if (!resolvedStorage) {
      throw new WalletApprovalReceiverError(
        'MISSING_LEDGER_DEPENDENCY',
        'No durable storage available for WalletApprovalLedger. Gate 2B/C2 fail closed.'
      )
    }
    this.storage = resolvedStorage
    this.storageKey = options?.storageKey ?? DEFAULT_WALLET_APPROVAL_LEDGER_STORAGE_KEY
    this.lockName = options?.lockName ?? DEFAULT_WALLET_APPROVAL_LEDGER_LOCK_NAME
    this.coordinator = options?.lockCoordinator ?? new WebLocksApprovalCoordinator()
  }

  private loadData(): DurableApprovalPayloadV1 {
    const raw = this.storage.getItem(this.storageKey)
    if (!raw) {
      return emptyPayload()
    }
    try {
      const parsed = JSON.parse(raw) as DurableApprovalPayloadV1
      if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.recordsByRequestId !== 'object') {
        throw new Error('Invalid approval ledger schema')
      }
      return {
        schemaVersion: 1,
        recordsByRequestId: parsed.recordsByRequestId ?? {},
        approvalIdIndex: parsed.approvalIdIndex ?? {},
        capabilityIdIndex: parsed.capabilityIdIndex ?? {}
      }
    } catch (err) {
      throw new WalletApprovalReceiverError(
        'ATOMIC_RECORDING_FAILED',
        `Failed to parse durable approval ledger: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private saveData(data: DurableApprovalPayloadV1): void {
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(data))
    } catch (err) {
      throw new WalletApprovalReceiverError(
        'ATOMIC_RECORDING_FAILED',
        `Failed to persist durable approval ledger: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  async recordApprovalAtomic(record: WalletApprovalLedgerRecord): Promise<void> {
    if (!record.requestId || !record.approvalId || !record.capabilityId) {
      throw new WalletApprovalReceiverError(
        'ATOMIC_RECORDING_FAILED',
        'Record is missing mandatory identification fields.'
      )
    }
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      if (data.recordsByRequestId[record.requestId]) {
        throw new WalletApprovalReceiverError(
          'DUPLICATE_APPROVAL_RECORD',
          `An approval record with requestId "${record.requestId}" already exists.`
        )
      }
      if (data.approvalIdIndex[record.approvalId]) {
        throw new WalletApprovalReceiverError(
          'DUPLICATE_APPROVAL_RECORD',
          `An approval record with approvalId "${record.approvalId}" already exists.`
        )
      }
      if (data.capabilityIdIndex[record.capabilityId]) {
        throw new WalletApprovalReceiverError(
          'DUPLICATE_APPROVAL_RECORD',
          `An approval record with capabilityId "${record.capabilityId}" already exists.`
        )
      }
      data.recordsByRequestId[record.requestId] = record
      data.approvalIdIndex[record.approvalId] = record.requestId
      data.capabilityIdIndex[record.capabilityId] = record.requestId
      this.saveData(data)
    })
  }

  async has(requestId: string): Promise<boolean> {
    const data = this.loadData()
    return Object.prototype.hasOwnProperty.call(data.recordsByRequestId, requestId)
  }

  async get(requestId: string): Promise<WalletApprovalLedgerRecord | undefined> {
    const data = this.loadData()
    return data.recordsByRequestId[requestId]
  }
}
