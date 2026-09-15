/**
 * @file trustedWalletExecutionRuntime.ts
 *
 * TRUSTED WALLET EXECUTION RUNTIME (Gate C2)
 *
 * The composition factory is FILE-LOCAL. It is not exported from this module,
 * engine.ts, the public agentWalletExecution barrel, or the host barrel.
 * Only TrustedWalletExecutionProvider (same trusted bootstrap) constructs
 * walletUIHost / controller / private settlement persistence.
 *
 * Agent/public callers receive AgentWalletExecutionEngine only.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { fromHex, Script, toHex, toHexRev, Tx, TxBuilder } from 'ecash-lib'
import { humanApprovalV1Schema, type HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import { AgentExecutionReviewModal } from '../../components/agentExecution/AgentExecutionReviewModal'
import { createProductionWalletRuntime } from './productionWalletAdapters'
import { xolosWalletService } from '../../services/XolosWalletService'
import { WalletExecutionError } from '../../features/agentWalletExecution/errors'
import {
  DEFAULT_REVIEW_LEASE_TTL_SECONDS,
  DEFAULT_EXECUTION_LEDGER_STORAGE_KEY,
  DEFAULT_EXECUTION_LOCK_NAME,
  DurableTransactionalExecutionLedger,
  VALID_EXECUTION_STATE_TRANSITIONS,
  WebLocksExecutionCoordinator,
  executionSettlementLockName,
  type ExecutionLockCoordinator
} from '../../features/agentWalletExecution/ledger'
import {
  assertUniqueUtxoOutpoints,
  buildPreparedExecutionPlan,
  computeCanonicalPlanHash,
  DEFAULT_FEE_POLICY,
  snapshotOwnedUtxos,
  validateOutputInvariants
} from '../../features/agentWalletExecution/plan'
import {
  deriveExpectedTxidFromRawTxHex
} from '../../features/agentWalletExecution/settlementUtils'
import type {
  AgentWalletExecutionEngine,
  AgentWalletExecutionEngineConfig,
  DisposableAgentWalletExecutionEngine,
  ExecutionNetwork,
  PublicExecutionStatus,
  SignedExecutionHandle,
  WalletExecutionLedger,
  WalletExecutionReviewSession,
  WalletExecutionReviewSnapshot,
  WalletExecutionState,
  WalletFeePolicy,
  WalletPreparedExecutionPlan,
  WalletExecutionTrustedOptions,
  WalletSettlementReceiptV1,
  ChronikBroadcastClient
} from '../../features/agentWalletExecution/types'

import { getChronik } from '../../services/ChronikClient'
import type {
  WalletExecutionComposition,
  WalletExecutionUIHost,
  WalletLocalConfirmationController
} from './types'
import {
  TrustedWalletExecutionContext,
  type TrustedWalletExecutionContextValue
} from './TrustedWalletExecutionContext'
import {
  DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY,
  DEFAULT_SETTLEMENT_STORE_LOCK_NAME
} from '../settlementStore'

const TEST_ONLY_CREATE_WALLET_EXECUTION_COMPOSITION = Symbol.for(
  'rmzwallet.testOnly.createWalletExecutionComposition'
)
const TEST_ONLY_PRIVATE_SETTLEMENT_STORAGE = Symbol.for(
  'rmzwallet.testOnly.privateSettlementStorage'
)
const TEST_ONLY_SETTLEMENT_LOCK_COORDINATOR = Symbol.for(
  'rmzwallet.testOnly.settlementLockCoordinator'
)
const TEST_ONLY_SETTLEMENT_CHRONIK_CLIENT = Symbol.for(
  'rmzwallet.testOnly.settlementChronikClient'
)
const TEST_ONLY_EXECUTION_STORAGE = Symbol.for(
  'rmzwallet.testOnly.executionStorage'
)

type ReviewSigningHandoffPhase = 'IDLE' | 'REVIEW_ACTIVE' | 'HANDOFF_TO_SIGNING' | 'SIGNING_DURABLE'

function resolveFileLocalPrivateSettlementStorage(): Storage | undefined {
  if (import.meta.env?.VITEST) {
    const override = (globalThis as Record<symbol, unknown>)[TEST_ONLY_PRIVATE_SETTLEMENT_STORAGE]
    if (override && typeof (override as Storage).setItem === 'function') {
      return override as Storage
    }
  }
  return typeof localStorage !== 'undefined' ? localStorage : undefined
}

function resolveWalletExecutionStorage(
  trusted?: WalletExecutionTrustedOptions
): Storage | undefined {
  if (import.meta.env?.VITEST) {
    if (trusted?.executionStorage && typeof (trusted.executionStorage as Storage).setItem === 'function') {
      return trusted.executionStorage
    }
    const override = (globalThis as Record<symbol, unknown>)[TEST_ONLY_EXECUTION_STORAGE]
    if (override && typeof (override as Storage).setItem === 'function') {
      return override as Storage
    }
  }
  return typeof localStorage !== 'undefined' ? localStorage : undefined
}

/**
 * File-local settlement authority interface.
 * Strictly NOT exported from this file, barrel, or deep importable surface.
 */
interface AuthoritativeSettlementLedger {
  get(executionId: string): Promise<PublicExecutionStatus | undefined>
  runWithSettlementLock<T>(executionId: string, operation: () => Promise<T>): Promise<T>
  transitionToSettling(params: {
    readonly executionId: string
    readonly expectedTxid: string
    readonly settlingAt: number
  }): Promise<void>
  transitionToSettled(params: {
    readonly executionId: string
    readonly expectedTxid: string
    readonly settledAt: number
  }): Promise<void>
  markSettlementUncertain(params: {
    readonly executionId: string
    readonly reason: string
    readonly timestamp: number
  }): Promise<void>
  markSettlementRejected(params: {
    readonly executionId: string
    readonly reason: string
    readonly timestamp: number
    readonly releaseOutpoints?: boolean
  }): Promise<void>
  snapshotSettlingRecords(): Promise<
    ReadonlyArray<{ readonly executionId: string; readonly expectedTxid?: string }>
  >
}

/**
 * File-local settlement authority implementation.
 * Operates on the canonical Wallet-owned execution storage under lock.
 * Strictly unexported.
 */
class FileLocalSettlementAuthority implements AuthoritativeSettlementLedger {
  private readonly storage: Storage
  private readonly coordinator: ExecutionLockCoordinator
  private readonly canonicalLedger: DurableTransactionalExecutionLedger

  constructor(options: {
    storage: Storage
    lockCoordinator: ExecutionLockCoordinator
    canonicalLedger: DurableTransactionalExecutionLedger
  }) {
    this.storage = options.storage
    this.coordinator = options.lockCoordinator
    this.canonicalLedger = options.canonicalLedger
  }

  async get(executionId: string): Promise<PublicExecutionStatus | undefined> {
    if (import.meta.env?.VITEST) {
      const hook = (globalThis as Record<symbol, unknown>)[
        Symbol.for('rmzwallet.testOnly.beforeAuthoritativeLedgerGet')
      ]
      if (typeof hook === 'function') {
        await hook(executionId)
      }
    }
    return this.canonicalLedger.get(executionId)
  }

  async runWithSettlementLock<T>(executionId: string, operation: () => Promise<T>): Promise<T> {
    return this.coordinator.requestExclusive(executionSettlementLockName(executionId), operation)
  }

  private loadData(): {
    schemaVersion: number
    generation: number
    records: Record<string, any>
    approvalIdIndex: Record<string, string>
    requestIdIndex: Record<string, string>
    outpointReservations: Record<string, string>
  } {
    const raw = this.storage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)
    if (!raw) {
      return {
        schemaVersion: 3,
        generation: 0,
        records: {},
        approvalIdIndex: {},
        requestIdIndex: {},
        outpointReservations: {}
      }
    }
    try {
      const parsed = JSON.parse(raw)
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

  private saveData(data: {
    schemaVersion: number
    generation: number
    records: Record<string, any>
    approvalIdIndex: Record<string, string>
    requestIdIndex: Record<string, string>
    outpointReservations: Record<string, string>
  }): void {
    data.generation += 1
    try {
      this.storage.setItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY, JSON.stringify({ ...data, schemaVersion: 3 }))
    } catch (err) {
      throw new WalletExecutionError(
        'STORAGE_MUTATION_FAILED',
        `Failed to persist durable execution ledger data: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private releaseOutpoints(data: any, executionId: string, keys: readonly string[] | undefined): void {
    if (!keys) return
    for (const key of keys) {
      if (data.outpointReservations[key] === executionId) {
        delete data.outpointReservations[key]
      }
    }
  }

  private assertTransition(currentState: WalletExecutionState, targetState: WalletExecutionState): void {
    const allowed = VALID_EXECUTION_STATE_TRANSITIONS[currentState]
    if (!allowed || !allowed.includes(targetState)) {
      throw new WalletExecutionError(
        'INVALID_STATE_TRANSITION',
        `Cannot transition execution record from state "${currentState}" to "${targetState}".`
      )
    }
  }

  async transitionToSettling(params: {
    readonly executionId: string
    readonly expectedTxid: string
    readonly settlingAt: number
  }): Promise<void> {
    return this.coordinator.requestExclusive(DEFAULT_EXECUTION_LOCK_NAME, async () => {
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
    return this.coordinator.requestExclusive(DEFAULT_EXECUTION_LOCK_NAME, async () => {
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
    return this.coordinator.requestExclusive(DEFAULT_EXECUTION_LOCK_NAME, async () => {
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
    return this.coordinator.requestExclusive(DEFAULT_EXECUTION_LOCK_NAME, async () => {
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
    return this.coordinator.requestExclusive(DEFAULT_EXECUTION_LOCK_NAME, async () => {
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
}

const fallbackTestSettlementQueues = new Map<string, Promise<unknown>>()

function getFallbackTestSettlementLockCoordinator(): ExecutionLockCoordinator {
  return {
    async requestExclusive<T>(lockName: string, operation: () => Promise<T>): Promise<T> {
      const prior = fallbackTestSettlementQueues.get(lockName) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>(resolve => {
        release = resolve
      })
      fallbackTestSettlementQueues.set(
        lockName,
        prior.then(() => current)
      )
      try {
        await prior
        return await operation()
      } finally {
        release()
      }
    },
    async tryExclusive<T>(lockName: string, operation: () => Promise<T>) {
      const result = await this.requestExclusive(lockName, operation)
      return { acquired: true as const, result }
    }
  }
}

function resolveWalletSettlementLockCoordinator(): ExecutionLockCoordinator {
  if (import.meta.env?.VITEST) {
    const testCoordinator = (globalThis as Record<symbol, unknown>)[
      TEST_ONLY_SETTLEMENT_LOCK_COORDINATOR
    ]
    if (
      testCoordinator &&
      typeof (testCoordinator as ExecutionLockCoordinator).requestExclusive === 'function' &&
      typeof (testCoordinator as ExecutionLockCoordinator).tryExclusive === 'function'
    ) {
      return testCoordinator as ExecutionLockCoordinator
    }
    if (typeof navigator === 'undefined' || !navigator.locks?.request) {
      return getFallbackTestSettlementLockCoordinator()
    }
  }
  return new WebLocksExecutionCoordinator()
}

function resolveWalletChronikClient(): ChronikBroadcastClient {
  if (import.meta.env?.VITEST) {
    const testChronik = (globalThis as Record<symbol, unknown>)[
      TEST_ONLY_SETTLEMENT_CHRONIK_CLIENT
    ]
    if (
      testChronik &&
      typeof (testChronik as ChronikBroadcastClient).broadcastTx === 'function' &&
      typeof (testChronik as ChronikBroadcastClient).tx === 'function'
    ) {
      return testChronik as ChronikBroadcastClient
    }
  }
  if (typeof getChronik === 'function') {
    return getChronik() as unknown as ChronikBroadcastClient
  }
  throw new WalletExecutionError(
    'STORAGE_UNAVAILABLE',
    'Wallet Chronik client is not available for settlement broadcast.'
  )
}

function createFileLocalProductionSignatoryProvider(): AgentWalletExecutionEngineConfig['signatoryProvider'] {
  return {
    async getSignatory(address: string) {
      const activeAddress = xolosWalletService.getAddress()
      if (!activeAddress) {
        throw new WalletExecutionError(
          'SESSION_REVALIDATION_FAILED',
          'Wallet is locked; production signatory refuses to mint a placeholder.'
        )
      }
      if (activeAddress !== address) {
        throw new WalletExecutionError(
          'SESSION_ADDRESS_MISMATCH',
          `Active wallet address "${activeAddress}" does not match requested signatory address "${address}".`
        )
      }
      return xolosWalletService.getSignatory()
    }
  }
}

// Module-private symbols for closure-encapsulated capabilities
const INTERNAL_CAPABILITY_TOKEN = Symbol('WalletExecutionCapabilityToken')
const LOCAL_CONFIRMATION_TOKEN = Symbol('LocalExecutionConfirmationToken')

interface ExecutionCapabilityBindings {
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

class InternalWalletExecutionCapability {
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
  private _invalidated = false

  constructor(token: symbol, bindings: ExecutionCapabilityBindings) {
    if (token !== INTERNAL_CAPABILITY_TOKEN) {
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

  get isInvalidated(): boolean {
    return this._invalidated
  }

  get boundPlanHash(): string | null {
    return this._boundPlanHash
  }

  bindPlan(plan: WalletPreparedExecutionPlan): void {
    if (this._consumed || this._invalidated) {
      throw new WalletExecutionError('DUPLICATE_EXECUTION', 'Execution capability is not active.')
    }
    if (this._boundPlanHash !== null) {
      throw new WalletExecutionError('DUPLICATE_EXECUTION', 'Plan has already been bound to this capability.')
    }
    if (plan.approvalId !== this.approvalId || plan.requestId !== this.requestId) {
      throw new WalletExecutionError('PLAN_HASH_MISMATCH', 'Plan does not match capability approval or request bindings.')
    }
    this._boundPlanHash = plan.planHash
  }

  consume(): void {
    if (this._consumed || this._invalidated) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        'Execution capability has already been consumed or invalidated. Replay is strictly prohibited.'
      )
    }
    this._consumed = true
  }

  invalidate(): void {
    this._invalidated = true
  }
}

class InternalLocalExecutionConfirmationToken {
  readonly executionId: string
  private _consumed = false

  constructor(token: symbol, executionId: string) {
    if (token !== LOCAL_CONFIRMATION_TOKEN) {
      throw new WalletExecutionError(
        'LOCAL_CONFIRMATION_REQUIRED',
        'Direct construction of LocalExecutionConfirmationToken is prohibited.'
      )
    }
    this.executionId = executionId
  }

  get isConsumed(): boolean {
    return this._consumed
  }

  consume(): void {
    if (this._consumed) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        'Local confirmation token has already been consumed. Replay is prohibited.'
      )
    }
    this._consumed = true
  }
}

function formatBigIntToExactXEC(sats: bigint): string {
  if (sats < 0n) {
    throw new Error(`[formatBigIntToExactXEC] Negative satoshis not supported: ${sats}`)
  }
  const whole = sats / 100n
  const fraction = sats % 100n
  const fractionStr = fraction.toString().padStart(2, '0')
  return `${whole.toString()}.${fractionStr} XEC`
}

function canonicalPrevoutTxidHex(txid: string | Uint8Array): string {
  if (typeof txid === 'string') {
    return txid.toLowerCase()
  }
  return toHexRev(txid).toLowerCase()
}

function parseCanonicalHumanApproval(value: unknown): HumanApprovalV1 {
  try {
    return humanApprovalV1Schema.parse(value) as HumanApprovalV1
  } catch (err) {
    throw new WalletExecutionError(
      'INVALID_RECEIPT',
      `Value is not a canonical HumanApprovalV1: ${err instanceof Error ? err.message : String(err)}`,
      err
    )
  }
}

function canonicalApprovedAmountSats(amountSats: string | bigint | number): bigint {
  try {
    const parsed = BigInt(amountSats)
    if (parsed <= 0n) {
      throw new Error('amountSats must be strictly positive')
    }
    return parsed
  } catch (err) {
    throw new WalletExecutionError(
      'APPROVAL_FIELD_MISMATCH',
      `Authoritative ledger amountSats is not a canonical positive integer: ${String(amountSats)}`,
      err
    )
  }
}

/**
 * Independently deserialize raw signed transaction hex with the canonical ecash-lib parser.
 * The signer-returned object is not an authority source.
 */
function parseRawSignedTransaction(rawSignedTxHex: string): Tx {
  if (typeof rawSignedTxHex !== 'string' || rawSignedTxHex.length < 2 || rawSignedTxHex.length % 2 !== 0) {
    throw new WalletExecutionError(
      'SIGNING_UNCERTAIN',
      'Signed transaction bytes could not be parsed by the canonical transaction parser.'
    )
  }
  try {
    return Tx.fromHex(rawSignedTxHex)
  } catch (err) {
    throw new WalletExecutionError(
      'SIGNING_UNCERTAIN',
      'Signed transaction bytes could not be parsed by the canonical transaction parser.',
      err
    )
  }
}

/**
 * Verify ALL post-sign fields against the Wallet-owned immutable plan.
 * Comparison uses only the independently parsed transaction.
 */
function assertParsedTransactionMatchesPlan(parsedTx: Tx, plan: WalletPreparedExecutionPlan): void {
  if (parsedTx.version !== plan.transactionVersion) {
    throw new WalletExecutionError(
      'SIGNED_TRANSACTION_MISMATCH',
      `Signed tx version ${parsedTx.version} !== plan ${plan.transactionVersion}`
    )
  }
  if (parsedTx.locktime !== plan.locktime) {
    throw new WalletExecutionError(
      'SIGNED_TRANSACTION_MISMATCH',
      `Signed tx locktime ${parsedTx.locktime} !== plan ${plan.locktime}`
    )
  }
  if (parsedTx.inputs.length !== plan.inputs.length) {
    throw new WalletExecutionError(
      'SIGNED_TRANSACTION_MISMATCH',
      `Signed tx input count ${parsedTx.inputs.length} !== plan ${plan.inputs.length}`
    )
  }
  for (let i = 0; i < plan.inputs.length; i++) {
    const txInput = parsedTx.inputs[i]
    const planInput = plan.inputs[i]
    const txPrevTxid = canonicalPrevoutTxidHex(txInput.prevOut.txid)
    if (txPrevTxid !== planInput.txid.toLowerCase()) {
      throw new WalletExecutionError(
        'SIGNED_TRANSACTION_MISMATCH',
        `Signed tx input ${i} prevout txid "${txPrevTxid}" !== plan "${planInput.txid}"`
      )
    }
    if (txInput.prevOut.outIdx !== planInput.outIdx) {
      throw new WalletExecutionError(
        'SIGNED_TRANSACTION_MISMATCH',
        `Signed tx input ${i} outIdx ${txInput.prevOut.outIdx} !== plan ${planInput.outIdx}`
      )
    }
  }
  if (parsedTx.outputs.length !== plan.outputs.length) {
    throw new WalletExecutionError(
      'SIGNED_TRANSACTION_MISMATCH',
      `Signed tx output count ${parsedTx.outputs.length} !== plan ${plan.outputs.length}`
    )
  }
  for (let j = 0; j < plan.outputs.length; j++) {
    const txOutput = parsedTx.outputs[j]
    const planOutput = plan.outputs[j]
    const txSats = txOutput.sats ?? (txOutput as { value?: bigint }).value
    if (BigInt(txSats) !== BigInt(planOutput.sats)) {
      throw new WalletExecutionError(
        'SIGNED_TRANSACTION_MISMATCH',
        `Signed tx output ${j} sats ${txSats} !== plan ${planOutput.sats}`
      )
    }
    const txScriptHex = toHex(txOutput.script.bytecode).toLowerCase()
    if (txScriptHex !== planOutput.scriptHex.toLowerCase()) {
      throw new WalletExecutionError(
        'SIGNED_TRANSACTION_MISMATCH',
        `Signed tx output ${j} script "${txScriptHex}" !== plan "${planOutput.scriptHex}"`
      )
    }
  }
}

function createWalletExecutionComposition(
  config: AgentWalletExecutionEngineConfig,
  trusted?: WalletExecutionTrustedOptions
): WalletExecutionComposition {
  const {
    approvalLedger,
    sessionVerifier,
    utxoProvider,
    signatoryProvider,
    clock,
    idGenerator
  } = config

  const getNow = clock ?? (() => Math.floor(Date.now() / 1000))
  const createId = idGenerator ?? (() => globalThis.crypto.randomUUID())
  const feePolicy: WalletFeePolicy = {
    ...DEFAULT_FEE_POLICY,
    ...(config.feePolicy ?? {})
  }

  let disposed = false
  let lifecycleGeneration = 0

  function isLifecycleActive(generation?: number): boolean {
    if (disposed) return false
    if (generation !== undefined && generation !== lifecycleGeneration) return false
    return true
  }

  const pendingSettlementRetries = new Map<string, { timer: ReturnType<typeof setTimeout>; attempt: number }>()

  function cancelSettlementRecoveryRetry(executionId: string): void {
    const existing = pendingSettlementRetries.get(executionId)
    if (existing) {
      clearTimeout(existing.timer)
      pendingSettlementRetries.delete(executionId)
    }
  }

  function cancelAllSettlementRecoveryRetries(): void {
    for (const [_, entry] of pendingSettlementRetries.entries()) {
      clearTimeout(entry.timer)
    }
    pendingSettlementRetries.clear()
  }

  // One canonical durable execution-state storage dataset
  const canonicalStorage = resolveWalletExecutionStorage(trusted)
  const trustedSettlementCoordinator = resolveWalletSettlementLockCoordinator()

  // Canonical Wallet-owned durable execution ledger for C2
  const canonicalLedger = canonicalStorage
    ? new DurableTransactionalExecutionLedger({
        storage: canonicalStorage,
        lockCoordinator: trustedSettlementCoordinator,
        clock: getNow
      })
    : null

  // File-local authoritative settlement ledger for C3A operating on the single dataset
  const authoritativeSettlementLedger: AuthoritativeSettlementLedger | null = canonicalStorage
    ? new FileLocalSettlementAuthority({
        storage: canonicalStorage,
        lockCoordinator: trustedSettlementCoordinator,
        canonicalLedger: canonicalLedger!
      })
    : null

  function getAuthoritativeSettlementLedger(): AuthoritativeSettlementLedger {
    if (!authoritativeSettlementLedger) {
      throw new WalletExecutionError(
        'STORAGE_UNAVAILABLE',
        'No durable settlement storage available. An explicit Storage adapter must be provided in non-browser environments.'
      )
    }
    return authoritativeSettlementLedger
  }

  // Durable execution ledger facade for C2 operations (or authoritative default).
  // In production, C2 ALWAYS uses the canonicalLedger.
  // Historical C2 test double substitution is confined to Vitest when test options are supplied.
  const executionLedger: WalletExecutionLedger =
    (import.meta.env?.VITEST && trusted?.testOnlyExecutionLedger)
      ? trusted.testOnlyExecutionLedger
      : (import.meta.env?.VITEST && config.executionLedger)
        ? config.executionLedger
        : canonicalLedger!

  if (!executionLedger) {
    throw new WalletExecutionError(
      'STORAGE_UNAVAILABLE',
      'No durable storage available. An explicit Storage adapter must be provided in non-browser environments.'
    )
  }

  async function handleSettlementRecovery(
    executionId: string,
    expectedTxid?: string,
    calledGeneration?: number
  ): Promise<void> {
    const generation = calledGeneration ?? lifecycleGeneration
    if (!isLifecycleActive(generation) || !authoritativeSettlementLedger) return

    const record = await authoritativeSettlementLedger.get(executionId)
    if (!isLifecycleActive(generation) || !authoritativeSettlementLedger) return

    if (!record || ((record as any).state ?? record.status) !== 'SETTLING') {
      return
    }

    let targetTxid = expectedTxid ?? record.expectedTxid
    if (!targetTxid) {
      try {
        const rawTxHex = await getPrivateSignedTransaction(executionId)
        if (!isLifecycleActive(generation)) return
        targetTxid = deriveExpectedTxidFromRawTxHex(rawTxHex)
      } catch {
        if (!isLifecycleActive(generation) || !authoritativeSettlementLedger) return
        await authoritativeSettlementLedger.markSettlementUncertain({
          executionId,
          reason: 'Abandoned SETTLING record without recoverable expectedTxid.',
          timestamp: getNow()
        })
        return
      }
    }

    if (!isLifecycleActive(generation)) return

    let chronik: ChronikBroadcastClient | undefined
    try {
      chronik = resolveWalletChronikClient()
    } catch {
      chronik = undefined
    }

    if (chronik) {
      try {
        if (import.meta.env?.VITEST) {
          const hook = (globalThis as Record<symbol, unknown>)[
            Symbol.for('rmzwallet.testOnly.beforeSettlementRecoveryObservation')
          ]
          if (typeof hook === 'function') {
            await hook(executionId, targetTxid)
          }
        }
        if (!isLifecycleActive(generation)) return
        const observed = await chronik.tx(targetTxid)
        if (!isLifecycleActive(generation) || !authoritativeSettlementLedger) return
        if (observed && observed.txid?.toLowerCase() === targetTxid.toLowerCase()) {
          await authoritativeSettlementLedger.transitionToSettled({
            executionId,
            expectedTxid: targetTxid,
            settledAt: getNow()
          })
          return
        }
      } catch {
        // Not found in mempool or chain
      }
    }

    if (!isLifecycleActive(generation) || !authoritativeSettlementLedger) return

    await authoritativeSettlementLedger.markSettlementUncertain({
      executionId,
      reason:
        'Abandoned SETTLING execution recovered at startup without network confirmation. Reconciled to SETTLEMENT_UNCERTAIN without rebroadcast.',
      timestamp: getNow()
    })
  }

  async function attemptSettlementRecovery(
    executionId: string,
    expectedTxid?: string,
    calledGeneration?: number
  ): Promise<boolean> {
    const generation = calledGeneration ?? lifecycleGeneration
    if (!isLifecycleActive(generation) || !authoritativeSettlementLedger) return true

    const current = await authoritativeSettlementLedger.get(executionId)
    // 1. Re-check disposed immediately AFTER: await authoritativeSettlementLedger.get(executionId)
    if (!isLifecycleActive(generation) || !authoritativeSettlementLedger) return true

    if (!current || ((current as any).state ?? current.status) !== 'SETTLING') {
      cancelSettlementRecoveryRetry(executionId)
      return true
    }

    // 2. Re-check disposed BEFORE attempting/acquiring the settlement lock
    if (import.meta.env?.VITEST) {
      const hook = (globalThis as Record<symbol, unknown>)[
        Symbol.for('rmzwallet.testOnly.beforeSettlementLockAcquire')
      ]
      if (typeof hook === 'function') {
        await hook(executionId)
      }
    }
    if (!isLifecycleActive(generation)) return true

    const coordinator = resolveWalletSettlementLockCoordinator()
    const lockResult = await coordinator.tryExclusive(
      executionSettlementLockName(executionId),
      async () => {
        // 3. Re-check disposed INSIDE the acquired settlement-lock callback BEFORE:
        //    - handleSettlementRecovery()
        //    - Chronik query
        //    - any durable settlement mutation
        if (import.meta.env?.VITEST) {
          const hook = (globalThis as Record<symbol, unknown>)[
            Symbol.for('rmzwallet.testOnly.afterLockAcquisitionBeforeRecovery')
          ]
          if (typeof hook === 'function') {
            await hook(executionId)
          }
        }
        if (!isLifecycleActive(generation)) return
        await handleSettlementRecovery(executionId, expectedTxid ?? current.expectedTxid, generation)
      }
    )

    if (!isLifecycleActive(generation)) return true

    if (lockResult.acquired) {
      cancelSettlementRecoveryRetry(executionId)
      return true
    }

    return false
  }

  function scheduleSettlementRecoveryRetry(
    executionId: string,
    expectedTxid: string | undefined,
    attempt: number = 1
  ): void {
    if (disposed) return
    const generation = lifecycleGeneration

    cancelSettlementRecoveryRetry(executionId)

    const baseDelay = 50
    const delayMs =
      attempt >= 9
        ? 1000
        : Math.min(Math.round(baseDelay * Math.pow(1.5, attempt - 1)), 1000)

    const timer = setTimeout(async () => {
      if (!isLifecycleActive(generation)) return
      const currentEntry = pendingSettlementRetries.get(executionId)
      if (currentEntry?.timer !== timer) {
        return
      }

      try {
        const resolved = await attemptSettlementRecovery(executionId, expectedTxid, generation)
        if (!resolved && isLifecycleActive(generation) && pendingSettlementRetries.get(executionId)?.timer === timer) {
          scheduleSettlementRecoveryRetry(executionId, expectedTxid, attempt + 1)
        }
      } catch {
        if (isLifecycleActive(generation) && pendingSettlementRetries.get(executionId)?.timer === timer) {
          scheduleSettlementRecoveryRetry(executionId, expectedTxid, attempt + 1)
        }
      }
    }, delayMs)

    pendingSettlementRetries.set(executionId, { timer, attempt })
  }

  async function reconcileAbandonedSettlements(): Promise<void> {
    const generation = lifecycleGeneration
    if (!isLifecycleActive(generation) || !authoritativeSettlementLedger) return
    const settlingList = await authoritativeSettlementLedger.snapshotSettlingRecords()
    if (!isLifecycleActive(generation) || settlingList.length === 0) return

    for (const item of settlingList) {
      if (!isLifecycleActive(generation)) return
      const { executionId, expectedTxid } = item
      const resolved = await attemptSettlementRecovery(executionId, expectedTxid, generation)
      if (!resolved && isLifecycleActive(generation)) {
        scheduleSettlementRecoveryRetry(executionId, expectedTxid, 1)
      }
    }
  }

  const ledgerReady = executionLedger.whenReady()
  ledgerReady.catch(() => {
    // Callers of prepareExecution/confirm still await ledgerReady and observe the error.
  })

  const startupReady: Promise<void> = (async () => {
    await ledgerReady
    if (disposed) return
    schedulePreparedRecovery()
    await reconcileAbandonedSettlements().catch(() => {})
  })()
  startupReady.catch(() => {})
  const reviewOwnerId = `review_${createId()}`
  const reviewLeaseTtlSeconds = trusted?.reviewLeaseTtlSeconds ?? DEFAULT_REVIEW_LEASE_TTL_SECONDS
  const reviewHeartbeatMs = trusted?.reviewHeartbeatMs ?? 10_000
  let reviewLeaseGeneration = 1
  let reviewLockRelease: (() => void) | null = null
  let reviewHeartbeatTimer: ReturnType<typeof setInterval> | null = null
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null
  let handoffPhase: ReviewSigningHandoffPhase = 'IDLE'
  let preSigningAbort: AbortController | null = null

  /**
   * Wallet-private write-once persistence. NEVER uses Agent-injectable config.storage.
   * Constructed only from trusted Wallet bootstrap options or origin localStorage.
   */
  async function persistVerifiedSignedTransactionOnce(
    executionId: string,
    rawSignedTxHex: string
  ): Promise<void> {
    const targetStorage =
      trusted?.privateSettlementStorage ?? resolveFileLocalPrivateSettlementStorage()
    if (!targetStorage) {
      throw new WalletExecutionError(
        'STORAGE_UNAVAILABLE',
        'No durable settlement storage available. Raw signed transactions cannot be persisted.'
      )
    }
    const coordinator = resolveWalletSettlementLockCoordinator()
    await coordinator.requestExclusive(DEFAULT_SETTLEMENT_STORE_LOCK_NAME, async () => {
      const raw = targetStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
      let store: Record<string, string> = {}
      if (raw) {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (err) {
          throw new WalletExecutionError(
            'STORAGE_MUTATION_FAILED',
            `Failed to parse settlement store payload: ${err instanceof Error ? err.message : String(err)}`
          )
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new WalletExecutionError(
            'STORAGE_MUTATION_FAILED',
            'Settlement store payload is not a JSON object.'
          )
        }
        store = parsed as Record<string, string>
      }
      if (Object.prototype.hasOwnProperty.call(store, executionId)) {
        throw new WalletExecutionError(
          'SETTLEMENT_ARTIFACT_ALREADY_EXISTS',
          `A raw signed transaction already exists for execution "${executionId}". Write-once violation.`
        )
      }
      store[executionId] = rawSignedTxHex
      try {
        targetStorage.setItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY, JSON.stringify(store))
      } catch (err) {
        throw new WalletExecutionError(
          'STORAGE_MUTATION_FAILED',
          `Failed to store settlement transaction: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      const confirmedRaw = targetStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
      if (!confirmedRaw) {
        throw new WalletExecutionError(
          'STORAGE_MUTATION_FAILED',
          'Settlement persistence confirmation failed: store is empty after write.'
        )
      }
      const confirmed = JSON.parse(confirmedRaw) as Record<string, string>
      if (confirmed[executionId] !== rawSignedTxHex) {
        throw new WalletExecutionError(
          'STORAGE_MUTATION_FAILED',
          'Settlement persistence confirmation failed: stored artifact does not match verified bytes.'
        )
      }
    })
  }

  /**
   * Module-private raw signed transaction reader.
   * Scoped strictly to this composition closure.
   * NEVER exposed via any public interface or exported getter.
   */
  async function getPrivateSignedTransaction(executionId: string): Promise<string> {
    const targetStorage =
      trusted?.privateSettlementStorage ?? resolveFileLocalPrivateSettlementStorage()
    if (!targetStorage) {
      throw new WalletExecutionError(
        'STORAGE_UNAVAILABLE',
        'No durable settlement storage available. Raw signed transaction cannot be retrieved.'
      )
    }
    const coordinator = resolveWalletSettlementLockCoordinator()
    return coordinator.requestExclusive(DEFAULT_SETTLEMENT_STORE_LOCK_NAME, async () => {
      const raw = targetStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
      if (!raw) {
        throw new WalletExecutionError(
          'SETTLEMENT_ARTIFACT_NOT_FOUND',
          `No settlement artifact store found for execution "${executionId}".`
        )
      }
      let parsed: Record<string, string>
      try {
        parsed = JSON.parse(raw) as Record<string, string>
      } catch (err) {
        throw new WalletExecutionError(
          'STORAGE_MUTATION_FAILED',
          `Failed to parse settlement store payload: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      const rawTxHex = parsed[executionId]
      if (!rawTxHex) {
        throw new WalletExecutionError(
          'SETTLEMENT_ARTIFACT_NOT_FOUND',
          `Raw signed transaction artifact not found for execution "${executionId}".`
        )
      }
      return rawTxHex
    })
  }

  // Synchronous single-flight lock guards
  let isPreparing = false
  let activeExecutionId: string | null = null
  let activeCapability: InternalWalletExecutionCapability | null = null
  let activePlan: WalletPreparedExecutionPlan | null = null
  let activeController: WalletLocalConfirmationController | null = null

  const sessionPreparedListeners = new Set<
    (session: WalletExecutionReviewSession, controller: WalletLocalConfirmationController) => void
  >()

  function stopReviewHeartbeat(): void {
    if (reviewHeartbeatTimer !== null) {
      clearInterval(reviewHeartbeatTimer)
      reviewHeartbeatTimer = null
    }
  }

  function cancelScheduledRecovery(): void {
    if (recoveryTimer !== null) {
      clearTimeout(recoveryTimer)
      recoveryTimer = null
    }
  }

  function endLiveReview(): void {
    stopReviewHeartbeat()
    reviewLockRelease?.()
    reviewLockRelease = null
  }

  function schedulePreparedRecovery(): void {
    cancelScheduledRecovery()
    if (disposed) return
    void (async () => {
      try {
        await ledgerReady
        const leases = await executionLedger.snapshotPreparedLeases()
        if (disposed || leases.length === 0) return
        const now = getNow()
        const earliest = Math.min(...leases.map(lease => lease.leaseExpiresAt))
        const rawDelay = (earliest - now) * 1000 + 25
        const delayMs = Math.max(25, Math.min(rawDelay, 2_147_000_000))
        recoveryTimer = setTimeout(() => {
          void runScheduledRecovery()
        }, delayMs)
      } catch {
        // Recovery is best-effort; the next prepare/conflict path still reclaims.
      }
    })()
  }

  async function runScheduledRecovery(): Promise<void> {
    if (disposed) return
    try {
      const leases = await executionLedger.snapshotPreparedLeases()
      const now = getNow()
      for (const lease of leases) {
        if (disposed) return
        if (lease.leaseExpiresAt > now) continue
        await executionLedger.tryRecoverAbandonedPrepared(lease.executionId)
      }
    } finally {
      if (!disposed) {
        schedulePreparedRecovery()
      }
    }
  }

  function disposeComposition(): void {
    if (disposed) return
    disposed = true
    lifecycleGeneration += 1
    cancelAllSettlementRecoveryRetries()
    isPreparing = false
    cancelScheduledRecovery()
    sessionPreparedListeners.clear()
    activeController = null
    preSigningAbort?.abort()
    if (handoffPhase !== 'SIGNING_DURABLE') {
      endLiveReview()
      if (handoffPhase !== 'HANDOFF_TO_SIGNING') {
        activeExecutionId = null
        activeCapability = null
        activePlan = null
      }
    } else {
      stopReviewHeartbeat()
    }
  }

  async function beginLiveReview(executionId: string): Promise<void> {
    endLiveReview()
    let acquired!: () => void
    const acquiredPromise = new Promise<void>(resolve => {
      acquired = resolve
    })
    const hold = new Promise<void>(resolve => {
      reviewLockRelease = resolve
    })
    void executionLedger.runWithReviewLock(executionId, async () => {
      acquired()
      await hold
    })
    await acquiredPromise
    if (disposed) {
      endLiveReview()
      return
    }
    handoffPhase = 'REVIEW_ACTIVE'
    stopReviewHeartbeat()
    reviewHeartbeatTimer = setInterval(() => {
      if (disposed) {
        stopReviewHeartbeat()
        return
      }
      void executionLedger
        .renewReviewLease({
          executionId,
          ownerId: reviewOwnerId,
          generation: reviewLeaseGeneration,
          now: getNow(),
          leaseTtlSeconds: reviewLeaseTtlSeconds
        })
        .then(next => {
          reviewLeaseGeneration = next.generation
        })
        .catch(() => {
          stopReviewHeartbeat()
        })
    }, reviewHeartbeatMs)
  }

  async function executeSigningWithConfirmation(
    executionId: string,
    token: unknown
  ): Promise<SignedExecutionHandle> {
    // 1. Verify token is a valid, unconsumed local confirmation token
    if (
      !(token instanceof InternalLocalExecutionConfirmationToken) ||
      token.executionId !== executionId
    ) {
      throw new WalletExecutionError(
        'LOCAL_CONFIRMATION_REQUIRED',
        'Valid Wallet-local confirmation token required for signing.'
      )
    }

    if (token.isConsumed) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        'Confirmation token has already been consumed.'
      )
    }

    if (disposed) {
      throw new WalletExecutionError(
        'COMPOSITION_DISPOSED',
        'Trusted Wallet execution composition has been disposed. Confirmation is no longer valid.'
      )
    }

    await ledgerReady

    async function abortablePreSigning<T>(operation: Promise<T>): Promise<T> {
      const abort = preSigningAbort
      if (!abort) {
        return operation
      }
      if (abort.signal.aborted || disposed) {
        throw new WalletExecutionError(
          'COMPOSITION_DISPOSED',
          'Pre-SIGNING handoff was cancelled before cryptographic signing.'
        )
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          reject(
            new WalletExecutionError(
              'COMPOSITION_DISPOSED',
              'Pre-SIGNING handoff was cancelled before cryptographic signing.'
            )
          )
        }
        abort.signal.addEventListener('abort', onAbort, { once: true })
        operation.then(
          value => {
            abort.signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          error => {
            abort.signal.removeEventListener('abort', onAbort)
            reject(error)
          }
        )
      })
    }

    // Canonical handoff: review lock remains held. Signing lock is acquired next.
    // Review lock is released only after durable SIGNING is committed.
    return executionLedger.runWithSigningLock(executionId, async () => {
    handoffPhase = 'HANDOFF_TO_SIGNING'
    preSigningAbort = new AbortController()
    let durableSigningCommitted = false
    try {
    // 2. Look up current ledger state
    const currentRecord = await executionLedger.get(executionId)
    const currentStatus = currentRecord ? (currentRecord.status ?? (currentRecord as any).state) : undefined
    if (!currentRecord || currentStatus !== 'PREPARED') {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      activeController = null
      throw new WalletExecutionError(
        'INVALID_STATE_TRANSITION',
        `Cannot execute signing from record state "${currentStatus}". Expected "PREPARED".`
      )
    }

    // 3. Verify single-flight ownership
    if (activeExecutionId !== executionId || !activeCapability || !activePlan) {
      throw new WalletExecutionError(
        'CONCURRENT_EXECUTION_ACTIVE',
        `Execution "${executionId}" is not the currently active execution session.`
      )
    }

    const capability = activeCapability
    const plan = activePlan

    if (capability.isConsumed || capability.isInvalidated) {
      throw new WalletExecutionError(
        'DUPLICATE_EXECUTION',
        'Execution capability has already been consumed or invalidated.'
      )
    }

    const confirmNow = getNow()

    if (confirmNow >= capability.effectiveExpiresAt) {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      activeController = null
      capability.invalidate()
      await executionLedger.markExpired(executionId, 'Approval expired during review', confirmNow)
      throw new WalletExecutionError('APPROVAL_EXPIRED', 'Approval expired during review.')
    }

    if (disposed || preSigningAbort?.signal.aborted) {
      throw new WalletExecutionError(
        'COMPOSITION_DISPOSED',
        'Pre-SIGNING handoff was cancelled before cryptographic signing.'
      )
    }

    // 5. Revalidate active custodian session immediately before signing
    const preSignSession = await abortablePreSigning(sessionVerifier.verifyActiveSession())
    if (!preSignSession.authenticated || !preSignSession.activeAddress) {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      await executionLedger.markFailed(executionId, 'Session unauthenticated before signing', confirmNow)
      throw new WalletExecutionError(
        'SESSION_REVALIDATION_FAILED',
        'Custodian session revalidation failed before signing.'
      )
    }

    if (preSignSession.activeAddress !== plan.fromAddress) {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      await executionLedger.markFailed(executionId, 'Session address changed before signing', confirmNow)
      throw new WalletExecutionError(
        'SESSION_ADDRESS_MISMATCH',
        `Session address changed to "${preSignSession.activeAddress}" before signing.`
      )
    }

    // 6. Re-read and revalidate UTXOs immediately before signing
    const latestUtxos = await abortablePreSigning(utxoProvider.getSpendableUtxos(plan.fromAddress))
    for (const planInput of plan.inputs) {
      const match = latestUtxos.find(
        u => u.txid === planInput.txid && u.outIdx === planInput.outIdx && u.sats === planInput.sats
      )
      if (!match) {
        activeExecutionId = null
        activeCapability = null
        activePlan = null
        await executionLedger.markFailed(executionId, 'Selected UTXO is no longer spendable', confirmNow)
        throw new WalletExecutionError(
          'UTXO_SELECTION_STALE',
          `Selected input ${planInput.txid}:${planInput.outIdx} is no longer spendable.`
        )
      }
    }

    // 7. Anti-TOCTOU: Re-verify output invariants and re-verify plan hash
    validateOutputInvariants(
      plan,
      {
        destination: currentRecord.destination,
        amountSats: currentRecord.amountSats,
        fromAddress: currentRecord.fromAddress,
        network: 'xec:mainnet'
      },
      feePolicy
    )

    const recomputedPlanHash = computeCanonicalPlanHash(plan)
    if (recomputedPlanHash !== plan.planHash || capability.boundPlanHash !== plan.planHash) {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      await executionLedger.markFailed(executionId, 'Plan hash mismatch detected', confirmNow)
      throw new WalletExecutionError(
        'PLAN_HASH_MISMATCH',
        'Plan hash mismatch. Transaction plan was modified.'
      )
    }

    try {
      assertUniqueUtxoOutpoints(plan.inputs)
    } catch (dupErr) {
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      activeController = null
      capability.invalidate()
      await executionLedger.markFailed(
        executionId,
        dupErr instanceof Error ? dupErr.message : String(dupErr),
        getNow()
      )
      throw dupErr
    }

    try {
      await executionLedger.transitionToSigningIfValid({
        executionId,
        plan,
        effectiveExpiresAt: capability.effectiveExpiresAt,
        now: getNow
      })
    } catch (transitionErr) {
      if (transitionErr instanceof WalletExecutionError && transitionErr.code === 'APPROVAL_EXPIRED') {
        activeExecutionId = null
        activeCapability = null
        activePlan = null
        activeController = null
        capability.invalidate()
      }
      throw transitionErr
    }

    // Durable SIGNING is committed. Release review ownership only now.
    durableSigningCommitted = true
    handoffPhase = 'SIGNING_DURABLE'
    endLiveReview()

    // 9. Wallet-owned signing. The signer-returned object is discarded as an authority source.
    let rawSignedTxHex: string
    try {
      let signerReturned: { ser: () => Uint8Array }
      if (typeof (signatoryProvider as any).signTransaction === 'function') {
        const txBuilder = new TxBuilder({
          version: plan.transactionVersion,
          locktime: plan.locktime,
          inputs: plan.inputs.map(input => ({
            input: {
              prevOut: { txid: input.txid, outIdx: input.outIdx },
              signData: {
                sats: input.sats,
                outputScript: new Script(fromHex(input.lockingScriptHex))
              }
            }
          })),
          outputs: plan.outputs.map(output => ({
            sats: output.sats,
            script: new Script(fromHex(output.scriptHex))
          }))
        })

        signerReturned = await (signatoryProvider as any).signTransaction(txBuilder)
      } else {
        const sigResult = await signatoryProvider.getSignatory(plan.fromAddress)
        const signatory =
          sigResult && typeof sigResult === 'object' && 'signatory' in sigResult
            ? sigResult.signatory
            : sigResult

        if (!signatory) {
          throw new Error('Signatory provider returned null or undefined signatory.')
        }

        const txBuilder = new TxBuilder({
          version: plan.transactionVersion,
          locktime: plan.locktime,
          inputs: plan.inputs.map(input => ({
            input: {
              prevOut: { txid: input.txid, outIdx: input.outIdx },
              signData: {
                sats: input.sats,
                outputScript: new Script(fromHex(input.lockingScriptHex))
              }
            },
            signatory
          })),
          outputs: plan.outputs.map(output => ({
            sats: output.sats,
            script: new Script(fromHex(output.scriptHex))
          }))
        })

        signerReturned = txBuilder.sign()
      }

      if (!signerReturned || typeof signerReturned.ser !== 'function') {
        throw new Error('Signing provider did not return a serializable transaction.')
      }
      rawSignedTxHex = toHex(signerReturned.ser())
    } catch (signErr) {
      await executionLedger.markSigningUncertain(
        executionId,
        signErr instanceof Error ? signErr.message : String(signErr),
        getNow()
      )
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      throw new WalletExecutionError(
        'SIGNING_UNCERTAIN',
        'Signing error occurred. Execution marked SIGNING_UNCERTAIN to prevent automated duplicate signing.',
        signErr
      )
    }

    // 10. Independently deserialize raw bytes. Do not trust signer-returned collections.
    let parsedSignedTx: Tx
    try {
      parsedSignedTx = parseRawSignedTransaction(rawSignedTxHex)
    } catch (parseErr) {
      const parseReason = parseErr instanceof Error ? parseErr.message : String(parseErr)
      await executionLedger.markSigningUncertain(executionId, parseReason, getNow())
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      if (parseErr instanceof WalletExecutionError && parseErr.code === 'SIGNING_UNCERTAIN') {
        throw parseErr
      }
      throw new WalletExecutionError(
        'SIGNING_UNCERTAIN',
        'Signed transaction bytes could not be parsed. No SignedExecutionHandle was issued.',
        parseErr
      )
    }

    try {
      assertParsedTransactionMatchesPlan(parsedSignedTx, plan)
    } catch (verifyErr) {
      const mismatchReason = verifyErr instanceof Error ? verifyErr.message : String(verifyErr)
      await executionLedger.markSigningUncertain(executionId, mismatchReason, getNow())
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      if (verifyErr instanceof WalletExecutionError && verifyErr.code === 'SIGNED_TRANSACTION_MISMATCH') {
        throw verifyErr
      }
      throw new WalletExecutionError(
        'SIGNED_TRANSACTION_MISMATCH',
        `Post-sign verification failed: ${mismatchReason}`
      )
    }

    // 11. Persist verified raw bytes write-once under settlement-store exclusive lock BEFORE SIGNED.
    try {
      await persistVerifiedSignedTransactionOnce(executionId, rawSignedTxHex)
    } catch (persistErr) {
      const persistReason = persistErr instanceof Error ? persistErr.message : String(persistErr)
      await executionLedger.markSigningUncertain(executionId, persistReason, getNow())
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      throw new WalletExecutionError(
        'SIGNING_UNCERTAIN',
        'Raw signed transaction persistence failed after signing. Execution marked SIGNING_UNCERTAIN; automatic re-sign is prohibited.',
        persistErr
      )
    }

    // 12. Only after durable raw-tx persistence: transition SIGNING → SIGNED.
    const signedAt = getNow()
    try {
      await executionLedger.transitionToSigned(executionId, signedAt)
    } catch (commitErr) {
      const commitReason = commitErr instanceof Error ? commitErr.message : String(commitErr)
      try {
        await executionLedger.markSigningUncertain(executionId, commitReason, getNow())
      } catch {
        // If the ledger cannot move off SIGNING, restart reconciliation still fail-closes.
      }
      activeExecutionId = null
      activeCapability = null
      activePlan = null
      throw new WalletExecutionError(
        'SIGNING_UNCERTAIN',
        'Durable SIGNED transition failed after raw-tx persistence. Automatic re-sign is prohibited.',
        commitErr
      )
    }

    // Consume capability & release single-flight lock
    capability.consume()
    activeExecutionId = null
    activeCapability = null
    activePlan = null

    // 13. Return opaque SignedExecutionHandle. STOP. Zero broadcast. No raw-tx read/write API.
    return Object.freeze({
      executionId,
      approvalId: plan.approvalId,
      requestId: plan.requestId,
      status: 'SIGNED',
      planHash: plan.planHash,
      signedAt
    })
    } finally {
      if (!durableSigningCommitted) {
        endLiveReview()
        handoffPhase = 'IDLE'
        preSigningAbort = null
        try {
          const current = await executionLedger.get(executionId)
          const status = current ? (current.status ?? (current as { state?: string }).state) : undefined
          if (status === 'PREPARED') {
            await executionLedger.markFailed(
              executionId,
              'Pre-SIGNING handoff aborted or failed before durable SIGNING. Outpoints released.',
              getNow()
            )
          }
        } catch {
          // Already terminal or ledger unavailable; review ownership is still released.
        }
        if (activeExecutionId === executionId) {
          activeExecutionId = null
          activeCapability = null
          activePlan = null
          activeController = null
        }
      } else {
        preSigningAbort = null
      }
    }
    })
  }

  async function prepareExecution(receiptInput: unknown): Promise<WalletExecutionReviewSession> {
    // 1. Synchronous single-flight reservation check BEFORE any await (P1-1)
    if (disposed) {
      throw new WalletExecutionError(
        'COMPOSITION_DISPOSED',
        'Trusted Wallet execution composition has been disposed. New prepared sessions are prohibited.'
      )
    }
    if (isPreparing || activeExecutionId !== null) {
      throw new WalletExecutionError(
        'CONCURRENT_EXECUTION_ACTIVE',
        'An execution review session is already active or being prepared.'
      )
    }
    isPreparing = true

    try {
      await startupReady

      // 2. Parse the incoming value with the canonical HumanApprovalV1 schema only.
      const receipt = parseCanonicalHumanApproval(receiptInput)

      if (receipt.status !== 'approved') {
        throw new WalletExecutionError(
          'RECEIPT_NOT_APPROVED',
          `Cannot prepare execution for receipt status "${receipt.status}". Only approved receipts are executable.`
        )
      }

      const now = getNow()

      // 3. Look up immutable approval record in approval ledger
      const record = await approvalLedger.get(receipt.requestId)
      if (!record) {
        throw new WalletExecutionError(
          'APPROVAL_NOT_FOUND',
          `No recorded approval found for requestId "${receipt.requestId}".`
        )
      }

      const recordedHumanApproval = parseCanonicalHumanApproval(record.humanApproval)

      // Authoritative Gate 2B decision must be approved. Rejected ledger records never execute,
      // even if a caller mutates only the externally supplied receipt status.
      if (record.status !== 'approved') {
        throw new WalletExecutionError(
          'RECEIPT_NOT_APPROVED',
          `Authoritative WalletApprovalLedgerRecord status is "${record.status}". Rejected decisions cannot execute.`
        )
      }
      if (recordedHumanApproval.status !== 'approved') {
        throw new WalletExecutionError(
          'RECEIPT_NOT_APPROVED',
          `Authoritative stored HumanApprovalV1 status is "${recordedHumanApproval.status}". Rejected decisions cannot execute.`
        )
      }

      if (record.network !== 'xec:mainnet') {
        throw new WalletExecutionError(
          'UNSUPPORTED_NETWORK',
          `Network "${record.network}" is not supported. Only "xec:mainnet" is supported.`
        )
      }

      // 4. Verify active custodian session
      const activeWalletSession = await sessionVerifier.verifyActiveSession()
      if (!activeWalletSession.authenticated || !activeWalletSession.activeAddress) {
        throw new WalletExecutionError(
          'SESSION_REVALIDATION_FAILED',
          `Active wallet session unauthenticated: ${activeWalletSession.error ?? 'unknown error'}.`
        )
      }

      if (activeWalletSession.activeAddress !== record.fromAddress) {
        throw new WalletExecutionError(
          'SESSION_ADDRESS_MISMATCH',
          `Active wallet session address "${activeWalletSession.activeAddress}" does not match approved fromAddress "${record.fromAddress}".`
        )
      }

      // 5. At-most-once check: verify approval has not already been reserved or executed
      const existingByApproval = await executionLedger.getByApprovalId(record.approvalId)
      if (existingByApproval) {
        const status = existingByApproval.status ?? (existingByApproval as { state?: string }).state
        throw new WalletExecutionError(
          'DUPLICATE_EXECUTION',
          `Execution already initiated for approvalId "${record.approvalId}" in state "${status}".`
        )
      }

      const existingByRequest = await executionLedger.getByRequestId(record.requestId)
      if (existingByRequest) {
        const status = existingByRequest.status ?? (existingByRequest as { state?: string }).state
        throw new WalletExecutionError(
          'DUPLICATE_EXECUTION',
          `Execution already initiated for requestId "${record.requestId}" in state "${status}".`
        )
      }

      // 6. Bind canonical HumanApprovalV1 fields to the authoritative ledger record.
      if (receipt.approvalId !== record.approvalId || receipt.approvalId !== recordedHumanApproval.approvalId) {
        throw new WalletExecutionError(
          'APPROVAL_FIELD_MISMATCH',
          `approvalId mismatch: receipt "${receipt.approvalId}" !== ledger "${record.approvalId}".`
        )
      }
      if (receipt.requestId !== record.requestId || receipt.requestId !== recordedHumanApproval.requestId) {
        throw new WalletExecutionError(
          'APPROVAL_FIELD_MISMATCH',
          `requestId mismatch: receipt "${receipt.requestId}" !== ledger "${record.requestId}".`
        )
      }
      if (receipt.intentId !== record.intentId || receipt.intentId !== recordedHumanApproval.intentId) {
        throw new WalletExecutionError(
          'APPROVAL_FIELD_MISMATCH',
          `intentId mismatch: receipt "${receipt.intentId}" !== ledger "${record.intentId}".`
        )
      }
      if (receipt.decisionId !== record.decisionId || receipt.decisionId !== recordedHumanApproval.decisionId) {
        throw new WalletExecutionError(
          'APPROVAL_FIELD_MISMATCH',
          `decisionId mismatch: receipt "${receipt.decisionId}" !== ledger "${record.decisionId}".`
        )
      }
      if (receipt.approver !== record.fromAddress || recordedHumanApproval.approver !== record.fromAddress) {
        throw new WalletExecutionError(
          'APPROVAL_FIELD_MISMATCH',
          `approver mismatch: receipt "${receipt.approver}" !== ledger "${record.fromAddress}".`
        )
      }
      if (receipt.recordedAt !== record.recordedAt || receipt.recordedAt !== recordedHumanApproval.recordedAt) {
        throw new WalletExecutionError(
          'APPROVAL_FIELD_MISMATCH',
          `recordedAt mismatch: receipt ${receipt.recordedAt} !== ledger ${record.recordedAt}.`
        )
      }
      if (now >= record.effectiveExpiresAt) {
        throw new WalletExecutionError(
          'APPROVAL_EXPIRED',
          `Approval expired at ${record.effectiveExpiresAt}; current time is ${now}.`
        )
      }

      const approvedAmountSats = canonicalApprovedAmountSats(record.amountSats)

      // 7. Mint module-private execution capability
      const capabilityId = `exec_cap_${createId()}`
      const capability = new InternalWalletExecutionCapability(INTERNAL_CAPABILITY_TOKEN, {
        capabilityId,
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        decisionId: record.decisionId,
        approvalStatus: 'approved',
        approver: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats,
        network: 'xec:mainnet',
        contentHash: record.contentHash,
        effectiveExpiresAt: record.effectiveExpiresAt
      })

      // 8. Atomically reserve execution in durable ledger
      const executionId = `exec_${createId()}`
      await executionLedger.reserveExecutionAtomic({
        executionId,
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        decisionId: record.decisionId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats,
        network: 'xec:mainnet',
        reservedAt: now
      })

      // 9-11. Every operation after reservation and before durable PREPARED is
      // inside this explicit pre-PREPARED failure boundary.
      let plan: WalletPreparedExecutionPlan
      try {
        const availableUtxos = snapshotOwnedUtxos(
          await utxoProvider.getSpendableUtxos(record.fromAddress)
        )
        plan = buildPreparedExecutionPlan({
          approved: {
            approvalId: record.approvalId,
            requestId: record.requestId,
            intentId: record.intentId,
            fromAddress: record.fromAddress,
            destination: record.destination,
            amountSats: approvedAmountSats
          },
          availableUtxos,
          feePolicy
        })
        capability.bindPlan(plan)
        reviewLeaseGeneration = 1
        const committedLease = await executionLedger.setPlanPrepared(executionId, plan, {
          ownerId: reviewOwnerId,
          generation: reviewLeaseGeneration,
          leaseTtlSeconds: reviewLeaseTtlSeconds
        })
        reviewLeaseGeneration = committedLease.generation
      } catch (prePreparedErr) {
        await executionLedger.markFailed(
          executionId,
          prePreparedErr instanceof Error ? prePreparedErr.message : String(prePreparedErr),
          getNow()
        )
        throw prePreparedErr
      }

        // 12. Construct human-readable review snapshot
        const review: WalletExecutionReviewSnapshot = Object.freeze({
          recipient: plan.destination,
          amountXEC: formatBigIntToExactXEC(plan.paymentAmountSats),
          amountSats: plan.paymentAmountSats.toString(),
          feeXEC: formatBigIntToExactXEC(plan.feeSats),
          feeSats: plan.feeSats.toString(),
          totalDebitXEC: formatBigIntToExactXEC(plan.paymentAmountSats + plan.feeSats),
          totalDebitSats: (plan.paymentAmountSats + plan.feeSats).toString(),
          fundingAddress: plan.fromAddress,
          network: 'xec:mainnet',
          approvalId: plan.approvalId,
          requestId: plan.requestId,
          intentId: plan.intentId,
          planHash: plan.planHash
        })

        // Set active single-flight state
        activeExecutionId = executionId
        activeCapability = capability
        activePlan = plan

        // 13. Construct review-only session (P0-3: NO signing method on session!)
        const session: WalletExecutionReviewSession = Object.freeze({
          executionId,
          plan,
          review,
          rejectExecution: async (reason?: string): Promise<void> => {
            endLiveReview()
            if (activeExecutionId === executionId) {
              activeExecutionId = null
              activeCapability = null
              activePlan = null
              activeController = null
            }
            capability.invalidate()
            await executionLedger.markRejected(
              executionId,
              reason ?? 'Execution rejected by human custodian.',
              getNow()
            )
          },
          dismiss: async (): Promise<void> => {
            endLiveReview()
            if (activeExecutionId === executionId) {
              activeExecutionId = null
              activeCapability = null
              activePlan = null
              activeController = null
            }
            capability.invalidate()
            // P0-4: Dismiss durably transitions execution to terminal REJECTED
            await executionLedger.markRejected(
              executionId,
              'Execution dismissed by custodian.',
              getNow()
            )
          }
        })

        // Wallet-owned local confirmation controller (strictly closure-confined to Wallet UI composition)
        const localController: WalletLocalConfirmationController = Object.freeze({
          executionId,
          confirm: async (): Promise<SignedExecutionHandle> => {
            if (disposed) {
              throw new WalletExecutionError(
                'COMPOSITION_DISPOSED',
                'Local confirmation controller was invalidated. Stale confirm() is prohibited.'
              )
            }
            const token = new InternalLocalExecutionConfirmationToken(
              LOCAL_CONFIRMATION_TOKEN,
              executionId
            )
            return executeSigningWithConfirmation(executionId, token)
          },
          reject: async (reason?: string): Promise<void> => {
            return session.rejectExecution(reason)
          },
          dismiss: async (): Promise<void> => {
            return session.dismiss()
          }
        })

        activeController = localController
        await beginLiveReview(executionId)
        schedulePreparedRecovery()

        // Dispatch to Wallet UI host listeners
        for (const listener of sessionPreparedListeners) {
          try {
            listener(session, localController)
          } catch (err) {
            console.error('Wallet UI host onSessionPrepared listener failed:', err)
          }
        }

        return session
      } finally {
        isPreparing = false
      }
    }

    async function getExecutionStatus(executionId: string): Promise<PublicExecutionStatus | undefined> {
      await startupReady
      const authRecord = authoritativeSettlementLedger ? await authoritativeSettlementLedger.get(executionId) : undefined
      const record = authRecord ?? (await executionLedger.get(executionId))
      if (!record) return undefined

      // P0-2: Strip raw signed tx hex from public status
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
        status: (record as any).status ?? (record as any).state,
        planHash: record.planHash,
        uncertainReason: record.uncertainReason,
        reservedAt: record.reservedAt,
        preparedAt: record.preparedAt,
        signingAt: record.signingAt,
        signedAt: record.signedAt,
        settlingAt: record.settlingAt,
        settledAt: record.settledAt,
        expectedTxid: record.expectedTxid,
        failedAt: record.failedAt
      })
    }

    /**
     * Authoritative settlement worker.
     * Transitions SIGNED → SETTLING → broadcast to Chronik → SETTLED.
     * Reconciles crash-recovery if previously SETTLING.
     *
     * Boundary Rules:
     * NEVER exports raw signed transaction bytes.
     * Produces only an immutable WalletSettlementReceiptV1.
     */
    async function settleExecution(executionId: string): Promise<WalletSettlementReceiptV1> {
      if (disposed) {
        throw new WalletExecutionError('COMPOSITION_DISPOSED', 'Execution engine is disposed.')
      }

      await startupReady

      const settlementLedger = getAuthoritativeSettlementLedger()

      return settlementLedger.runWithSettlementLock(executionId, async () => {
        if (disposed) {
          throw new WalletExecutionError('COMPOSITION_DISPOSED', 'Execution engine is disposed.')
        }

        const currentStatus = await settlementLedger.get(executionId)
        if (!currentStatus) {
          throw new WalletExecutionError(
            'EXECUTION_NOT_FOUND',
            `Execution record "${executionId}" not found.`
          )
        }

        const state = (currentStatus as any).state ?? (currentStatus as any).status

        // Idempotent return if already settled
        if (state === 'SETTLED') {
          return Object.freeze({
            status: 'settled',
            network: currentStatus.network,
            executionId: currentStatus.executionId,
            approvalId: currentStatus.approvalId,
            requestId: currentStatus.requestId,
            txid: currentStatus.expectedTxid!,
            settledAt: currentStatus.settledAt ?? currentStatus.signedAt ?? getNow()
          })
        }

        // Terminal rejected check
        if (state === 'SETTLEMENT_REJECTED') {
          throw new WalletExecutionError(
            'SETTLEMENT_REJECTED',
            `Execution "${executionId}" has already been definitively rejected: ${currentStatus.uncertainReason ?? 'settlement rejected'}`
          )
        }

        // Chronik client resolution from trusted runtime
        const chronik = resolveWalletChronikClient()

        // Handle recovering SETTLING or SETTLEMENT_UNCERTAIN
        if (state === 'SETTLING' || state === 'SETTLEMENT_UNCERTAIN') {
          let expectedTxid = currentStatus.expectedTxid
          if (!expectedTxid) {
            const rawTxHex = await getPrivateSignedTransaction(executionId)
            expectedTxid = deriveExpectedTxidFromRawTxHex(rawTxHex)
          }

          // Query network acceptance before any further action
          let accepted = false
          try {
            const queryRes = await chronik.tx(expectedTxid)
            if (queryRes && queryRes.txid?.toLowerCase() === expectedTxid.toLowerCase()) {
              accepted = true
            }
          } catch {
            accepted = false
          }

          if (accepted) {
            const settledAt = getNow()
            await settlementLedger.transitionToSettled({
              executionId,
              expectedTxid,
              settledAt
            })
            return Object.freeze({
              status: 'settled',
              network: currentStatus.network,
              executionId: currentStatus.executionId,
              approvalId: currentStatus.approvalId,
              requestId: currentStatus.requestId,
              txid: expectedTxid,
              settledAt
            })
          }

          // If previously SETTLEMENT_UNCERTAIN and not accepted, keep uncertain
          if (state === 'SETTLEMENT_UNCERTAIN') {
            throw new WalletExecutionError(
              'SETTLEMENT_UNCERTAIN',
              `Execution "${executionId}" settlement outcome is uncertain: ${currentStatus.uncertainReason ?? 'network acceptance could not be confirmed'}`
            )
          }

          // If was SETTLING (abandoned attempt), mark uncertain
          await settlementLedger.markSettlementUncertain({
            executionId,
            reason: 'Previous settlement attempt interrupted; transaction not observed on network.',
            timestamp: getNow()
          })
          throw new WalletExecutionError(
            'SETTLEMENT_UNCERTAIN',
            `Execution "${executionId}" settlement interrupted. Reconciled to SETTLEMENT_UNCERTAIN.`
          )
        }

        // Only SIGNED state can initiate a new broadcast
        if (state !== 'SIGNED') {
          throw new WalletExecutionError(
            'INVALID_SETTLEMENT_STATE',
            `Cannot settle execution "${executionId}" in state "${state}". Execution must be in SIGNED state.`
          )
        }

        // Retrieve raw signed tx from module-private storage
        const rawSignedTxHex = await getPrivateSignedTransaction(executionId)

        // Derive expectedTxid locally from verified signed bytes
        const expectedTxid = deriveExpectedTxidFromRawTxHex(rawSignedTxHex)

        // Bind and persist expectedTxid in durable SETTLING state BEFORE broadcast
        const settlingAt = getNow()
        await settlementLedger.transitionToSettling({
          executionId,
          expectedTxid,
          settlingAt
        })

        // Broadcast to Chronik
        const rawTxBytes = fromHex(rawSignedTxHex)
        let broadcastTxid: string | undefined
        let broadcastError: unknown = null

        try {
          const res = await chronik.broadcastTx(rawTxBytes)
          broadcastTxid = res?.txid?.toLowerCase()
        } catch (err) {
          broadcastError = err
        }

        // If broadcast threw, check whether the network actually accepted it or if it was rejected
        if (broadcastError) {
          // Check network acceptance (e.g. timeout on broadcast response, or already in mempool)
          let accepted = false
          try {
            const queryRes = await chronik.tx(expectedTxid)
            if (queryRes && queryRes.txid?.toLowerCase() === expectedTxid.toLowerCase()) {
              accepted = true
            }
          } catch {
            accepted = false
          }

          if (accepted) {
            cancelSettlementRecoveryRetry(executionId)
            const settledAt = getNow()
            await settlementLedger.transitionToSettled({
              executionId,
              expectedTxid,
              settledAt
            })
            return Object.freeze({
              status: 'settled',
              network: currentStatus.network,
              executionId: currentStatus.executionId,
              approvalId: currentStatus.approvalId,
              requestId: currentStatus.requestId,
              txid: expectedTxid,
              settledAt
            })
          }

          // Any exception thrown by Chronik broadcastTx() where tx is not observed on network
          // defaults to SETTLEMENT_UNCERTAIN. Gate C3A does NOT infer permanent invalidity from
          // any broadcast exception. Outpoint reservations are retained (never released on broadcast failure).
          cancelSettlementRecoveryRetry(executionId)
          const timestamp = getNow()
          const reason = broadcastError instanceof Error ? broadcastError.message : String(broadcastError)
          await settlementLedger.markSettlementUncertain({
            executionId,
            reason: `Settlement broadcast uncertain: ${reason}`,
            timestamp
          })
          throw new WalletExecutionError(
            'SETTLEMENT_UNCERTAIN',
            `Settlement broadcast outcome uncertain: ${reason}`,
            broadcastError
          )
        }

        // Broadcast returned normally: verify returnedTxid === expectedTxid
        if (!broadcastTxid || broadcastTxid !== expectedTxid) {
          // FAIL CLOSED
          const timestamp = getNow()
          await settlementLedger.markSettlementUncertain({
            executionId,
            reason: `Chronik returned txid "${broadcastTxid}" does not match locally derived expected txid "${expectedTxid}".`,
            timestamp
          })
          throw new WalletExecutionError(
            'SETTLEMENT_TXID_MISMATCH',
            `Chronik returned txid "${broadcastTxid}" does not match locally derived expected txid "${expectedTxid}".`
          )
        }

        // Verify network acceptance via Chronik query
        let verifiedAcceptance = false
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const queryRes = await chronik.tx(expectedTxid)
            if (queryRes && queryRes.txid?.toLowerCase() === expectedTxid.toLowerCase()) {
              verifiedAcceptance = true
              break
            }
          } catch {
            await new Promise(resolve => setTimeout(resolve, 50))
          }
        }

        if (!verifiedAcceptance) {
          const timestamp = getNow()
          await settlementLedger.markSettlementUncertain({
            executionId,
            reason: 'Broadcast succeeded but network acceptance could not be verified via Chronik index.',
            timestamp
          })
          throw new WalletExecutionError(
            'SETTLEMENT_UNCERTAIN',
            'Broadcast succeeded but network acceptance could not be verified via Chronik index.'
          )
        }

        // Transition to SETTLED
        const settledAt = getNow()
        await settlementLedger.transitionToSettled({
          executionId,
          expectedTxid,
          settledAt
        })

        return Object.freeze({
          status: 'settled',
          network: currentStatus.network,
          executionId: currentStatus.executionId,
          approvalId: currentStatus.approvalId,
          requestId: currentStatus.requestId,
          txid: expectedTxid,
          settledAt
        })
      })
    }

    const publicEngine: AgentWalletExecutionEngine = Object.freeze({
      prepareExecution,
      getExecutionStatus,
      settle: settleExecution
    })

    const walletUIHost: WalletExecutionUIHost = Object.freeze({
      onSessionPrepared(
        handler: (
          session: WalletExecutionReviewSession,
          localController: WalletLocalConfirmationController
        ) => void
      ): () => void {
        sessionPreparedListeners.add(handler)
        return () => {
          sessionPreparedListeners.delete(handler)
        }
      },
      getActiveController(): WalletLocalConfirmationController | undefined {
        if (disposed) return undefined
        return activeController ?? undefined
      }
    })

    return {
      publicEngine,
      walletUIHost,
      dispose: disposeComposition
    }
  }

  /**
   * Helper that returns the public Agent-facing engine wrapped with an explicit lifecycle dispose method.
   * Strictly exposes NO confirm, sign, execute, local confirmation controller, private storage,
   * settlement mutators, Chronik, lock coordinator, raw tx, or signing authority.
   */
  export function createAgentWalletExecutionEngine(
    config: AgentWalletExecutionEngineConfig
  ): DisposableAgentWalletExecutionEngine {
    const composition = createWalletExecutionComposition(
      config,
      import.meta.env?.VITEST && config.storage
        ? { executionStorage: config.storage }
        : undefined
    )

    const disposableEngine: DisposableAgentWalletExecutionEngine = {
      prepareExecution: receipt =>
        composition.publicEngine.prepareExecution(receipt),

      getExecutionStatus: executionId =>
        composition.publicEngine.getExecutionStatus(executionId),

      settle: executionId =>
        composition.publicEngine.settle(executionId),

      dispose: () => composition.dispose()
    }

    return Object.freeze(disposableEngine)
  }

  if (import.meta.env?.VITEST) {
    Object.defineProperty(globalThis, TEST_ONLY_CREATE_WALLET_EXECUTION_COMPOSITION, {
      value: (config: AgentWalletExecutionEngineConfig, trusted?: WalletExecutionTrustedOptions) => {
        const effectiveTrusted: WalletExecutionTrustedOptions = {
          ...(config.storage && !trusted?.executionStorage
            ? { executionStorage: config.storage }
            : {}),
          ...trusted
        }
        return createWalletExecutionComposition(config, effectiveTrusted)
      },
      configurable: true,
      enumerable: false,
      writable: true
    })
  }

export interface TrustedWalletExecutionProviderProps {
  readonly children: ReactNode
  readonly approvalLedger?: AgentWalletExecutionEngineConfig['approvalLedger']
  readonly executionLedger?: AgentWalletExecutionEngineConfig['executionLedger']
  readonly sessionVerifier?: AgentWalletExecutionEngineConfig['sessionVerifier']
  readonly utxoProvider?: AgentWalletExecutionEngineConfig['utxoProvider']
  readonly signatoryProvider?: AgentWalletExecutionEngineConfig['signatoryProvider']
  readonly feePolicy?: AgentWalletExecutionEngineConfig['feePolicy']
  readonly lockCoordinator?: AgentWalletExecutionEngineConfig['lockCoordinator']
  readonly clock?: AgentWalletExecutionEngineConfig['clock']
  readonly idGenerator?: AgentWalletExecutionEngineConfig['idGenerator']
  /**
   * Public execution-ledger Storage only. NEVER used for raw signed transactions.
   */
  readonly ledgerStorage?: Storage
  readonly reviewLeaseTtlSeconds?: number
  readonly reviewHeartbeatMs?: number
}

interface ShellSlot {
  composition: WalletExecutionComposition
  refs: number
  disposeScheduled: boolean
}

let shellSlot: ShellSlot | null = null

export function resetTrustedExecutionShellForTests(): void {
  if (shellSlot) {
    try {
      shellSlot.composition.dispose()
    } catch {
      // Test reset must not throw from a previous composition.
    }
  }
  shellSlot = null
  fallbackTestSettlementQueues.clear()
}

function getOrCreateShell(
  publicConfig: AgentWalletExecutionEngineConfig,
  trusted: WalletExecutionTrustedOptions
): WalletExecutionComposition {
  if (!shellSlot) {
    shellSlot = {
      composition: createWalletExecutionComposition(publicConfig, trusted),
      refs: 0,
      disposeScheduled: false
    }
  }
  return shellSlot.composition
}

function releaseShell(): void {
  if (!shellSlot) return
  shellSlot.refs -= 1
  if (shellSlot.refs > 0) return
  const slot = shellSlot
  slot.disposeScheduled = true
  queueMicrotask(() => {
    if (shellSlot !== slot || shellSlot.refs > 0) {
      slot.disposeScheduled = false
      return
    }
    slot.composition.dispose()
    if (shellSlot === slot) {
      shellSlot = null
    }
  })
}

/**
 * Trusted Wallet application-shell bootstrap. Owns composition creation in a
 * file-local closure. Agent/public code never receives the factory.
 */
export function TrustedWalletExecutionProvider({
  children,
  approvalLedger,
  executionLedger,
  sessionVerifier,
  utxoProvider,
  signatoryProvider,
  feePolicy,
  lockCoordinator,
  clock,
  idGenerator,
  ledgerStorage,
  reviewLeaseTtlSeconds,
  reviewHeartbeatMs
}: TrustedWalletExecutionProviderProps): ReactElement {
  const productionRuntime = useMemo(() => {
    const testsSupplyAdapters = Boolean(
      approvalLedger ||
        executionLedger ||
        sessionVerifier ||
        utxoProvider ||
        signatoryProvider ||
        lockCoordinator ||
        ledgerStorage
    )
    if (testsSupplyAdapters) {
      return null
    }
    return createProductionWalletRuntime()
  }, [
    approvalLedger,
    executionLedger,
    sessionVerifier,
    utxoProvider,
    signatoryProvider,
    lockCoordinator,
    ledgerStorage
  ])

  const resolvedApprovalLedger = approvalLedger ?? productionRuntime?.approvalLedger
  const resolvedSessionVerifier = sessionVerifier ?? productionRuntime?.sessionVerifier
  const resolvedUtxoProvider = utxoProvider ?? productionRuntime?.utxoProvider
  const resolvedSignatoryProvider =
    signatoryProvider ?? (resolvedApprovalLedger ? createFileLocalProductionSignatoryProvider() : undefined)
  const resolvedLedgerStorage = ledgerStorage ?? productionRuntime?.ledgerStorage

  const c2Enabled = Boolean(
    resolvedApprovalLedger &&
      resolvedSessionVerifier &&
      resolvedUtxoProvider &&
      resolvedSignatoryProvider
  )

  const compositionRef = useRef<WalletExecutionComposition | null>(null)
  if (c2Enabled && compositionRef.current === null) {
    compositionRef.current = getOrCreateShell(
      {
        approvalLedger: resolvedApprovalLedger!,
        executionLedger,
        sessionVerifier: resolvedSessionVerifier!,
        utxoProvider: resolvedUtxoProvider!,
        signatoryProvider: resolvedSignatoryProvider!,
        feePolicy,
        storage: resolvedLedgerStorage,
        lockCoordinator,
        clock,
        idGenerator
      },
      {
        executionStorage: import.meta.env?.VITEST ? resolvedLedgerStorage : undefined,
        privateSettlementStorage: resolveFileLocalPrivateSettlementStorage(),
        reviewLeaseTtlSeconds,
        reviewHeartbeatMs
      }
    )
  }
  const composition = compositionRef.current

  const [session, setSession] = useState<WalletExecutionReviewSession | null>(null)
  const [controller, setController] = useState<WalletLocalConfirmationController | null>(null)

  useEffect(() => {
    if (!composition) {
      return
    }
    if (shellSlot) {
      shellSlot.refs += 1
      shellSlot.disposeScheduled = false
    }
    const unsubscribe = composition.walletUIHost.onSessionPrepared((nextSession, nextController) => {
      setSession(nextSession)
      setController(nextController)
    })
    return () => {
      unsubscribe()
      releaseShell()
    }
  }, [composition])

  const clearActiveReview = () => {
    setSession(null)
    setController(null)
  }

  const contextValue = useMemo<TrustedWalletExecutionContextValue>(
    () => ({
      publicEngine: composition?.publicEngine ?? null
    }),
    [composition]
  )

  const bound =
    session !== null && controller !== null && controller.executionId === session.executionId

  if (!c2Enabled) {
    return (
      <TrustedWalletExecutionContext.Provider value={{ publicEngine: null }}>
        {children}
      </TrustedWalletExecutionContext.Provider>
    )
  }

  return (
    <TrustedWalletExecutionContext.Provider value={contextValue}>
      {children}
      {bound && session && controller ? (
        <AgentExecutionReviewModal
          session={session}
          controller={controller}
          isOpen={true}
          onExecutionSuccess={clearActiveReview}
          onExecutionRejected={clearActiveReview}
          onClose={clearActiveReview}
        />
      ) : null}
    </TrustedWalletExecutionContext.Provider>
  )
}
