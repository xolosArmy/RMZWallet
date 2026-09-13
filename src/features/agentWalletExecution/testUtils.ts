/**
 * @file testUtils.ts
 *
 * Test utilities and in-memory test doubles for agentWalletExecution test suites.
 * In-memory ledgers and mock storages live strictly in testUtils and are NEVER exported in production index.ts.
 */

import { WalletExecutionError } from './errors'
import { canonicalOutpointKey, VALID_EXECUTION_STATE_TRANSITIONS } from './ledger'
import type { ExecutionLockCoordinator } from './ledger'
import type {
  ExecutionNetwork,
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

  async whenReady(): Promise<void> {}

  async runWithSigningLock<T>(_executionId: string, operation: () => Promise<T>): Promise<T> {
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
    preparedAt: number
  ): Promise<void> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(existing.state, 'PREPARED')

    const reservedOutpoints = plan.inputs.map(input => canonicalOutpointKey(input.txid, input.outIdx))
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

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      plan,
      planHash: plan.planHash,
      state: 'PREPARED',
      preparedAt,
      reservedOutpoints
    })

    this.commitUpdate(updated)
  }

  async transitionToSigning(
    executionId: string,
    signingAt: number,
    plan: WalletPreparedExecutionPlan
  ): Promise<void> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(existing.state, 'SIGNING')

    const planKeys = plan.inputs.map(input => canonicalOutpointKey(input.txid, input.outIdx))
    for (const key of planKeys) {
      if (this.outpointReservations.get(key) !== executionId) {
        throw new WalletExecutionError(
          'OUTPOINT_RESERVATION_MISMATCH',
          `Execution "${executionId}" does not durably own outpoint "${key}".`
        )
      }
    }

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'SIGNING',
      signingAt,
      reservedOutpoints: planKeys
    })

    this.commitUpdate(updated)
  }

  async transitionToSigned(
    executionId: string,
    rawSignedTxHex: string,
    signedAt: number
  ): Promise<void> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(existing.state, 'SIGNED')

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'SIGNED',
      rawSignedTxHex,
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
