/**
 * @file agentWalletExecution.test.ts
 *
 * CANONICAL TEST SUITE FOR GATE C2 (Wallet-Owned Prepared Transaction Execution)
 *
 * Verifies all required P0 focus tests, durable crash consistency, invariant enforcement,
 * anti-TOCTOU, single-flight concurrency guards, output script matching, post-sign verification,
 * and boundary checks.
 */

import { describe, expect, it, vi } from 'vitest'
import { ALL_BIP143, Ecc, P2PKHSignatory, Script, toHex, Tx, TxBuilder } from 'ecash-lib'
import { humanApprovalV1Schema, type HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import type { WalletApprovalLedgerRecord } from '../agentWalletApprovalReceiver/types'
import '../../internal/agentWalletExecutionHost/trustedWalletExecutionRuntime'
import type { WalletExecutionComposition } from '../../internal/agentWalletExecutionHost'
import type { AgentWalletExecutionEngineConfig, WalletExecutionTrustedOptions } from './types'

const createWalletExecutionComposition = ((
  ...args: [AgentWalletExecutionEngineConfig, WalletExecutionTrustedOptions?]
): WalletExecutionComposition => {
  const factory = (globalThis as Record<symbol, unknown>)[
    Symbol.for('rmzwallet.testOnly.createWalletExecutionComposition')
  ]
  if (typeof factory !== 'function') {
    throw new Error('Test-only composition factory is not registered.')
  }
  return (factory as (...inner: typeof args) => WalletExecutionComposition)(...args)
}) as (
  config: AgentWalletExecutionEngineConfig,
  trusted?: WalletExecutionTrustedOptions
) => WalletExecutionComposition
import {
  DEFAULT_EXECUTION_LEDGER_STORAGE_KEY,
  DEFAULT_EXECUTION_LOCK_NAME,
  DurableStorageWalletExecutionLedger,
  DurableTransactionalExecutionLedger,
  WebLocksExecutionCoordinator,
  canonicalOutpointKey,
  executionReviewLockName,
  executionSigningLockName
} from './ledger'
import { DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY } from '../../internal/settlementStore'
import { InMemoryWalletExecutionLedger, MockStorage, TestExecutionLockCoordinator } from './testUtils'
import { WalletExecutionError } from './errors'
import {
  assertFeePolicy,
  assertUniqueUtxoOutpoints,
  buildPreparedExecutionPlan,
  computeCanonicalPlanHash,
  DEFAULT_FEE_POLICY,
  estimateP2pkhTransactionSize,
  snapshotOwnedUtxos,
  validateOutputInvariants
} from './plan'
import type { ExecutionUtxoInput, WalletFeePolicy } from './types'

const FROM_ADDRESS = 'ecash:qpumqqygwcnt999fz3gp5nxjy66ckg6esvxaqmtclv'
const DESTINATION_ADDRESS = 'ecash:qr4upmst92u7sfm6vqxz29r4ug4rysdpcyk8hcgvqm'
const ALTERNATE_ADDRESS = 'ecash:qpqh6jlfp56nvvn8hre2lt7f2vg3r3q6usynp6427l'

const FROM_SCRIPT_HEX = '76a91479b000887626b294a914501a4cd226b58b23598388ac'
const DEST_SCRIPT_HEX = '76a914ebc0ee0b2ab9e8277a600c251475e22a3241a1c188ac'

const FIXED_NOW = 1_800_000_000
const EXPIRES_AT = 1_800_000_300

function createSyntheticSignatory() {
  const ecc = new Ecc()
  const secretKey = new Uint8Array(32).fill(7)
  const publicKey = ecc.derivePubkey(secretKey)
  const signatory = P2PKHSignatory(secretKey, publicKey, ALL_BIP143)
  return { signatory, publicKey, secretKey }
}

function createCanonicalHumanApproval(overrides: Record<string, unknown> = {}): HumanApprovalV1 {
  return humanApprovalV1Schema.parse({
    contractVersion: '1.0',
    kind: 'human_approval',
    approvalId: 'appr_456',
    requestId: 'req_123',
    intentId: 'intent_789',
    decisionId: 'dec_101',
    status: 'approved',
    approver: FROM_ADDRESS,
    recordedAt: FIXED_NOW + 10,
    ...overrides
  }) as HumanApprovalV1
}

function createFixtureLedgerRecord(overrides: Partial<WalletApprovalLedgerRecord> = {}): WalletApprovalLedgerRecord {
  const humanApproval = overrides.humanApproval
    ? createCanonicalHumanApproval(overrides.humanApproval as Record<string, unknown>)
    : createCanonicalHumanApproval()
  return {
    operationId: 'req_123',
    requestId: 'req_123',
    approvalId: 'appr_456',
    intentId: 'intent_789',
    decisionId: 'dec_101',
    contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    capabilityId: 'cap_xyz',
    effectiveExpiresAt: EXPIRES_AT,
    network: 'xec:mainnet',
    amountSats: '250000',
    fromAddress: FROM_ADDRESS,
    destination: DESTINATION_ADDRESS,
    presentationHash: 'pres_hash_def',
    recordedAt: FIXED_NOW + 10,
    status: 'approved',
    ...overrides,
    humanApproval
  }
}

function approvedAmountSats(record: WalletApprovalLedgerRecord): bigint {
  return BigInt(record.amountSats)
}

function testReviewOwnership(leaseTtlSeconds = 3600) {
  return {
    ownerId: 'owner_test',
    generation: 1,
    leaseTtlSeconds
  }
}

function readStoredRawTx(storage: Storage, executionId: string): string | undefined {
  const raw = storage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
  if (!raw) return undefined
  const parsed = JSON.parse(raw) as Record<string, string>
  return parsed[executionId]
}

function createFixtureUtxos(sats = 500_000n, txid = '11'.repeat(32)): ExecutionUtxoInput[] {
  return [
    {
      txid,
      outIdx: 0,
      sats,
      lockingScriptHex: FROM_SCRIPT_HEX
    }
  ]
}

function setupEngine(options: {
  record?: WalletApprovalLedgerRecord
  utxos?: ExecutionUtxoInput[]
  activeAddress?: string
  authenticated?: boolean
  clockNow?: number
  feePolicy?: Partial<WalletFeePolicy>
  signatoryProvider?: any
  storage?: Storage
  privateSettlementStorage?: Storage
  executionLedger?: any
  lockCoordinator?: InstanceType<typeof TestExecutionLockCoordinator>
  idGenerator?: () => string
  onSpendableUtxos?: () => Promise<void>
  onVerifyActiveSession?: () => Promise<void>
  reviewLeaseTtlSeconds?: number
  reviewHeartbeatMs?: number
} = {}) {
  const record = options.record ?? createFixtureLedgerRecord()
  const utxos = options.utxos ?? createFixtureUtxos()
  let activeAddress = options.activeAddress ?? FROM_ADDRESS
  let authenticated = options.authenticated ?? true
  let clockTime = options.clockNow ?? (FIXED_NOW + 20)

  const approvalStore = new Map<string, WalletApprovalLedgerRecord>()
  if (record) {
    approvalStore.set(record.requestId, record)
  }

  const approvalLedger = {
    async get(requestId: string) {
      return approvalStore.get(requestId)
    },
    async getByApprovalId(approvalId: string) {
      for (const rec of approvalStore.values()) {
        if (rec.approvalId === approvalId) return rec
      }
      return undefined
    }
  }

  const lockCoordinator = options.lockCoordinator ?? new TestExecutionLockCoordinator()
  const settlementStorage = options.privateSettlementStorage ?? new MockStorage()
  const executionLedger =
    options.executionLedger ??
    (options.storage
      ? new DurableTransactionalExecutionLedger({
          storage: options.storage,
          lockCoordinator,
          clock: () => clockTime
        })
      : new InMemoryWalletExecutionLedger(() => clockTime))

  const sessionVerifier = {
    async verifyActiveSession() {
      if (options.onVerifyActiveSession) {
        await options.onVerifyActiveSession()
      }
      return {
        authenticated,
        activeAddress: authenticated ? activeAddress : undefined
      }
    }
  }

  let currentUtxos = [...utxos]
  const utxoProvider = {
    async getSpendableUtxos(_address: string) {
      if (options.onSpendableUtxos) {
        await options.onSpendableUtxos()
      }
      return [...currentUtxos]
    }
  }

  const synthetic = createSyntheticSignatory()
  const signatoryProvider = options.signatoryProvider ?? {
    async getSignatory(_address: string) {
      return synthetic.signatory
    }
  }

  const composition = createWalletExecutionComposition(
    {
      approvalLedger,
      executionLedger,
      sessionVerifier,
      utxoProvider,
      signatoryProvider,
      feePolicy: options.feePolicy,
      storage: options.storage,
      lockCoordinator,
      clock: () => clockTime,
      idGenerator: options.idGenerator ?? (() => 'test_id_1')
    },
    {
      privateSettlementStorage: settlementStorage,
      reviewLeaseTtlSeconds: options.reviewLeaseTtlSeconds,
      reviewHeartbeatMs: options.reviewHeartbeatMs
    }
  )

  return {
    engine: composition.publicEngine,
    composition,
    uiHost: composition.walletUIHost,
    record,
    utxos,
    executionLedger,
    storage: options.storage,
    settlementStorage,
    setActiveAddress: (addr: string) => {
      activeAddress = addr
    },
    setAuthenticated: (auth: boolean) => {
      authenticated = auth
    },
    setUtxos: (newUtxos: ExecutionUtxoInput[]) => {
      currentUtxos = [...newUtxos]
    },
    setClock: (t: number) => {
      clockTime = t
    }
  }
}

describe('AgentWalletExecutionEngine Gate C2 Canonical Tests', () => {
  // P0-1: Multi-Tab Web Locks Concurrency & CAS Generation
  describe('P0-1: Cross-Tab Transactional Exclusion & Generation CAS (Web Locks)', () => {
    it('concurrently reserves same approval from Tab A and Tab B: exactly one succeeds, loser gets DUPLICATE_EXECUTION', async () => {
      const sharedStorage = new MockStorage()
      const sharedCoordinator = new TestExecutionLockCoordinator()
      const ledgerA = new DurableTransactionalExecutionLedger({
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      })
      const ledgerB = new DurableTransactionalExecutionLedger({
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      })

      const entryA = {
        executionId: 'exec_tab_a',
        approvalId: 'appr_shared_1',
        requestId: 'req_shared_1',
        intentId: 'intent_1',
        decisionId: 'dec_1',
        fromAddress: FROM_ADDRESS,
        destination: DESTINATION_ADDRESS,
        amountSats: 250_000n,
        network: 'xec:mainnet' as const,
        reservedAt: FIXED_NOW
      }

      const entryB = {
        executionId: 'exec_tab_b',
        approvalId: 'appr_shared_1', // identical approvalId
        requestId: 'req_shared_1_b',
        intentId: 'intent_1',
        decisionId: 'dec_1',
        fromAddress: FROM_ADDRESS,
        destination: DESTINATION_ADDRESS,
        amountSats: 250_000n,
        network: 'xec:mainnet' as const,
        reservedAt: FIXED_NOW
      }

      const results = await Promise.allSettled([
        ledgerA.reserveExecutionAtomic(entryA),
        ledgerB.reserveExecutionAtomic(entryB)
      ])

      const fulfilled = results.filter(r => r.status === 'fulfilled')
      const rejected = results.filter(r => r.status === 'rejected')

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)

      const rejectionReason = (rejected[0] as PromiseRejectedResult).reason
      expect(rejectionReason).toBeInstanceOf(WalletExecutionError)
      expect(rejectionReason.code).toBe('DUPLICATE_EXECUTION')

      // Repeat after page reload / process restart (re-instantiating ledger on the same durable storage)
      const ledgerC = new DurableTransactionalExecutionLedger({
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      })
      const entryC = {
        executionId: 'exec_tab_c',
        approvalId: 'appr_shared_1', // same approvalId
        requestId: 'req_shared_1_c',
        intentId: 'intent_1',
        decisionId: 'dec_1',
        fromAddress: FROM_ADDRESS,
        destination: DESTINATION_ADDRESS,
        amountSats: 250_000n,
        network: 'xec:mainnet' as const,
        reservedAt: FIXED_NOW + 10
      }

      await expect(ledgerC.reserveExecutionAtomic(entryC)).rejects.toMatchObject({
        code: 'DUPLICATE_EXECUTION'
      })
    })

    it('concurrently reserves two different approvals from Tab A and Tab B without lost update', async () => {
      const sharedStorage = new MockStorage()
      const sharedCoordinator = new TestExecutionLockCoordinator()
      const ledgerA = new DurableTransactionalExecutionLedger({
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      })
      const ledgerB = new DurableTransactionalExecutionLedger({
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      })

      const entry1 = {
        executionId: 'exec_tab_1',
        approvalId: 'appr_unique_1',
        requestId: 'req_unique_1',
        intentId: 'intent_1',
        decisionId: 'dec_1',
        fromAddress: FROM_ADDRESS,
        destination: DESTINATION_ADDRESS,
        amountSats: 100_000n,
        network: 'xec:mainnet' as const,
        reservedAt: FIXED_NOW
      }

      const entry2 = {
        executionId: 'exec_tab_2',
        approvalId: 'appr_unique_2',
        requestId: 'req_unique_2',
        intentId: 'intent_2',
        decisionId: 'dec_2',
        fromAddress: FROM_ADDRESS,
        destination: DESTINATION_ADDRESS,
        amountSats: 200_000n,
        network: 'xec:mainnet' as const,
        reservedAt: FIXED_NOW
      }

      const results = await Promise.allSettled([
        ledgerA.reserveExecutionAtomic(entry1),
        ledgerB.reserveExecutionAtomic(entry2)
      ])

      expect(results[0].status).toBe('fulfilled')
      expect(results[1].status).toBe('fulfilled')

      // Both records must exist durably without lost updates
      const status1 = await ledgerA.get('exec_tab_1')
      const status2 = await ledgerB.get('exec_tab_2')
      expect(status1).toBeDefined()
      expect(status2).toBeDefined()
      expect(status1?.approvalId).toBe('appr_unique_1')
      expect(status2?.approvalId).toBe('appr_unique_2')

      // Verify generation CAS incremented twice
      const raw = sharedStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)
      expect(raw).toBeDefined()
      const parsed = JSON.parse(raw!)
      expect(parsed.generation).toBe(2)
      expect(Object.keys(parsed.records)).toHaveLength(2)
    })

    it('fails closed before reservation/signing when navigator.locks is unavailable in production composition', async () => {
      const originalNavigator = globalThis.navigator
      try {
        vi.stubGlobal('navigator', {})
        const coordinator = new WebLocksExecutionCoordinator()
        await expect(
          coordinator.requestExclusive(DEFAULT_EXECUTION_LOCK_NAME, async () => 'should_not_run')
        ).rejects.toThrowError(
          expect.objectContaining({
            code: 'COORDINATION_UNAVAILABLE'
          })
        )
        await expect(
          coordinator.tryExclusive(DEFAULT_EXECUTION_LOCK_NAME, async () => 'should_not_run')
        ).rejects.toThrowError(
          expect.objectContaining({
            code: 'COORDINATION_UNAVAILABLE'
          })
        )
      } finally {
        vi.stubGlobal('navigator', originalNavigator)
      }
    })

    it('allows tests to execute when explicitly providing TestExecutionLockCoordinator', async () => {
      const storage = new MockStorage()
      const testCoordinator = new TestExecutionLockCoordinator()
      const testLedger = new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: testCoordinator
      })
      const { engine, record, uiHost } = setupEngine({
        storage,
        executionLedger: testLedger,
        lockCoordinator: testCoordinator
      })

      const session = await engine.prepareExecution(record.humanApproval!)
      expect(session.executionId).toBe('exec_test_id_1')
      const controller = uiHost.getActiveController()
      expect(controller).toBeDefined()
      const handle = await controller!.confirm()
      expect(handle.status).toBe('SIGNED')
    })

    it('verifies public barrel import cannot obtain the local confirmation controller', async () => {
      const publicBarrel = await import('./index')
      expect((publicBarrel as any).createWalletExecutionComposition).toBeUndefined()
      expect((publicBarrel as any).WalletExecutionComposition).toBeUndefined()
      expect((publicBarrel as any).WalletExecutionUIHost).toBeUndefined()
      expect((publicBarrel as any).WalletLocalConfirmationController).toBeUndefined()
      expect((publicBarrel as any).walletUIHost).toBeUndefined()
      expect((publicBarrel as any).getActiveController).toBeUndefined()
      expect((publicBarrel as any).confirm).toBeUndefined()
      expect((publicBarrel as any).sign).toBeUndefined()
    })
  })

  // P0 Focus Test 1: Complete Valid Execution Flow
  it('executes complete valid preparation, review snapshot, local confirmation, and offline signing', async () => {
    const storage = new MockStorage()
    const { engine, uiHost, record, executionLedger, settlementStorage } = setupEngine({ storage })

    const session = await engine.prepareExecution(record.humanApproval!)
    expect(session.executionId).toBe('exec_test_id_1')
    expect(session.review.amountXEC).toBe('2500.00 XEC')
    expect(session.review.feeXEC).toMatch(/XEC/)
    expect(session.review.network).toBe('xec:mainnet')

    // Local confirmation controller from internal Wallet UI host
    const controller = uiHost.getActiveController()
    expect(controller).toBeDefined()
    const handle = await controller!.confirm()

    expect(handle.status).toBe('SIGNED')
    expect(handle.approvalId).toBe(record.approvalId)
    expect(handle.requestId).toBe(record.requestId)
    expect(handle.planHash).toBe(session.plan.planHash)

    // Verify raw signed tx is retained in private settlement partition, not in handle or public status
    expect((handle as any).rawSignedTxHex).toBeUndefined()
    const publicStatus = await executionLedger.get(session.executionId)
    expect(publicStatus?.status).toBe('SIGNED')
    expect((publicStatus as any).rawSignedTxHex).toBeUndefined()

    // Write-only settlement store retains raw tx; C2 has no retrieval API.
    const rawTx = readStoredRawTx(settlementStorage, session.executionId)
    expect(rawTx).toBeDefined()
    expect(rawTx!.length).toBeGreaterThan(100)
    const independentlyParsed = Tx.fromHex(rawTx!)
    expect(independentlyParsed.outputs).toHaveLength(session.plan.outputs.length)
    expect(independentlyParsed.outputs[0].sats).toBe(session.plan.outputs[0].sats)
    expect(toHex(independentlyParsed.outputs[0].script.bytecode).toLowerCase()).toBe(
      session.plan.outputs[0].scriptHex.toLowerCase()
    )
  })

  // P0-1: Persistent Durable Ledger & Restart / Reopen Safety
  it('persists execution state across engine re-instantiation on the same storage', async () => {
    const storage = new MockStorage()
    const record = createFixtureLedgerRecord()

    // Instance 1: Prepare and confirm
    const instance1 = setupEngine({ record, storage })
    const session = await instance1.engine.prepareExecution(record.humanApproval!)
    const controller = instance1.uiHost.getActiveController()
    expect(controller).toBeDefined()
    const handle = await controller!.confirm()
    expect(handle.status).toBe('SIGNED')

    // Instance 2: Reopen with new engine on same storage
    const instance2 = setupEngine({ record, storage })
    const status = await instance2.engine.getExecutionStatus(session.executionId)
    expect(status?.status).toBe('SIGNED')

    // Replay attempt on reopened ledger throws DUPLICATE_EXECUTION
    await expect(instance2.engine.prepareExecution(record.humanApproval!)).rejects.toThrow(
      expect.objectContaining({ code: 'DUPLICATE_EXECUTION' })
    )
  })

  // P0-1 Crash Consistency Probe: Reopening while in SIGNING reconciles to SIGNING_UNCERTAIN
  it('reconciles interrupted SIGNING state to SIGNING_UNCERTAIN upon restart', async () => {
    const storage = new MockStorage()
    const record = createFixtureLedgerRecord()

    // Setup ledger directly to simulate crash during signing
    const restartCoordinator = new TestExecutionLockCoordinator()
    const initialLedger = new DurableStorageWalletExecutionLedger({
      storage,
      lockCoordinator: restartCoordinator
    })
    await initialLedger.whenReady()
    await initialLedger.reserveExecutionAtomic({
      executionId: 'exec_crashed',
      approvalId: record.approvalId,
      requestId: record.requestId,
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: approvedAmountSats(record),
      network: 'xec:mainnet',
      reservedAt: FIXED_NOW
    })
    const plan = buildPreparedExecutionPlan({
      approved: {
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats(record)
      },
      availableUtxos: createFixtureUtxos()
    })
    await initialLedger.setPlanPrepared('exec_crashed', plan, testReviewOwnership())
    await initialLedger.transitionToSigningIfValid({
      executionId: 'exec_crashed',
      plan,
      effectiveExpiresAt: EXPIRES_AT,
      now: () => FIXED_NOW + 2
    })

    // Verify it was in SIGNING
    const preCrashStatus = await initialLedger.get('exec_crashed')
    expect(preCrashStatus?.status).toBe('SIGNING')

    // Restart process / re-instantiate ledger
    const recoveredLedger = new DurableStorageWalletExecutionLedger({
      storage,
      lockCoordinator: restartCoordinator
    })
    await recoveredLedger.whenReady()
    const recoveredStatus = await recoveredLedger.get('exec_crashed')

    // Must be reconciled to SIGNING_UNCERTAIN
    expect(recoveredStatus?.status).toBe('SIGNING_UNCERTAIN')
    expect(recoveredStatus?.uncertainReason).toContain('Process interrupted during signing')

    // Automated retry is blocked
    await expect(
      recoveredLedger.transitionToSigningIfValid({
        executionId: 'exec_crashed',
        plan,
        effectiveExpiresAt: EXPIRES_AT,
        now: () => FIXED_NOW + 10
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }))
  })

  // P0-2: Local Confirmation Authority Isolation
  it('enforces that session alone does not expose signing method and public engine does not expose confirmation', async () => {
    const { engine, record, uiHost } = setupEngine({ storage: new MockStorage() })
    const session = await engine.prepareExecution(record.humanApproval!)

    // Public engine strictly has NO confirm, sign, execute, or controller creation methods
    expect((engine as any).createLocalConfirmationController).toBeUndefined()
    expect((engine as any).confirm).toBeUndefined()
    expect((engine as any).sign).toBeUndefined()
    expect((engine as any).execute).toBeUndefined()

    // Public review session has NO confirm or signing method
    expect((session as any).confirm).toBeUndefined()
    expect((session as any).confirmExecution).toBeUndefined()
    expect((session as any).sign).toBeUndefined()

    // Calling controller strictly from Wallet-internal UI host succeeds
    const controller = uiHost.getActiveController()
    expect(controller).toBeDefined()
    const handle = await controller!.confirm()
    expect(handle.status).toBe('SIGNED')
  })

  // P0-3: Raw Signed Transaction Isolation
  it('strictly isolates rawSignedTxHex from public engine and ledger inspection APIs', async () => {
    const storage = new MockStorage()
    const { engine, uiHost, record, executionLedger, settlementStorage } = setupEngine({ storage })
    const session = await engine.prepareExecution(record.humanApproval!)
    const controller = uiHost.getActiveController()
    expect(controller).toBeDefined()
    await controller!.confirm()

    const publicStatus = await engine.getExecutionStatus(session.executionId)
    expect(publicStatus?.status).toBe('SIGNED')
    expect((publicStatus as any).rawSignedTxHex).toBeUndefined()
    expect((publicStatus as any).plan).toBeUndefined()

    // Public executionLedger has NO getSignedTransactionHex or _getRawSignedTxHexInternal methods
    expect((executionLedger as any).getSignedTransactionHex).toBeUndefined()
    expect((executionLedger as any)._getRawSignedTxHexInternal).toBeUndefined()
    expect((executionLedger as any).getRawSignedTxHex).toBeUndefined()

    // C2 is write-only: raw bytes are inspectable only via the storage payload, not a getter API.
    const internalHex = readStoredRawTx(settlementStorage, session.executionId)
    expect(internalHex).toBeDefined()
    expect(typeof internalHex).toBe('string')
  })

  // P0-4: Dismiss invalidates execution durably
  it('durably invalidates execution when dismiss is called, preventing subsequent signing', async () => {
    const signerMock = vi.fn()
    const { engine, uiHost, record, executionLedger } = setupEngine({
      signatoryProvider: {
        getSignatory: async () => {
          signerMock()
          return createSyntheticSignatory().signatory
        }
      }
    })

    const session = await engine.prepareExecution(record.humanApproval!)
    const controller = uiHost.getActiveController()
    expect(controller).toBeDefined()

    // Dismiss execution
    await session.dismiss()

    // Subsequent confirm must fail
    await expect(controller!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' })
    )

    // Signer was never invoked
    expect(signerMock).not.toHaveBeenCalled()

    // Durable state must be REJECTED
    const status = await executionLedger.get(session.executionId)
    expect(status?.status).toBe('REJECTED')
  })

  // P1-1: Single-flight race prevention
  it('synchronously blocks concurrent prepareExecution calls before async awaits', async () => {
    const { engine, record } = setupEngine()

    const record2 = createFixtureLedgerRecord({
      operationId: 'req_distinct_2',
      requestId: 'req_distinct_2',
      approvalId: 'appr_distinct_2',
      intentId: 'intent_distinct_2',
      decisionId: 'dec_distinct_2',
      humanApproval: {
        ...record.humanApproval!,
        approvalId: 'appr_distinct_2',
        requestId: 'req_distinct_2'
      }
    })

    // Initiate prepareExecution 1
    const preparePromise1 = engine.prepareExecution(record.humanApproval!)

    // Synchronously initiate prepareExecution 2 immediately without awaiting 1
    await expect(engine.prepareExecution(record2.humanApproval!)).rejects.toThrow(
      expect.objectContaining({ code: 'CONCURRENT_EXECUTION_ACTIVE' })
    )

    const session1 = await preparePromise1
    expect(session1.executionId).toBeDefined()
  })

  // P1-2: Plan hash nested fields binding
  it('guarantees that modifying any nested plan field alters the canonical plan hash', () => {
    const basePlan: Omit<import('./types').WalletPreparedExecutionPlan, 'planHash'> = {
      network: 'xec:mainnet',
      fromAddress: FROM_ADDRESS,
      destination: DESTINATION_ADDRESS,
      paymentAmountSats: 250_000n,
      changeAmountSats: 249_728n,
      changeAddress: FROM_ADDRESS,
      feeSats: 272n,
      feeRateSatsPerByte: 1.2,
      inputs: [
        {
          txid: '11'.repeat(32),
          outIdx: 0,
          sats: 500_000n,
          lockingScriptHex: FROM_SCRIPT_HEX
        }
      ],
      outputs: [
        {
          index: 0,
          destination: DESTINATION_ADDRESS,
          scriptHex: DEST_SCRIPT_HEX,
          sats: 250_000n,
          isChange: false
        },
        {
          index: 1,
          destination: FROM_ADDRESS,
          scriptHex: FROM_SCRIPT_HEX,
          sats: 249_728n,
          isChange: true
        }
      ],
      totalInputSats: 500_000n,
      transactionVersion: 2,
      locktime: 0,
      approvalId: 'appr_456',
      requestId: 'req_123',
      intentId: 'intent_789'
    }

    const baseHash = computeCanonicalPlanHash(basePlan)

    // 1. Mutate input txid
    const planMutTxid = { ...basePlan, inputs: [{ ...basePlan.inputs[0], txid: '22'.repeat(32) }] }
    expect(computeCanonicalPlanHash(planMutTxid)).not.toBe(baseHash)

    // 2. Mutate input outIdx
    const planMutOutIdx = { ...basePlan, inputs: [{ ...basePlan.inputs[0], outIdx: 1 }] }
    expect(computeCanonicalPlanHash(planMutOutIdx)).not.toBe(baseHash)

    // 3. Mutate input sats
    const planMutInputSats = { ...basePlan, inputs: [{ ...basePlan.inputs[0], sats: 600_000n }] }
    expect(computeCanonicalPlanHash(planMutInputSats)).not.toBe(baseHash)

    // 4. Mutate input lockingScriptHex
    const planMutInputScript = { ...basePlan, inputs: [{ ...basePlan.inputs[0], lockingScriptHex: '00' }] }
    expect(computeCanonicalPlanHash(planMutInputScript)).not.toBe(baseHash)

    // 5. Mutate output sats
    const planMutOutSats = { ...basePlan, outputs: [{ ...basePlan.outputs[0], sats: 200_000n }, basePlan.outputs[1]] }
    expect(computeCanonicalPlanHash(planMutOutSats)).not.toBe(baseHash)

    // 6. Mutate output scriptHex
    const planMutOutScript = { ...basePlan, outputs: [{ ...basePlan.outputs[0], scriptHex: FROM_SCRIPT_HEX }, basePlan.outputs[1]] }
    expect(computeCanonicalPlanHash(planMutOutScript)).not.toBe(baseHash)

    // 7. Mutate feeSats
    const planMutFee = { ...basePlan, feeSats: 300n }
    expect(computeCanonicalPlanHash(planMutFee)).not.toBe(baseHash)

    // 8. Mutate feeRate
    const planMutFeeRate = { ...basePlan, feeRateSatsPerByte: 1.5 }
    expect(computeCanonicalPlanHash(planMutFeeRate)).not.toBe(baseHash)

    // 9. Mutate locktime
    const planMutLocktime = { ...basePlan, locktime: 1 }
    expect(computeCanonicalPlanHash(planMutLocktime)).not.toBe(baseHash)
  })

  // P1-3: Strict Destination Output Script Match
  it('fails closed when output script does not exactly match approved destination', () => {
    const plan = buildPreparedExecutionPlan({
      approved: {
        approvalId: 'appr_1',
        requestId: 'req_1',
        intentId: 'intent_1',
        fromAddress: FROM_ADDRESS,
        destination: DESTINATION_ADDRESS,
        amountSats: 250_000n
      },
      availableUtxos: createFixtureUtxos()
    })

    // Modify the destination script to point to another address
    const tamperedOutputs = [
      {
        ...plan.outputs[0],
        scriptHex: FROM_SCRIPT_HEX // wrong script!
      },
      plan.outputs[1]
    ]

    expect(() =>
      validateOutputInvariants(
        { ...plan, outputs: tamperedOutputs },
        {
          destination: DESTINATION_ADDRESS,
          amountSats: 250_000n,
          fromAddress: FROM_ADDRESS,
          network: 'xec:mainnet'
        },
        DEFAULT_FEE_POLICY
      )
    ).toThrow(expect.objectContaining({ code: 'OUTPUT_INVARIANT_VIOLATION' }))
  })

  // P1-4: Post-Sign Verification of Serialized Transaction
  it('fails closed if signed transaction does not match prepared plan outputs', async () => {
    // Adversarial signatory that produces valid signature over tampered transaction
    const adversarialSigner = {
      signTransaction: async (builder: TxBuilder) => {
        // Tamper by modifying outputs in builder before signing
        const tamperedBuilder = new TxBuilder({
          version: builder.version,
          locktime: builder.locktime,
          inputs: builder.inputs,
          outputs: [
            {
              sats: 'sats' in builder.outputs[0] ? builder.outputs[0].sats : 0n,
              script: Script.fromAddress(ALTERNATE_ADDRESS)
            },
            ...builder.outputs.slice(1)
          ]
        })
        const synthetic = createSyntheticSignatory()
        return (tamperedBuilder as any).sign(synthetic.signatory)
      }
    }

    const { engine, uiHost, record, executionLedger } = setupEngine({
      signatoryProvider: adversarialSigner
    })

    const session = await engine.prepareExecution(record.humanApproval!)
    const controller = uiHost.getActiveController()
    expect(controller).toBeDefined()

    await expect(controller!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'SIGNED_TRANSACTION_MISMATCH' })
    )

    // Ledger record must be marked SIGNING_UNCERTAIN
    const ledgerRecord = await executionLedger.get(session.executionId)
    expect(ledgerRecord?.status).toBe('SIGNING_UNCERTAIN')
  })

  // P1-5: Terminal State Immutability
  it('enforces terminal state immutability across all terminal states', async () => {
    const ledger = new InMemoryWalletExecutionLedger()
    const record = createFixtureLedgerRecord()

    await ledger.reserveExecutionAtomic({
      executionId: 'exec_imm',
      approvalId: record.approvalId,
      requestId: record.requestId,
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: approvedAmountSats(record),
      network: 'xec:mainnet',
      reservedAt: FIXED_NOW
    })
    const plan = buildPreparedExecutionPlan({
      approved: {
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats(record)
      },
      availableUtxos: createFixtureUtxos()
    })
    await ledger.setPlanPrepared('exec_imm', plan, testReviewOwnership())
    await ledger.transitionToSigningIfValid({
      executionId: 'exec_imm',
      plan,
      effectiveExpiresAt: EXPIRES_AT,
      now: () => FIXED_NOW + 2
    })
    await ledger.transitionToSigned('exec_imm', FIXED_NOW + 3)

    // Attempting to reject a SIGNED record throws INVALID_STATE_TRANSITION
    await expect(ledger.markRejected('exec_imm', 'too late', FIXED_NOW + 4)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' })
    )

    // State remains SIGNED
    const finalRecord = await ledger.get('exec_imm')
    expect(finalRecord?.status).toBe('SIGNED')
  })

  // Fee Policy Violation Tests
  it('fails closed when fee rate is below minimum policy threshold', () => {
    const estimatedSize = estimateP2pkhTransactionSize(1, 2)
    // 0 sats fee on 216 bytes -> 0 sat/byte
    expect(() => assertFeePolicy(0n, estimatedSize, DEFAULT_FEE_POLICY)).toThrow(
      expect.objectContaining({ code: 'FEE_POLICY_VIOLATION' })
    )
  })

  it('fails closed when fee exceeds absolute maximum policy ceiling', () => {
    const estimatedSize = estimateP2pkhTransactionSize(1, 2)
    // 100,000 sats fee exceeds 50,000 sats ceiling
    expect(() => assertFeePolicy(100_000n, estimatedSize, DEFAULT_FEE_POLICY)).toThrow(
      expect.objectContaining({ code: 'FEE_POLICY_VIOLATION' })
    )
  })

  // TOCTOU / Stale UTXO Test
  it('fails closed and records FAILED if selected UTXO becomes unspendable before signing', async () => {
    const { engine, uiHost, record, executionLedger, setUtxos } = setupEngine()

    const session = await engine.prepareExecution(record.humanApproval!)
    const controller = uiHost.getActiveController()
    expect(controller).toBeDefined()

    // Simulate UTXO spent in the interim
    setUtxos([])

    await expect(controller!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'UTXO_SELECTION_STALE' })
    )

    const updated = await executionLedger.get(session.executionId)
    expect(updated?.status).toBe('FAILED')
  })

  // Custodian Session Revalidation Failures
  it('fails closed when wallet custodian session changes before signing', async () => {
    const { engine, uiHost, record, setActiveAddress } = setupEngine()

    const session = await engine.prepareExecution(record.humanApproval)
    expect(session.executionId).toBeDefined()
    const controller = uiHost.getActiveController()
    expect(controller).toBeDefined()

    // Custodian changes active wallet address
    setActiveAddress(ALTERNATE_ADDRESS)

    // Confirm fails closed
    await expect(controller!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'SESSION_ADDRESS_MISMATCH' })
    )
  })

  // Rejection by Custodian
  it('allows custodian to reject execution, updating ledger to REJECTED', async () => {
    const { engine, record, executionLedger } = setupEngine()
    const session = await engine.prepareExecution(record.humanApproval!)

    await session.rejectExecution('Custodian rejected plan.')
    const updated = await executionLedger.get(session.executionId)
    expect(updated?.status).toBe('REJECTED')
    expect(updated?.uncertainReason).toBe('Custodian rejected plan.')
  })

  it('rejects a signer whose returned object looks correct but ser() emits a different transaction', async () => {
    const coordinator = new TestExecutionLockCoordinator()
    const storage = new MockStorage()
    const deceptiveSigner = {
      signTransaction: async (builder: TxBuilder) => {
        const synthetic = createSyntheticSignatory()
        const honestTx = (builder as unknown as { sign: (signatory?: unknown) => Tx }).sign(synthetic.signatory)
        const maliciousTx = new Tx({
          version: honestTx.version,
          locktime: honestTx.locktime,
          inputs: [
            {
              prevOut: { txid: '22'.repeat(32), outIdx: 99 },
              script: honestTx.inputs[0]?.script,
              sequence: 0xffffffff
            }
          ],
          outputs: [
            { sats: 1n, script: Script.fromAddress(ALTERNATE_ADDRESS) },
            { sats: 2n, script: Script.fromAddress(ALTERNATE_ADDRESS) },
            { sats: 3n, script: Script.fromAddress(ALTERNATE_ADDRESS) }
          ]
        })
        return {
          version: honestTx.version,
          locktime: honestTx.locktime,
          inputs: honestTx.inputs,
          outputs: honestTx.outputs,
          ser: () => maliciousTx.ser()
        }
      }
    }

    const { engine, uiHost, record, executionLedger } = setupEngine({
      storage,
      lockCoordinator: coordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: coordinator
      }),
      signatoryProvider: deceptiveSigner
    })

    const session = await engine.prepareExecution(record.humanApproval)
    const controller = uiHost.getActiveController()
    expect(controller).toBeDefined()

    await expect(controller!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'SIGNED_TRANSACTION_MISMATCH' })
    )

    const ledgerRecord = await executionLedger.get(session.executionId)
    expect(ledgerRecord?.status).toBe('SIGNING_UNCERTAIN')
    expect(readStoredRawTx(storage, session.executionId)).toBeUndefined()
  })

  it('marks SIGNING_UNCERTAIN and issues no handle when raw signed bytes cannot be parsed', async () => {
    const coordinator = new TestExecutionLockCoordinator()
    const storage = new MockStorage()
    const unparseableSigner = {
      signTransaction: async (builder: TxBuilder) => {
        const synthetic = createSyntheticSignatory()
        const honestTx = (builder as unknown as { sign: (signatory?: unknown) => Tx }).sign(synthetic.signatory)
        return {
          version: honestTx.version,
          locktime: honestTx.locktime,
          inputs: honestTx.inputs,
          outputs: honestTx.outputs,
          ser: () => new Uint8Array([0xff, 0x00, 0x01])
        }
      }
    }

    const { engine, uiHost, record, executionLedger } = setupEngine({
      storage,
      lockCoordinator: coordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: coordinator
      }),
      signatoryProvider: unparseableSigner
    })

    const session = await engine.prepareExecution(record.humanApproval)
    await expect(uiHost.getActiveController()!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'SIGNING_UNCERTAIN' })
    )
    const ledgerRecord = await executionLedger.get(session.executionId)
    expect(ledgerRecord?.status).toBe('SIGNING_UNCERTAIN')
  })

  it('keeps the Wallet-owned UTXO snapshot after the provider mutates its original objects', async () => {
    const providerOwnedUtxo = {
      txid: '11'.repeat(32),
      outIdx: 0,
      sats: 500_000n,
      lockingScriptHex: FROM_SCRIPT_HEX
    }
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    const { engine, record, uiHost } = setupEngine({
      storage,
      lockCoordinator: coordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: coordinator
      }),
      utxos: [providerOwnedUtxo]
    })

    const session = await engine.prepareExecution(record.humanApproval)
    const originalHash = session.plan.planHash
    const originalTxid = session.plan.inputs[0].txid
    const originalSats = session.plan.inputs[0].sats

    providerOwnedUtxo.txid = 'ff'.repeat(32)
    providerOwnedUtxo.outIdx = 99
    providerOwnedUtxo.sats = 1n
    providerOwnedUtxo.lockingScriptHex = '00'

    expect(session.plan.inputs[0].txid).toBe(originalTxid)
    expect(session.plan.inputs[0].sats).toBe(originalSats)
    expect(session.plan.inputs[0]).not.toBe(providerOwnedUtxo)
    expect(computeCanonicalPlanHash(session.plan)).toBe(originalHash)
    expect(Object.isFrozen(session.plan.inputs[0])).toBe(true)
    expect(Object.isFrozen(session.plan.inputs)).toBe(true)
    expect(Object.isFrozen(session.plan.outputs[0])).toBe(true)

    const rebuiltFromPlanSnapshot = buildPreparedExecutionPlan({
      approved: {
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats(record)
      },
      availableUtxos: session.plan.inputs
    })
    expect(rebuiltFromPlanSnapshot.inputs[0].txid).toBe(originalTxid)
    expect(rebuiltFromPlanSnapshot.planHash).toBe(originalHash)
    expect(uiHost.getActiveController()?.executionId).toBe(session.executionId)
  })

  it('does not let provider mutation during transitionToSigning alter the signed plan', async () => {
    const providerOwnedUtxo = {
      txid: '11'.repeat(32),
      outIdx: 0,
      sats: 500_000n,
      lockingScriptHex: FROM_SCRIPT_HEX
    }
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    const delayedLedger = new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: coordinator
    })
    const originalTransition = delayedLedger.transitionToSigningIfValid.bind(delayedLedger)
    delayedLedger.transitionToSigningIfValid = async params => {
      await new Promise(resolve => setTimeout(resolve, 20))
      providerOwnedUtxo.txid = 'aa'.repeat(32)
      providerOwnedUtxo.sats = 7n
      return originalTransition(params)
    }

    const { engine, record, uiHost } = setupEngine({
      storage,
      lockCoordinator: coordinator,
      executionLedger: delayedLedger,
      utxos: [providerOwnedUtxo]
    })

    const session = await engine.prepareExecution(record.humanApproval)
    const originalHash = session.plan.planHash
    const handle = await uiHost.getActiveController()!.confirm()
    expect(handle.status).toBe('SIGNED')
    expect(handle.planHash).toBe(originalHash)
    expect(session.plan.inputs[0].txid).toBe('11'.repeat(32))
    expect(session.plan.inputs[0].sats).toBe(500_000n)
  })

  it('rejects an authoritative Gate 2B rejection even if the supplied receipt status is flipped to approved', async () => {
    const rejectedRecord = createFixtureLedgerRecord({
      status: 'rejected',
      humanApproval: createCanonicalHumanApproval({ status: 'rejected' })
    })
    const { engine } = setupEngine({ record: rejectedRecord })

    const forgedReceipt = createCanonicalHumanApproval({
      status: 'approved',
      approvalId: rejectedRecord.approvalId,
      requestId: rejectedRecord.requestId,
      intentId: rejectedRecord.intentId,
      decisionId: rejectedRecord.decisionId,
      recordedAt: rejectedRecord.recordedAt
    })

    await expect(engine.prepareExecution(forgedReceipt)).rejects.toThrow(
      expect.objectContaining({ code: 'RECEIPT_NOT_APPROVED' })
    )
    expect(await engine.getExecutionStatus('exec_test_id_1')).toBeUndefined()
  })

  it('does not automatically re-sign after crash windows A-C', async () => {
    const storage = new MockStorage()
    const record = createFixtureLedgerRecord()
    const coordinator = new TestExecutionLockCoordinator()

    // A: crash before raw storage — SIGNING with no raw tx.
    const ledgerA = new DurableTransactionalExecutionLedger({ storage, lockCoordinator: coordinator })
    await ledgerA.whenReady()
    await ledgerA.reserveExecutionAtomic({
      executionId: 'exec_crash_a',
      approvalId: 'appr_crash_a',
      requestId: 'req_crash_a',
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: approvedAmountSats(record),
      network: 'xec:mainnet',
      reservedAt: FIXED_NOW
    })
    const planA = buildPreparedExecutionPlan({
      approved: {
        approvalId: 'appr_crash_a',
        requestId: 'req_crash_a',
        intentId: record.intentId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats(record)
      },
      availableUtxos: createFixtureUtxos()
    })
    await ledgerA.setPlanPrepared('exec_crash_a', planA, testReviewOwnership())
    await ledgerA.transitionToSigningIfValid({
      executionId: 'exec_crash_a',
      plan: planA,
      effectiveExpiresAt: EXPIRES_AT,
      now: () => FIXED_NOW + 2
    })

    const recoveredA = new DurableTransactionalExecutionLedger({ storage, lockCoordinator: coordinator })
    await recoveredA.whenReady()
    const recoveredAStatus = await recoveredA.get('exec_crash_a')
    expect(recoveredAStatus?.status).toBe('SIGNING_UNCERTAIN')
    expect(readStoredRawTx(storage, 'exec_crash_a')).toBeUndefined()
    await expect(
      recoveredA.transitionToSigningIfValid({
        executionId: 'exec_crash_a',
        plan: planA,
        effectiveExpiresAt: EXPIRES_AT,
        now: () => FIXED_NOW + 9
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }))

    // B: persistence failure after signing → SIGNING_UNCERTAIN, no SIGNED, no automatic re-sign.
    const ledgerStorageB = new MockStorage()
    const failingSettlement = new MockStorage()
    const originalSetItem = failingSettlement.setItem.bind(failingSettlement)
    failingSettlement.setItem = (key: string, value: string) => {
      if (key === DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY) {
        throw new Error('settlement quota exceeded')
      }
      originalSetItem(key, value)
    }
    const { engine, uiHost, record: recordB, executionLedger } = setupEngine({
      record: createFixtureLedgerRecord({
        requestId: 'req_crash_b',
        approvalId: 'appr_crash_b',
        humanApproval: createCanonicalHumanApproval({
          requestId: 'req_crash_b',
          approvalId: 'appr_crash_b'
        })
      }),
      storage: ledgerStorageB,
      privateSettlementStorage: failingSettlement,
      lockCoordinator: coordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage: ledgerStorageB,
        lockCoordinator: coordinator
      })
    })
    const sessionB = await engine.prepareExecution(recordB.humanApproval)
    await expect(uiHost.getActiveController()!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'SIGNING_UNCERTAIN' })
    )
    expect((await executionLedger.get(sessionB.executionId))?.status).toBe('SIGNING_UNCERTAIN')
    await expect(uiHost.getActiveController()!.confirm()).rejects.toThrow()

    // C: raw storage succeeds, crash before ledger SIGNED. Orphan raw tx + SIGNING_UNCERTAIN is fail-closed.
    const storageC = new MockStorage()
    const ledgerC = new DurableTransactionalExecutionLedger({
      storage: storageC,
      lockCoordinator: coordinator
    })
    await ledgerC.whenReady()
    await ledgerC.reserveExecutionAtomic({
      executionId: 'exec_crash_c',
      approvalId: 'appr_crash_c',
      requestId: 'req_crash_c',
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: approvedAmountSats(record),
      network: 'xec:mainnet',
      reservedAt: FIXED_NOW
    })
    const planC = buildPreparedExecutionPlan({
      approved: {
        approvalId: 'appr_crash_c',
        requestId: 'req_crash_c',
        intentId: record.intentId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats(record)
      },
      availableUtxos: createFixtureUtxos()
    })
    await ledgerC.setPlanPrepared('exec_crash_c', planC, testReviewOwnership())
    await ledgerC.transitionToSigningIfValid({
      executionId: 'exec_crash_c',
      plan: planC,
      effectiveExpiresAt: EXPIRES_AT,
      now: () => FIXED_NOW + 2
    })
    storageC.setItem(
      DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY,
      JSON.stringify({ exec_crash_c: '0200000001deadbeef' })
    )
    const recoveredC = new DurableTransactionalExecutionLedger({
      storage: storageC,
      lockCoordinator: coordinator
    })
    await recoveredC.whenReady()
    const recoveredCStatus = await recoveredC.get('exec_crash_c')
    expect(recoveredCStatus?.status).toBe('SIGNING_UNCERTAIN')
    expect(readStoredRawTx(storageC, 'exec_crash_c')).toBe('0200000001deadbeef')
    await expect(
      recoveredC.transitionToSigningIfValid({
        executionId: 'exec_crash_c',
        plan: planC,
        effectiveExpiresAt: EXPIRES_AT,
        now: () => FIXED_NOW + 9
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }))
  })

  it('persists both raw signed transactions when two tabs sign different approvals concurrently', async () => {
    const sharedStorage = new MockStorage()
    const sharedSettlement = new MockStorage()
    const sharedCoordinator = new TestExecutionLockCoordinator()
    const recordA = createFixtureLedgerRecord({
      requestId: 'req_conc_a',
      approvalId: 'appr_conc_a',
      humanApproval: createCanonicalHumanApproval({
        requestId: 'req_conc_a',
        approvalId: 'appr_conc_a'
      })
    })
    const recordB = createFixtureLedgerRecord({
      requestId: 'req_conc_b',
      approvalId: 'appr_conc_b',
      humanApproval: createCanonicalHumanApproval({
        requestId: 'req_conc_b',
        approvalId: 'appr_conc_b'
      })
    })

    const tabA = setupEngine({
      record: recordA,
      utxos: createFixtureUtxos(500_000n, '11'.repeat(32)),
      storage: sharedStorage,
      privateSettlementStorage: sharedSettlement,
      lockCoordinator: sharedCoordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      }),
      idGenerator: () => 'conc_a'
    })
    const tabB = setupEngine({
      record: recordB,
      utxos: createFixtureUtxos(500_000n, '22'.repeat(32)),
      storage: sharedStorage,
      privateSettlementStorage: sharedSettlement,
      lockCoordinator: sharedCoordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      }),
      idGenerator: () => 'conc_b'
    })

    const sessionA = await tabA.engine.prepareExecution(recordA.humanApproval)
    const sessionB = await tabB.engine.prepareExecution(recordB.humanApproval)

    const results = await Promise.allSettled([
      tabA.uiHost.getActiveController()!.confirm(),
      tabB.uiHost.getActiveController()!.confirm()
    ])

    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('fulfilled')
    expect(readStoredRawTx(sharedSettlement, sessionA.executionId)).toBeDefined()
    expect(readStoredRawTx(sharedSettlement, sessionB.executionId)).toBeDefined()
    expect(Object.keys(JSON.parse(sharedSettlement.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)!))).toEqual(
      expect.arrayContaining([sessionA.executionId, sessionB.executionId])
    )
    expect((await tabA.engine.getExecutionStatus(sessionA.executionId))?.status).toBe('SIGNED')
    expect((await tabB.engine.getExecutionStatus(sessionB.executionId))?.status).toBe('SIGNED')
  })

  it('refuses a second settlement write for the same executionId', async () => {
    const storage = new MockStorage()
    const { engine, uiHost, record, executionLedger, settlementStorage } = setupEngine({ storage })
    const session = await engine.prepareExecution(record.humanApproval)
    settlementStorage.setItem(
      DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY,
      JSON.stringify({ [session.executionId]: '00ffaabb' })
    )
    await expect(uiHost.getActiveController()!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'SIGNING_UNCERTAIN' })
    )
    expect(readStoredRawTx(settlementStorage, session.executionId)).toBe('00ffaabb')
    expect((await executionLedger.get(session.executionId))?.status).toBe('SIGNING_UNCERTAIN')
  })

  it('does not invoke the signer when approval expires during UTXO revalidation', async () => {
    const signerMock = vi.fn()
    let confirmPhase = false
    let setClockRef: (t: number) => void = () => {}
    const { engine, uiHost, record, executionLedger, setClock } = setupEngine({
      signatoryProvider: {
        getSignatory: async () => {
          signerMock()
          return createSyntheticSignatory().signatory
        }
      },
      onSpendableUtxos: async () => {
        if (confirmPhase) {
          setClockRef(EXPIRES_AT + 1)
        }
      }
    })
    setClockRef = setClock
    const session = await engine.prepareExecution(record.humanApproval)
    confirmPhase = true
    await expect(uiHost.getActiveController()!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'APPROVAL_EXPIRED' })
    )
    expect(signerMock).not.toHaveBeenCalled()
    expect((await executionLedger.get(session.executionId))?.status).toBe('EXPIRED')
    expect(
      await (executionLedger as InMemoryWalletExecutionLedger).getOutpointReservation(
        canonicalOutpointKey('11'.repeat(32), 0)
      )
    ).toBeUndefined()
  })

  it('does not reconcile a live SIGNING execution held by another tab', async () => {
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    const ledgerA = new DurableTransactionalExecutionLedger({ storage, lockCoordinator: coordinator })
    await ledgerA.whenReady()
    const record = createFixtureLedgerRecord()
    const plan = buildPreparedExecutionPlan({
      approved: {
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats(record)
      },
      availableUtxos: createFixtureUtxos()
    })
    await ledgerA.reserveExecutionAtomic({
      executionId: 'exec_live',
      approvalId: record.approvalId,
      requestId: record.requestId,
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: approvedAmountSats(record),
      network: 'xec:mainnet',
      reservedAt: FIXED_NOW
    })
    await ledgerA.setPlanPrepared('exec_live', plan, testReviewOwnership())
    await ledgerA.transitionToSigningIfValid({
      executionId: 'exec_live',
      plan,
      effectiveExpiresAt: EXPIRES_AT,
      now: () => FIXED_NOW + 2
    })

    await coordinator.requestExclusive(executionSigningLockName('exec_live'), async () => {
      const ledgerB = new DurableTransactionalExecutionLedger({ storage, lockCoordinator: coordinator })
      await ledgerB.whenReady()
      expect((await ledgerB.get('exec_live'))?.status).toBe('SIGNING')
    })

    const ledgerC = new DurableTransactionalExecutionLedger({ storage, lockCoordinator: coordinator })
    await ledgerC.whenReady()
    expect((await ledgerC.get('exec_live'))?.status).toBe('SIGNING_UNCERTAIN')
    expect(await ledgerC.getOutpointReservation(canonicalOutpointKey(plan.inputs[0].txid, 0))).toBe(
      'exec_live'
    )
  })

  it('allows only one of two distinct approvals to PREPARE the same outpoint', async () => {
    const sharedStorage = new MockStorage()
    const sharedCoordinator = new TestExecutionLockCoordinator()
    const sharedUtxos = createFixtureUtxos()
    const recordA = createFixtureLedgerRecord({
      requestId: 'req_out_a',
      approvalId: 'appr_out_a',
      humanApproval: createCanonicalHumanApproval({ requestId: 'req_out_a', approvalId: 'appr_out_a' })
    })
    const recordB = createFixtureLedgerRecord({
      requestId: 'req_out_b',
      approvalId: 'appr_out_b',
      humanApproval: createCanonicalHumanApproval({ requestId: 'req_out_b', approvalId: 'appr_out_b' })
    })
    const tabA = setupEngine({
      record: recordA,
      utxos: sharedUtxos,
      storage: sharedStorage,
      lockCoordinator: sharedCoordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      }),
      idGenerator: () => 'out_a'
    })
    const tabB = setupEngine({
      record: recordB,
      utxos: sharedUtxos,
      storage: sharedStorage,
      lockCoordinator: sharedCoordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      }),
      idGenerator: () => 'out_b'
    })

    const sessionA = await tabA.engine.prepareExecution(recordA.humanApproval)
    expect((await tabA.engine.getExecutionStatus(sessionA.executionId))?.status).toBe('PREPARED')
    await expect(tabB.engine.prepareExecution(recordB.humanApproval)).rejects.toThrow(
      expect.objectContaining({ code: 'OUTPOINT_ALREADY_RESERVED' })
    )
    expect((await tabB.engine.getExecutionStatus('exec_out_b'))?.status).toBe('FAILED')
  })

  it('releases outpoints on reject, expiry, and failure, but not on SIGNED or SIGNING_UNCERTAIN', async () => {
    const outpoint = canonicalOutpointKey('11'.repeat(32), 0)

    const rejected = setupEngine()
    const rejectedSession = await rejected.engine.prepareExecution(rejected.record.humanApproval)
    expect(await (rejected.executionLedger as InMemoryWalletExecutionLedger).getOutpointReservation(outpoint)).toBe(
      rejectedSession.executionId
    )
    await rejectedSession.rejectExecution('custodian rejected')
    expect(await (rejected.executionLedger as InMemoryWalletExecutionLedger).getOutpointReservation(outpoint)).toBeUndefined()

    const failed = setupEngine({
      record: createFixtureLedgerRecord({
        requestId: 'req_fail_op',
        approvalId: 'appr_fail_op',
        humanApproval: createCanonicalHumanApproval({ requestId: 'req_fail_op', approvalId: 'appr_fail_op' })
      })
    })
    const failedSession = await failed.engine.prepareExecution(failed.record.humanApproval)
    failed.setUtxos([])
    await expect(failed.uiHost.getActiveController()!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'UTXO_SELECTION_STALE' })
    )
    expect((await failed.executionLedger.get(failedSession.executionId))?.status).toBe('FAILED')
    expect(await (failed.executionLedger as InMemoryWalletExecutionLedger).getOutpointReservation(outpoint)).toBeUndefined()

    const signed = setupEngine({ storage: new MockStorage() })
    const signedSession = await signed.engine.prepareExecution(signed.record.humanApproval)
    await signed.uiHost.getActiveController()!.confirm()
    expect((await signed.executionLedger.get(signedSession.executionId))?.status).toBe('SIGNED')
    expect(await (signed.executionLedger as InMemoryWalletExecutionLedger).getOutpointReservation(outpoint)).toBe(
      signedSession.executionId
    )

    const uncertain = setupEngine({
      storage: new MockStorage(),
      signatoryProvider: {
        signTransaction: async () => {
          throw new Error('hardware unplugged')
        }
      }
    })
    const uncertainSession = await uncertain.engine.prepareExecution(uncertain.record.humanApproval)
    await expect(uncertain.uiHost.getActiveController()!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'SIGNING_UNCERTAIN' })
    )
    expect((await uncertain.executionLedger.get(uncertainSession.executionId))?.status).toBe('SIGNING_UNCERTAIN')
    expect(
      await (uncertain.executionLedger as InMemoryWalletExecutionLedger).getOutpointReservation(outpoint)
    ).toBe(uncertainSession.executionId)

    const blocked = setupEngine({
      record: createFixtureLedgerRecord({
        requestId: 'req_blocked',
        approvalId: 'appr_blocked',
        humanApproval: createCanonicalHumanApproval({ requestId: 'req_blocked', approvalId: 'appr_blocked' })
      }),
      executionLedger: uncertain.executionLedger,
      idGenerator: () => 'blocked_after_uncertain'
    })
    await expect(blocked.engine.prepareExecution(blocked.record.humanApproval)).rejects.toThrow(
      expect.objectContaining({ code: 'OUTPOINT_ALREADY_RESERVED' })
    )
  })

  it('never passes signed transaction bytes through the injectable ledger port', async () => {
    const inner = new InMemoryWalletExecutionLedger()
    const calls: { method: string; args: unknown[] }[] = []
    const recordingLedger = new Proxy(inner, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            calls.push({ method: String(prop), args })
            return (value as (...innerArgs: unknown[]) => unknown).apply(target, args)
          }
        }
        return value
      }
    }) as InMemoryWalletExecutionLedger

    const { engine, uiHost, record } = setupEngine({
      storage: new MockStorage(),
      executionLedger: recordingLedger
    })
    const session = await engine.prepareExecution(record.humanApproval)
    const handle = await uiHost.getActiveController()!.confirm()
    expect(handle.status).toBe('SIGNED')

    const signedCall = calls.find(call => call.method === 'transitionToSigned')
    expect(signedCall).toBeDefined()
    expect(signedCall!.args).toHaveLength(2)
    expect(signedCall!.args[0]).toBe(session.executionId)
    expect(typeof signedCall!.args[1]).toBe('number')

    const seen = new Set<unknown>()
    const visit = (value: unknown): void => {
      if (value === null || value === undefined) return
      if (typeof value === 'string') {
        expect(value).not.toMatch(/rawSignedTxHex/)
        if (/^[0-9a-f]+$/i.test(value)) {
          expect(value.length).toBeLessThanOrEqual(64)
        }
        return
      }
      if (typeof value !== 'object') return
      if (seen.has(value)) return
      seen.add(value)
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        expect(key).not.toBe('rawSignedTxHex')
        expect(key).not.toBe('rawTx')
        expect(key).not.toBe('txHex')
        visit(nested)
      }
    }
    for (const call of calls) {
      visit(call.args)
    }
  })

  it('expires inside the exclusive PREPARED -> SIGNING mutation if the ledger lock is delayed', async () => {
    const signerMock = vi.fn()
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    const ledger = new DurableTransactionalExecutionLedger({ storage, lockCoordinator: coordinator })
    const { engine, uiHost, record, setClock } = setupEngine({
      storage,
      lockCoordinator: coordinator,
      executionLedger: ledger,
      signatoryProvider: {
        getSignatory: async () => {
          signerMock()
          return createSyntheticSignatory().signatory
        }
      }
    })
    const session = await engine.prepareExecution(record.humanApproval)

    let releaseLock!: () => void
    const hold = new Promise<void>(resolve => {
      releaseLock = resolve
    })
    const holding = coordinator.requestExclusive(DEFAULT_EXECUTION_LOCK_NAME, async () => {
      await hold
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const confirmPromise = uiHost.getActiveController()!.confirm()
    await new Promise(resolve => setTimeout(resolve, 40))
    setClock(EXPIRES_AT + 5)
    releaseLock()
    await holding

    await expect(confirmPromise).rejects.toThrow(expect.objectContaining({ code: 'APPROVAL_EXPIRED' }))
    expect(signerMock).not.toHaveBeenCalled()
    expect((await ledger.get(session.executionId))?.status).toBe('EXPIRED')
  })

  it('fails closed before PREPARED when the UTXO provider returns duplicate outpoints', async () => {
    const duplicates: ExecutionUtxoInput[][] = [
      [
        ...createFixtureUtxos(),
        { txid: '11'.repeat(32), outIdx: 0, sats: 500_000n, lockingScriptHex: FROM_SCRIPT_HEX }
      ],
      [
        ...createFixtureUtxos(),
        { txid: '11'.repeat(32), outIdx: 0, sats: 400_000n, lockingScriptHex: FROM_SCRIPT_HEX }
      ],
      [
        ...createFixtureUtxos(),
        { txid: '11'.repeat(32), outIdx: 0, sats: 500_000n, lockingScriptHex: DEST_SCRIPT_HEX }
      ]
    ]

    for (const utxos of duplicates) {
      const signerMock = vi.fn()
      const { engine, record } = setupEngine({
        utxos,
        signatoryProvider: {
          getSignatory: async () => {
            signerMock()
            return createSyntheticSignatory().signatory
          }
        }
      })
      await expect(engine.prepareExecution(record.humanApproval)).rejects.toThrow(
        expect.objectContaining({ code: 'DUPLICATE_UTXO_OUTPOINT' })
      )
      expect(signerMock).not.toHaveBeenCalled()
      expect(() =>
        assertUniqueUtxoOutpoints(utxos)
      ).toThrow(expect.objectContaining({ code: 'DUPLICATE_UTXO_OUTPOINT' }))
    }
  })

  it('never writes the signed transaction into Agent-injectable config.storage', async () => {
    const malicious = new MockStorage()
    const captured: string[] = []
    const originalSetItem = malicious.setItem.bind(malicious)
    malicious.setItem = (key: string, value: string) => {
      captured.push(value)
      originalSetItem(key, value)
    }
    const settlement = new MockStorage()
    const { engine, uiHost, record } = setupEngine({
      storage: malicious,
      privateSettlementStorage: settlement
    })
    const session = await engine.prepareExecution(record.humanApproval)
    await uiHost.getActiveController()!.confirm()

    expect(readStoredRawTx(malicious, session.executionId)).toBeUndefined()
    const privateHex = readStoredRawTx(settlement, session.executionId)
    expect(privateHex).toBeDefined()
    expect(privateHex!.length).toBeGreaterThan(100)
    expect(captured.join('\n')).not.toContain(privateHex!)
    expect(captured.join('\n')).not.toMatch(/rawSignedTxHex/)
  })

  it('keeps a live PREPARED review when another tab reconciles', async () => {
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    let now = FIXED_NOW + 20
    const tabA = setupEngine({
      storage,
      lockCoordinator: coordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: coordinator,
        clock: () => now
      }),
      reviewLeaseTtlSeconds: 30
    })
    const session = await tabA.engine.prepareExecution(tabA.record.humanApproval)
    const tabB = new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: coordinator,
      clock: () => now
    })
    await tabB.whenReady()
    expect((await tabB.get(session.executionId))?.status).toBe('PREPARED')
    expect(await tabB.getOutpointReservation(canonicalOutpointKey('11'.repeat(32), 0))).toBe(
      session.executionId
    )
  })

  it('reclaims abandoned PREPARED reservations after lease expiry', async () => {
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    let now = 1_000
    const ledgerA = new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: coordinator,
      clock: () => now
    })
    await ledgerA.whenReady()
    const record = createFixtureLedgerRecord()
    const plan = buildPreparedExecutionPlan({
      approved: {
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats(record)
      },
      availableUtxos: createFixtureUtxos()
    })
    await ledgerA.reserveExecutionAtomic({
      executionId: 'exec_abandoned',
      approvalId: record.approvalId,
      requestId: record.requestId,
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: approvedAmountSats(record),
      network: 'xec:mainnet',
      reservedAt: now
    })
    await ledgerA.setPlanPrepared('exec_abandoned', plan, {
      ownerId: 'owner_gone',
      generation: 1,
      leaseTtlSeconds: 5
    })
    now = 1_020
    const ledgerB = new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: coordinator,
      clock: () => now
    })
    await ledgerB.whenReady()
    expect((await ledgerB.get('exec_abandoned'))?.status).toBe('EXPIRED')
    expect(await ledgerB.getOutpointReservation(canonicalOutpointKey(plan.inputs[0].txid, 0))).toBeUndefined()

    await expect(
      ledgerB.renewReviewLease({
        executionId: 'exec_abandoned',
        ownerId: 'owner_gone',
        generation: 1,
        now,
        leaseTtlSeconds: 30
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'REVIEW_LEASE_REJECTED' }))
  })

  it('does not release outpoints of a live renewed PREPARED review during recovery race', async () => {
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    let now = FIXED_NOW + 20
    const tabA = setupEngine({
      storage,
      lockCoordinator: coordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: coordinator,
        clock: () => now
      }),
      reviewLeaseTtlSeconds: 30,
      reviewHeartbeatMs: 20
    })
    const session = await tabA.engine.prepareExecution(tabA.record.humanApproval)
    await Promise.all([
      new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: coordinator,
        clock: () => now
      }).whenReady(),
      tabA.executionLedger.renewReviewLease({
        executionId: session.executionId,
        ownerId: `review_test_id_1`,
        generation: (await (tabA.executionLedger as DurableTransactionalExecutionLedger).getReviewLease(
          session.executionId
        ))!.generation,
        now,
        leaseTtlSeconds: 30
      })
    ])
    expect((await tabA.engine.getExecutionStatus(session.executionId))?.status).toBe('PREPARED')
    expect(
      await (tabA.executionLedger as DurableTransactionalExecutionLedger).getOutpointReservation(
        canonicalOutpointKey('11'.repeat(32), 0)
      )
    ).toBe(session.executionId)
  })

  it('snapshotOwnedUtxos never retains provider object references', () => {
    const providerOwned = {
      txid: '11'.repeat(32),
      outIdx: 0,
      sats: 500_000n,
      lockingScriptHex: FROM_SCRIPT_HEX
    }
    const owned = snapshotOwnedUtxos([providerOwned])
    providerOwned.txid = 'ee'.repeat(32)
    expect(owned[0].txid).toBe('11'.repeat(32))
    expect(owned[0]).not.toBe(providerOwned)
    expect(Object.isFrozen(owned[0])).toBe(true)
    expect(Object.isFrozen(owned)).toBe(true)
  })

  it('samples a fresh PREPARED lease at durable commit after slow preparation', async () => {
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    let now = FIXED_NOW + 20
    const { engine, record, executionLedger } = setupEngine({
      storage,
      lockCoordinator: coordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: coordinator,
        clock: () => now
      }),
      reviewLeaseTtlSeconds: 30,
      onSpendableUtxos: async () => {
        now += 45
      }
    })
    const session = await engine.prepareExecution(record.humanApproval)
    const lease = await (executionLedger as DurableTransactionalExecutionLedger).getReviewLease(
      session.executionId
    )
    expect(lease).toBeDefined()
    expect(lease!.leaseExpiresAt).toBe(now + 30)
    expect((await executionLedger.get(session.executionId))?.preparedAt).toBe(now)

    const otherTab = new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: coordinator,
      clock: () => now
    })
    await otherTab.whenReady()
    expect((await otherTab.get(session.executionId))?.status).toBe('PREPARED')
    expect(await otherTab.tryRecoverAbandonedPrepared(session.executionId)).toBe('still_live')
  })

  it('schedules PREPARED recovery after startup when the lease expires', async () => {
    vi.useFakeTimers()
    try {
      const storage = new MockStorage()
      const coordinator = new TestExecutionLockCoordinator()
      let now = 5_000
      const ledgerA = new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: coordinator,
        clock: () => now
      })
      await ledgerA.whenReady()
      const record = createFixtureLedgerRecord()
      const plan = buildPreparedExecutionPlan({
        approved: {
          approvalId: record.approvalId,
          requestId: record.requestId,
          intentId: record.intentId,
          fromAddress: record.fromAddress,
          destination: record.destination,
          amountSats: approvedAmountSats(record)
        },
        availableUtxos: createFixtureUtxos()
      })
      await ledgerA.reserveExecutionAtomic({
        executionId: 'exec_scheduled',
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        decisionId: record.decisionId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats(record),
        network: 'xec:mainnet',
        reservedAt: now
      })
      await ledgerA.setPlanPrepared('exec_scheduled', plan, {
        ownerId: 'owner_gone',
        generation: 1,
        leaseTtlSeconds: 1
      })

      const observer = setupEngine({
        storage,
        lockCoordinator: coordinator,
        executionLedger: new DurableTransactionalExecutionLedger({
          storage,
          lockCoordinator: coordinator,
          clock: () => now
        }),
        record: createFixtureLedgerRecord({
          requestId: 'req_sched_obs',
          approvalId: 'appr_sched_obs',
          humanApproval: createCanonicalHumanApproval({
            requestId: 'req_sched_obs',
            approvalId: 'appr_sched_obs'
          })
        }),
        reviewLeaseTtlSeconds: 1
      })
      await observer.executionLedger.whenReady()
      now = 5_003
      await vi.advanceTimersByTimeAsync(2_000)
      expect((await observer.executionLedger.get('exec_scheduled'))?.status).toBe('EXPIRED')
      expect(
        await (observer.executionLedger as DurableTransactionalExecutionLedger).getOutpointReservation(
          canonicalOutpointKey(plan.inputs[0].txid, 0)
        )
      ).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reclaims an expired PREPARED owner on reservation conflict and retries once', async () => {
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    let now = 8_000
    const abandoned = new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: coordinator,
      clock: () => now
    })
    await abandoned.whenReady()
    const recordA = createFixtureLedgerRecord({
      requestId: 'req_conflict_a',
      approvalId: 'appr_conflict_a',
      humanApproval: createCanonicalHumanApproval({
        requestId: 'req_conflict_a',
        approvalId: 'appr_conflict_a'
      })
    })
    const plan = buildPreparedExecutionPlan({
      approved: {
        approvalId: recordA.approvalId,
        requestId: recordA.requestId,
        intentId: recordA.intentId,
        fromAddress: recordA.fromAddress,
        destination: recordA.destination,
        amountSats: approvedAmountSats(recordA)
      },
      availableUtxos: createFixtureUtxos()
    })
    await abandoned.reserveExecutionAtomic({
      executionId: 'exec_conflict_a',
      approvalId: recordA.approvalId,
      requestId: recordA.requestId,
      intentId: recordA.intentId,
      decisionId: recordA.decisionId,
      fromAddress: recordA.fromAddress,
      destination: recordA.destination,
      amountSats: approvedAmountSats(recordA),
      network: 'xec:mainnet',
      reservedAt: now
    })
    await abandoned.setPlanPrepared('exec_conflict_a', plan, {
      ownerId: 'owner_abandoned',
      generation: 1,
      leaseTtlSeconds: 1
    })
    now = 8_005

    const recordB = createFixtureLedgerRecord({
      requestId: 'req_conflict_b',
      approvalId: 'appr_conflict_b',
      humanApproval: createCanonicalHumanApproval({
        requestId: 'req_conflict_b',
        approvalId: 'appr_conflict_b'
      })
    })
    const tabB = setupEngine({
      record: recordB,
      storage,
      lockCoordinator: coordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: coordinator,
        clock: () => now
      }),
      idGenerator: () => 'conflict_b'
    })
    const sessionB = await tabB.engine.prepareExecution(recordB.humanApproval)
    expect((await tabB.engine.getExecutionStatus(sessionB.executionId))?.status).toBe('PREPARED')
    expect((await tabB.executionLedger.get('exec_conflict_a'))?.status).toBe('EXPIRED')
  })

  it('does not reclaim SIGNING on reservation conflict', async () => {
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    const signing = setupEngine({
      storage,
      lockCoordinator: coordinator,
      executionLedger: new DurableTransactionalExecutionLedger({
        storage,
        lockCoordinator: coordinator,
        clock: () => FIXED_NOW + 20
      }),
      idGenerator: () => 'keep_signing'
    })
    const session = await signing.engine.prepareExecution(signing.record.humanApproval)
    await signing.executionLedger.transitionToSigningIfValid({
      executionId: session.executionId,
      plan: session.plan,
      effectiveExpiresAt: EXPIRES_AT,
      now: () => FIXED_NOW + 21
    })
    await coordinator.requestExclusive(executionSigningLockName(session.executionId), async () => {
      const blocked = setupEngine({
        record: createFixtureLedgerRecord({
          requestId: 'req_block_signing',
          approvalId: 'appr_block_signing',
          humanApproval: createCanonicalHumanApproval({
            requestId: 'req_block_signing',
            approvalId: 'appr_block_signing'
          })
        }),
        storage,
        lockCoordinator: coordinator,
        executionLedger: new DurableTransactionalExecutionLedger({
          storage,
          lockCoordinator: coordinator,
          clock: () => FIXED_NOW + 80
        }),
        idGenerator: () => 'blocked_signing'
      })
      await expect(blocked.engine.prepareExecution(blocked.record.humanApproval)).rejects.toThrow(
        expect.objectContaining({ code: 'OUTPOINT_ALREADY_RESERVED' })
      )
      expect((await signing.executionLedger.get(session.executionId))?.status).toBe('SIGNING')
    })
  })

  it('acquires signing lock while review lock is held and forbids reverse order', async () => {
    const coordinator = new TestExecutionLockCoordinator()
    const executionId = 'exec_handoff'
    await coordinator.requestExclusive(`rmzwallet:agent-review:${executionId}`, async () => {
      await coordinator.requestExclusive(`rmzwallet:agent-signing:${executionId}`, async () => {
        await coordinator.requestExclusive('rmzwallet:agent-execution:lock:v2', async () => {
          await coordinator.requestExclusive('rmzwallet:internal-settlement:lock:v2', async () => {
            return 'ok'
          })
        })
      })
    })

    await expect(
      coordinator.requestExclusive(`rmzwallet:agent-signing:${executionId}`, async () => {
        await coordinator.requestExclusive(`rmzwallet:agent-review:${executionId}`, async () => 'nope')
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'LOCK_ORDER_VIOLATION' }))

    await expect(
      coordinator.requestExclusive('rmzwallet:agent-execution:lock:v2', async () => {
        await coordinator.requestExclusive(`rmzwallet:agent-signing:${executionId}`, async () => 'nope')
      })
    ).rejects.toThrow(expect.objectContaining({ code: 'LOCK_ORDER_VIOLATION' }))
  })

  it('dispose cancels recovery timers and rejects stale confirm without marking SIGNED', async () => {
    const { engine, composition, uiHost, record, executionLedger } = setupEngine({
      reviewLeaseTtlSeconds: 30
    })
    const session = await engine.prepareExecution(record.humanApproval)
    const controller = uiHost.getActiveController()
    expect(controller).toBeDefined()
    composition.dispose()
    expect(uiHost.getActiveController()).toBeUndefined()
    await expect(controller!.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'COMPOSITION_DISPOSED' })
    )
    await expect(engine.prepareExecution(record.humanApproval)).rejects.toThrow(
      expect.objectContaining({ code: 'COMPOSITION_DISPOSED' })
    )
    expect((await executionLedger.get(session.executionId))?.status).toBe('PREPARED')
  })

  it('terminalizes EXECUTION_RESERVED to FAILED when Chronik rejects after reservation', async () => {
    const signerMock = vi.fn()
    const { engine, record, executionLedger } = setupEngine({
      storage: new MockStorage(),
      onSpendableUtxos: async () => {
        throw new Error('chronik rejected')
      },
      signatoryProvider: {
        getSignatory: async () => {
          signerMock()
          return createSyntheticSignatory().signatory
        }
      }
    })
    await expect(engine.prepareExecution(record.humanApproval)).rejects.toThrow(/chronik rejected/)
    const status = await executionLedger.get('exec_test_id_1')
    expect(status?.status).toBe('FAILED')
    expect(signerMock).not.toHaveBeenCalled()
    expect(
      await (executionLedger as DurableTransactionalExecutionLedger).getOutpointReservation(
        canonicalOutpointKey('11'.repeat(32), 0)
      )
    ).toBeUndefined()
    await expect(engine.prepareExecution(record.humanApproval)).rejects.toThrow(
      expect.objectContaining({ code: 'DUPLICATE_EXECUTION' })
    )
    expect(signerMock).not.toHaveBeenCalled()
  })

  it('terminalizes EXECUTION_RESERVED to FAILED when Chronik payload conversion throws', async () => {
    const signerMock = vi.fn()
    const { engine, record, executionLedger } = setupEngine({
      storage: new MockStorage(),
      utxos: [
        {
          txid: '11'.repeat(32),
          outIdx: 0,
          sats: undefined as unknown as bigint,
          lockingScriptHex: FROM_SCRIPT_HEX
        }
      ],
      signatoryProvider: {
        getSignatory: async () => {
          signerMock()
          return createSyntheticSignatory().signatory
        }
      }
    })
    await expect(engine.prepareExecution(record.humanApproval)).rejects.toThrow()
    expect((await executionLedger.get('exec_test_id_1'))?.status).toBe('FAILED')
    expect(signerMock).not.toHaveBeenCalled()
    expect(
      await (executionLedger as DurableTransactionalExecutionLedger).getOutpointReservation(
        canonicalOutpointKey('11'.repeat(32), 0)
      )
    ).toBeUndefined()
    await expect(engine.prepareExecution(record.humanApproval)).rejects.toThrow(
      expect.objectContaining({ code: 'DUPLICATE_EXECUTION' })
    )
  })

  it('reconciles abandoned EXECUTION_RESERVED records to FAILED at startup', async () => {
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    const ledgerA = new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: coordinator,
      clock: () => FIXED_NOW
    })
    await ledgerA.whenReady()
    const record = createFixtureLedgerRecord()
    await ledgerA.reserveExecutionAtomic({
      executionId: 'exec_reserved_crash',
      approvalId: record.approvalId,
      requestId: record.requestId,
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: approvedAmountSats(record),
      network: 'xec:mainnet',
      reservedAt: FIXED_NOW
    })
    expect((await ledgerA.get('exec_reserved_crash'))?.status).toBe('EXECUTION_RESERVED')

    const ledgerB = new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: coordinator,
      clock: () => FIXED_NOW + 5
    })
    await ledgerB.whenReady()
    expect((await ledgerB.get('exec_reserved_crash'))?.status).toBe('FAILED')
    expect(await ledgerB.getOutpointReservation(canonicalOutpointKey('11'.repeat(32), 0))).toBeUndefined()
  })

  it('retries PREPARED commit once when concurrent recovery returns not_prepared', async () => {
    const storage = new MockStorage()
    const inner = new TestExecutionLockCoordinator()
    let injected = false
    let now = 9_000
    const recoverer = new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: inner,
      clock: () => now
    })
    await recoverer.whenReady()
    const record = createFixtureLedgerRecord({
      requestId: 'req_np',
      approvalId: 'appr_np',
      humanApproval: createCanonicalHumanApproval({ requestId: 'req_np', approvalId: 'appr_np' })
    })
    const plan = buildPreparedExecutionPlan({
      approved: {
        approvalId: record.approvalId,
        requestId: record.requestId,
        intentId: record.intentId,
        fromAddress: record.fromAddress,
        destination: record.destination,
        amountSats: approvedAmountSats(record)
      },
      availableUtxos: createFixtureUtxos()
    })
    await recoverer.reserveExecutionAtomic({
      executionId: 'exec_abandoned_np',
      approvalId: 'appr_abandoned_np',
      requestId: 'req_abandoned_np',
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: approvedAmountSats(record),
      network: 'xec:mainnet',
      reservedAt: 8_990
    })
    await recoverer.setPlanPrepared('exec_abandoned_np', plan, {
      ownerId: 'owner_gone',
      generation: 1,
      leaseTtlSeconds: 1
    })

    let allowInject = false
    let globalOps = 0
    const wrappingCoordinator = {
      requestExclusive: async <T>(lockName: string, operation: () => Promise<T>): Promise<T> => {
        const result = await inner.requestExclusive(lockName, operation)
        if (allowInject && lockName === DEFAULT_EXECUTION_LOCK_NAME) {
          globalOps += 1
          if (globalOps === 2 && !injected) {
            injected = true
            const recovered = await recoverer.tryRecoverAbandonedPrepared('exec_abandoned_np')
            expect(recovered).toBe('reclaimed')
          }
        }
        return result
      },
      tryExclusive: <T>(lockName: string, operation: () => Promise<T>) =>
        inner.tryExclusive(lockName, operation)
    }

    const newLedger = new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: wrappingCoordinator,
      clock: () => now
    })
    await newLedger.whenReady()
    now = 9_010
    allowInject = true
    await newLedger.reserveExecutionAtomic({
      executionId: 'exec_new_np',
      approvalId: record.approvalId,
      requestId: record.requestId,
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: approvedAmountSats(record),
      network: 'xec:mainnet',
      reservedAt: 9_010
    })
    const lease = await newLedger.setPlanPrepared('exec_new_np', plan, {
      ownerId: 'owner_new',
      generation: 1,
      leaseTtlSeconds: 30
    })
    expect(lease.ownerId).toBe('owner_new')
    expect((await newLedger.get('exec_new_np'))?.status).toBe('PREPARED')
    expect((await newLedger.get('exec_abandoned_np'))?.status).toBe('EXPIRED')
    expect(await newLedger.getOutpointReservation(canonicalOutpointKey(plan.inputs[0].txid, 0))).toBe(
      'exec_new_np'
    )
  })

  it('releases review ownership and does not invoke the signer if disposed during session revalidation', async () => {
    await assertDisposeDuringPreSigningHandoff('session')
  })

  it('releases review ownership and does not invoke the signer if disposed during UTXO revalidation', async () => {
    await assertDisposeDuringPreSigningHandoff('utxo')
  })

  it('releases review ownership and does not invoke the signer if disposed while signing lock is held before durable SIGNING', async () => {
    await assertDisposeDuringPreSigningHandoff('lock')
  })
})

async function assertDisposeDuringPreSigningHandoff(
  hang: 'session' | 'utxo' | 'lock'
): Promise<void> {
  const signerMock = vi.fn()
  const storage = new MockStorage()
  const coordinator = new TestExecutionLockCoordinator()
  let hangResolve!: () => void
  const hung = new Promise<void>(resolve => {
    hangResolve = resolve
  })
  let prepared = false
  const { engine, composition, uiHost, record, executionLedger } = setupEngine({
    storage,
    lockCoordinator: coordinator,
    executionLedger: new DurableTransactionalExecutionLedger({
      storage,
      lockCoordinator: coordinator,
      clock: () => FIXED_NOW + 20
    }),
    onVerifyActiveSession: async () => {
      if (prepared && (hang === 'session' || hang === 'lock')) {
        await hung
      }
    },
    onSpendableUtxos: async () => {
      if (prepared && hang === 'utxo') {
        await hung
      }
    },
    signatoryProvider: {
      getSignatory: async () => {
        signerMock()
        return createSyntheticSignatory().signatory
      }
    }
  })
  const session = await engine.prepareExecution(record.humanApproval)
  prepared = true
  const confirmPromise = uiHost.getActiveController()!.confirm()
  for (let i = 0; i < 50; i++) {
    const attempt = await coordinator.tryExclusive(
      executionSigningLockName(session.executionId),
      async () => 'probe'
    )
    if (!attempt.acquired) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  composition.dispose()
  hangResolve()
  await expect(confirmPromise).rejects.toThrow(
    expect.objectContaining({ code: 'COMPOSITION_DISPOSED' })
  )
  expect(signerMock).not.toHaveBeenCalled()
  const reviewAttempt = await coordinator.tryExclusive(
    executionReviewLockName(session.executionId),
    async () => 'acquired'
  )
  expect(reviewAttempt.acquired).toBe(true)
  expect((await executionLedger.get(session.executionId))?.status).toBe('FAILED')
  expect(
    await (executionLedger as DurableTransactionalExecutionLedger).getOutpointReservation(
      canonicalOutpointKey('11'.repeat(32), 0)
    )
  ).toBeUndefined()
}
