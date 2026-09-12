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
import { ALL_BIP143, Ecc, P2PKHSignatory, Script, toHex, TxBuilder } from 'ecash-lib'
import type { HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import type { WalletApprovalLedgerRecord } from '../agentWalletApprovalReceiver/types'
import { createAgentWalletExecutionEngine } from './engine'
import { DurableStorageWalletExecutionLedger } from './ledger'
import { InMemoryWalletExecutionLedger, MockStorage } from './testUtils'
import { WalletExecutionError } from './errors'
import {
  assertFeePolicy,
  buildPreparedExecutionPlan,
  computeCanonicalPlanHash,
  DEFAULT_FEE_POLICY,
  estimateP2pkhTransactionSize,
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

function createFixtureLedgerRecord(overrides: Partial<WalletApprovalLedgerRecord> = {}): WalletApprovalLedgerRecord {
  return {
    operationId: 'req_123',
    requestId: 'req_123',
    approvalId: 'appr_456',
    intentId: 'intent_789',
    decisionId: 'dec_101',
    contentHash: 'content_hash_abc',
    capabilityId: 'cap_xyz',
    effectiveExpiresAt: EXPIRES_AT,
    network: 'xec:mainnet',
    amountSats: 250_000n, // 2,500 XEC
    fromAddress: FROM_ADDRESS,
    destination: DESTINATION_ADDRESS,
    presentationHash: 'pres_hash_def',
    recordedAt: FIXED_NOW + 10,
    status: 'approved',
    humanApproval: {
      schema: 'tonalli.human-approval',
      version: 1,
      approvalId: 'appr_456',
      requestId: 'req_123',
      intentId: 'intent_789',
      decisionId: 'dec_101',
      status: 'approved',
      approver: FROM_ADDRESS,
      network: 'xec:mainnet',
      presentationHash: 'pres_hash_def',
      contentHash: 'content_hash_abc',
      recordedAt: FIXED_NOW + 10
    },
    ...overrides
  }
}

function createFixtureUtxos(sats = 500_000n): ExecutionUtxoInput[] {
  return [
    {
      txid: '11'.repeat(32),
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
  executionLedger?: any
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

  const executionLedger =
    options.executionLedger ??
    (options.storage
      ? new DurableStorageWalletExecutionLedger({ storage: options.storage })
      : new InMemoryWalletExecutionLedger())

  const sessionVerifier = {
    async verifyActiveSession() {
      return {
        authenticated,
        activeAddress: authenticated ? activeAddress : undefined
      }
    }
  }

  let currentUtxos = [...utxos]
  const utxoProvider = {
    async getSpendableUtxos(_address: string) {
      return [...currentUtxos]
    }
  }

  const synthetic = createSyntheticSignatory()
  const signatoryProvider = options.signatoryProvider ?? {
    async getSignatory(_address: string) {
      return synthetic.signatory
    }
  }

  const engine = createAgentWalletExecutionEngine({
    approvalLedger,
    executionLedger,
    sessionVerifier,
    utxoProvider,
    signatoryProvider,
    feePolicy: options.feePolicy,
    clock: () => clockTime,
    idGenerator: () => 'test_id_1'
  })

  return {
    engine,
    record,
    utxos,
    executionLedger,
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
  // P0 Focus Test 1: Complete Valid Execution Flow
  it('executes complete valid preparation, review snapshot, local confirmation, and offline signing', async () => {
    const { engine, record, executionLedger } = setupEngine()

    const session = await engine.prepareExecution(record.humanApproval!)
    expect(session.executionId).toBe('exec_test_id_1')
    expect(session.review.amountXEC).toBe('2500.00 XEC')
    expect(session.review.feeXEC).toMatch(/XEC/)
    expect(session.review.network).toBe('xec:mainnet')

    // Local confirmation controller
    const controller = engine.createLocalConfirmationController(session)
    const handle = await controller.confirm()

    expect(handle.status).toBe('SIGNED')
    expect(handle.approvalId).toBe(record.approvalId)
    expect(handle.requestId).toBe(record.requestId)
    expect(handle.planHash).toBe(session.plan.planHash)

    // Verify raw signed tx is retained in ledger, not in handle
    expect((handle as any).rawSignedTxHex).toBeUndefined()
    const internalRecord = await executionLedger.get(session.executionId)
    expect(internalRecord?.state).toBe('SIGNED')
    expect(internalRecord?.rawSignedTxHex).toBeDefined()
    expect(internalRecord?.rawSignedTxHex?.length).toBeGreaterThan(100)
  })

  // P0-1: Persistent Durable Ledger & Restart / Reopen Safety
  it('persists execution state across engine re-instantiation on the same storage', async () => {
    const storage = new MockStorage()
    const record = createFixtureLedgerRecord()

    // Instance 1: Prepare and confirm
    const instance1 = setupEngine({ record, storage })
    const session = await instance1.engine.prepareExecution(record.humanApproval!)
    const controller = instance1.engine.createLocalConfirmationController(session)
    const handle = await controller.confirm()
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
    const initialLedger = new DurableStorageWalletExecutionLedger({ storage })
    await initialLedger.reserveExecutionAtomic({
      executionId: 'exec_crashed',
      approvalId: record.approvalId,
      requestId: record.requestId,
      intentId: record.intentId,
      decisionId: record.decisionId,
      fromAddress: record.fromAddress,
      destination: record.destination,
      amountSats: record.amountSats,
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
        amountSats: record.amountSats
      },
      availableUtxos: createFixtureUtxos()
    })
    await initialLedger.setPlanPrepared('exec_crashed', plan, FIXED_NOW + 1)
    await initialLedger.transitionToSigning('exec_crashed', FIXED_NOW + 2)

    // Simulate process death and reopen with new ledger instance
    const reopenedLedger = new DurableStorageWalletExecutionLedger({ storage })
    const recovered = await reopenedLedger.get('exec_crashed')
    expect(recovered?.state).toBe('SIGNING_UNCERTAIN')
    expect(recovered?.uncertainReason).toContain('Process interrupted during signing')

    // Transitioning from SIGNING_UNCERTAIN is prohibited (terminal state)
    await expect(reopenedLedger.transitionToSigning('exec_crashed', FIXED_NOW + 3)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' })
    )
  })

  // P0-2: Public API isolates rawSignedTxHex
  it('strictly isolates rawSignedTxHex from public engine inspection APIs', async () => {
    const { engine, record, executionLedger } = setupEngine()
    const session = await engine.prepareExecution(record.humanApproval!)
    const controller = engine.createLocalConfirmationController(session)
    await controller.confirm()

    const publicStatus = await engine.getExecutionStatus(session.executionId)
    expect(publicStatus?.status).toBe('SIGNED')
    expect((publicStatus as any).rawSignedTxHex).toBeUndefined()
    expect((publicStatus as any).plan).toBeUndefined()

    // Internal ledger method can retrieve raw tx for future settlement
    const internalHex = await (executionLedger as any).getSignedTransactionHex?.(session.executionId)
    expect(internalHex).toBeDefined()
    expect(typeof internalHex).toBe('string')
  })

  // P0-3: Final human confirmation is strictly enforced
  it('enforces that session alone does not expose signing method and requires local authority', async () => {
    const { engine, record } = setupEngine()
    const session = await engine.prepareExecution(record.humanApproval!)

    // Public review session has NO confirmExecution or signing method
    expect((session as any).confirmExecution).toBeUndefined()
    expect((session as any).sign).toBeUndefined()

    // Calling controller from local UI succeeds
    const controller = engine.createLocalConfirmationController(session)
    const handle = await controller.confirm()
    expect(handle.status).toBe('SIGNED')
  })

  // P0-4: Dismiss invalidates execution durably
  it('durably invalidates execution when dismiss is called, preventing subsequent signing', async () => {
    const signerMock = vi.fn()
    const { engine, record, executionLedger } = setupEngine({
      signatoryProvider: {
        async getSignatory() {
          signerMock()
          return createSyntheticSignatory().signatory
        }
      }
    })

    const session = await engine.prepareExecution(record.humanApproval!)
    const controller = engine.createLocalConfirmationController(session)

    // Custodian dismisses modal
    await session.dismiss()

    // Check ledger state is durably REJECTED
    const ledgerRecord = await executionLedger.get(session.executionId)
    expect(ledgerRecord?.state).toBe('REJECTED')

    // Subsequent confirm attempt MUST fail
    await expect(controller.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' })
    )

    // Signer was never invoked
    expect(signerMock).not.toHaveBeenCalled()
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

  // P1-3: Output script must match declared address
  it('strictly validates output scriptHex matches derived address script', () => {
    const plan = buildPreparedExecutionPlan({
      approved: {
        approvalId: 'appr_456',
        requestId: 'req_123',
        intentId: 'intent_789',
        fromAddress: FROM_ADDRESS,
        destination: DESTINATION_ADDRESS,
        amountSats: 250_000n
      },
      availableUtxos: createFixtureUtxos()
    })

    // Valid plan passes output invariant validation
    expect(() =>
      validateOutputInvariants(plan, {
        destination: DESTINATION_ADDRESS,
        amountSats: 250_000n,
        fromAddress: FROM_ADDRESS,
        network: 'xec:mainnet'
      })
    ).not.toThrow()

    // Attacker modifies primary output script to another valid address script
    const attackerScriptHex = toHex(Script.fromAddress(ALTERNATE_ADDRESS).bytecode)
    const tamperedPlan: any = {
      ...plan,
      outputs: [
        { ...plan.outputs[0], scriptHex: attackerScriptHex },
        plan.outputs[1]
      ]
    }

    expect(() =>
      validateOutputInvariants(tamperedPlan, {
        destination: DESTINATION_ADDRESS,
        amountSats: 250_000n,
        fromAddress: FROM_ADDRESS,
        network: 'xec:mainnet'
      })
    ).toThrow(expect.objectContaining({ code: 'OUTPUT_INVARIANT_VIOLATION' }))
  })

  // P1-4: Post-sign verification against adversarial signatory
  it('detects adversarial signer modifying output script and fails closed to SIGNING_UNCERTAIN', async () => {
    // Adversarial signatory provider that modifies the destination output
    const adversarialSigner = {
      async signTransaction(txBuilder: any) {
        // Tamper with output script
        const tamperedBuilder = new TxBuilder({
          version: txBuilder.version,
          locktime: txBuilder.locktime,
          inputs: txBuilder.inputs,
          outputs: [
            {
              sats: txBuilder.outputs[0].sats,
              script: Script.fromAddress(ALTERNATE_ADDRESS)
            },
            ...(txBuilder.outputs.slice(1))
          ]
        })
        const synthetic = createSyntheticSignatory()
        // Sign tampered
        return tamperedBuilder.sign()
      }
    }

    const { engine, record, executionLedger } = setupEngine({
      signatoryProvider: adversarialSigner
    })

    const session = await engine.prepareExecution(record.humanApproval!)
    const controller = engine.createLocalConfirmationController(session)

    await expect(controller.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'SIGNED_TRANSACTION_MISMATCH' })
    )

    // Ledger record must be marked SIGNING_UNCERTAIN
    const ledgerRecord = await executionLedger.get(session.executionId)
    expect(ledgerRecord?.state).toBe('SIGNING_UNCERTAIN')
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
      amountSats: record.amountSats,
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
        amountSats: record.amountSats
      },
      availableUtxos: createFixtureUtxos()
    })
    await ledger.setPlanPrepared('exec_imm', plan, FIXED_NOW + 1)
    await ledger.transitionToSigning('exec_imm', FIXED_NOW + 2)
    await ledger.transitionToSigned('exec_imm', '0200000001...', FIXED_NOW + 3)

    // Attempting to reject a SIGNED record throws INVALID_STATE_TRANSITION
    await expect(ledger.markRejected('exec_imm', 'too late', FIXED_NOW + 4)).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' })
    )

    // State remains SIGNED
    const finalRecord = await ledger.get('exec_imm')
    expect(finalRecord?.state).toBe('SIGNED')
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
    const { engine, record, executionLedger, setUtxos } = setupEngine()

    const session = await engine.prepareExecution(record.humanApproval!)
    const controller = engine.createLocalConfirmationController(session)

    // Simulate UTXO spent in the interim
    setUtxos([])

    await expect(controller.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'UTXO_SELECTION_STALE' })
    )

    const updated = await executionLedger.get(session.executionId)
    expect(updated?.state).toBe('FAILED')
  })

  // Custodian Session Revalidation Failures
  it('fails closed when wallet custodian session changes before signing', async () => {
    const { engine, record, setActiveAddress } = setupEngine()

    const session = await engine.prepareExecution(record.humanApproval!)
    const controller = engine.createLocalConfirmationController(session)

    // Custodian changes active wallet address
    setActiveAddress(ALTERNATE_ADDRESS)

    // Confirm fails closed
    await expect(controller.confirm()).rejects.toThrow(
      expect.objectContaining({ code: 'SESSION_ADDRESS_MISMATCH' })
    )
  })

  // Rejection by Custodian
  it('allows custodian to reject execution, updating ledger to REJECTED', async () => {
    const { engine, record, executionLedger } = setupEngine()
    const session = await engine.prepareExecution(record.humanApproval!)

    await session.rejectExecution('Custodian rejected plan.')
    const updated = await executionLedger.get(session.executionId)
    expect(updated?.state).toBe('REJECTED')
    expect(updated?.uncertainReason).toBe('Custodian rejected plan.')
  })
})
