/**
 * @file ledger.ts
 *
 * CANONICAL WALLET EXECUTION LEDGER (Gate C2)
 *
 * Enforces at-most-once execution, crash consistency, and atomic reservation.
 * Transitions:
 * APPROVED -> EXECUTION_RESERVED -> PREPARED -> SIGNING -> SIGNED
 *
 * Crash uncertainty:
 * If a failure or crash occurs after signing may have been initiated, the state transitions
 * to SIGNING_UNCERTAIN. It fails closed against automatic retry.
 */

import { WalletExecutionError } from './errors'
import type {
  ExecutionNetwork,
  WalletExecutionLedger,
  WalletExecutionRecord,
  WalletPreparedExecutionPlan
} from './types'

export class InMemoryWalletExecutionLedger implements WalletExecutionLedger {
  private readonly recordsByExecutionId = new Map<string, WalletExecutionRecord>()
  private readonly recordsByApprovalId = new Map<string, WalletExecutionRecord>()
  private readonly recordsByRequestId = new Map<string, WalletExecutionRecord>()

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

    const record: WalletExecutionRecord = Object.freeze({
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

    this.recordsByExecutionId.set(entry.executionId, record)
    this.recordsByApprovalId.set(entry.approvalId, record)
    this.recordsByRequestId.set(entry.requestId, record)
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

    if (existing.state !== 'EXECUTION_RESERVED') {
      throw new WalletExecutionError(
        'INVALID_STATE_TRANSITION',
        `Cannot prepare plan from state "${existing.state}". Expected "EXECUTION_RESERVED".`
      )
    }

    const updated: WalletExecutionRecord = Object.freeze({
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

    if (existing.state !== 'PREPARED') {
      throw new WalletExecutionError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition to SIGNING from state "${existing.state}". Expected "PREPARED".`
      )
    }

    const updated: WalletExecutionRecord = Object.freeze({
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

    if (existing.state !== 'SIGNING') {
      throw new WalletExecutionError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition to SIGNED from state "${existing.state}". Expected "SIGNING".`
      )
    }

    const updated: WalletExecutionRecord = Object.freeze({
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

    // Fail-closed crash consistency state
    const updated: WalletExecutionRecord = Object.freeze({
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

    const updated: WalletExecutionRecord = Object.freeze({
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

    const updated: WalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'REJECTED',
      uncertainReason: reason,
      failedAt: timestamp
    })

    this.commitUpdate(updated)
  }

  async get(executionId: string): Promise<WalletExecutionRecord | undefined> {
    return this.recordsByExecutionId.get(executionId)
  }

  async getByApprovalId(approvalId: string): Promise<WalletExecutionRecord | undefined> {
    return this.recordsByApprovalId.get(approvalId)
  }

  async getByRequestId(requestId: string): Promise<WalletExecutionRecord | undefined> {
    return this.recordsByRequestId.get(requestId)
  }

  async has(approvalId: string): Promise<boolean> {
    return this.recordsByApprovalId.has(approvalId)
  }

  clear(): void {
    this.recordsByExecutionId.clear()
    this.recordsByApprovalId.clear()
    this.recordsByRequestId.clear()
  }

  private commitUpdate(updated: WalletExecutionRecord): void {
    this.recordsByExecutionId.set(updated.executionId, updated)
    this.recordsByApprovalId.set(updated.approvalId, updated)
    this.recordsByRequestId.set(updated.requestId, updated)
  }
}
