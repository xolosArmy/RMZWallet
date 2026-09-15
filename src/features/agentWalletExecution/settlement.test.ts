/**
 * @file settlement.test.ts
 *
 * CANONICAL TEST SUITE FOR GATE C3A (RMZWallet Settlement Engine)
 *
 * Verifies:
 * 1. Successful settlement end-to-end: SIGNED -> SETTLING -> broadcast -> tx query -> SETTLED + receipt
 * 2. Local TXID derivation matches ecash-lib and canonical format
 * 3. Chronik TXID mismatch fails closed and marks SETTLEMENT_UNCERTAIN
 * 4. Idempotent replay on already-settled execution returns receipt with 0 broadcast calls
 * 5. Concurrent settlement attempts: fenced by Web Lock, exactly one broadcast
 * 6. Definitive consensus rejection transitions to SETTLEMENT_REJECTED
 * 7. Network timeout / transport error transitions to SETTLEMENT_UNCERTAIN (retains outpoints)
 * 8. Startup recovery reconciles abandoned SETTLING record without rebroadcast
 * 9. Calling settle on non-SIGNED state throws INVALID_SETTLEMENT_STATE
 * 10. Private settlement storage absence throws STORAGE_UNAVAILABLE
 * 11. Coordination absence fails closed
 * 12. Consensus rejection discriminator tests
 * 13. Architectural boundary invariants (zero raw signed tx in publicEngine / receipt)
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_BIP143, Ecc, P2PKHSignatory, Tx } from 'ecash-lib'
import { humanApprovalV1Schema, type HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import type { WalletApprovalLedgerRecord } from '../agentWalletApprovalReceiver/types'
import '../../internal/agentWalletExecutionHost/trustedWalletExecutionRuntime'
import type { WalletExecutionComposition } from '../../internal/agentWalletExecutionHost'
import type {
  AgentWalletExecutionEngineConfig,
  ChronikBroadcastClient,
  ExecutionUtxoInput,
  WalletExecutionTrustedOptions,
  WalletExecutionLedger
} from './types'
import {
  deriveExpectedTxidFromRawTxHex,
  isDefinitiveConsensusRejection
} from './settlementUtils'
import {
  canonicalOutpointKey,
  DEFAULT_EXECUTION_LEDGER_STORAGE_KEY,
  DurableTransactionalExecutionLedger,
  executionSettlementLockName,
  WebLocksExecutionCoordinator,
  type ExecutionLockCoordinator
} from './ledger'
import { DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY } from '../../internal/settlementStore'
import { MockStorage, TestExecutionLockCoordinator } from './testUtils'
import { WalletExecutionError } from './errors'

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

const FROM_ADDRESS = 'ecash:qpumqqygwcnt999fz3gp5nxjy66ckg6esvxaqmtclv'
const DESTINATION_ADDRESS = 'ecash:qr4upmst92u7sfm6vqxz29r4ug4rysdpcyk8hcgvqm'
const FROM_SCRIPT_HEX = '76a91479b000887626b294a914501a4cd226b58b23598388ac'

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

function createFixtureLedgerRecord(
  overrides: Partial<WalletApprovalLedgerRecord> = {}
): WalletApprovalLedgerRecord {
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

interface TestHarness {
  composition: WalletExecutionComposition
  ledgerStorage: Storage
  settlementStorage: Storage
  lockCoordinator: TestExecutionLockCoordinator
  mockChronik: ChronikBroadcastClient & {
    broadcastCalls: Uint8Array[]
    txCalls: string[]
  }
  signExecution: (record?: WalletApprovalLedgerRecord) => Promise<{
    executionId: string
    expectedTxid: string
  }>
}

function seedSettlingState(
  storage: Storage,
  executionId: string,
  expectedTxid: string,
  settlingAt: number = FIXED_NOW
): void {
  const raw = storage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)
  const data = JSON.parse(raw!)
  data.records[executionId] = {
    ...data.records[executionId],
    state: 'SETTLING',
    expectedTxid: expectedTxid.toLowerCase(),
    settlingAt,
    settlementAttempt: (data.records[executionId]?.settlementAttempt ?? 0) + 1
  }
  storage.setItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY, JSON.stringify(data))
}

function setupTestHarness(options: {
  chronikOverride?: Partial<ChronikBroadcastClient>
} = {}): TestHarness {
  const ledgerStorage = new MockStorage()
  const settlementStorage = new MockStorage()
  const lockCoordinator = new TestExecutionLockCoordinator()

  const broadcastCalls: Uint8Array[] = []
  const txCalls: string[] = []

  let broadcastImpl: (rawTx: Uint8Array) => Promise<{ txid?: string }> = async rawTx => {
    broadcastCalls.push(rawTx)
    const tx = Tx.fromHex(Buffer.from(rawTx).toString('hex'))
    const txid = tx.txid().toLowerCase()
    return { txid }
  }

  let txImpl: ChronikBroadcastClient['tx'] = async txid => {
    txCalls.push(txid)
    return { txid }
  }

  if (options.chronikOverride?.broadcastTx) {
    const customBroadcast = options.chronikOverride.broadcastTx
    broadcastImpl = async rawTx => {
      broadcastCalls.push(rawTx)
      return customBroadcast(rawTx)
    }
  }

  if (options.chronikOverride?.tx) {
    const customTx = options.chronikOverride.tx
    txImpl = async txid => {
      txCalls.push(txid)
      return customTx(txid)
    }
  }

  const mockChronik: ChronikBroadcastClient & {
    broadcastCalls: Uint8Array[]
    txCalls: string[]
  } = {
    broadcastTx: broadcastImpl,
    tx: txImpl,
    broadcastCalls,
    txCalls
  }

  const { signatory } = createSyntheticSignatory()
  const defaultRecord = createFixtureLedgerRecord()

  const approvalMap = new Map<string, WalletApprovalLedgerRecord>()
  approvalMap.set(defaultRecord.requestId, defaultRecord)

  ;(globalThis as Record<symbol, unknown>)[
    Symbol.for('rmzwallet.testOnly.settlementChronikClient')
  ] = mockChronik
  ;(globalThis as Record<symbol, unknown>)[
    Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
  ] = lockCoordinator

  const config: AgentWalletExecutionEngineConfig = {
    approvalLedger: {
      get: async (reqId: string) => approvalMap.get(reqId),
      getByApprovalId: async (apprId: string) =>
        Array.from(approvalMap.values()).find(r => r.approvalId === apprId)
    },
    sessionVerifier: {
      verifyActiveSession: async () => ({
        authenticated: true,
        activeAddress: FROM_ADDRESS
      })
    },
    utxoProvider: {
      getSpendableUtxos: async () => createFixtureUtxos()
    },
    signatoryProvider: {
      getSignatory: () => signatory
    },
    storage: ledgerStorage,
    lockCoordinator,
    clock: () => FIXED_NOW,
    idGenerator: () => 'exec_test_c3a'
  }

  const composition = createWalletExecutionComposition(config, {
    executionStorage: ledgerStorage,
    privateSettlementStorage: settlementStorage
  })

  const signExecution = async (customRecord?: WalletApprovalLedgerRecord) => {
    const rec = customRecord ?? defaultRecord
    approvalMap.set(rec.requestId, rec)

    const session = await composition.publicEngine.prepareExecution(rec.humanApproval!)
    const controller = composition.walletUIHost.getActiveController()
    if (!controller) throw new Error('No active controller')
    const handle = await controller.confirm()
    expect(handle.status).toBe('SIGNED')

    // Read expectedTxid from private settlement partition to know what it is
    const rawStore = settlementStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
    const parsed = JSON.parse(rawStore!)
    const rawTxHex = parsed[session.executionId]
    const expectedTxid = deriveExpectedTxidFromRawTxHex(rawTxHex)

    return { executionId: session.executionId, expectedTxid }
  }

  return {
    composition,
    ledgerStorage,
    settlementStorage,
    lockCoordinator,
    mockChronik,
    signExecution
  }
}

describe('Gate C3A — RMZWallet Settlement Engine', () => {
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for('rmzwallet.testOnly.settlementChronikClient')
    ]
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
    ]
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for('rmzwallet.testOnly.privateSettlementStorage')
    ]
  })

  describe('Test 1: Successful Settlement End-to-End', () => {
    it('transitions SIGNED -> SETTLING -> broadcast -> tx query -> SETTLED and returns immutable receipt', async () => {
      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      // Prior to settlement, status is SIGNED
      const preStatus = await harness.composition.publicEngine.getExecutionStatus(executionId)
      expect(preStatus?.status).toBe('SIGNED')
      expect(preStatus?.settlingAt).toBeUndefined()
      expect(preStatus?.settledAt).toBeUndefined()

      // Perform settlement
      const receipt = await harness.composition.publicEngine.settle(executionId)

      // Verify returned receipt
      expect(receipt.status).toBe('settled')
      expect(receipt.executionId).toBe(executionId)
      expect(receipt.approvalId).toBe('appr_456')
      expect(receipt.requestId).toBe('req_123')
      expect(receipt.network).toBe('xec:mainnet')
      expect(receipt.txid).toBe(expectedTxid)
      expect(receipt.settledAt).toBe(FIXED_NOW)

      // Verify Chronik was invoked exactly once for broadcast
      expect(harness.mockChronik.broadcastCalls).toHaveLength(1)
      expect(harness.mockChronik.txCalls).toContain(expectedTxid)

      // Verify durable ledger status
      const postStatus = await harness.composition.publicEngine.getExecutionStatus(executionId)
      expect(postStatus?.status).toBe('SETTLED')
      expect(postStatus?.expectedTxid).toBe(expectedTxid)
      expect(postStatus?.settlingAt).toBe(FIXED_NOW)
      expect(postStatus?.settledAt).toBe(FIXED_NOW)

      // Outpoint reservations remain retained in SETTLED (not automatically freed)
      const ledger = new DurableTransactionalExecutionLedger({
        storage: harness.ledgerStorage,
        lockCoordinator: harness.lockCoordinator,
        clock: () => FIXED_NOW
      })
      const outpoint = canonicalOutpointKey('11'.repeat(32), 0)
      expect(await ledger.getOutpointReservation(outpoint)).toBe(executionId)

      harness.composition.dispose()
    })
  })

  describe('Test 2: Local TXID Derivation', () => {
    it('correctly derives canonical 64-char lowercase TXID from raw transaction hex', async () => {
      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      const rawStore = harness.settlementStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
      const rawHex = JSON.parse(rawStore!)[executionId]

      const derivedTxid = deriveExpectedTxidFromRawTxHex(rawHex)
      expect(derivedTxid).toBe(expectedTxid)
      expect(derivedTxid).toMatch(/^[0-9a-f]{64}$/)

      // Verify error on invalid input
      expect(() => deriveExpectedTxidFromRawTxHex('')).toThrow(WalletExecutionError)
      expect(() => deriveExpectedTxidFromRawTxHex('not-hex')).toThrow(WalletExecutionError)
      expect(() => deriveExpectedTxidFromRawTxHex('123')).toThrow(WalletExecutionError) // odd length
      expect(() => deriveExpectedTxidFromRawTxHex('deadbeef')).toThrow(WalletExecutionError) // invalid tx

      harness.composition.dispose()
    })
  })

  describe('Test 3: Chronik TXID Mismatch', () => {
    it('fails closed and marks SETTLEMENT_UNCERTAIN when returned txid does not match expected txid', async () => {
      const harness = setupTestHarness({
        chronikOverride: {
          broadcastTx: async () => ({
            txid: '99'.repeat(32) // Mismatched TXID
          })
        }
      })
      const { executionId } = await harness.signExecution()

      await expect(harness.composition.publicEngine.settle(executionId)).rejects.toThrow(
        /does not match locally derived expected txid/
      )

      const status = await harness.composition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLEMENT_UNCERTAIN')
      expect(status?.uncertainReason).toContain('does not match locally derived')

      harness.composition.dispose()
    })
  })

  describe('Test 4: Idempotent Replay on Already-Settled Execution', () => {
    it('returns receipt immediately with 0 additional broadcasts when called multiple times', async () => {
      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      const receipt1 = await harness.composition.publicEngine.settle(executionId)
      expect(receipt1.status).toBe('settled')
      expect(harness.mockChronik.broadcastCalls).toHaveLength(1)

      // Second call: idempotent replay
      const receipt2 = await harness.composition.publicEngine.settle(executionId)
      expect(receipt2.status).toBe('settled')
      expect(receipt2.txid).toBe(expectedTxid)
      // Broadcast count MUST remain 1 (zero rebroadcast)
      expect(harness.mockChronik.broadcastCalls).toHaveLength(1)

      harness.composition.dispose()
    })
  })

  describe('Test 5: Concurrent Settlement Attempts Fencing', () => {
    it('fences concurrent settle calls: second caller waits for lock and does not rebroadcast', async () => {
      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      // Launch two concurrent settlement calls
      const [r1, r2] = await Promise.all([
        harness.composition.publicEngine.settle(executionId),
        harness.composition.publicEngine.settle(executionId)
      ])

      expect(r1.txid).toBe(expectedTxid)
      expect(r2.txid).toBe(expectedTxid)
      expect(r1.status).toBe('settled')
      expect(r2.status).toBe('settled')

      // Exactly ONE broadcast occurred
      expect(harness.mockChronik.broadcastCalls).toHaveLength(1)

      harness.composition.dispose()
    })
  })

  describe('Test 6: Definitive Consensus Rejection vs Ambiguous Failures', () => {
    it('transitions to SETTLEMENT_REJECTED on structured definitive consensus rejection and releases outpoints', async () => {
      const consensusError = Object.assign(
        new Error('Consensus rule violated: transaction script failed verify'),
        { isDefinitiveConsensusRejection: true }
      )
      const harness = setupTestHarness({
        chronikOverride: {
          broadcastTx: async () => {
            throw consensusError
          },
          tx: async () => {
            throw new Error('Not found')
          }
        }
      })
      const { executionId } = await harness.signExecution()

      await expect(harness.composition.publicEngine.settle(executionId)).rejects.toThrow(
        /Settlement rejected by network consensus/
      )

      const status = await harness.composition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLEMENT_REJECTED')
      expect(status?.uncertainReason).toContain('Consensus rule violated')

      // Outpoint reservations MUST be released on definitive rejection
      const ledger = new DurableTransactionalExecutionLedger({
        storage: harness.ledgerStorage,
        lockCoordinator: harness.lockCoordinator,
        clock: () => FIXED_NOW
      })
      const outpoint = canonicalOutpointKey('11'.repeat(32), 0)
      expect(await ledger.getOutpointReservation(outpoint)).toBeUndefined()

      harness.composition.dispose()
    })

    it('defaults txn-mempool-conflict to SETTLEMENT_UNCERTAIN and retains outpoint reservations', async () => {
      const harness = setupTestHarness({
        chronikOverride: {
          broadcastTx: async () => {
            throw new Error('txn-mempool-conflict: txn conflicts with existing txn')
          },
          tx: async () => {
            throw new Error('Not found')
          }
        }
      })
      const { executionId } = await harness.signExecution()

      await expect(harness.composition.publicEngine.settle(executionId)).rejects.toThrow(
        /SETTLEMENT_UNCERTAIN/
      )

      const status = await harness.composition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLEMENT_UNCERTAIN')
      expect(status?.uncertainReason).toContain('txn-mempool-conflict')

      // Outpoints MUST be retained!
      const ledger = new DurableTransactionalExecutionLedger({
        storage: harness.ledgerStorage,
        lockCoordinator: harness.lockCoordinator,
        clock: () => FIXED_NOW
      })
      const outpoint = canonicalOutpointKey('11'.repeat(32), 0)
      expect(await ledger.getOutpointReservation(outpoint)).toBe(executionId)

      harness.composition.dispose()
    })

    it('defaults bad-txns-inputs-missingorspent to SETTLEMENT_UNCERTAIN and retains outpoint reservations', async () => {
      const harness = setupTestHarness({
        chronikOverride: {
          broadcastTx: async () => {
            throw new Error('bad-txns-inputs-missingorspent')
          },
          tx: async () => {
            throw new Error('Not found')
          }
        }
      })
      const { executionId } = await harness.signExecution()

      await expect(harness.composition.publicEngine.settle(executionId)).rejects.toThrow(
        /SETTLEMENT_UNCERTAIN/
      )

      const status = await harness.composition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLEMENT_UNCERTAIN')
      expect(status?.uncertainReason).toContain('bad-txns-inputs-missingorspent')

      // Outpoints MUST be retained!
      const ledger = new DurableTransactionalExecutionLedger({
        storage: harness.ledgerStorage,
        lockCoordinator: harness.lockCoordinator,
        clock: () => FIXED_NOW
      })
      const outpoint = canonicalOutpointKey('11'.repeat(32), 0)
      expect(await ledger.getOutpointReservation(outpoint)).toBe(executionId)

      harness.composition.dispose()
    })

    it('defaults non-mandatory-script-verify-flag-failed to SETTLEMENT_UNCERTAIN and retains outpoint reservations', async () => {
      const harness = setupTestHarness({
        chronikOverride: {
          broadcastTx: async () => {
            throw new Error(
              'non-mandatory-script-verify-flag-failed (Signature must be zero for failed CHECK(MULTI)SIG operation)'
            )
          },
          tx: async () => {
            throw new Error('Not found')
          }
        }
      })
      const { executionId } = await harness.signExecution()

      await expect(harness.composition.publicEngine.settle(executionId)).rejects.toThrow(
        /SETTLEMENT_UNCERTAIN/
      )

      const status = await harness.composition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLEMENT_UNCERTAIN')
      expect(status?.uncertainReason).toContain('non-mandatory-script-verify-flag-failed')

      // Outpoints MUST be retained!
      const ledger = new DurableTransactionalExecutionLedger({
        storage: harness.ledgerStorage,
        lockCoordinator: harness.lockCoordinator,
        clock: () => FIXED_NOW
      })
      const outpoint = canonicalOutpointKey('11'.repeat(32), 0)
      expect(await ledger.getOutpointReservation(outpoint)).toBe(executionId)

      harness.composition.dispose()
    })
  })

  describe('Test 7: Network Timeout / Transport Error', () => {
    it('transitions to SETTLEMENT_UNCERTAIN and retains outpoint reservations', async () => {
      const harness = setupTestHarness({
        chronikOverride: {
          broadcastTx: async () => {
            throw new Error('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8332')
          },
          tx: async () => {
            throw new Error('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:8332')
          }
        }
      })
      const { executionId } = await harness.signExecution()

      await expect(harness.composition.publicEngine.settle(executionId)).rejects.toThrow(
        /Settlement broadcast outcome uncertain/
      )

      const status = await harness.composition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLEMENT_UNCERTAIN')
      expect(status?.uncertainReason).toContain('ECONNREFUSED')

      // Outpoint reservations MUST NOT be released
      const ledger = new DurableTransactionalExecutionLedger({
        storage: harness.ledgerStorage,
        lockCoordinator: harness.lockCoordinator,
        clock: () => FIXED_NOW
      })
      const outpoint = canonicalOutpointKey('11'.repeat(32), 0)
      expect(await ledger.getOutpointReservation(outpoint)).toBe(executionId)

      harness.composition.dispose()
    })
  })

  describe('Test 8: Startup Recovery Reconciles Abandoned SETTLING Record', () => {
    it('automatically transitions SETTLING to SETTLED upon runtime initialization without calling settle() when observable by Chronik', async () => {
      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      // Transition to SETTLING manually to simulate an interrupted broadcast
      seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
      harness.composition.dispose()

      // Chronik observer sees the transaction
      const broadcastCalls: Uint8Array[] = []
      const recoveredChronik: ChronikBroadcastClient = {
        broadcastTx: async rawTx => {
          broadcastCalls.push(rawTx)
          return { txid: expectedTxid }
        },
        tx: async txid => ({ txid })
      }
      ;(globalThis as Record<symbol, unknown>)[
        Symbol.for('rmzwallet.testOnly.settlementChronikClient')
      ] = recoveredChronik

      const rec = createFixtureLedgerRecord()
      const recoveredComposition = createWalletExecutionComposition(
        {
          approvalLedger: {
            get: async () => rec,
            getByApprovalId: async () => rec
          },
          sessionVerifier: {
            verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS })
          },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        },
        {
          privateSettlementStorage: harness.settlementStorage
        }
      )

      // Query getExecutionStatus WITHOUT calling publicEngine.settle()
      const status = await recoveredComposition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLED')
      expect(status?.settledAt).toBe(FIXED_NOW + 100)

      // Verify directly in durable storage that state became SETTLED
      const checkLedger = new DurableTransactionalExecutionLedger({
        storage: harness.ledgerStorage,
        lockCoordinator: harness.lockCoordinator,
        clock: () => FIXED_NOW + 100
      })
      const durableRecord = await checkLedger.get(executionId)
      expect(durableRecord?.status).toBe('SETTLED')
      expect(durableRecord?.settledAt).toBe(FIXED_NOW + 100)

      // Rebroadcast MUST be 0!
      expect(broadcastCalls).toHaveLength(0)

      recoveredComposition.dispose()
    })

    it('automatically transitions SETTLING to SETTLEMENT_UNCERTAIN upon runtime initialization without calling settle() when unobservable by Chronik', async () => {
      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      // Transition to SETTLING manually to simulate an interrupted broadcast
      seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
      harness.composition.dispose()

      // Chronik tx query throws not found
      const broadcastCalls: Uint8Array[] = []
      const recoveredChronik: ChronikBroadcastClient = {
        broadcastTx: async rawTx => {
          broadcastCalls.push(rawTx)
          return { txid: expectedTxid }
        },
        tx: async () => {
          throw new Error('Not found')
        }
      }
      ;(globalThis as Record<symbol, unknown>)[
        Symbol.for('rmzwallet.testOnly.settlementChronikClient')
      ] = recoveredChronik

      const rec = createFixtureLedgerRecord()
      const recoveredComposition = createWalletExecutionComposition(
        {
          approvalLedger: {
            get: async () => rec,
            getByApprovalId: async () => rec
          },
          sessionVerifier: {
            verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS })
          },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        },
        {
          privateSettlementStorage: harness.settlementStorage
        }
      )

      // Query getExecutionStatus WITHOUT calling publicEngine.settle()
      const status = await recoveredComposition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLEMENT_UNCERTAIN')

      // Verify directly in durable storage that state became SETTLEMENT_UNCERTAIN
      const checkLedger = new DurableTransactionalExecutionLedger({
        storage: harness.ledgerStorage,
        lockCoordinator: harness.lockCoordinator,
        clock: () => FIXED_NOW + 100
      })
      const durableRecord = await checkLedger.get(executionId)
      expect(durableRecord?.status).toBe('SETTLEMENT_UNCERTAIN')

      // Outpoints MUST be retained while uncertain
      const outpoint = canonicalOutpointKey('11'.repeat(32), 0)
      expect(await checkLedger.getOutpointReservation(outpoint)).toBe(executionId)

      // Zero rebroadcast!
      expect(broadcastCalls).toHaveLength(0)

      recoveredComposition.dispose()
    })

    it('queries network first and marks SETTLED if observed, with 0 rebroadcast', async () => {
      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      // Transition to SETTLING manually to simulate a crash during settlement
      seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
      harness.composition.dispose()

      // Re-instantiate engine on same storage with mock Chronik that sees the tx in mempool
      const broadcastCalls: Uint8Array[] = []
      const recoveredChronik: ChronikBroadcastClient = {
        broadcastTx: async rawTx => {
          broadcastCalls.push(rawTx)
          return { txid: expectedTxid }
        },
        tx: async txid => ({ txid })
      }
      ;(globalThis as Record<symbol, unknown>)[
        Symbol.for('rmzwallet.testOnly.settlementChronikClient')
      ] = recoveredChronik

      const rec = createFixtureLedgerRecord()
      const recoveredComposition = createWalletExecutionComposition(
        {
          approvalLedger: {
            get: async () => rec,
            getByApprovalId: async () => rec
          },
          sessionVerifier: {
            verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS })
          },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        },
        {
          privateSettlementStorage: harness.settlementStorage
        }
      )

      // Settle should reconcile from network
      const receipt = await recoveredComposition.publicEngine.settle(executionId)
      expect(receipt.status).toBe('settled')
      expect(receipt.txid).toBe(expectedTxid)

      // Rebroadcast MUST be 0!
      expect(broadcastCalls).toHaveLength(0)

      recoveredComposition.dispose()
    })

    it('queries network and marks SETTLEMENT_UNCERTAIN if not observed, with 0 rebroadcast', async () => {
      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      // Transition to SETTLING to simulate an interrupted broadcast
      seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
      harness.composition.dispose()

      // Chronik tx query throws not found
      const broadcastCalls: Uint8Array[] = []
      const recoveredChronik: ChronikBroadcastClient = {
        broadcastTx: async rawTx => {
          broadcastCalls.push(rawTx)
          return { txid: expectedTxid }
        },
        tx: async () => {
          throw new Error('Not found')
        }
      }
      ;(globalThis as Record<symbol, unknown>)[
        Symbol.for('rmzwallet.testOnly.settlementChronikClient')
      ] = recoveredChronik

      const rec = createFixtureLedgerRecord()
      const recoveredComposition = createWalletExecutionComposition(
        {
          approvalLedger: {
            get: async () => rec,
            getByApprovalId: async () => rec
          },
          sessionVerifier: {
            verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS })
          },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        },
        {
          privateSettlementStorage: harness.settlementStorage
        }
      )

      // Settle should fail closed with SETTLEMENT_UNCERTAIN
      await expect(recoveredComposition.publicEngine.settle(executionId)).rejects.toThrow(
        /SETTLEMENT_UNCERTAIN/
      )

      // Zero rebroadcast!
      expect(broadcastCalls).toHaveLength(0)

      const status = await recoveredComposition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLEMENT_UNCERTAIN')

      recoveredComposition.dispose()
    })
  })

  describe('Test 9: Invalid Settlement State', () => {
    it('throws INVALID_SETTLEMENT_STATE when calling settle on non-SIGNED state', async () => {
      const harness = setupTestHarness()
      const rec = createFixtureLedgerRecord()

      const session = await harness.composition.publicEngine.prepareExecution(rec.humanApproval!)
      // Currently PREPARED, not SIGNED
      await expect(
        harness.composition.publicEngine.settle(session.executionId)
      ).rejects.toThrow(/Execution must be in SIGNED state/)

      harness.composition.dispose()
    })

    it('throws EXECUTION_NOT_FOUND when execution does not exist', async () => {
      const harness = setupTestHarness()
      await expect(
        harness.composition.publicEngine.settle('non_existent_id')
      ).rejects.toThrow(/not found/)
      harness.composition.dispose()
    })
  })

  describe('Test 10: Private Settlement Storage Absence', () => {
    it('throws STORAGE_UNAVAILABLE when private settlement storage is missing', async () => {
      const harness = setupTestHarness()
      const { executionId } = await harness.signExecution()
      harness.composition.dispose()

      const rec = createFixtureLedgerRecord()
      // Composition created WITHOUT privateSettlementStorage
      const badComposition = createWalletExecutionComposition(
        {
          approvalLedger: { get: async () => rec },
          sessionVerifier: {
            verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS })
          },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator
        },
        {
          // No privateSettlementStorage provided
        }
      )

      await expect(badComposition.publicEngine.settle(executionId)).rejects.toThrow(
        /No durable settlement storage available/
      )

      badComposition.dispose()
    })
  })

  describe('Test 11: Coordination Absence', () => {
    it('fails closed when navigator.locks is unavailable in production composition', async () => {
      const originalNavigator = globalThis.navigator
      try {
        vi.stubGlobal('navigator', {})
        const coordinator = new WebLocksExecutionCoordinator()
        await expect(
          coordinator.requestExclusive('rmzwallet:agent-settlement:test', async () => 'should_not_run')
        ).rejects.toThrowError(
          expect.objectContaining({
            code: 'COORDINATION_UNAVAILABLE'
          })
        )
        await expect(
          coordinator.tryExclusive('rmzwallet:agent-settlement:test', async () => 'should_not_run')
        ).rejects.toThrowError(
          expect.objectContaining({
            code: 'COORDINATION_UNAVAILABLE'
          })
        )
      } finally {
        vi.stubGlobal('navigator', originalNavigator)
      }
    })
  })

  describe('Test 12: Consensus Rejection Discriminator', () => {
    it('accurately identifies definitive consensus errors vs transient or policy errors', () => {
      // Structured invariant: MUST return true
      expect(isDefinitiveConsensusRejection({ isDefinitiveConsensusRejection: true })).toBe(true)
      expect(isDefinitiveConsensusRejection({ definitiveConsensusRejection: true })).toBe(true)
      expect(
        isDefinitiveConsensusRejection(
          Object.assign(new Error('consensus violation'), { isDefinitiveConsensusRejection: true })
        )
      ).toBe(true)

      // Ambiguous strings / mempool conflict / missing inputs / script flags (P1-1: MUST return false)
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-inputs-spent'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('txn-mempool-conflict'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-in-belowout'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('mandatory-script-verify-flag-failed'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('non-mandatory-script-verify-flag-failed'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-inputs-missingorspent'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-vin-empty'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-vout-empty'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-oversize'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('dust'))).toBe(false)

      // Ambiguous / transport errors (MUST return false)
      expect(isDefinitiveConsensusRejection(new Error('Connection timeout'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('502 Bad Gateway'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('504 Gateway Timeout'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('ECONNRESET'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('Network error'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('fetch failed'))).toBe(false)

      // Mempool already-known (NOT a rejection!)
      expect(isDefinitiveConsensusRejection(new Error('txn-already-in-mempool'))).toBe(false)
      expect(isDefinitiveConsensusRejection(new Error('already known'))).toBe(false)
    })
  })

  describe('Test 13: Architectural Boundary Invariants', () => {
    it('verifies publicEngine and WalletSettlementReceiptV1 never expose raw signed transaction or private keys', async () => {
      const harness = setupTestHarness()
      const { executionId } = await harness.signExecution()

      // Inspect publicEngine keys
      const publicKeys = Object.keys(harness.composition.publicEngine)
      expect(publicKeys).toEqual(expect.arrayContaining(['prepareExecution', 'getExecutionStatus', 'settle']))
      expect(publicKeys).not.toContain('confirm')
      expect(publicKeys).not.toContain('sign')
      expect(publicKeys).not.toContain('getSignatory')
      expect(publicKeys).not.toContain('getRawSignedTransaction')
      expect(publicKeys).not.toContain('rawSignedTxHex')

      const receipt = await harness.composition.publicEngine.settle(executionId)

      // Inspect receipt keys
      expect(receipt.status).toBe('settled')
      const unsafeReceipt = receipt as unknown as Record<string, unknown>
      expect(unsafeReceipt.rawSignedTxHex).toBeUndefined()
      expect(unsafeReceipt.rawTx).toBeUndefined()
      expect(unsafeReceipt.signatory).toBeUndefined()
      expect(unsafeReceipt.privateKey).toBeUndefined()

      // Inspect public status
      const status = await harness.composition.publicEngine.getExecutionStatus(executionId)
      const unsafeStatus = status as unknown as Record<string, unknown>
      expect(unsafeStatus.rawSignedTxHex).toBeUndefined()
      expect(unsafeStatus.rawTx).toBeUndefined()

      harness.composition.dispose()
    })
  })

  describe('Test 14: P0-1 Private Raw Tx Read and Settlement Coordination Privacy', () => {
    it('ensures caller-supplied config.lockCoordinator cannot observe raw signed transaction or intercept settlement fencing', async () => {
      const observedLockCallbacks: string[] = []
      const observedRawBytes: string[] = []

      const hostileLockCoordinator: ExecutionLockCoordinator = {
        async requestExclusive<T>(name: string, operation: () => Promise<T>): Promise<T> {
          observedLockCallbacks.push(name)
          const result = await operation()
          if (typeof result === 'string') {
            observedRawBytes.push(result)
          }
          return result
        },
        async tryExclusive<T>(name: string, operation: () => Promise<T>) {
          observedLockCallbacks.push(name)
          const result = await operation()
          return { acquired: true as const, result }
        }
      }

      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      // Create a composition where the caller passes the hostile lock coordinator in config
      const rec = createFixtureLedgerRecord()
      const compositionWithHostileLock = createWalletExecutionComposition(
        {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: hostileLockCoordinator,
          clock: () => FIXED_NOW
        },
        {
          privateSettlementStorage: harness.settlementStorage
        }
      )

      // Run settlement
      const receipt = await compositionWithHostileLock.publicEngine.settle(executionId)
      expect(receipt.status).toBe('settled')
      expect(receipt.txid).toBe(expectedTxid)

      // The hostile lock coordinator MUST have observed ZERO settlement locks and ZERO raw tx bytes!
      expect(observedRawBytes).toHaveLength(0)
      const settlementStoreLocks = observedLockCallbacks.filter(name =>
        name.includes('settlement-store') || name.includes('settlement:')
      )
      expect(settlementStoreLocks).toHaveLength(0)

      compositionWithHostileLock.dispose()
      harness.composition.dispose()
    })
  })

  describe('Test 15: P0-3 Settlement Ledger Authority Invariants', () => {
    it('prevents caller-supplied executionLedger from hijacking settlement authority or fabricating signed state', async () => {
      const hostileExecutionLedger: WalletExecutionLedger = {
        async whenReady() {},
        async reserveExecutionAtomic() { throw new Error('Unused') },
        async runWithSigningLock<T>(_id: string, op: () => Promise<T>): Promise<T> { return op() },
        async runWithReviewLock<T>(_id: string, op: () => Promise<T>): Promise<T> { return op() },
        async setPlanPrepared() { throw new Error('Unused') },
        async get(_executionId: string): Promise<any> {
          return {
            executionId: 'fake_exec_id',
            approvalId: 'fake_appr',
            requestId: 'fake_req',
            intentId: 'fake_intent',
            decisionId: 'fake_decision',
            fromAddress: FROM_ADDRESS,
            destination: 'fake_dest',
            amountSats: 1000,
            network: 'xec:mainnet',
            status: 'SIGNED',
            planHash: 'fake_hash',
            reservedAt: FIXED_NOW,
            signedAt: FIXED_NOW
          }
        },
        async snapshotPreparedLeases() { return [] },
        async tryRecoverAbandonedPrepared() { return 'not_prepared' },
        async renewReviewLease() { throw new Error('Unused') },
        async transitionToSigningIfValid() { throw new Error('Unused') },
        async transitionToSigned() {},
        async markSigningUncertain() {},
        async markFailed() {},
        async markRejected() {},
        async markExpired() {},
        async getByApprovalId() { return undefined },
        async getByRequestId() { return undefined },
        async has() { return false }
      }

      const harness = setupTestHarness()
      const rec = createFixtureLedgerRecord()

      // Hostile ledger passed in public config
      const hostileComposition = createWalletExecutionComposition(
        {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          executionLedger: hostileExecutionLedger,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW
        },
        {
          privateSettlementStorage: harness.settlementStorage
        }
      )

      // Calling settle with fake_exec_id: authoritative settlement ledger checks canonical storage,
      // where fake_exec_id DOES NOT EXIST. It fails closed with EXECUTION_NOT_FOUND without broadcasting!
      await expect(
        hostileComposition.publicEngine.settle('fake_exec_id')
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'EXECUTION_NOT_FOUND'
        })
      )

      expect(harness.mockChronik.broadcastCalls).toHaveLength(0)

      hostileComposition.dispose()
      harness.composition.dispose()
    })

    it('enforces settlement fencing across concurrent independent engine instances on shared canonical storage', async () => {
      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      const rec = createFixtureLedgerRecord()
      // Instance B created on identical canonical storage
      const instanceB = createWalletExecutionComposition(
        {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW
        },
        {
          privateSettlementStorage: harness.settlementStorage
        }
      )

      // Concurrent settle across instance A (harness) and instance B
      const [rA, rB] = await Promise.all([
        harness.composition.publicEngine.settle(executionId),
        instanceB.publicEngine.settle(executionId)
      ])

      expect(rA.status).toBe('settled')
      expect(rB.status).toBe('settled')
      expect(rA.txid).toBe(expectedTxid)
      expect(rB.txid).toBe(expectedTxid)

      // Exactly ONE broadcast across both instances!
      expect(harness.mockChronik.broadcastCalls).toHaveLength(1)

      instanceB.dispose()
      harness.composition.dispose()
    })
  })

  describe('Gate C3A Pass 3 Remediation Suite', () => {
    describe('P0-1: Settlement Mutators Must Not Be Publicly Importable', () => {
      it('proves DurableTransactionalExecutionLedger has NO settlement mutators on prototype or instance', () => {
        const forbiddenMethods = [
          'transitionToSettling',
          'transitionToSettled',
          'markSettlementUncertain',
          'markSettlementRejected',
          'snapshotSettlingRecords',
          'runWithSettlementLock'
        ]

        for (const method of forbiddenMethods) {
          expect((DurableTransactionalExecutionLedger.prototype as any)[method]).toBeUndefined()
        }

        const ledger = new DurableTransactionalExecutionLedger({
          storage: new MockStorage(),
          lockCoordinator: new TestExecutionLockCoordinator(),
          clock: () => FIXED_NOW
        })

        for (const method of forbiddenMethods) {
          expect((ledger as any)[method]).toBeUndefined()
        }
      })

      it('proves production deep import cannot obtain a trusted settlement mutation capability', async () => {
        const ledgerModule = await import('./ledger')
        const typesModule = await import('./types')

        expect((typesModule as any).AuthoritativeSettlementLedger).toBeUndefined()
        expect((ledgerModule as any).FileLocalSettlementAuthority).toBeUndefined()
        expect((ledgerModule as any).AuthoritativeSettlementLedger).toBeUndefined()

        for (const exportName of Object.keys(ledgerModule)) {
          expect(exportName).not.toMatch(/settle.*mutat/i)
          expect(exportName).not.toMatch(/authoritative.*settlement/i)
        }
      })
    })

    describe('P0-2: Public config.storage Must Not Back Settlement Authority', () => {
      it('proves malicious config.storage cannot suppress SETTLING persistence or hijack settlement authority', async () => {
        const canonicalStorage = new MockStorage()
        const settlementStorage = new MockStorage()
        const lockCoordinator = new TestExecutionLockCoordinator()

        let hostileSetItemCalled = false
        const hostileStorage: Storage = {
          getItem: vi.fn(() => null),
          setItem: vi.fn(() => {
            hostileSetItemCalled = true
            throw new Error('Hostile storage reject')
          }),
          removeItem: vi.fn(),
          clear: vi.fn(),
          key: vi.fn(),
          length: 0
        }

        const { signatory } = createSyntheticSignatory()
        const defaultRecord = createFixtureLedgerRecord()
        const approvalMap = new Map<string, WalletApprovalLedgerRecord>()
        approvalMap.set(defaultRecord.requestId, defaultRecord)

        const mockChronik: ChronikBroadcastClient = {
          broadcastTx: async rawTx => {
            const tx = Tx.fromHex(Buffer.from(rawTx).toString('hex'))
            return { txid: tx.txid().toLowerCase() }
          },
          tx: async txid => ({ txid })
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = mockChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = lockCoordinator

        const composition = createWalletExecutionComposition(
          {
            approvalLedger: {
              get: async (reqId: string) => approvalMap.get(reqId),
              getByApprovalId: async (apprId: string) =>
                Array.from(approvalMap.values()).find(r => r.approvalId === apprId)
            },
            sessionVerifier: {
              verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS })
            },
            utxoProvider: {
              getSpendableUtxos: async () => createFixtureUtxos()
            },
            signatoryProvider: {
              getSignatory: () => signatory
            },
            storage: hostileStorage, // HOSTILE STORAGE IN PUBLIC CONFIG
            lockCoordinator,
            clock: () => FIXED_NOW,
            idGenerator: () => 'exec_p0_2_hostile'
          },
          {
            executionStorage: canonicalStorage,
            privateSettlementStorage: settlementStorage
          }
        )

        // Prepare and sign
        const session = await composition.publicEngine.prepareExecution(defaultRecord.humanApproval!)
        const controller = composition.walletUIHost.getActiveController()
        if (!controller) throw new Error('No active controller')
        const handle = await controller.confirm()
        expect(handle.status).toBe('SIGNED')

        // Settle must succeed because settlement uses canonicalStorage, not hostileStorage
        const receipt = await composition.publicEngine.settle(session.executionId)
        expect(receipt.status).toBe('settled')

        // Check canonicalStorage has SETTLED record
        const rawCanonical = canonicalStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)
        expect(rawCanonical).toBeDefined()
        const parsedCanonical = JSON.parse(rawCanonical!)
        expect(parsedCanonical.records[session.executionId]?.state).toBe('SETTLED')

        // Hostile storage setItem was NEVER called for settlement
        expect(hostileSetItemCalled).toBe(false)

        composition.dispose()
      })
    })

    describe('P2: C2 and C3A Must Use One Wallet-Owned Durable Dataset', () => {
      it('proves normal C2 signing and C3 settlement operate over the exact same Wallet-owned execution record', async () => {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()

        // 1. Check raw record immediately after C2 confirm(): it must be SIGNED in harness.ledgerStorage
        const rawC2 = harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)
        expect(rawC2).toBeDefined()
        const parsedC2 = JSON.parse(rawC2!)
        expect(parsedC2.records[executionId]?.state).toBe('SIGNED')

        // 2. C3A settle() executes over the exact same record
        const receipt = await harness.composition.publicEngine.settle(executionId)
        expect(receipt.status).toBe('settled')
        expect(receipt.txid).toBe(expectedTxid)

        // 3. Check raw record after C3A settle(): same record in same storage is now SETTLED
        const rawC3 = harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)
        const parsedC3 = JSON.parse(rawC3!)
        expect(parsedC3.records[executionId]?.state).toBe('SETTLED')
        expect(parsedC3.records[executionId]?.settlingAt).toBe(FIXED_NOW)
        expect(parsedC3.records[executionId]?.settledAt).toBe(FIXED_NOW)

        harness.composition.dispose()
      })

      it('proves SIGNED produced by C2 is immediately visible to C3A settle() without divergence', async () => {
        const harness = setupTestHarness()
        const { executionId } = await harness.signExecution()

        // Status query sees SIGNED
        const statusBefore = await harness.composition.publicEngine.getExecutionStatus(executionId)
        expect(statusBefore?.status).toBe('SIGNED')

        // Settle immediately sees SIGNED and transitions to settled
        const receipt = await harness.composition.publicEngine.settle(executionId)
        expect(receipt.status).toBe('settled')

        harness.composition.dispose()
      })
    })

    describe('P1: Startup Recovery Must Retry Skipped Locks', () => {
      it('retries skipped startup recovery after another tab releases the settlement lock, performing ZERO rebroadcasts', async () => {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()
        seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
        harness.composition.dispose()

        const broadcastCalls: Uint8Array[] = []
        const txCalls: string[] = []
        const recoveredChronik: ChronikBroadcastClient = {
          broadcastTx: async rawTx => {
            broadcastCalls.push(rawTx)
            return { txid: expectedTxid }
          },
          tx: async txid => {
            txCalls.push(txid)
            return { txid } // Chronik observes tx in mempool / block!
          }
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = recoveredChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = harness.lockCoordinator

        // Tab A acquires the settlement lock for this executionId and holds it
        let releaseTabALock: () => void = () => {}
        const tabALockHeld = new Promise<void>(resolve => {
          releaseTabALock = resolve
        })

        const tabAHolding = harness.lockCoordinator.requestExclusive(
          executionSettlementLockName(executionId),
          async () => {
            await tabALockHeld
          }
        )

        // Tab B initializes while Tab A holds the lock
        const rec = createFixtureLedgerRecord()
        const tabBComposition = createWalletExecutionComposition(
          {
            approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
            sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
            utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
            signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
            storage: harness.ledgerStorage,
            lockCoordinator: harness.lockCoordinator,
            clock: () => FIXED_NOW + 100
          },
          {
            executionStorage: harness.ledgerStorage,
            privateSettlementStorage: harness.settlementStorage
          }
        )

        // Wait a tick: Tab B's initial attempt fails to acquire the lock because Tab A holds it
        await new Promise(r => setTimeout(r, 20))

        // Record must STILL be SETTLING (not abandoned or forgotten)
        const midData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(midData.records[executionId]?.state).toBe('SETTLING')
        expect(broadcastCalls).toHaveLength(0)

        // Now Tab A releases the settlement lock
        releaseTabALock()
        await tabAHolding

        // Wait for Tab B's scheduled retry timer to fire (base 50ms)
        await vi.waitFor(
          async () => {
            const data = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
            expect(data.records[executionId]?.state).toBe('SETTLED')
          },
          { timeout: 500, interval: 20 }
        )

        // ZERO rebroadcasts occurred!
        expect(broadcastCalls).toHaveLength(0)
        // Chronik tx query was performed
        expect(txCalls).toContain(expectedTxid)

        tabBComposition.dispose()
      })

      it('retries skipped startup recovery and transitions to SETTLEMENT_UNCERTAIN if Chronik cannot observe the tx', async () => {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()
        seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
        harness.composition.dispose()

        const broadcastCalls: Uint8Array[] = []
        const recoveredChronik: ChronikBroadcastClient = {
          broadcastTx: async rawTx => {
            broadcastCalls.push(rawTx)
            return { txid: expectedTxid }
          },
          tx: async () => {
            throw new Error('Not found') // Unobservable
          }
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = recoveredChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = harness.lockCoordinator

        let releaseTabALock: () => void = () => {}
        const tabALockHeld = new Promise<void>(resolve => {
          releaseTabALock = resolve
        })

        const tabAHolding = harness.lockCoordinator.requestExclusive(
          executionSettlementLockName(executionId),
          async () => {
            await tabALockHeld
          }
        )

        const rec = createFixtureLedgerRecord()
        const tabBComposition = createWalletExecutionComposition(
          {
            approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
            sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
            utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
            signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
            storage: harness.ledgerStorage,
            lockCoordinator: harness.lockCoordinator,
            clock: () => FIXED_NOW + 100
          },
          {
            executionStorage: harness.ledgerStorage,
            privateSettlementStorage: harness.settlementStorage
          }
        )

        await new Promise(r => setTimeout(r, 20))
        releaseTabALock()
        await tabAHolding

        await vi.waitFor(
          async () => {
            const data = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
            expect(data.records[executionId]?.state).toBe('SETTLEMENT_UNCERTAIN')
          },
          { timeout: 500, interval: 20 }
        )

        // ZERO rebroadcasts!
        expect(broadcastCalls).toHaveLength(0)

        // Outpoints retained during UNCERTAIN
        const finalData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        const outpoint = canonicalOutpointKey('11'.repeat(32), 0)
        expect(finalData.outpointReservations[outpoint]).toBe(executionId)

        tabBComposition.dispose()
      })

      it('cancels pending startup recovery retry timers when composition is disposed', async () => {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()
        seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
        harness.composition.dispose()

        let txCalls = 0
        const recoveredChronik: ChronikBroadcastClient = {
          broadcastTx: async () => ({ txid: expectedTxid }),
          tx: async () => {
            txCalls++
            return { txid: expectedTxid }
          }
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = recoveredChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = harness.lockCoordinator

        let releaseTabALock: () => void = () => {}
        const tabALockHeld = new Promise<void>(resolve => {
          releaseTabALock = resolve
        })

        const tabAHolding = harness.lockCoordinator.requestExclusive(
          executionSettlementLockName(executionId),
          async () => {
            await tabALockHeld
          }
        )

        const rec = createFixtureLedgerRecord()
        const composition = createWalletExecutionComposition(
          {
            approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
            sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
            utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
            signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
            storage: harness.ledgerStorage,
            lockCoordinator: harness.lockCoordinator,
            clock: () => FIXED_NOW + 100
          },
          {
            executionStorage: harness.ledgerStorage,
            privateSettlementStorage: harness.settlementStorage
          }
        )

        await new Promise(r => setTimeout(r, 20))

        // Dispose composition while retry is pending
        composition.dispose()

        // Release the lock
        releaseTabALock()
        await tabAHolding

        // Wait to verify retry does NOT fire after disposal
        await new Promise(r => setTimeout(r, 120))

        // State remains SETTLING because retry was cancelled on dispose
        const data = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(data.records[executionId]?.state).toBe('SETTLING')
        expect(txCalls).toBe(0)
      })
    })
  })
})
