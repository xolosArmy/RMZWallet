/**
 * @file testUtils.ts
 *
 * Test utilities and in-memory test doubles for agentWalletExecution test suites.
 * In-memory ledgers and mock storages live strictly in testUtils and are NEVER exported in production index.ts.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { WalletExecutionError } from './errors'
import {
  canonicalOutpointKey,
  DEFAULT_EXECUTION_LOCK_NAME,
  EXECUTION_REVIEW_LOCK_PREFIX,
  EXECUTION_SIGNING_LOCK_PREFIX,
  VALID_EXECUTION_STATE_TRANSITIONS
} from './ledger'
import type { ExecutionLockCoordinator } from './ledger'
import { DEFAULT_SETTLEMENT_STORE_LOCK_NAME } from '../../internal/settlementStore'

const testLockOrderAls = new AsyncLocalStorage<readonly number[]>()

export function testLockRank(lockName: string): number {
  if (lockName.startsWith(EXECUTION_REVIEW_LOCK_PREFIX)) return 10
  if (lockName.startsWith(EXECUTION_SIGNING_LOCK_PREFIX)) return 20
  if (lockName === DEFAULT_EXECUTION_LOCK_NAME) return 30
  if (lockName === DEFAULT_SETTLEMENT_STORE_LOCK_NAME) return 40
  return 100
}

function assertTestLockOrder(lockName: string): void {
  const held = testLockOrderAls.getStore() ?? []
  if (held.length === 0) return
  const rank = testLockRank(lockName)
  const maxHeld = Math.max(...held)
  if (rank < maxHeld) {
    throw new WalletExecutionError(
      'LOCK_ORDER_VIOLATION',
      `Forbidden lock order: holding rank ${maxHeld} then acquiring "${lockName}" (rank ${rank}). Canonical order is review → signing → global ledger → settlement.`
    )
  }
}
import type {
  ExecutionNetwork,
  ExecutionReviewLease,
  InternalWalletExecutionRecord,
  PublicExecutionStatus,
  WalletExecutionLedger,
  WalletExecutionState,
  WalletPreparedExecutionPlan
} from './types'

/**
 * Explicit test/simulation coordinator using an in-process serialized Promise queue.
 * Strictly for test suites; NEVER used as an automatic fallback in production.
 */
export class TestExecutionLockCoordinator implements ExecutionLockCoordinator {
  private readonly queues = new Map<string, Promise<unknown>>()

  async requestExclusive<T>(lockName: string, operation: () => Promise<T>): Promise<T> {
    assertTestLockOrder(lockName)
    const parentHeld = testLockOrderAls.getStore() ?? []
    const nextHeld = [...parentHeld, testLockRank(lockName)]
    return testLockOrderAls.run(nextHeld, async () => {
      let resolveQueue: (() => void) | undefined
      const queuePromise = new Promise<void>(res => {
        resolveQueue = res
      })
      const prevQueue = this.queues.get(lockName) ?? Promise.resolve()
      this.queues.set(lockName, queuePromise)

      await prevQueue
      try {
        return await operation()
      } finally {
        resolveQueue?.()
        if (this.queues.get(lockName) === queuePromise) {
          this.queues.delete(lockName)
        }
      }
    })
  }

  async tryExclusive<T>(
    lockName: string,
    operation: () => Promise<T>
  ): Promise<{ acquired: false } | { acquired: true; result: T }> {
    if (this.queues.has(lockName)) {
      return { acquired: false }
    }
    const result = await this.requestExclusive(lockName, operation)
    return { acquired: true, result }
  }
}

export class MockStorage implements Storage {
  private items = new Map<string, string>()

  get length(): number {
    return this.items.size
  }

  clear(): void {
    this.items.clear()
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.items.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.items.delete(key)
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
}

export class InMemoryWalletExecutionLedger implements WalletExecutionLedger {
  private readonly recordsByExecutionId = new Map<string, InternalWalletExecutionRecord>()
  private readonly recordsByApprovalId = new Map<string, InternalWalletExecutionRecord>()
  private readonly recordsByRequestId = new Map<string, InternalWalletExecutionRecord>()
  private readonly outpointReservations = new Map<string, string>()
  private readonly clock: () => number

  constructor(clock?: () => number) {
    this.clock = clock ?? (() => Math.floor(Date.now() / 1000))
  }

  async whenReady(): Promise<void> {}

  async runWithSigningLock<T>(_executionId: string, operation: () => Promise<T>): Promise<T> {
    return operation()
  }

  async runWithReviewLock<T>(_executionId: string, operation: () => Promise<T>): Promise<T> {
    return operation()
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
    if (this.recordsByApprovalId.has(entry.approvalId)) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        `An execution record for approvalId "${entry.approvalId}" already exists.`
      )
    }

    if (this.recordsByRequestId.has(entry.requestId)) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        `An execution record for requestId "${entry.requestId}" already exists.`
      )
    }

    if (this.recordsByExecutionId.has(entry.executionId)) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        `An execution record for executionId "${entry.executionId}" already exists.`
      )
    }

    const record: InternalWalletExecutionRecord = Object.freeze({
      executionId: entry.executionId,
      approvalId: entry.approvalId,
      requestId: entry.requestId,
      intentId: entry.intentId,
      decisionId: entry.decisionId,
      fromAddress: entry.fromAddress,
      destination: entry.destination,
      amountSats: entry.amountSats,
      network: entry.network,
      state: 'EXECUTION_RESERVED',
      reservedAt: entry.reservedAt
    })

    this.commitUpdate(record)
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
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(existing.state, 'PREPARED')

    const reservedOutpoints = plan.inputs.map(input => canonicalOutpointKey(input.txid, input.outIdx))
    const recoverableOwners = new Set<string>()
    for (const key of reservedOutpoints) {
      const owner = this.outpointReservations.get(key)
      if (owner && owner !== executionId) {
        const ownerRecord = this.recordsByExecutionId.get(owner)
        const now = this.clock()
        if (
          ownerRecord &&
          ownerRecord.state === 'PREPARED' &&
          (ownerRecord.reviewLeaseExpiresAt ?? 0) <= now
        ) {
          recoverableOwners.add(owner)
          continue
        }
        throw new WalletExecutionError(
          'OUTPOINT_ALREADY_RESERVED',
          `Outpoint "${key}" is already reserved by execution "${owner}".`
        )
      }
    }
    if (recoverableOwners.size > 0) {
      for (const ownerId of recoverableOwners) {
        const recovered = await this.tryRecoverAbandonedPrepared(ownerId)
        if (recovered === 'still_live') {
          throw new WalletExecutionError(
            'OUTPOINT_ALREADY_RESERVED',
            `Outpoint is already reserved by execution "${ownerId}" and could not be reclaimed.`
          )
        }
      }
    }
    for (const key of reservedOutpoints) {
      const owner = this.outpointReservations.get(key)
      if (owner && owner !== executionId) {
        throw new WalletExecutionError(
          'OUTPOINT_ALREADY_RESERVED',
          `Outpoint "${key}" is already reserved by execution "${owner}".`
        )
      }
    }
    for (const key of reservedOutpoints) {
      this.outpointReservations.set(key, executionId)
    }

    const freshNow = this.clock()
    const reviewLease: ExecutionReviewLease = {
      ownerId: reviewOwnership.ownerId,
      generation: reviewOwnership.generation,
      leaseExpiresAt: freshNow + reviewOwnership.leaseTtlSeconds
    }

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      plan,
      planHash: plan.planHash,
      state: 'PREPARED',
      preparedAt: freshNow,
      reservedOutpoints,
      reviewOwnerId: reviewLease.ownerId,
      reviewLeaseExpiresAt: reviewLease.leaseExpiresAt,
      reviewLeaseGeneration: reviewLease.generation
    })

    this.commitUpdate(updated)
    return reviewLease
  }

  async snapshotPreparedLeases(): Promise<
    ReadonlyArray<{ readonly executionId: string; readonly leaseExpiresAt: number }>
  > {
    const leases: Array<{ executionId: string; leaseExpiresAt: number }> = []
    for (const record of this.recordsByExecutionId.values()) {
      if (record.state !== 'PREPARED' || record.reviewLeaseExpiresAt === undefined) {
        continue
      }
      leases.push({ executionId: record.executionId, leaseExpiresAt: record.reviewLeaseExpiresAt })
    }
    return leases
  }

  async tryRecoverAbandonedPrepared(
    executionId: string
  ): Promise<'reclaimed' | 'still_live' | 'not_prepared'> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing || existing.state !== 'PREPARED') {
      return 'not_prepared'
    }
    const now = this.clock()
    if ((existing.reviewLeaseExpiresAt ?? 0) > now) {
      return 'still_live'
    }
    this.assertTransition(existing.state, 'EXPIRED')
    this.releaseOwnedOutpoints(executionId, existing.reservedOutpoints)
    this.commitUpdate(
      Object.freeze({
        ...existing,
        state: 'EXPIRED' as const,
        uncertainReason:
          'Abandoned PREPARED review: lease expired and review lock was acquired. Outpoints released.',
        failedAt: now,
        reservedOutpoints: []
      })
    )
    return 'reclaimed'
  }

  async renewReviewLease(params: {
    readonly executionId: string
    readonly ownerId: string
    readonly generation: number
    readonly now: number
    readonly leaseTtlSeconds: number
  }): Promise<ExecutionReviewLease> {
    const existing = this.recordsByExecutionId.get(params.executionId)
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
    this.commitUpdate(
      Object.freeze({
        ...existing,
        reviewOwnerId: next.ownerId,
        reviewLeaseGeneration: next.generation,
        reviewLeaseExpiresAt: next.leaseExpiresAt
      })
    )
    return next
  }

  async getReviewLease(executionId: string): Promise<ExecutionReviewLease | undefined> {
    const record = this.recordsByExecutionId.get(executionId)
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
    const existing = this.recordsByExecutionId.get(executionId)
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
    for (const key of planKeys) {
      if (this.outpointReservations.get(key) !== executionId) {
        throw new WalletExecutionError(
          'OUTPOINT_RESERVATION_MISMATCH',
          `Execution "${executionId}" does not durably own outpoint "${key}".`
        )
      }
    }

    const signingAt = now()
    if (signingAt >= effectiveExpiresAt) {
      this.assertTransition(existing.state, 'EXPIRED')
      this.releaseOwnedOutpoints(executionId, existing.reservedOutpoints)
      const expired: InternalWalletExecutionRecord = Object.freeze({
        ...existing,
        state: 'EXPIRED',
        uncertainReason: 'Approval expired inside PREPARED -> SIGNING exclusive mutation.',
        failedAt: signingAt,
        reservedOutpoints: []
      })
      this.commitUpdate(expired)
      throw new WalletExecutionError(
        'APPROVAL_EXPIRED',
        'Approval expired inside the exclusive PREPARED -> SIGNING mutation. Cryptographic signing was not started.'
      )
    }

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'SIGNING',
      signingAt,
      reservedOutpoints: planKeys
    })

    this.commitUpdate(updated)
  }

  async transitionToSigned(executionId: string, signedAt: number): Promise<void> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(existing.state, 'SIGNED')

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'SIGNED',
      signedAt
    })

    this.commitUpdate(updated)
  }

  async markSigningUncertain(
    executionId: string,
    reason: string,
    timestamp: number
  ): Promise<void> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(existing.state, 'SIGNING_UNCERTAIN')

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'SIGNING_UNCERTAIN',
      uncertainReason: reason,
      failedAt: timestamp
    })

    this.commitUpdate(updated)
  }

  async markFailed(executionId: string, reason: string, timestamp: number): Promise<void> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) return

    this.assertTransition(existing.state, 'FAILED')
    const release = existing.state === 'EXECUTION_RESERVED' || existing.state === 'PREPARED'
    if (release) {
      this.releaseOwnedOutpoints(executionId, existing.reservedOutpoints)
    }

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'FAILED',
      uncertainReason: reason,
      failedAt: timestamp,
      reservedOutpoints: release ? [] : existing.reservedOutpoints
    })

    this.commitUpdate(updated)
  }

  async markRejected(executionId: string, reason: string, timestamp: number): Promise<void> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) return

    this.assertTransition(existing.state, 'REJECTED')
    const release = existing.state === 'EXECUTION_RESERVED' || existing.state === 'PREPARED'
    if (release) {
      this.releaseOwnedOutpoints(executionId, existing.reservedOutpoints)
    }

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'REJECTED',
      uncertainReason: reason,
      failedAt: timestamp,
      reservedOutpoints: release ? [] : existing.reservedOutpoints
    })

    this.commitUpdate(updated)
  }

  async markExpired(executionId: string, reason: string, timestamp: number): Promise<void> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) return

    this.assertTransition(existing.state, 'EXPIRED')
    const release = existing.state === 'EXECUTION_RESERVED' || existing.state === 'PREPARED'
    if (release) {
      this.releaseOwnedOutpoints(executionId, existing.reservedOutpoints)
    }

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'EXPIRED',
      uncertainReason: reason,
      failedAt: timestamp,
      reservedOutpoints: release ? [] : existing.reservedOutpoints
    })

    this.commitUpdate(updated)
  }

  async getOutpointReservation(outpointKey: string): Promise<string | undefined> {
    return this.outpointReservations.get(outpointKey)
  }

  private toPublicStatus(record: InternalWalletExecutionRecord): PublicExecutionStatus {
    return Object.freeze({
      executionId: record.executionId,
      approvalId: record.approvalId,
      requestId: record.requestId,
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: record.amountSats,
      network: record.network,
      status: record.state,
      planHash: record.planHash,
      uncertainReason: record.uncertainReason,
      reservedAt: record.reservedAt,
      preparedAt: record.preparedAt,
      signingAt: record.signingAt,
      signedAt: record.signedAt,
      failedAt: record.failedAt
    })
  }

  async get(executionId: string): Promise<PublicExecutionStatus | undefined> {
    const record = this.recordsByExecutionId.get(executionId)
    return record ? this.toPublicStatus(record) : undefined
  }

  async getByApprovalId(approvalId: string): Promise<PublicExecutionStatus | undefined> {
    const record = this.recordsByApprovalId.get(approvalId)
    return record ? this.toPublicStatus(record) : undefined
  }

  async getByRequestId(requestId: string): Promise<PublicExecutionStatus | undefined> {
    const record = this.recordsByRequestId.get(requestId)
    return record ? this.toPublicStatus(record) : undefined
  }

  async has(approvalId: string): Promise<boolean> {
    return this.recordsByApprovalId.has(approvalId)
  }

  clear(): void {
    this.recordsByExecutionId.clear()
    this.recordsByApprovalId.clear()
    this.recordsByRequestId.clear()
    this.outpointReservations.clear()
  }

  private releaseOwnedOutpoints(executionId: string, keys: readonly string[] | undefined): void {
    if (!keys) return
    for (const key of keys) {
      if (this.outpointReservations.get(key) === executionId) {
        this.outpointReservations.delete(key)
      }
    }
  }

  private commitUpdate(updated: InternalWalletExecutionRecord): void {
    this.recordsByExecutionId.set(updated.executionId, updated)
    this.recordsByApprovalId.set(updated.approvalId, updated)
    this.recordsByRequestId.set(updated.requestId, updated)
  }
}
