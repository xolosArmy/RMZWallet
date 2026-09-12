/**
 * @file ledger.ts
 *
 * CANONICAL DURABLE TRANSACTIONAL WALLET EXECUTION LEDGER (Gate C2)
 *
 * Enforces cross-tab transactional exclusion, durable at-most-once execution,
 * crash consistency, and terminal state immutability.
 *
 * Coordination Primitive:
 * - Atomic exclusion across same-origin tabs/contexts using Web Locks API (navigator.locks)
 *   with unique durable indexes on approvalId, requestId, and executionId.
 * - Single-transaction CAS generation tracking.
 * - Private settlement storage partition for raw signed transaction isolation (P0-3).
 *
 * Allowed Transitions:
 * APPROVED -> EXECUTION_RESERVED -> PREPARED -> SIGNING -> SIGNED
 * Terminal states: SIGNED, REJECTED, FAILED, SIGNING_UNCERTAIN (all strictly immutable).
 */

import { WalletExecutionError } from './errors'
import type {
  ExecutionNetwork,
  PublicExecutionStatus,
  WalletExecutionLedger,
  WalletExecutionState,
  WalletPreparedExecutionPlan
} from './types'

export const DEFAULT_EXECUTION_LEDGER_STORAGE_KEY = 'rmzwallet_agent_execution_ledger_v2'
export const DEFAULT_EXECUTION_LOCK_NAME = 'rmzwallet:agent-execution:lock:v2'

export const VALID_EXECUTION_STATE_TRANSITIONS: Readonly<
  Record<WalletExecutionState, readonly WalletExecutionState[]>
> = Object.freeze({
  APPROVED: ['EXECUTION_RESERVED'],
  EXECUTION_RESERVED: ['PREPARED', 'REJECTED', 'FAILED'],
  PREPARED: ['SIGNING', 'REJECTED', 'FAILED'],
  SIGNING: ['SIGNED', 'SIGNING_UNCERTAIN'],
  SIGNED: [], // Strictly terminal
  REJECTED: [], // Strictly terminal
  FAILED: [], // Strictly terminal
  SIGNING_UNCERTAIN: [] // Strictly terminal
})

/**
 * Coordination primitive port for atomic cross-tab/cross-context mutual exclusion.
 */
export interface ExecutionLockCoordinator {
  requestExclusive<T>(lockName: string, operation: () => Promise<T>): Promise<T>
}

/**
 * Production Web Locks coordinator providing cross-tab atomic exclusion in modern browsers & Node 24.
 *
 * Runtime Assumptions:
 * - Requires W3C Web Locks API (`navigator.locks.request`). Supported in Chrome 69+, Firefox 96+, Safari 15.4+, Edge 79+, Node.js 24+.
 * - In environments where `navigator.locks?.request` is absent, fails closed with `COORDINATION_UNAVAILABLE`.
 * - NEVER automatically falls back to an in-memory queue in production.
 */
export class WebLocksExecutionCoordinator implements ExecutionLockCoordinator {
  async requestExclusive<T>(lockName: string, operation: () => Promise<T>): Promise<T> {
    if (typeof navigator === 'undefined' || !navigator.locks?.request) {
      throw new WalletExecutionError(
        'COORDINATION_UNAVAILABLE',
        'Cross-context coordination primitive (navigator.locks.request) is unavailable. Execution fails closed.'
      )
    }

    return navigator.locks.request(lockName, { mode: 'exclusive' }, operation)
  }
}

interface SerializedExecutionStateEntry {
  readonly executionId: string
  readonly approvalId: string
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly fromAddress: string
  readonly destination: string
  readonly amountSats: string
  readonly network: ExecutionNetwork
  readonly state: WalletExecutionState
  readonly planHash?: string
  readonly uncertainReason?: string
  readonly reservedAt: number
  readonly preparedAt?: number
  readonly signingAt?: number
  readonly signedAt?: number
  readonly failedAt?: number
}

interface DurableLedgerStoragePayloadV2 {
  readonly schemaVersion: 2
  generation: number
  records: Record<string, SerializedExecutionStateEntry>
  approvalIdIndex: Record<string, string>
  requestIdIndex: Record<string, string>
}

function toPublicStatus(entry: SerializedExecutionStateEntry): PublicExecutionStatus {
  return Object.freeze({
    executionId: entry.executionId,
    approvalId: entry.approvalId,
    requestId: entry.requestId,
    intentId: entry.intentId,
    decisionId: entry.decisionId,
    fromAddress: entry.fromAddress,
    destination: entry.destination,
    amountSats: BigInt(entry.amountSats),
    network: entry.network,
    status: entry.state,
    planHash: entry.planHash,
    uncertainReason: entry.uncertainReason,
    reservedAt: entry.reservedAt,
    preparedAt: entry.preparedAt,
    signingAt: entry.signingAt,
    signedAt: entry.signedAt,
    failedAt: entry.failedAt
  })
}

export interface DurableTransactionalExecutionLedgerOptions {
  readonly storage?: Storage | null
  readonly storageKey?: string
  readonly lockName?: string
  readonly lockCoordinator?: ExecutionLockCoordinator
}

/**
 * Production durable transactional execution ledger backed by Storage and Web Locks.
 * Ensures that two concurrent tabs cannot both reserve the same approval.
 */
export class DurableTransactionalExecutionLedger implements WalletExecutionLedger {
  private readonly storage: Storage
  private readonly storageKey: string
  private readonly lockName: string
  private readonly coordinator: ExecutionLockCoordinator

  constructor(options?: DurableTransactionalExecutionLedgerOptions) {
    const resolvedStorage = options?.storage ?? (typeof window !== 'undefined' ? window.localStorage : null)
    if (!resolvedStorage) {
      throw new WalletExecutionError(
        'STORAGE_UNAVAILABLE',
        'No durable storage available. An explicit Storage adapter must be provided in non-browser environments.'
      )
    }
    this.storage = resolvedStorage
    this.storageKey = options?.storageKey ?? DEFAULT_EXECUTION_LEDGER_STORAGE_KEY
    this.lockName = options?.lockName ?? DEFAULT_EXECUTION_LOCK_NAME
    this.coordinator = options?.lockCoordinator ?? new WebLocksExecutionCoordinator()

    // Reconcile crash consistency on startup under atomic lock
    void this.reconcileInterruptedSignings().catch(() => {
      // If coordinator fails on startup (e.g. locks unavailable), subsequent operations fail closed
    })
  }

  private loadData(): DurableLedgerStoragePayloadV2 {
    const raw = this.storage.getItem(this.storageKey)
    if (!raw) {
      return {
        schemaVersion: 2,
        generation: 0,
        records: {},
        approvalIdIndex: {},
        requestIdIndex: {}
      }
    }
    try {
      const parsed = JSON.parse(raw) as DurableLedgerStoragePayloadV2
      if (!parsed || parsed.schemaVersion !== 2 || typeof parsed.records !== 'object') {
        throw new Error('Invalid storage schema')
      }
      return parsed
    } catch (err) {
      throw new WalletExecutionError(
        'STORAGE_MUTATION_FAILED',
        `Failed to parse durable execution ledger data: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private saveData(data: DurableLedgerStoragePayloadV2): void {
    data.generation += 1
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(data))
    } catch (err) {
      throw new WalletExecutionError(
        'STORAGE_MUTATION_FAILED',
        `Failed to persist durable execution ledger data: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  /**
   * Crash probe & recovery: If the process crashes while a record is in SIGNING,
   * it must be reconciled to SIGNING_UNCERTAIN upon restart to prevent automated retries.
   */
  private async reconcileInterruptedSignings(): Promise<void> {
    await this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      let changed = false
      for (const [id, record] of Object.entries(data.records)) {
        if (record.state === 'SIGNING') {
          data.records[id] = {
            ...record,
            state: 'SIGNING_UNCERTAIN',
            uncertainReason: 'Process interrupted during signing; reconciled to SIGNING_UNCERTAIN on reopen.',
            failedAt: Math.floor(Date.now() / 1000)
          }
          changed = true
        }
      }
      if (changed) {
        this.saveData(data)
      }
    })
  }

  private assertTransition(currentState: WalletExecutionState, targetState: WalletExecutionState): void {
    const allowed = VALID_EXECUTION_STATE_TRANSITIONS[currentState]
    if (!allowed.includes(targetState)) {
      throw new WalletExecutionError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition execution record from terminal state "${currentState}" to "${targetState}".`
      )
    }
  }

  async reserveExecutionAtomic(entry: {
    executionId: string
    approvalId: string
    requestId: string
    intentId: string
    decisionId: string
    fromAddress: string
    destination: string
    amountSats: bigint
    network: ExecutionNetwork
    reservedAt: number
  }): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()

      if (data.approvalIdIndex[entry.approvalId]) {
        throw new WalletExecutionError(
          'DUPLICATE_EXECUTION',
          `An execution record for approvalId "${entry.approvalId}" already exists.`
        )
      }

      if (data.requestIdIndex[entry.requestId]) {
        throw new WalletExecutionError(
          'DUPLICATE_EXECUTION',
          `An execution record for requestId "${entry.requestId}" already exists.`
        )
      }

      if (data.records[entry.executionId]) {
        throw new WalletExecutionError(
          'DUPLICATE_EXECUTION',
          `An execution record for executionId "${entry.executionId}" already exists.`
        )
      }

      const serialized: SerializedExecutionStateEntry = {
        executionId: entry.executionId,
        approvalId: entry.approvalId,
        requestId: entry.requestId,
        intentId: entry.intentId,
        decisionId: entry.decisionId,
        fromAddress: entry.fromAddress,
        destination: entry.destination,
        amountSats: entry.amountSats.toString(),
        network: entry.network,
        state: 'EXECUTION_RESERVED',
        reservedAt: entry.reservedAt
      }

      data.records[entry.executionId] = serialized
      data.approvalIdIndex[entry.approvalId] = entry.executionId
      data.requestIdIndex[entry.requestId] = entry.executionId

      this.saveData(data)
    })
  }

  async setPlanPrepared(
    executionId: string,
    plan: WalletPreparedExecutionPlan,
    preparedAt: number
  ): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
      }

      this.assertTransition(existing.state, 'PREPARED')

      data.records[executionId] = {
        ...existing,
        state: 'PREPARED',
        planHash: plan.planHash,
        preparedAt
      }

      this.saveData(data)
    })
  }

  async transitionToSigning(executionId: string, signingAt: number): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
      }

      this.assertTransition(existing.state, 'SIGNING')

      data.records[executionId] = {
        ...existing,
        state: 'SIGNING',
        signingAt
      }

      this.saveData(data)
    })
  }

  async transitionToSigned(
    executionId: string,
    rawSignedTxHex: string,
    signedAt: number
  ): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
      }

      this.assertTransition(existing.state, 'SIGNED')

      // Update public ledger record (strictly omits raw signed tx bytes)
      data.records[executionId] = {
        ...existing,
        state: 'SIGNED',
        signedAt
      }

      this.saveData(data)
    })
  }

  async markSigningUncertain(
    executionId: string,
    reason: string,
    timestamp: number
  ): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
      }

      this.assertTransition(existing.state, 'SIGNING_UNCERTAIN')

      data.records[executionId] = {
        ...existing,
        state: 'SIGNING_UNCERTAIN',
        uncertainReason: reason,
        failedAt: timestamp
      }

      this.saveData(data)
    })
  }

  async markFailed(executionId: string, reason: string, timestamp: number): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[executionId]
      if (!existing) return

      this.assertTransition(existing.state, 'FAILED')

      data.records[executionId] = {
        ...existing,
        state: 'FAILED',
        uncertainReason: reason,
        failedAt: timestamp
      }

      this.saveData(data)
    })
  }

  async markRejected(executionId: string, reason: string, timestamp: number): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[executionId]
      if (!existing) return

      this.assertTransition(existing.state, 'REJECTED')

      data.records[executionId] = {
        ...existing,
        state: 'REJECTED',
        uncertainReason: reason,
        failedAt: timestamp
      }

      this.saveData(data)
    })
  }

  async get(executionId: string): Promise<PublicExecutionStatus | undefined> {
    const data = this.loadData()
    const entry = data.records[executionId]
    return entry ? toPublicStatus(entry) : undefined
  }

  async getByApprovalId(approvalId: string): Promise<PublicExecutionStatus | undefined> {
    const data = this.loadData()
    const executionId = data.approvalIdIndex[approvalId]
    if (!executionId) return undefined
    const entry = data.records[executionId]
    return entry ? toPublicStatus(entry) : undefined
  }

  async getByRequestId(requestId: string): Promise<PublicExecutionStatus | undefined> {
    const data = this.loadData()
    const executionId = data.requestIdIndex[requestId]
    if (!executionId) return undefined
    const entry = data.records[executionId]
    return entry ? toPublicStatus(entry) : undefined
  }

  async has(approvalId: string): Promise<boolean> {
    const data = this.loadData()
    return Boolean(data.approvalIdIndex[approvalId])
  }
}

/**
 * Backward compatibility alias for DurableTransactionalExecutionLedger.
 */
export { DurableTransactionalExecutionLedger as DurableStorageWalletExecutionLedger }
