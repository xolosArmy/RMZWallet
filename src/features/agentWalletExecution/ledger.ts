/**
 * @file ledger.ts
 *
 * CANONICAL DURABLE WALLET EXECUTION LEDGER (Gate C2)
 *
 * Enforces durable at-most-once execution, crash consistency, and terminal state immutability.
 * Backed by canonical wallet storage (Web Storage / localStorage).
 *
 * Allowed Transitions:
 * APPROVED -> EXECUTION_RESERVED -> PREPARED -> SIGNING -> SIGNED
 * Terminal states: SIGNED, REJECTED, FAILED, SIGNING_UNCERTAIN (all strictly immutable).
 */

import { WalletExecutionError } from './errors'
import type {
  ExecutionNetwork,
  InternalWalletExecutionRecord,
  WalletExecutionLedger,
  WalletExecutionState,
  WalletPreparedExecutionPlan
} from './types'

export const DEFAULT_EXECUTION_LEDGER_STORAGE_KEY = 'rmzwallet_agent_execution_ledger_v1'

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

interface SerializedExecutionRecord {
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
  readonly rawSignedTxHex?: string
  readonly uncertainReason?: string
  readonly reservedAt: number
  readonly preparedAt?: number
  readonly signingAt?: number
  readonly signedAt?: number
  readonly failedAt?: number
  readonly plan?: {
    readonly network: ExecutionNetwork
    readonly fromAddress: string
    readonly destination: string
    readonly paymentAmountSats: string
    readonly changeAmountSats: string
    readonly changeAddress: string
    readonly feeSats: string
    readonly feeRateSatsPerByte: number
    readonly inputs: readonly {
      readonly txid: string
      readonly outIdx: number
      readonly sats: string
      readonly lockingScriptHex: string
    }[]
    readonly outputs: readonly {
      readonly index: number
      readonly destination: string
      readonly scriptHex: string
      readonly sats: string
      readonly isChange: boolean
    }[]
    readonly totalInputSats: string
    readonly transactionVersion: number
    readonly locktime: number
    readonly planHash: string
    readonly approvalId: string
    readonly requestId: string
    readonly intentId: string
  }
}

interface DurableLedgerStoragePayload {
  readonly version: 1
  generation: number
  records: Record<string, SerializedExecutionRecord>
  approvalIdIndex: Record<string, string>
  requestIdIndex: Record<string, string>
}

function serializeRecord(record: InternalWalletExecutionRecord): SerializedExecutionRecord {
  return {
    executionId: record.executionId,
    approvalId: record.approvalId,
    requestId: record.requestId,
    intentId: record.intentId,
    decisionId: record.decisionId,
    fromAddress: record.fromAddress,
    destination: record.destination,
    amountSats: record.amountSats.toString(),
    network: record.network,
    state: record.state,
    rawSignedTxHex: record.rawSignedTxHex,
    uncertainReason: record.uncertainReason,
    reservedAt: record.reservedAt,
    preparedAt: record.preparedAt,
    signingAt: record.signingAt,
    signedAt: record.signedAt,
    failedAt: record.failedAt,
    plan: record.plan
      ? {
          network: record.plan.network,
          fromAddress: record.plan.fromAddress,
          destination: record.plan.destination,
          paymentAmountSats: record.plan.paymentAmountSats.toString(),
          changeAmountSats: record.plan.changeAmountSats.toString(),
          changeAddress: record.plan.changeAddress,
          feeSats: record.plan.feeSats.toString(),
          feeRateSatsPerByte: record.plan.feeRateSatsPerByte,
          inputs: record.plan.inputs.map(i => ({
            txid: i.txid,
            outIdx: i.outIdx,
            sats: i.sats.toString(),
            lockingScriptHex: i.lockingScriptHex
          })),
          outputs: record.plan.outputs.map(o => ({
            index: o.index,
            destination: o.destination,
            scriptHex: o.scriptHex,
            sats: o.sats.toString(),
            isChange: o.isChange
          })),
          totalInputSats: record.plan.totalInputSats.toString(),
          transactionVersion: record.plan.transactionVersion,
          locktime: record.plan.locktime,
          planHash: record.plan.planHash,
          approvalId: record.plan.approvalId,
          requestId: record.plan.requestId,
          intentId: record.plan.intentId
        }
      : undefined
  }
}

function deserializeRecord(serialized: SerializedExecutionRecord): InternalWalletExecutionRecord {
  const plan: WalletPreparedExecutionPlan | undefined = serialized.plan
    ? Object.freeze({
        network: serialized.plan.network,
        fromAddress: serialized.plan.fromAddress,
        destination: serialized.plan.destination,
        paymentAmountSats: BigInt(serialized.plan.paymentAmountSats),
        changeAmountSats: BigInt(serialized.plan.changeAmountSats),
        changeAddress: serialized.plan.changeAddress,
        feeSats: BigInt(serialized.plan.feeSats),
        feeRateSatsPerByte: serialized.plan.feeRateSatsPerByte,
        inputs: Object.freeze(
          serialized.plan.inputs.map(i =>
            Object.freeze({
              txid: i.txid,
              outIdx: i.outIdx,
              sats: BigInt(i.sats),
              lockingScriptHex: i.lockingScriptHex
            })
          )
        ),
        outputs: Object.freeze(
          serialized.plan.outputs.map(o =>
            Object.freeze({
              index: o.index,
              destination: o.destination,
              scriptHex: o.scriptHex,
              sats: BigInt(o.sats),
              isChange: o.isChange
            })
          )
        ),
        totalInputSats: BigInt(serialized.plan.totalInputSats),
        transactionVersion: serialized.plan.transactionVersion,
        locktime: serialized.plan.locktime,
        planHash: serialized.plan.planHash,
        approvalId: serialized.plan.approvalId,
        requestId: serialized.plan.requestId,
        intentId: serialized.plan.intentId
      })
    : undefined

  return Object.freeze({
    executionId: serialized.executionId,
    approvalId: serialized.approvalId,
    requestId: serialized.requestId,
    intentId: serialized.intentId,
    decisionId: serialized.decisionId,
    fromAddress: serialized.fromAddress,
    destination: serialized.destination,
    amountSats: BigInt(serialized.amountSats),
    network: serialized.network,
    state: serialized.state,
    rawSignedTxHex: serialized.rawSignedTxHex,
    uncertainReason: serialized.uncertainReason,
    reservedAt: serialized.reservedAt,
    preparedAt: serialized.preparedAt,
    signingAt: serialized.signingAt,
    signedAt: serialized.signedAt,
    failedAt: serialized.failedAt,
    plan,
    planHash: plan?.planHash
  })
}

export interface DurableStorageWalletExecutionLedgerOptions {
  readonly storage?: Storage | null
  readonly storageKey?: string
}

export class DurableStorageWalletExecutionLedger implements WalletExecutionLedger {
  private readonly storage: Storage
  private readonly storageKey: string

  constructor(options?: DurableStorageWalletExecutionLedgerOptions) {
    const resolvedStorage = options?.storage ?? (typeof window !== 'undefined' ? window.localStorage : null)
    if (!resolvedStorage) {
      throw new WalletExecutionError(
        'STORAGE_UNAVAILABLE',
        'No durable storage available. An explicit Storage adapter must be provided in non-browser environments.'
      )
    }
    this.storage = resolvedStorage
    this.storageKey = options?.storageKey ?? DEFAULT_EXECUTION_LEDGER_STORAGE_KEY

    // Initialize & reconcile crash consistency on startup
    this.reconcileInterruptedSignings()
  }

  private loadData(): DurableLedgerStoragePayload {
    const raw = this.storage.getItem(this.storageKey)
    if (!raw) {
      return {
        version: 1,
        generation: 0,
        records: {},
        approvalIdIndex: {},
        requestIdIndex: {}
      }
    }
    try {
      const parsed = JSON.parse(raw) as DurableLedgerStoragePayload
      if (!parsed || parsed.version !== 1 || typeof parsed.records !== 'object') {
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

  private saveData(data: DurableLedgerStoragePayload): void {
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
  private reconcileInterruptedSignings(): void {
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

    data.records[entry.executionId] = serializeRecord(record)
    data.approvalIdIndex[entry.approvalId] = entry.executionId
    data.requestIdIndex[entry.requestId] = entry.executionId

    this.saveData(data)
  }

  async setPlanPrepared(
    executionId: string,
    plan: WalletPreparedExecutionPlan,
    preparedAt: number
  ): Promise<void> {
    const data = this.loadData()
    const serialized = data.records[executionId]
    if (!serialized) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(serialized.state, 'PREPARED')

    const existing = deserializeRecord(serialized)
    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      plan,
      planHash: plan.planHash,
      state: 'PREPARED',
      preparedAt
    })

    data.records[executionId] = serializeRecord(updated)
    this.saveData(data)
  }

  async transitionToSigning(executionId: string, signingAt: number): Promise<void> {
    const data = this.loadData()
    const serialized = data.records[executionId]
    if (!serialized) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(serialized.state, 'SIGNING')

    const existing = deserializeRecord(serialized)
    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'SIGNING',
      signingAt
    })

    data.records[executionId] = serializeRecord(updated)
    this.saveData(data)
  }

  async transitionToSigned(
    executionId: string,
    rawSignedTxHex: string,
    signedAt: number
  ): Promise<void> {
    const data = this.loadData()
    const serialized = data.records[executionId]
    if (!serialized) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(serialized.state, 'SIGNED')

    const existing = deserializeRecord(serialized)
    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'SIGNED',
      rawSignedTxHex,
      signedAt
    })

    data.records[executionId] = serializeRecord(updated)
    this.saveData(data)
  }

  async markSigningUncertain(
    executionId: string,
    reason: string,
    timestamp: number
  ): Promise<void> {
    const data = this.loadData()
    const serialized = data.records[executionId]
    if (!serialized) {
      throw new WalletExecutionError('APPROVAL_NOT_FOUND', `Execution record "${executionId}" not found.`)
    }

    this.assertTransition(serialized.state, 'SIGNING_UNCERTAIN')

    const existing = deserializeRecord(serialized)
    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'SIGNING_UNCERTAIN',
      uncertainReason: reason,
      failedAt: timestamp
    })

    data.records[executionId] = serializeRecord(updated)
    this.saveData(data)
  }

  async markFailed(executionId: string, reason: string, timestamp: number): Promise<void> {
    const data = this.loadData()
    const serialized = data.records[executionId]
    if (!serialized) return

    this.assertTransition(serialized.state, 'FAILED')

    const existing = deserializeRecord(serialized)
    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'FAILED',
      uncertainReason: reason,
      failedAt: timestamp
    })

    data.records[executionId] = serializeRecord(updated)
    this.saveData(data)
  }

  async markRejected(executionId: string, reason: string, timestamp: number): Promise<void> {
    const data = this.loadData()
    const serialized = data.records[executionId]
    if (!serialized) return

    this.assertTransition(serialized.state, 'REJECTED')

    const existing = deserializeRecord(serialized)
    const updated: InternalWalletExecutionRecord = Object.freeze({
      ...existing,
      state: 'REJECTED',
      uncertainReason: reason,
      failedAt: timestamp
    })

    data.records[executionId] = serializeRecord(updated)
    this.saveData(data)
  }

  async get(executionId: string): Promise<InternalWalletExecutionRecord | undefined> {
    const data = this.loadData()
    const serialized = data.records[executionId]
    return serialized ? deserializeRecord(serialized) : undefined
  }

  async getByApprovalId(approvalId: string): Promise<InternalWalletExecutionRecord | undefined> {
    const data = this.loadData()
    const executionId = data.approvalIdIndex[approvalId]
    if (!executionId) return undefined
    const serialized = data.records[executionId]
    return serialized ? deserializeRecord(serialized) : undefined
  }

  async getByRequestId(requestId: string): Promise<InternalWalletExecutionRecord | undefined> {
    const data = this.loadData()
    const executionId = data.requestIdIndex[requestId]
    if (!executionId) return undefined
    const serialized = data.records[executionId]
    return serialized ? deserializeRecord(serialized) : undefined
  }

  async has(approvalId: string): Promise<boolean> {
    const data = this.loadData()
    return Boolean(data.approvalIdIndex[approvalId])
  }

  async getSignedTransactionHex(executionId: string): Promise<string | undefined> {
    const data = this.loadData()
    const serialized = data.records[executionId]
    return serialized?.rawSignedTxHex
  }
}
