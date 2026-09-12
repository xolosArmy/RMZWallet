/**
 * @file agentWalletExecution.test.ts
 *
 * CANONICAL TEST SUITE FOR GATE C2 (Wallet-Owned Prepared Transaction Execution)
 *
 * Verifies all required P0 focus tests, crash consistency, invariant enforcement,
 * anti-TOCTOU, concurrency guards, and boundary checks.
 */

import { describe, expect, it, vi } from 'vitest'
import { ALL_BIP143, Ecc, P2PKHSignatory, Script, shaRmd160, toHex } from 'ecash-lib'
import type { HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import type { WalletApprovalLedgerRecord } from '../agentWalletApprovalReceiver/types'
import { createAgentWalletExecutionEngine } from './engine'
import { InMemoryWalletExecutionLedger } from './ledger'
import { WalletExecutionError } from './errors'
import {
  assertFeePolicy,
  buildPreparedExecutionPlan,
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
} = {}) {
  const record = options.record ?? createFixtureLedgerRecord()
  const utxos = options.utxos ?? createFixtureUtxos()
  const activeAddress = options.activeAddress ?? FROM_ADDRESS
  const authenticated = options.authenticated ?? true
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

  const executionLedger = new InMemoryWalletExecutionLedger()

  const sessionVerifier = {
    async verifyActiveSession() {
      return {
        authenticated,
        activeAddress: authenticated ? activeAddress : undefined
      }
    }
  }

  const utxoProvider = {
    async getSpendableUtxos(_address: string) {
      return [...utxos]
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
    approvalStore,
    executionLedger,
    sessionVerifier,
    utxoProvider,
    setClock: (t: number) => { clockTime = t }
  }
}

describe('agentWalletExecution (Gate C2)', () => {
  describe('Happy Path: Complete Lifecycle & Boundary Enforcement', () => {
    it('valid approved request -> prepare -> final review -> sign exactly once', async () => {
      const { engine, record, executionLedger } = setupEngine()
      const receipt = record.humanApproval!

      // 1. Prepare Execution
      const session = await engine.prepareExecution(receipt)
      expect(session).toBeDefined()
      expect(session.executionId).toBe('exec_test_id_1')
      expect(session.plan.destination).toBe(DESTINATION_ADDRESS)
      expect(session.plan.paymentAmountSats).toBe(250_000n)
      expect(session.plan.changeAmountSats).toBe(249_728n) // 500,000 - 250,000 - 272 fee
      expect(session.plan.changeAddress).toBe(FROM_ADDRESS)
      expect(session.plan.network).toBe('xec:mainnet')

      // Check Review Snapshot formatting
      expect(session.review.recipient).toBe(DESTINATION_ADDRESS)
      expect(session.review.amountXEC).toBe('2500.00 XEC')
      expect(session.review.feeXEC).toBe('2.72 XEC')
      expect(session.review.totalDebitXEC).toBe('2502.72 XEC')
      expect(session.review.fundingAddress).toBe(FROM_ADDRESS)
      expect(session.review.planHash).toBe(session.plan.planHash)

      // State in ledger should be PREPARED
      const preparedRecord = await executionLedger.get(session.executionId)
      expect(preparedRecord?.state).toBe('PREPARED')
      expect(preparedRecord?.rawSignedTxHex).toBeUndefined()

      // 2. Final Execution Confirmation & Signing
      const handle = await session.confirmExecution()
      expect(handle).toBeDefined()
      expect(handle.status).toBe('SIGNED')
      expect(handle.executionId).toBe('exec_test_id_1')
      expect(handle.approvalId).toBe(record.approvalId)
      expect(handle.requestId).toBe(record.requestId)
      expect(handle.planHash).toBe(session.plan.planHash)
      expect(handle.signedAt).toBeGreaterThan(0)

      // Boundary check: handle must NOT leak raw signed transaction or private keys
      expect((handle as any).rawSignedTxHex).toBeUndefined()
      expect((handle as any).privateKey).toBeUndefined()
      expect((handle as any).secretKey).toBeUndefined()
      expect((handle as any).txid).toBeUndefined()

      // State in ledger should be SIGNED and retain raw tx internally
      const signedRecord = await executionLedger.get(session.executionId)
      expect(signedRecord?.state).toBe('SIGNED')
      expect(signedRecord?.rawSignedTxHex).toBeDefined()
      expect(typeof signedRecord?.rawSignedTxHex).toBe('string')
      expect(signedRecord?.rawSignedTxHex!.length).toBeGreaterThan(100)
    })

    it('single-flight slot is released when session is dismissed', async () => {
      const { engine, record } = setupEngine()
      const receipt = record.humanApproval!

      const session1 = await engine.prepareExecution(receipt)
      session1.dismiss()

      // Slot is released, but duplicate approval check prevents re-preparing same approvalId
      await expect(engine.prepareExecution(receipt)).rejects.toThrow(WalletExecutionError)
    })
  })

  describe('Receipt & Approval Invariants (Negative Tests)', () => {
    it('negative: receipt with status "rejected" fails closed', async () => {
      const { engine, record } = setupEngine()
      const rejectedReceipt: HumanApprovalV1 = {
        ...record.humanApproval!,
        status: 'rejected'
      }

      await expect(engine.prepareExecution(rejectedReceipt)).rejects.toThrow(
        /Only approved receipts are executable/
      )
    })

    it('negative: receipt with status "expired" fails closed', async () => {
      const { engine, record } = setupEngine()
      const expiredReceipt: HumanApprovalV1 = {
        ...record.humanApproval!,
        status: 'expired'
      }

      await expect(engine.prepareExecution(expiredReceipt)).rejects.toThrow(
        /Only approved receipts are executable/
      )
    })

    it('negative: receipt missing from Wallet approval ledger fails closed with APPROVAL_NOT_FOUND', async () => {
      const { engine, record, approvalStore } = setupEngine()
      approvalStore.clear() // remove record

      await expect(engine.prepareExecution(record.humanApproval!)).rejects.toThrow(
        /No recorded approval found/
      )
    })

    it('negative: approval expired in ledger fails closed with APPROVAL_EXPIRED', async () => {
      const { engine, record, setClock } = setupEngine()
      setClock(EXPIRES_AT + 1) // clock advanced past expiration

      await expect(engine.prepareExecution(record.humanApproval!)).rejects.toThrow(
        /Approval expired/
      )
    })

    it('negative: approval expires between preparation and confirmation fails closed', async () => {
      const { engine, record, setClock } = setupEngine()
      const session = await engine.prepareExecution(record.humanApproval!)

      // Time advances past expiration before confirmation
      setClock(EXPIRES_AT + 50)
      await expect(session.confirmExecution()).rejects.toThrow(/Approval expired during review/)
    })

    it('negative: forged contentHash fails closed with APPROVAL_FORGED', async () => {
      const { engine, record } = setupEngine()
      const forgedReceipt: HumanApprovalV1 = {
        ...record.humanApproval!,
        contentHash: 'forged_content_hash_123'
      }

      await expect(engine.prepareExecution(forgedReceipt)).rejects.toThrow(
        /contentHash does not match/
      )
    })

    it('negative: forged presentationHash fails closed with APPROVAL_FORGED', async () => {
      const { engine, record } = setupEngine()
      const forgedReceipt: HumanApprovalV1 = {
        ...record.humanApproval!,
        presentationHash: 'forged_presentation_hash_123'
      }

      await expect(engine.prepareExecution(forgedReceipt)).rejects.toThrow(
        /presentationHash does not match/
      )
    })

    it('negative: approvalId mismatch fails closed with APPROVAL_FIELD_MISMATCH', async () => {
      const { engine, record } = setupEngine()
      const alteredReceipt: HumanApprovalV1 = {
        ...record.humanApproval!,
        approvalId: 'different_approval_id'
      }

      await expect(engine.prepareExecution(alteredReceipt)).rejects.toThrow(
        /approvalId mismatch/
      )
    })

    it('negative: requestId mismatch fails closed with APPROVAL_NOT_FOUND', async () => {
      const { engine, record } = setupEngine()
      const alteredReceipt: HumanApprovalV1 = {
        ...record.humanApproval!,
        requestId: 'different_request_id'
      }

      await expect(engine.prepareExecution(alteredReceipt)).rejects.toThrow(
        /No recorded approval found/
      )
    })

    it('negative: intentId mismatch fails closed with APPROVAL_FIELD_MISMATCH', async () => {
      const { engine, record } = setupEngine()
      const alteredReceipt: HumanApprovalV1 = {
        ...record.humanApproval!,
        intentId: 'different_intent_id'
      }

      await expect(engine.prepareExecution(alteredReceipt)).rejects.toThrow(
        /intentId mismatch/
      )
    })

    it('negative: approver mismatch fails closed with APPROVAL_FIELD_MISMATCH', async () => {
      const { engine, record } = setupEngine()
      const alteredReceipt: HumanApprovalV1 = {
        ...record.humanApproval!,
        approver: ALTERNATE_ADDRESS
      }

      await expect(engine.prepareExecution(alteredReceipt)).rejects.toThrow(
        /approver mismatch/
      )
    })

    it('negative: unsupported network fails closed with OUTPUT_INVARIANT_VIOLATION', async () => {
      const { engine, record } = setupEngine()
      const alteredReceipt: any = {
        ...record.humanApproval!,
        network: 'xec:regtest'
      }

      await expect(engine.prepareExecution(alteredReceipt)).rejects.toThrow(
        /Network "xec:regtest" is not supported/
      )
    })
  })

  describe('Session & Address Security', () => {
    it('negative: unauthenticated session fails closed with SESSION_REVALIDATION_FAILED', async () => {
      const { engine, record } = setupEngine({ authenticated: false })

      await expect(engine.prepareExecution(record.humanApproval!)).rejects.toThrow(
        /Active wallet session unauthenticated/
      )
    })

    it('negative: active address mismatch fails closed with SESSION_ADDRESS_MISMATCH', async () => {
      const { engine, record } = setupEngine({ activeAddress: ALTERNATE_ADDRESS })

      await expect(engine.prepareExecution(record.humanApproval!)).rejects.toThrow(
        /does not match approved fromAddress/
      )
    })

    it('negative: active address changes before confirmation fails closed with SESSION_ADDRESS_MISMATCH', async () => {
      const dynamicVerifier = {
        authenticated: true,
        address: FROM_ADDRESS,
        async verifyActiveSession() {
          return { authenticated: this.authenticated, activeAddress: this.address }
        }
      }
      const setup = setupEngine()
      const customEngine = createAgentWalletExecutionEngine({
        approvalLedger: setup.approvalStore as any,
        executionLedger: setup.executionLedger,
        sessionVerifier: dynamicVerifier,
        utxoProvider: setup.utxoProvider,
        signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
        clock: () => FIXED_NOW + 20
      })

      const sess = await customEngine.prepareExecution(setup.record.humanApproval!)

      // Switch active address
      dynamicVerifier.address = ALTERNATE_ADDRESS
      await expect(sess.confirmExecution()).rejects.toThrow(
        /Session address changed to/
      )
    })
  })

  describe('Output & Arithmetic Invariants (Anti-TOCTOU)', () => {
    it('invariant: payment destination exactly equals approved destination', () => {
      const plan = buildPreparedExecutionPlan({
        approved: {
          approvalId: 'appr_1',
          requestId: 'req_1',
          intentId: 'int_1',
          fromAddress: FROM_ADDRESS,
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n
        },
        availableUtxos: createFixtureUtxos()
      })

      expect(() => {
        validateOutputInvariants(plan, {
          destination: ALTERNATE_ADDRESS, // mismatch
          amountSats: 100_000n,
          fromAddress: FROM_ADDRESS,
          network: 'xec:mainnet'
        })
      }).toThrow(/Payment destination mismatch/)
    })

    it('invariant: payment amount exactly equals approved amount (+1 sat fails closed)', () => {
      const plan = buildPreparedExecutionPlan({
        approved: {
          approvalId: 'appr_1',
          requestId: 'req_1',
          intentId: 'int_1',
          fromAddress: FROM_ADDRESS,
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n
        },
        availableUtxos: createFixtureUtxos()
      })

      expect(() => {
        validateOutputInvariants(plan, {
          destination: DESTINATION_ADDRESS,
          amountSats: 100_001n, // +1 sat
          fromAddress: FROM_ADDRESS,
          network: 'xec:mainnet'
        })
      }).toThrow(/Payment amount mismatch/)
    })

    it('invariant: payment amount exactly equals approved amount (-1 sat fails closed)', () => {
      const plan = buildPreparedExecutionPlan({
        approved: {
          approvalId: 'appr_1',
          requestId: 'req_1',
          intentId: 'int_1',
          fromAddress: FROM_ADDRESS,
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n
        },
        availableUtxos: createFixtureUtxos()
      })

      expect(() => {
        validateOutputInvariants(plan, {
          destination: DESTINATION_ADDRESS,
          amountSats: 99_999n, // -1 sat
          fromAddress: FROM_ADDRESS,
          network: 'xec:mainnet'
        })
      }).toThrow(/Payment amount mismatch/)
    })

    it('invariant: change output must return ONLY to wallet-controlled address', () => {
      const plan = buildPreparedExecutionPlan({
        approved: {
          approvalId: 'appr_1',
          requestId: 'req_1',
          intentId: 'int_1',
          fromAddress: FROM_ADDRESS,
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n
        },
        availableUtxos: createFixtureUtxos()
      })

      const attackerPlan = {
        ...plan,
        changeAddress: ALTERNATE_ADDRESS,
        outputs: [
          plan.outputs[0],
          {
            ...plan.outputs[1],
            destination: ALTERNATE_ADDRESS
          }
        ]
      }

      expect(() => {
        validateOutputInvariants(attackerPlan as any, {
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n,
          fromAddress: FROM_ADDRESS,
          network: 'xec:mainnet'
        })
      }).toThrow(/Change output violation/)
    })

    it('invariant: unexpected OP_RETURN output fails closed', () => {
      const plan = buildPreparedExecutionPlan({
        approved: {
          approvalId: 'appr_1',
          requestId: 'req_1',
          intentId: 'int_1',
          fromAddress: FROM_ADDRESS,
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n
        },
        availableUtxos: createFixtureUtxos()
      })

      const tamperedPlan = {
        ...plan,
        outputs: [
          plan.outputs[0],
          {
            index: 1,
            destination: FROM_ADDRESS,
            scriptHex: '6a0474657374', // OP_RETURN "test"
            sats: plan.changeAmountSats,
            isChange: true
          }
        ]
      }

      expect(() => {
        validateOutputInvariants(tamperedPlan as any, {
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n,
          fromAddress: FROM_ADDRESS,
          network: 'xec:mainnet'
        })
      }).toThrow(/Unexpected OP_RETURN output detected/)
    })

    it('invariant: token output / NFT script injection fails closed', () => {
      const plan = buildPreparedExecutionPlan({
        approved: {
          approvalId: 'appr_1',
          requestId: 'req_1',
          intentId: 'int_1',
          fromAddress: FROM_ADDRESS,
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n
        },
        availableUtxos: createFixtureUtxos()
      })

      const tamperedPlan = {
        ...plan,
        outputs: [
          {
            index: 0,
            destination: DESTINATION_ADDRESS,
            scriptHex: '544f4b454e', // Arbitrary non-P2PKH script
            sats: 100_000n,
            isChange: false
          },
          plan.outputs[1]
        ]
      }

      expect(() => {
        validateOutputInvariants(tamperedPlan as any, {
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n,
          fromAddress: FROM_ADDRESS,
          network: 'xec:mainnet'
        })
      }).toThrow(/Non-standard output script detected/)
    })

    it('invariant: exact conservation of satoshis: sum(inputs) = payment + change + fee', () => {
      const plan = buildPreparedExecutionPlan({
        approved: {
          approvalId: 'appr_1',
          requestId: 'req_1',
          intentId: 'int_1',
          fromAddress: FROM_ADDRESS,
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n
        },
        availableUtxos: createFixtureUtxos(500_000n)
      })

      const tamperedPlan = {
        ...plan,
        changeAmountSats: plan.changeAmountSats - 100n,
        outputs: [
          plan.outputs[0],
          {
            ...plan.outputs[1],
            sats: plan.changeAmountSats - 100n
          }
        ]
      }

      expect(() => {
        validateOutputInvariants(tamperedPlan as any, {
          destination: DESTINATION_ADDRESS,
          amountSats: 100_000n,
          fromAddress: FROM_ADDRESS,
          network: 'xec:mainnet'
        })
      }).toThrow(/Exact satoshi balance violation/)
    })
  })

  describe('Fee Security Policy', () => {
    it('rejects negative fee', () => {
      expect(() => assertFeePolicy(-1n, 200, DEFAULT_FEE_POLICY)).toThrow(
        /Transaction fee cannot be negative/
      )
    })

    it('rejects fee exceeding maxAbsoluteFeeSats', () => {
      expect(() => assertFeePolicy(50_001n, 200, DEFAULT_FEE_POLICY)).toThrow(
        /exceeds maximum allowed fee/
      )
    })

    it('rejects fee rate below minimum policy', () => {
      expect(() => assertFeePolicy(100n, 200, DEFAULT_FEE_POLICY)).toThrow(
        /is below policy minimum/
      )
    })

    it('rejects fee rate above maximum policy', () => {
      expect(() => assertFeePolicy(2_000n, 200, DEFAULT_FEE_POLICY)).toThrow(
        /exceeds policy maximum/
      )
    })
  })

  describe('Pre-Signing UTXO Revalidation (Anti-TOCTOU)', () => {
    it('fails closed when selected UTXO is spent before confirmation', async () => {
      const { engine, record, utxos } = setupEngine()
      const session = await engine.prepareExecution(record.humanApproval!)

      // Simulate UTXO spent by external wallet activity
      utxos.length = 0 // clear spendable UTXOs

      await expect(session.confirmExecution()).rejects.toThrow(
        /Selected input .* is no longer spendable/
      )
    })
  })

  describe('Concurrency & At-Most-Once Execution', () => {
    it('duplicate prepareExecution call with same approvalId fails closed', async () => {
      const { engine, record } = setupEngine()
      const session = await engine.prepareExecution(record.humanApproval!)
      session.dismiss()

      await expect(engine.prepareExecution(record.humanApproval!)).rejects.toThrow(
        /Execution already initiated/
      )
    })

    it('concurrent prepareExecution calls while review is active reject the second with CONCURRENT_EXECUTION_ACTIVE', async () => {
      const { engine, record } = setupEngine()
      const secondRecord = createFixtureLedgerRecord({
        approvalId: 'appr_diff',
        requestId: 'req_diff',
        humanApproval: {
          ...record.humanApproval!,
          approvalId: 'appr_diff',
          requestId: 'req_diff'
        }
      })
      const { approvalStore } = setupEngine()
      // Setup engine with both records
      const setup = setupEngine()
      setup.approvalStore.set(record.requestId, record)
      setup.approvalStore.set(secondRecord.requestId, secondRecord)

      // Start first review
      await setup.engine.prepareExecution(record.humanApproval!)

      // Try to start second review concurrently
      await expect(setup.engine.prepareExecution(secondRecord.humanApproval!)).rejects.toThrow(
        /An execution review session is already active/
      )
    })

    it('double click on confirmExecution: first succeeds, second fails closed with DUPLICATE_EXECUTION', async () => {
      const { engine, record } = setupEngine()
      const session = await engine.prepareExecution(record.humanApproval!)

      const handle1 = await session.confirmExecution()
      expect(handle1.status).toBe('SIGNED')

      // Second click on same session
      await expect(session.confirmExecution()).rejects.toThrow(
        /Execution capability has already been consumed/
      )
    })

    it('truly concurrent calls to confirmExecution: exactly one succeeds', async () => {
      const { engine, record } = setupEngine()
      const session = await engine.prepareExecution(record.humanApproval!)

      const results = await Promise.allSettled([
        session.confirmExecution(),
        session.confirmExecution()
      ])

      const fulfilled = results.filter(r => r.status === 'fulfilled')
      const rejected = results.filter(r => r.status === 'rejected')

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
    })

    it('rejectExecution transitions record to REJECTED in ledger', async () => {
      const { engine, record, executionLedger } = setupEngine()
      const session = await engine.prepareExecution(record.humanApproval!)

      await session.rejectExecution('User cancelled')

      const rec = await executionLedger.get(session.executionId)
      expect(rec?.state).toBe('REJECTED')
      expect(rec?.uncertainReason).toBe('User cancelled')
    })
  })

  describe('Crash Consistency (SIGNING_UNCERTAIN)', () => {
    it('failure during signing marks ledger state as SIGNING_UNCERTAIN and prevents automated retry', async () => {
      const { record, executionLedger, approvalStore, utxoProvider, sessionVerifier } = setupEngine()

      // Provider throws during sign
      const failingSigner = {
        async getSignatory() {
          throw new Error('Hardware token communication timeout during signing')
        }
      }

      const engine = createAgentWalletExecutionEngine({
        approvalLedger: { get: async (id: string) => approvalStore.get(id) },
        executionLedger,
        sessionVerifier,
        utxoProvider,
        signatoryProvider: failingSigner,
        clock: () => FIXED_NOW + 20,
        idGenerator: () => 'test_id_crash'
      })

      const session = await engine.prepareExecution(record.humanApproval!)

      await expect(session.confirmExecution()).rejects.toThrow(
        /Execution marked SIGNING_UNCERTAIN to prevent automated duplicate signing/
      )

      // Verify execution record state in ledger
      const crashedRecord = await executionLedger.get(session.executionId)
      expect(crashedRecord?.state).toBe('SIGNING_UNCERTAIN')
      expect(crashedRecord?.uncertainReason).toContain('Hardware token communication timeout')

      // Attempting to retry confirmExecution must fail closed
      await expect(session.confirmExecution()).rejects.toThrow(
        /Cannot execute signing from record state "SIGNING_UNCERTAIN"/
      )

      // Attempting to re-prepare with same receipt must fail closed
      await expect(engine.prepareExecution(record.humanApproval!)).rejects.toThrow(
        /Execution already initiated/
      )
    })
  })
})
