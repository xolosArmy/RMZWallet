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
 * - Per-execution review lock: rmzwallet:agent-review:<executionId>
 * - Settlement-store lock: rmzwallet:internal-settlement:lock:v2
 *
 * Canonical lock ordering (deadlock prevention):
 * 1. Per-execution review lock (outermost for a live PREPARED review).
 * 2. Per-execution signing lock (acquired WHILE review ownership remains valid
 *    on the confirmation handoff; review lock is released only AFTER durable SIGNING).
 * 3. Global ledger lock is acquired only for short mutations and NEVER while waiting
 *    for a per-execution review or signing lock.
 * 4. Settlement-store lock is acquired only for write-once raw-tx persist, after the
 *    signing lock is already held.
 *
 * Canonical rank: review → signing → short global ledger → settlement-store.
 * Forbidden: hold global ledger lock → then wait for execution review/signing lock.
 * Forbidden: acquire signing lock → then attempt review lock.
 * Recovery: snapshot SIGNING/PREPARED candidates under the ledger lock, release it,
 * then tryExclusive the matching per-execution lock (ifAvailable / non-blocking).
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
  ExecutionReviewLease,
  PublicExecutionStatus,
  WalletExecutionLedger,
  WalletExecutionState,
  WalletPreparedExecutionPlan
} from './types'

export const DEFAULT_EXECUTION_LEDGER_STORAGE_KEY = 'rmzwallet_agent_execution_ledger_v2'
export const DEFAULT_EXECUTION_LOCK_NAME = 'rmzwallet:agent-execution:lock:v2'
export const EXECUTION_SIGNING_LOCK_PREFIX = 'rmzwallet:agent-signing:'
export const EXECUTION_REVIEW_LOCK_PREFIX = 'rmzwallet:agent-review:'
export const EXECUTION_SETTLEMENT_LOCK_PREFIX = 'rmzwallet:agent-settlement:'
export const DEFAULT_REVIEW_LEASE_TTL_SECONDS = 30

export function executionSigningLockName(executionId: string): string {
  return `${EXECUTION_SIGNING_LOCK_PREFIX}${executionId}`
}

export function executionReviewLockName(executionId: string): string {
  return `${EXECUTION_REVIEW_LOCK_PREFIX}${executionId}`
}

export function executionSettlementLockName(executionId: string): string {
  return `${EXECUTION_SETTLEMENT_LOCK_PREFIX}${executionId}`
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
  SIGNED: ['SETTLING'],
  SETTLING: ['SETTLED', 'SETTLEMENT_UNCERTAIN', 'SETTLEMENT_REJECTED'],
  SETTLEMENT_UNCERTAIN: ['SETTLED', 'SETTLEMENT_REJECTED'],
  SETTLED: [],
  SETTLEMENT_REJECTED: [],
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
  readonly settlingAt?: number
  readonly settledAt?: number
  readonly expectedTxid?: string
  readonly settlementAttempt?: number
  readonly failedAt?: number
  readonly reservedOutpoints?: readonly string[]
  readonly reviewOwnerId?: string
  readonly reviewLeaseExpiresAt?: number
  readonly reviewLeaseGeneration?: number
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
    settlingAt: entry.settlingAt,
    settledAt: entry.settledAt,
    expectedTxid: entry.expectedTxid,
    failedAt: entry.failedAt
  })
}

export interface DurableTransactionalExecutionLedgerOptions {
  readonly storage?: Storage | null
  readonly storageKey?: string
  readonly lockName?: string
  readonly lockCoordinator?: ExecutionLockCoordinator
  readonly clock?: () => number
  readonly settlementRecoveryHandler?: (
    executionId: string,
    expectedTxid?: string
  ) => Promise<void>
}

/**
 * Production durable transactional execution ledger backed by Storage and Web Locks.
 */
export class DurableTransactionalExecutionLedger implements WalletExecutionLedger {
  private readonly storage: Storage
  private readonly storageKey: string
  private readonly lockName: string
  private readonly coordinator: ExecutionLockCoordinator
  private readonly clock: () => number
  private readonly settlementRecoveryHandler?: (
    executionId: string,
    expectedTxid?: string
  ) => Promise<void>
  private ready: Promise<void> | null = null

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
    this.clock = options?.clock ?? (() => Math.floor(Date.now() / 1000))
    this.settlementRecoveryHandler = options?.settlementRecoveryHandler
  }

  async whenReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.reconcileInterruptedExecutions()
    }
    await this.ready
  }

  async runWithSigningLock<T>(executionId: string, operation: () => Promise<T>): Promise<T> {
    return this.coordinator.requestExclusive(executionSigningLockName(executionId), operation)
  }

  async runWithReviewLock<T>(executionId: string, operation: () => Promise<T>): Promise<T> {
    return this.coordinator.requestExclusive(executionReviewLockName(executionId), operation)
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
   * Live-signer/review-safe crash recovery.
   * SIGNING: only abandoned signers (review/signing lock available) become SIGNING_UNCERTAIN.
   * PREPARED: only expired leases whose review lock can be acquired become EXPIRED and release outpoints.
   * EXECUTION_RESERVED: never entered PREPARED/SIGNING; terminalize to FAILED and release outpoints.
   * SETTLING: query expectedTxid; if observed -> SETTLED; if ambiguous -> SETTLEMENT_UNCERTAIN. Never blindly rebroadcast.
   */
  private async reconcileInterruptedExecutions(): Promise<void> {
    const snapshot = await this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const reservedIds = Object.keys(data.records).filter(
        id => data.records[id]?.state === 'EXECUTION_RESERVED'
      )
      for (const executionId of reservedIds) {
        const record = data.records[executionId]
        if (!record || record.state !== 'EXECUTION_RESERVED') {
          continue
        }
        this.assertTransition(record.state, 'FAILED')
        this.releaseOutpoints(data, executionId, record.reservedOutpoints)
        data.records[executionId] = {
          ...record,
          state: 'FAILED',
          uncertainReason:
            'Abandoned EXECUTION_RESERVED: never reached PREPARED. Terminalized at startup. Outpoints released.',
          failedAt: this.clock(),
          reservedOutpoints: []
        }
      }
      if (reservedIds.length > 0) {
        this.saveData(data)
      }
      return {
        signingIds: Object.keys(data.records).filter(id => data.records[id]?.state === 'SIGNING'),
        preparedIds: Object.keys(data.records).filter(id => data.records[id]?.state === 'PREPARED'),
        settlingIds: Object.keys(data.records).filter(id => data.records[id]?.state === 'SETTLING')
      }
    })

    for (const executionId of snapshot.signingIds) {
      await this.coordinator.tryExclusive(executionSigningLockName(executionId), async () => {
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
            failedAt: this.clock()
          }
          this.saveData(data)
        })
      })
    }

    for (const executionId of snapshot.preparedIds) {
      await this.tryRecoverAbandonedPrepared(executionId)
    }

    for (const executionId of snapshot.settlingIds) {
      await this.coordinator.tryExclusive(executionSettlementLockName(executionId), async () => {
        const record = await this.coordinator.requestExclusive(this.lockName, async () => {
          return this.loadData().records[executionId]
        })
        if (!record || record.state !== 'SETTLING') {
          return
        }
        if (this.settlementRecoveryHandler) {
          await this.settlementRecoveryHandler(executionId, record.expectedTxid)
        } else {
          await this.markSettlementUncertain({
            executionId,
            reason:
              'Abandoned SETTLING execution recovered at startup without network observer. Reconciled to SETTLEMENT_UNCERTAIN.',
            timestamp: this.clock()
          })
        }
      })
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

  private commitPreparedInsideLedgerLock(
    data: DurableLedgerStoragePayloadV3,
    executionId: string,
    plan: WalletPreparedExecutionPlan,
    reviewOwnership: {
      readonly ownerId: string
      readonly generation: number
      readonly leaseTtlSeconds: number
    }
  ): ExecutionReviewLease {
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

    // Fresh lease timestamp is sampled inside this exclusive mutation.
    // There is no await between freshNow and durable commit.
    const freshNow = this.clock()
    const reviewLease: ExecutionReviewLease = {
      ownerId: reviewOwnership.ownerId,
      generation: reviewOwnership.generation,
      leaseExpiresAt: freshNow + reviewOwnership.leaseTtlSeconds
    }

    data.records[executionId] = {
      ...existing,
      state: 'PREPARED',
      planHash: plan.planHash,
      preparedAt: freshNow,
      reservedOutpoints,
      reviewOwnerId: reviewLease.ownerId,
      reviewLeaseExpiresAt: reviewLease.leaseExpiresAt,
      reviewLeaseGeneration: reviewLease.generation
    }

    this.saveData(data)
    return reviewLease
  }

  private inspectExpiredPreparedOutpointOwner(
    data: DurableLedgerStoragePayloadV3,
    executionId: string,
    plan: WalletPreparedExecutionPlan
  ): string | undefined {
    const reservedOutpoints = plan.inputs.map(input => canonicalOutpointKey(input.txid, input.outIdx))
    const now = this.clock()
    for (const key of reservedOutpoints) {
      const ownerId = data.outpointReservations[key]
      if (!ownerId || ownerId === executionId) {
        continue
      }
      const owner = data.records[ownerId]
      if (
        owner &&
        owner.state === 'PREPARED' &&
        (owner.reviewLeaseExpiresAt ?? 0) <= now
      ) {
        return ownerId
      }
    }
    return undefined
  }

  async setPlanPrepared(
    executionId: string,
    plan: WalletPreparedExecutionPlan,
    reviewOwnership: {
      readonly ownerId: string
      readonly generation: number
      readonly leaseTtlSeconds: number
    }
  ): Promise<ExecutionReviewLease> {
    const first = await this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const recoverableOwner = this.inspectExpiredPreparedOutpointOwner(data, executionId, plan)
      if (recoverableOwner) {
        return { kind: 'recover' as const, ownerId: recoverableOwner }
      }
      return {
        kind: 'commit' as const,
        lease: this.commitPreparedInsideLedgerLock(data, executionId, plan, reviewOwnership)
      }
    })

    if (first.kind === 'commit') {
      return first.lease
    }

    const recovered = await this.tryRecoverAbandonedPrepared(first.ownerId)
    if (recovered === 'still_live') {
      throw new WalletExecutionError(
        'OUTPOINT_ALREADY_RESERVED',
        `Outpoint is already reserved by execution "${first.ownerId}" and could not be reclaimed.`
      )
    }

    // reclaimed OR not_prepared (concurrent recovery already terminalized the owner):
    // re-read durable reservations and retry the PREPARED commit exactly once.
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      return this.commitPreparedInsideLedgerLock(data, executionId, plan, reviewOwnership)
    })
  }

  async snapshotPreparedLeases(): Promise<
    ReadonlyArray<{ readonly executionId: string; readonly leaseExpiresAt: number }>
  > {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const leases: Array<{ executionId: string; leaseExpiresAt: number }> = []
      for (const [executionId, record] of Object.entries(data.records)) {
        if (record.state !== 'PREPARED' || record.reviewLeaseExpiresAt === undefined) {
          continue
        }
        leases.push({ executionId, leaseExpiresAt: record.reviewLeaseExpiresAt })
      }
      return leases
    })
  }

  async tryRecoverAbandonedPrepared(
    executionId: string
  ): Promise<'reclaimed' | 'still_live' | 'not_prepared'> {
    const attempt = await this.coordinator.tryExclusive(executionReviewLockName(executionId), async () => {
      return this.coordinator.requestExclusive(this.lockName, async () => {
        const data = this.loadData()
        const record = data.records[executionId]
        if (!record || record.state !== 'PREPARED') {
          return 'not_prepared' as const
        }
        const now = this.clock()
        if ((record.reviewLeaseExpiresAt ?? 0) > now) {
          return 'still_live' as const
        }
        this.assertTransition(record.state, 'EXPIRED')
        this.releaseOutpoints(data, executionId, record.reservedOutpoints)
        data.records[executionId] = {
          ...record,
          state: 'EXPIRED',
          uncertainReason:
            'Abandoned PREPARED review: lease expired and review lock was acquired. Outpoints released.',
          failedAt: now,
          reservedOutpoints: [],
          reviewOwnerId: record.reviewOwnerId,
          reviewLeaseExpiresAt: record.reviewLeaseExpiresAt,
          reviewLeaseGeneration: record.reviewLeaseGeneration
        }
        this.saveData(data)
        return 'reclaimed' as const
      })
    })
    if (!attempt.acquired) {
      return 'still_live'
    }
    return attempt.result
  }

  async renewReviewLease(params: {
    readonly executionId: string
    readonly ownerId: string
    readonly generation: number
    readonly now: number
    readonly leaseTtlSeconds: number
  }): Promise<ExecutionReviewLease> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[params.executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${params.executionId}" not found.`)
      }
      if (existing.state !== 'PREPARED') {
        throw new WalletExecutionError(
          'REVIEW_LEASE_REJECTED',
          `Cannot renew review lease for execution "${params.executionId}" in state "${existing.state}".`
        )
      }
      if (existing.reviewOwnerId !== params.ownerId || existing.reviewLeaseGeneration !== params.generation) {
        throw new WalletExecutionError(
          'REVIEW_LEASE_REJECTED',
          `Stale review owner cannot renew lease for execution "${params.executionId}".`
        )
      }
      const next: ExecutionReviewLease = {
        ownerId: params.ownerId,
        generation: params.generation + 1,
        leaseExpiresAt: params.now + params.leaseTtlSeconds
      }
      data.records[params.executionId] = {
        ...existing,
        reviewOwnerId: next.ownerId,
        reviewLeaseGeneration: next.generation,
        reviewLeaseExpiresAt: next.leaseExpiresAt
      }
      this.saveData(data)
      return next
    })
  }

  async getReviewLease(executionId: string): Promise<ExecutionReviewLease | undefined> {
    const data = this.loadData()
    const record = data.records[executionId]
    if (!record?.reviewOwnerId || record.reviewLeaseExpiresAt === undefined || record.reviewLeaseGeneration === undefined) {
      return undefined
    }
    return {
      ownerId: record.reviewOwnerId,
      leaseExpiresAt: record.reviewLeaseExpiresAt,
      generation: record.reviewLeaseGeneration
    }
  }

  async transitionToSigningIfValid(params: {
    readonly executionId: string
    readonly plan: WalletPreparedExecutionPlan
    readonly effectiveExpiresAt: number
    readonly now: () => number
  }): Promise<void> {
    const { executionId, plan, effectiveExpiresAt, now } = params
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
      }
      if (existing.state !== 'PREPARED') {
        throw new WalletExecutionError(
          'INVALID_STATE_TRANSITION',
          `Cannot transition execution record from terminal state "${existing.state}" to "SIGNING".`
        )
      }

      const planKeys = plan.inputs.map(input => canonicalOutpointKey(input.txid, input.outIdx))
      if (new Set(planKeys).size !== planKeys.length) {
        throw new WalletExecutionError(
          'DUPLICATE_UTXO_OUTPOINT',
          `Plan for execution "${executionId}" contains duplicate input outpoints.`
        )
      }
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

      const signingAt = now()
      if (signingAt >= effectiveExpiresAt) {
        this.assertTransition(existing.state, 'EXPIRED')
        this.releaseOutpoints(data, executionId, existing.reservedOutpoints)
        data.records[executionId] = {
          ...existing,
          state: 'EXPIRED',
          uncertainReason: 'Approval expired inside PREPARED -> SIGNING exclusive mutation.',
          failedAt: signingAt,
          reservedOutpoints: []
        }
        this.saveData(data)
        throw new WalletExecutionError(
          'APPROVAL_EXPIRED',
          'Approval expired inside the exclusive PREPARED -> SIGNING mutation. Cryptographic signing was not started.'
        )
      }

      this.assertTransition(existing.state, 'SIGNING')
      data.records[executionId] = {
        ...existing,
        state: 'SIGNING',
        signingAt,
        reservedOutpoints: planKeys
      }

      this.saveData(data)
    })
  }

  async transitionToSigned(executionId: string, signedAt: number): Promise<void> {
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

  async runWithSettlementLock<T>(executionId: string, operation: () => Promise<T>): Promise<T> {
    return this.coordinator.requestExclusive(executionSettlementLockName(executionId), operation)
  }

  async transitionToSettling(params: {
    readonly executionId: string
    readonly expectedTxid: string
    readonly settlingAt: number
  }): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[params.executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${params.executionId}" not found.`)
      }

      this.assertTransition(existing.state, 'SETTLING')

      data.records[params.executionId] = {
        ...existing,
        state: 'SETTLING',
        expectedTxid: params.expectedTxid.toLowerCase(),
        settlingAt: params.settlingAt,
        settlementAttempt: (existing.settlementAttempt ?? 0) + 1
      }

      this.saveData(data)
    })
  }

  async transitionToSettled(params: {
    readonly executionId: string
    readonly expectedTxid: string
    readonly settledAt: number
  }): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[params.executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${params.executionId}" not found.`)
      }

      this.assertTransition(existing.state, 'SETTLED')

      if (existing.expectedTxid && existing.expectedTxid.toLowerCase() !== params.expectedTxid.toLowerCase()) {
        throw new WalletExecutionError(
          'SETTLEMENT_TXID_MISMATCH',
          `Cannot settle execution "${params.executionId}" with txid "${params.expectedTxid}" (expected "${existing.expectedTxid}").`
        )
      }

      data.records[params.executionId] = {
        ...existing,
        state: 'SETTLED',
        expectedTxid: params.expectedTxid.toLowerCase(),
        settledAt: params.settledAt
      }

      this.saveData(data)
    })
  }

  async markSettlementUncertain(params: {
    readonly executionId: string
    readonly reason: string
    readonly timestamp: number
  }): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[params.executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${params.executionId}" not found.`)
      }

      this.assertTransition(existing.state, 'SETTLEMENT_UNCERTAIN')

      data.records[params.executionId] = {
        ...existing,
        state: 'SETTLEMENT_UNCERTAIN',
        uncertainReason: params.reason,
        failedAt: params.timestamp
      }

      this.saveData(data)
    })
  }

  async markSettlementRejected(params: {
    readonly executionId: string
    readonly reason: string
    readonly timestamp: number
    readonly releaseOutpoints?: boolean
  }): Promise<void> {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const existing = data.records[params.executionId]
      if (!existing) {
        throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${params.executionId}" not found.`)
      }

      this.assertTransition(existing.state, 'SETTLEMENT_REJECTED')

      const release = params.releaseOutpoints === true
      if (release) {
        this.releaseOutpoints(data, params.executionId, existing.reservedOutpoints)
      }

      data.records[params.executionId] = {
        ...existing,
        state: 'SETTLEMENT_REJECTED',
        uncertainReason: params.reason,
        failedAt: params.timestamp,
        reservedOutpoints: release ? [] : existing.reservedOutpoints
      }

      this.saveData(data)
    })
  }

  async snapshotSettlingRecords(): Promise<
    ReadonlyArray<{ readonly executionId: string; readonly expectedTxid?: string }>
  > {
    return this.coordinator.requestExclusive(this.lockName, async () => {
      const data = this.loadData()
      const results: Array<{ executionId: string; expectedTxid?: string }> = []
      for (const record of Object.values(data.records)) {
        if (record && record.state === 'SETTLING') {
          results.push({ executionId: record.executionId, expectedTxid: record.expectedTxid })
        }
      }
      return results
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
