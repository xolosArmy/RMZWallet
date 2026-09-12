/**
 * @file capability.ts
 *
 * CANONICAL MODULE-PRIVATE WALLET EXECUTION CAPABILITY (Gate C2)
 *
 * Authority Boundary:
 * - Module-private one-use capability.
 * - MUST NEVER be exported through index.ts or exposed to external callers, Agents, or x402-XEC.
 * - Constructor is gated by a private Symbol token.
 * - Single-use: once consumed, subsequent signing attempts throw immediately.
 */

import type { HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import type { WalletApprovalLedgerRecord } from '../agentWalletApprovalReceiver/types'
import { WalletExecutionError } from './errors'
import type { ExecutionNetwork, WalletPreparedExecutionPlan } from './types'

export const INTERNAL_EXECUTION_TOKEN = Symbol('WalletExecutionCapabilityToken')

export interface ExecutionCapabilityBindings {
  readonly capabilityId: string
  readonly approvalId: string
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly approvalStatus: 'approved'
  readonly approver: string
  readonly destination: string
  readonly amountSats: bigint
  readonly network: ExecutionNetwork
  readonly contentHash: string
  readonly effectiveExpiresAt: number
}

/**
 * Encapsulated one-use execution capability.
 * Cannot be constructed directly without the module-private INTERNAL_EXECUTION_TOKEN.
 */
export class WalletExecutionCapability {
  readonly capabilityId: string
  readonly approvalId: string
  readonly requestId: string
  readonly intentId: string
  readonly decisionId: string
  readonly approvalStatus: 'approved'
  readonly approver: string
  readonly destination: string
  readonly amountSats: bigint
  readonly network: ExecutionNetwork
  readonly contentHash: string
  readonly effectiveExpiresAt: number

  private _boundPlanHash: string | null = null
  private _consumed = false

  constructor(token: symbol, bindings: ExecutionCapabilityBindings) {
    if (token !== INTERNAL_EXECUTION_TOKEN) {
      throw new WalletExecutionError(
        'INVALID_RECEIPT',
        'Direct construction of WalletExecutionCapability is prohibited.'
      )
    }

    this.capabilityId = bindings.capabilityId
    this.approvalId = bindings.approvalId
    this.requestId = bindings.requestId
    this.intentId = bindings.intentId
    this.decisionId = bindings.decisionId
    this.approvalStatus = bindings.approvalStatus
    this.approver = bindings.approver
    this.destination = bindings.destination
    this.amountSats = bindings.amountSats
    this.network = bindings.network
    this.contentHash = bindings.contentHash
    this.effectiveExpiresAt = bindings.effectiveExpiresAt
  }

  get isConsumed(): boolean {
    return this._consumed
  }

  get boundPlanHash(): string | null {
    return this._boundPlanHash
  }

  /**
   * Binds the prepared execution plan hash to this capability.
   * Can only be bound once.
   */
  bindPlan(plan: WalletPreparedExecutionPlan): void {
    if (this._consumed) {
      throw new WalletExecutionError('DUPLICATE_EXECUTION', 'Execution capability has already been consumed.')
    }
    if (this._boundPlanHash !== null) {
      throw new WalletExecutionError('DUPLICATE_EXECUTION', 'Plan has already been bound to this capability.')
    }
    if (plan.approvalId !== this.approvalId || plan.requestId !== this.requestId) {
      throw new WalletExecutionError('PLAN_HASH_MISMATCH', 'Plan does not match capability approval or request bindings.')
    }
    this._boundPlanHash = plan.planHash
  }

  /**
   * Consumes the capability. Transitions to consumed state. Throws if already consumed.
   */
  consume(): void {
    if (this._consumed) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        'Execution capability has already been consumed. Replay is strictly prohibited.'
      )
    }
    this._consumed = true
  }
}

/**
 * Strictly verifies receipt against recorded approval ledger record before minting capability.
 */
export function mintExecutionCapability(params: {
  readonly token: symbol
  readonly receipt: HumanApprovalV1
  readonly record: WalletApprovalLedgerRecord
  readonly activeAddress: string
  readonly now: number
  readonly createId: () => string
}): WalletExecutionCapability {
  const { token, receipt, record, activeAddress, now, createId } = params

  if (token !== INTERNAL_EXECUTION_TOKEN) {
    throw new WalletExecutionError('INVALID_RECEIPT', 'Invalid internal capability token.')
  }

  // 1. HumanApprovalV1 status === 'approved'
  if (receipt.status !== 'approved') {
    throw new WalletExecutionError(
      'RECEIPT_NOT_APPROVED',
      `Receipt status is "${receipt.status}". Only approved receipts may enter execution.`
    )
  }

  if (record.status !== 'approved') {
    throw new WalletExecutionError(
      'APPROVAL_FIELD_MISMATCH',
      `Ledger record status is "${record.status}", but receipt was approved.`
    )
  }

  // 2. Receipt exactly matches recorded Wallet approval
  if (receipt.approvalId !== record.approvalId) {
    throw new WalletExecutionError(
      'APPROVAL_FIELD_MISMATCH',
      `approvalId mismatch: receipt "${receipt.approvalId}" !== ledger "${record.approvalId}".`
    )
  }

  if (receipt.requestId !== record.requestId) {
    throw new WalletExecutionError(
      'APPROVAL_FIELD_MISMATCH',
      `requestId mismatch: receipt "${receipt.requestId}" !== ledger "${record.requestId}".`
    )
  }

  if (receipt.intentId !== record.intentId) {
    throw new WalletExecutionError(
      'APPROVAL_FIELD_MISMATCH',
      `intentId mismatch: receipt "${receipt.intentId}" !== ledger "${record.intentId}".`
    )
  }

  if (receipt.decisionId !== record.decisionId) {
    throw new WalletExecutionError(
      'APPROVAL_FIELD_MISMATCH',
      `decisionId mismatch: receipt "${receipt.decisionId}" !== ledger "${record.decisionId}".`
    )
  }

  if (receipt.approver !== record.fromAddress) {
    throw new WalletExecutionError(
      'APPROVAL_FIELD_MISMATCH',
      `approver mismatch: receipt "${receipt.approver}" !== ledger "${record.fromAddress}".`
    )
  }

  if (receipt.network !== record.network) {
    throw new WalletExecutionError(
      'APPROVAL_FIELD_MISMATCH',
      `network mismatch: receipt "${receipt.network}" !== ledger "${record.network}".`
    )
  }

  if (receipt.presentationHash !== record.presentationHash) {
    throw new WalletExecutionError(
      'APPROVAL_FORGED',
      'presentationHash does not match recorded ledger entry.'
    )
  }

  if (receipt.contentHash !== record.contentHash) {
    throw new WalletExecutionError(
      'APPROVAL_FORGED',
      'contentHash does not match recorded ledger entry.'
    )
  }

  if (receipt.recordedAt !== record.recordedAt) {
    throw new WalletExecutionError(
      'APPROVAL_FIELD_MISMATCH',
      `recordedAt mismatch: receipt ${receipt.recordedAt} !== ledger ${record.recordedAt}.`
    )
  }

  // 3. Approval has not expired
  if (now >= record.effectiveExpiresAt) {
    throw new WalletExecutionError(
      'APPROVAL_EXPIRED',
      `Approval expired at ${record.effectiveExpiresAt}; current time is ${now}.`
    )
  }

  // 4. Active authenticated wallet address equals the approved fromAddress
  if (activeAddress !== record.fromAddress) {
    throw new WalletExecutionError(
      'SESSION_ADDRESS_MISMATCH',
      `Active wallet address "${activeAddress}" does not match approved fromAddress "${record.fromAddress}".`
    )
  }

  // 5. Mint capability
  const capabilityId = `exec_cap_${createId()}`

  return new WalletExecutionCapability(INTERNAL_EXECUTION_TOKEN, {
    capabilityId,
    approvalId: record.approvalId,
    requestId: record.requestId,
    intentId: record.intentId,
    decisionId: record.decisionId,
    approvalStatus: 'approved',
    approver: record.fromAddress,
    destination: record.destination,
    amountSats: record.amountSats,
    network: record.network,
    contentHash: record.contentHash,
    effectiveExpiresAt: record.effectiveExpiresAt
  })
}
