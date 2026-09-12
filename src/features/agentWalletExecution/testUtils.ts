/**
 * @file testUtils.ts
 *
 * Test utilities and in-memory test doubles for agentWalletExecution test suites.
 * In-memory ledgers and mock storages live strictly in testUtils and are NEVER exported in production index.ts.
 */

import { WalletExecutionError } from './errors'
import { VALID_EXECUTION_STATE_TRANSITIONS } from './ledger'
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

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      plan,
      planHash: plan.planHash,
      state: 'PREPARED',
      preparedAt
    })

    this.commitUpdate(updated)
  }

  async transitionToSigning(executionId: string, signingAt: number): Promise<void> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(existing.state, 'SIGNING')

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'SIGNING',
      signingAt
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

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'FAILED',
      uncertainReason: reason,
      failedAt: timestamp
    })

    this.commitUpdate(updated)
  }

  async markRejected(executionId: string, reason: string, timestamp: number): Promise<void> {
    const existing = this.recordsByExecutionId.get(executionId)
    if (!existing) return

    this.assertTransition(existing.state, 'REJECTED')

    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'REJECTED',
      uncertainReason: reason,
      failedAt: timestamp
    })

    this.commitUpdate(updated)
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
  }

  private commitUpdate(updated: InternalWalletExecutionRecord): void {
    this.recordsByExecutionId.set(updated.executionId, updated)
    this.recordsByApprovalId.set(updated.approvalId, updated)
    this.recordsByRequestId.set(updated.requestId, updated)
  }
}
