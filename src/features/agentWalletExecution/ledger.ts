/**
 * @file ledger.ts
 *
 * CANONICAL DURABLE TRANSACTIONAL WALLET EXECUTION LEDGER (Gate C2)
 *
 * Enforces cross-tab transactional exclusion, durable at-most-once execution,
 * crash consistency, outpoint reservation, and terminal state immutability.
 *
 * Canonical lock names:
 * - Global ledger lock: rmzwallet:agent-execution:lock:v2
 * - Per-execution signing lock: rmzwallet:agent-signing:<executionId>
 * - Settlement-store lock: rmzwallet:internal-settlement:lock:v2
 *
 * Canonical lock ordering (deadlock prevention):
 * 1. Per-execution signing lock is the outermost lock of the signing critical section.
 * 2. Global ledger lock is acquired only for short mutations and NEVER while waiting
 *    for a per-execution signing lock.
 * 3. Settlement-store lock is acquired only for write-once raw-tx persist, after the
 *    signing lock is already held, and is released before or without nesting a wait
 *    for the signing lock.
 *
 * Forbidden: hold global ledger lock → then wait for execution signing lock.
 * Recovery: snapshot SIGNING candidates under the ledger lock, release it, then
 * tryExclusive the per-execution signing lock (ifAvailable / non-blocking).
 *
 * Allowed Transitions:
 * APPROVED -> EXECUTION_RESERVED -> PREPARED -> SIGNING -> SIGNED
 * PREPARED -> REJECTED | FAILED | EXPIRED (pre-sign; outpoints released)
 * SIGNING -> SIGNED | SIGNING_UNCERTAIN (outpoints NOT released)
 * Terminal: SIGNED, REJECTED, FAILED, SIGNING_UNCERTAIN, EXPIRED (immutable).
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
export const EXECUTION_SIGNING_LOCK_PREFIX = 'rmzwallet:agent-signing:'

export function executionSigningLockName(executionId: string): string {
  return `${EXECUTION_SIGNING_LOCK_PREFIX}${executionId}`
}

export function canonicalOutpointKey(txid: string, outIdx: number): string {
  return `${String(txid).toLowerCase()}:${Number(outIdx)}`
}

export const VALID_EXECUTION_STATE_TRANSITIONS: Readonly<
  Record<WalletExecutionState, readonly WalletExecutionState[]>
> = Object.freeze({
  APPROVED: ['EXECUTION_RESERVED'],
  EXECUTION_RESERVED: ['PREPARED', 'REJECTED', 'FAILED', 'EXPIRED'],
  PREPARED: ['SIGNING', 'REJECTED', 'FAILED', 'EXPIRED'],
  SIGNING: ['SIGNED', 'SIGNING_UNCERTAIN'],
  SIGNED: [],
  REJECTED: [],
  FAILED: [],
  SIGNING_UNCERTAIN: [],
  EXPIRED: []
})

function releasesOutpointsOnTerminal(state: WalletExecutionState): boolean {
  return state === 'EXECUTION_RESERVED' || state === 'PREPARED'
}

/**
 * Coordination primitive port for atomic cross-tab/cross-context mutual exclusion.
 * tryExclusive MUST be non-blocking (ifAvailable). No in-memory production fallback.
 */
export interface ExecutionLockCoordinator {
  requestExclusive<T>(lockName: string, operation: () => Promise<T>): Promise<T>
  tryExclusive<T>(
    lockName: string,
    operation: () => Promise<T>
  ): Promise<{ acquired: false } | { acquired: true; result: T }>
}

/**
 * Production Web Locks coordinator. Fail closed when navigator.locks.request is absent.
 */
export class WebLocksExecutionCoordinator implements ExecutionLockCoordinator {
  private assertLocksAvailable(): void {
    if (typeof navigator === 'undefined' || !navigator.locks?.request) {
      throw new WalletExecutionError(
        'COORDINATION_UNAVAILABLE',
        'Cross-context coordination primitive (navigator.locks.request) is unavailable. Execution fails closed.'
      )
    }
  }

  async requestExclusive<T>(lockName: string, operation: () => Promise<T>): Promise<T> {
    this.assertLocksAvailable()
    return navigator.locks.request(lockName, { mode: 'exclusive' }, operation)
  }

  async tryExclusive<T>(
    lockName: string,
    operation: () => Promise<T>
  ): Promise<{ acquired: false } | { acquired: true; result: T }> {
    this.assertLocksAvailable()
    let acquired = false
    let result: T | undefined
    await navigator.locks.request(lockName, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (lock === null) {
        return
      }
      acquired = true
      result = await operation()
    })
    return acquired ? { acquired: true, result: result as T } : { acquired: false }
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
  readonly reservedOutpoints?: readonly string[]
}

interface DurableLedgerStoragePayloadV3 {
  readonly schemaVersion: 3
  generation: number
  records: Record<string, SerializedExecutionStateEntry>
  approvalIdIndex: Record<string, string>
  requestIdIndex: Record<string, string>
  outpointReservations: Record<string, string>
}

function emptyPayload(): DurableLedgerStoragePayloadV3 {
  return {
    schemaVersion: 3,
    generation: 0,
    records: {},
    approvalIdIndex: {},
    requestIdIndex: {},
    outpointReservations: {}
  }
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
 */
export class DurableTransactionalExecutionLedger implements WalletExecutionLedger {
  private readonly storage: Storage
  private readonly storageKey: string
  private readonly lockName: string
  private readonly coordinator: ExecutionLockCoordinator
  private readonly ready: Promise<void>

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
    this.ready = this.reconcileInterruptedSignings()
    this.ready.catch(() => {
      // Prevent unhandled rejection if callers have not yet awaited whenReady().
    })
  }

  async whenReady(): Promise<void> {
    await this.ready
  }

  async runWithSigningLock<T>(executionId: string, operation: () => Promise<T>): Promise<T> {
    return this.coordinator.requestExclusive(executionSigningLockName(executionId), operation)
  }

  private loadData(): DurableLedgerStoragePayloadV3 {
    const raw = this.storage.getItem(this.storageKey)
    if (!raw) {
      return emptyPayload()
    }
    try {
      const parsed = JSON.parse(raw) as {
        schemaVersion?: number
        generation?: number
        records?: Record<string, SerializedExecutionStateEntry>
        approvalIdIndex?: Record<string, string>
        requestIdIndex?: Record<string, string>
        outpointReservations?: Record<string, string>
      }
      if (!parsed || typeof parsed.records !== 'object') {
        throw new Error('Invalid storage schema')
      }
      if (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) {
        throw new Error('Invalid storage schema')
      }
      return {
        schemaVersion: 3,
        generation: parsed.generation ?? 0,
        records: parsed.records ?? {},
        approvalIdIndex: parsed.approvalIdIndex ?? {},
        requestIdIndex: parsed.requestIdIndex ?? {},
        outpointReservations: parsed.outpointReservations ?? {}
      }
    } catch (err) {
      throw new WalletExecutionError(
        'STORAGE_MUTATION_FAILED',
        `Failed to parse durable execution ledger data: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private saveData(data: DurableLedgerStoragePayloadV3): void {
    data.generation += 1
    try {
      this.storage.setItem(this.storageKey, JSON.stringify({ ...data, schemaVersion: 3 }))
    } catch (err) {
      throw new WalletExecutionError(
        'STORAGE_MUTATION_FAILED',
        `Failed to persist durable execution ledger data: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private releaseOutpoints(data: DurableLedgerStoragePayloadV3, executionId: string, keys: readonly string[] | undefined): void {
    if (!keys) return
    for (const key of keys) {
      if (data.outpointReservations[key] === executionId) {
        delete data.outpointReservations[key]
      }
    }
  }

  /**
   * Live-signer-safe crash recovery. Does not blindly convert every SIGNING record.
   */
  private async reconcileInterruptedSignings(): Promise<void> {
    const signingIds = await this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      return Object.keys(data.records).filter(id => data.records[id]?.state === 'SIGNING')
    })

    for (const executionId of signingIds) {
      const attempt = await this.coordinator.tryExclusive(
        executionSigningLockName(executionId),
        async () => {
          await this.coordinator.requestExclusive(this.lockName, async () => {
            const data = this.loadData()
            const record = data.records[executionId]
            if (!record || record.state !== 'SIGNING') {
              return
            }
            data.records[executionId] = {
              ...record,
              state: 'SIGNING_UNCERTAIN',
              uncertainReason:
                'Process interrupted during signing; reconciled to SIGNING_UNCERTAIN after acquiring abandoned signing lock.',
              failedAt: Math.floor(Date.now() / 1000)
            }
            this.saveData(data)
          })
        }
      )
      void attempt
    }
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

      const reservedOutpoints = plan.inputs.map(input => canonicalOutpointKey(input.txid, input.outIdx))
      for (const key of reservedOutpoints) {
        const owner = data.outpointReservations[key]
        if (owner && owner !== executionId) {
          throw new WalletExecutionError(
            'OUTPOINT_ALREADY_RESERVED',
            `Outpoint "${key}" is already reserved by execution "${owner}".`
          )
        }
      }
      for (const key of reservedOutpoints) {
        data.outpointReservations[key] = executionId
      }

      data.records[executionId] = {
        ...existing,
        state: 'PREPARED',
        planHash: plan.planHash,
        preparedAt,
        reservedOutpoints
      }

      this.saveData(data)
    })
  }

  async transitionToSigning(
    executionId: string,
    signingAt: number,
    plan: WalletPreparedExecutionPlan
  ): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
      }

      this.assertTransition(existing.state, 'SIGNING')

      const planKeys = plan.inputs.map(input => canonicalOutpointKey(input.txid, input.outIdx))
      const reserved = existing.reservedOutpoints ?? planKeys
      if (reserved.length !== planKeys.length || reserved.some((key, i) => key !== planKeys[i])) {
        throw new WalletExecutionError(
          'OUTPOINT_RESERVATION_MISMATCH',
          `Reserved outpoints do not match the immutable plan for execution "${executionId}".`
        )
      }
      for (const key of planKeys) {
        if (data.outpointReservations[key] !== executionId) {
          throw new WalletExecutionError(
            'OUTPOINT_RESERVATION_MISMATCH',
            `Execution "${executionId}" does not durably own outpoint "${key}".`
          )
        }
      }

      data.records[executionId] = {
        ...existing,
        state: 'SIGNING',
        signingAt,
        reservedOutpoints: planKeys
      }

      this.saveData(data)
    })
  }

  async transitionToSigned(
    executionId: string,
    rawSignedTxHex: string,
    signedAt: number
  ): Promise<void> {
    void rawSignedTxHex
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
      }

      this.assertTransition(existing.state, 'SIGNED')

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
      if (releasesOutpointsOnTerminal(existing.state)) {
        this.releaseOutpoints(data, executionId, existing.reservedOutpoints)
      }

      data.records[executionId] = {
        ...existing,
        state: 'FAILED',
        uncertainReason: reason,
        failedAt: timestamp,
        reservedOutpoints: releasesOutpointsOnTerminal(existing.state) ? [] : existing.reservedOutpoints
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
      if (releasesOutpointsOnTerminal(existing.state)) {
        this.releaseOutpoints(data, executionId, existing.reservedOutpoints)
      }

      data.records[executionId] = {
        ...existing,
        state: 'REJECTED',
        uncertainReason: reason,
        failedAt: timestamp,
        reservedOutpoints: releasesOutpointsOnTerminal(existing.state) ? [] : existing.reservedOutpoints
      }

      this.saveData(data)
    })
  }

  async markExpired(executionId: string, reason: string, timestamp: number): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[executionId]
      if (!existing) return

      this.assertTransition(existing.state, 'EXPIRED')
      if (releasesOutpointsOnTerminal(existing.state)) {
        this.releaseOutpoints(data, executionId, existing.reservedOutpoints)
      }

      data.records[executionId] = {
        ...existing,
        state: 'EXPIRED',
        uncertainReason: reason,
        failedAt: timestamp,
        reservedOutpoints: releasesOutpointsOnTerminal(existing.state) ? [] : existing.reservedOutpoints
      }

      this.saveData(data)
    })
  }

  async getOutpointReservation(outpointKey: string): Promise<string | undefined> {
    const data = this.loadData()
    return data.outpointReservations[outpointKey]
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

export { DurableTransactionalExecutionLedger as DurableStorageWalletExecutionLedger }
