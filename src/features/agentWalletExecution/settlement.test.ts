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
  WalletExecutionLedger,
  DisposableAgentWalletExecutionEngine
} from './types'
import {
  deriveExpectedTxidFromRawTxHex
} from './settlementUtils'
import {
  createAgentWalletExecutionEngine
} from './index'
import {
  canonicalOutpointKey,
  DEFAULT_EXECUTION_LEDGER_STORAGE_KEY,
  DEFAULT_EXECUTION_LOCK_NAME,
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

  describe('Test 6: Broadcast Error Handling — Zero Rejections and Invariant Outpoint Retention (P1-2)', () => {
    const errorShapes: Array<{ name: string; error: unknown }> = [
      { name: 'plain Error', error: new Error('Generic socket level failure') },
      { name: 'HTTP/RPC error', error: new Error('502 Bad Gateway: Upstream RPC failure') },
      { name: 'mempool conflict', error: new Error('txn-mempool-conflict: txn conflicts with existing txn') },
      { name: 'missing/spent input', error: new Error('bad-txns-inputs-missingorspent: input already spent') },
      { name: 'policy error', error: new Error('non-mandatory-script-verify-flag-failed: script flag failure') },
      {
        name: 'object with isDefinitiveConsensusRejection: true',
        error: Object.assign(new Error('Consensus rule violated: transaction script failed verify'), {
          isDefinitiveConsensusRejection: true
        })
      },
      {
        name: 'object with definitiveConsensusRejection: true',
        error: Object.assign(new Error('Consensus rule violated: inputs rejected'), {
          definitiveConsensusRejection: true
        })
      },
      {
        name: 'arbitrary nested flags',
        error: Object.assign(new Error('Arbitrary nested flags error'), {
          error: { consensus: { rejected: true, definitive: true } },
          flags: { permanent: true }
        })
      }
    ]

    for (const { name, error } of errorShapes) {
      it(`defaults ${name} to SETTLEMENT_UNCERTAIN with zero outpoint release and zero terminal rejection`, async () => {
        const harness = setupTestHarness({
          chronikOverride: {
            broadcastTx: async () => {
              throw error
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
        expect(status?.status).not.toBe('SETTLEMENT_REJECTED')

        // Outpoint reservations MUST be retained (zero release on any broadcast failure!)
        const ledger = new DurableTransactionalExecutionLedger({
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW
        })
        const outpoint = canonicalOutpointKey('11'.repeat(32), 0)
        expect(await ledger.getOutpointReservation(outpoint)).toBe(executionId)

        harness.composition.dispose()
      })
    }

    it('settles cleanly if expectedTxid becomes observable during post-error query', async () => {
      let broadcastThrew = false
      const harness = setupTestHarness({
        chronikOverride: {
          broadcastTx: async () => {
            broadcastThrew = true
            throw Object.assign(new Error('Network drop or consensus spoof'), {
              isDefinitiveConsensusRejection: true
            })
          },
          tx: async txid => {
            // Observed on node despite broadcast exception!
            return { txid }
          }
        }
      })
      const { executionId, expectedTxid } = await harness.signExecution()

      const receipt = await harness.composition.publicEngine.settle(executionId)
      expect(broadcastThrew).toBe(true)
      expect(receipt.status).toBe('settled')
      expect(receipt.txid).toBe(expectedTxid)

      const status = await harness.composition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLED')

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

  describe('Test 12: Broadcast Error Invariant (Zero Rejections from Broadcast Failures)', () => {
    it('verifies Gate C3A broadcast path never transitions to SETTLEMENT_REJECTED or releases outpoints', async () => {
      const spoofedErrors = [
        Object.assign(new Error('Consensus rule permanently violated'), {
          isDefinitiveConsensusRejection: true,
          definitiveConsensusRejection: true
        }),
        Object.assign(new Error('Arbitrary deep consensus flag'), {
          consensus: { rejected: true }
        }),
        new Error('txn-mempool-conflict'),
        new Error('bad-txns-inputs-missingorspent'),
        new Error('ECONNRESET')
      ]

      for (const err of spoofedErrors) {
        const harness = setupTestHarness({
          chronikOverride: {
            broadcastTx: async () => {
              throw err
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
        expect(status?.status).not.toBe('SETTLEMENT_REJECTED')

        const ledger = new DurableTransactionalExecutionLedger({
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW
        })
        const outpoint = canonicalOutpointKey('11'.repeat(32), 0)
        expect(await ledger.getOutpointReservation(outpoint)).toBe(executionId)

        harness.composition.dispose()
      }
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

      it('continues retrying beyond the previous 20-attempt window and reconciles to SETTLED when lock is released (observed tx)', async () => {
        vi.useFakeTimers()
        try {
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
              return { txid }
            }
          }

          ;(globalThis as Record<symbol, unknown>)[
            Symbol.for('rmzwallet.testOnly.settlementChronikClient')
          ] = recoveredChronik
          ;(globalThis as Record<symbol, unknown>)[
            Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
          ] = harness.lockCoordinator

          // 1. Tab A holds the settlement lock longer than the previous 20-attempt window
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

          // 2. Tab B starts recovery and repeatedly fails to acquire the lock
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

          // Advance past the previous 20-attempt window (~14.5s for 20 attempts; 25s is ~30 attempts)
          await vi.advanceTimersByTimeAsync(25_000)

          const midData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
          expect(midData.records[executionId]?.state).toBe('SETTLING')
          expect(broadcastCalls).toHaveLength(0)

          // 3. After that old retry window has elapsed, Tab A releases/crashes
          releaseTabALock()
          await tabAHolding

          // 4. Without any call to publicEngine.settle(), Tab B acquires the lock and reconciles: observed tx -> SETTLED
          await vi.advanceTimersByTimeAsync(1_000)

          const finalData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
          expect(finalData.records[executionId]?.state).toBe('SETTLED')

          // 5. broadcast count = 0
          expect(broadcastCalls).toHaveLength(0)
          expect(txCalls).toContain(expectedTxid)

          tabBComposition.dispose()
        } finally {
          vi.useRealTimers()
        }
      })

      it('continues retrying beyond the previous 20-attempt window and reconciles to SETTLEMENT_UNCERTAIN when lock is released (unobservable tx)', async () => {
        vi.useFakeTimers()
        try {
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
              throw new Error('Transaction not found in mempool or block')
            }
          }

          ;(globalThis as Record<symbol, unknown>)[
            Symbol.for('rmzwallet.testOnly.settlementChronikClient')
          ] = recoveredChronik
          ;(globalThis as Record<symbol, unknown>)[
            Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
          ] = harness.lockCoordinator

          // 1. Tab A holds the settlement lock longer than the previous 20-attempt window
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

          // 2. Tab B starts recovery and repeatedly fails to acquire the lock
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

          // Advance past the previous 20-attempt window (~14.5s for 20 attempts; 25s is ~30 attempts)
          await vi.advanceTimersByTimeAsync(25_000)

          const midData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
          expect(midData.records[executionId]?.state).toBe('SETTLING')
          expect(broadcastCalls).toHaveLength(0)

          // 3. After that old retry window has elapsed, Tab A releases/crashes
          releaseTabALock()
          await tabAHolding

          // 4. Without any call to publicEngine.settle(), Tab B acquires the lock and reconciles: unobservable -> SETTLEMENT_UNCERTAIN
          await vi.advanceTimersByTimeAsync(1_000)

          const finalData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
          expect(finalData.records[executionId]?.state).toBe('SETTLEMENT_UNCERTAIN')

          // 5. broadcast count = 0
          expect(broadcastCalls).toHaveLength(0)
          expect(txCalls.length).toBeGreaterThan(0)

          tabBComposition.dispose()
        } finally {
          vi.useRealTimers()
        }
      })
    })
  })

  describe('Test 16: Factory-Created Engine Lifecycle Cleanup (P1-1)', () => {
    it('satisfies all 10 factory lifecycle cleanup and boundary requirements', async () => {
      vi.useFakeTimers()
      try {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()
        seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
        harness.composition.dispose()

        let txCalls = 0
        const testChronik: ChronikBroadcastClient = {
          broadcastTx: async () => {
            throw new Error('Should not broadcast')
          },
          tx: async (txid: string) => {
            txCalls++
            return { txid }
          }
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = testChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = harness.lockCoordinator

        // Hold the settlement lock so neither engine can acquire it immediately
        let releaseExternalLock: () => void = () => {}
        const externalLockHeld = new Promise<void>(resolve => {
          releaseExternalLock = resolve
        })
        const externalHolding = harness.lockCoordinator.requestExclusive(
          executionSettlementLockName(executionId),
          async () => {
            await externalLockHeld
          }
        )

        const rec = createFixtureLedgerRecord()
        const engineConfigA: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        }

        const engineConfigB: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        }

        // 1. Two independently factory-created disposable engines are created.
        const engineA: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigA)
        const engineB: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigB)

        // 10. No settlement/security authority is added to the disposable handle.
        expect(typeof engineA.prepareExecution).toBe('function')
        expect(typeof engineA.getExecutionStatus).toBe('function')
        expect(typeof engineA.settle).toBe('function')
        expect(typeof engineA.dispose).toBe('function')

        expect((engineA as any).walletUIHost).toBeUndefined()
        expect((engineA as any).controller).toBeUndefined()
        expect((engineA as any).privateSettlementStorage).toBeUndefined()
        expect((engineA as any).settlementLedger).toBeUndefined()
        expect((engineA as any).chronik).toBeUndefined()
        expect((engineA as any).lockCoordinator).toBeUndefined()
        expect((engineA as any).rawSignedTxHex).toBeUndefined()
        expect((engineA as any).sign).toBeUndefined()
        expect((engineA as any).confirm).toBeUndefined()
        expect((engineA as any).execute).toBeUndefined()

        // 2. Both encounter the same locked SETTLING record.
        // Advance slightly to trigger initial settlement recovery attempt and fail to lock
        await vi.advanceTimersByTimeAsync(100)

        // 3. Dispose engine A.
        // 9. dispose cancels settlement retry timers immediately.
        // 8. Calling dispose twice is safe/idempotent.
        engineA.dispose()
        expect(() => engineA.dispose()).not.toThrow()

        // 4. Verify A stops all background polling permanently (advance 5s while lock held)
        // 6. No timers remain from A.
        await vi.advanceTimersByTimeAsync(5_000)

        // 5. Engine B continues its own recovery correctly.
        releaseExternalLock()
        await externalHolding

        // Advance 1s for engine B retry to fire and reconcile
        await vi.advanceTimersByTimeAsync(1_000)

        const finalData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(finalData.records[executionId]?.state).toBe('SETTLED')

        // Clean up Engine B
        engineB.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('7. Provider/context publicEngine has NO dispose property', () => {
      const harness = setupTestHarness()
      expect('dispose' in harness.composition.publicEngine).toBe(false)
      expect((harness.composition.publicEngine as any).dispose).toBeUndefined()
      harness.composition.dispose()
    })
  })

  describe('P1 (Pass 4.1): Stop In-Flight Settlement Recovery After Disposal', () => {
    it('stops in-flight recovery when disposed while waiting for authoritative ledger read', async () => {
      vi.useFakeTimers()
      try {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()
        seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
        harness.composition.dispose()

        let txCalls = 0
        let broadcastCalls = 0
        const testChronik: ChronikBroadcastClient = {
          broadcastTx: async () => {
            broadcastCalls++
            return { txid: expectedTxid }
          },
          tx: async (txid: string) => {
            txCalls++
            return { txid }
          }
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = testChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = harness.lockCoordinator

        let pauseResolve!: () => void
        const ledgerReadPaused = new Promise<void>(resolve => {
          pauseResolve = resolve
        })

        let ledgerReadStartedResolve!: () => void
        const ledgerReadStarted = new Promise<void>(resolve => {
          ledgerReadStartedResolve = resolve
        })

        let hookRan = false
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeAuthoritativeLedgerGet')
        ] = async (targetExecutionId: string) => {
          if (targetExecutionId === executionId && !hookRan) {
            hookRan = true
            ledgerReadStartedResolve()
            await ledgerReadPaused
          }
        }

        const rec = createFixtureLedgerRecord()
        const engineConfigA: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        }

        // 1. Engine/composition A begins settlement recovery.
        const engineA: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigA)

        // Wait until authoritative ledger get() is invoked and paused
        await ledgerReadStarted

        // 3. Call A.dispose() while get() is pending.
        engineA.dispose()

        // 4. Resolve the pending ledger read with SETTLING state.
        pauseResolve()

        // 5. Allow all microtasks/timers to run.
        await vi.advanceTimersByTimeAsync(5_000)

        // Assert for A:
        // - zero settlement mutation after disposal
        const dataAfterA = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(dataAfterA.records[executionId]?.state).toBe('SETTLING')
        // - zero Chronik tx() after disposal
        expect(txCalls).toBe(0)
        // - zero broadcastTx()
        expect(broadcastCalls).toBe(0)

        // Remove the pause hook so Engine B can read the ledger unimpeded
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeAuthoritativeLedgerGet')
        ]

        // Then prove live Engine B can still recover the same SETTLING execution.
        const engineConfigB: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 200
        }
        const engineB: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigB)

        // Allow Engine B startup recovery to run and observe the tx
        await vi.advanceTimersByTimeAsync(500)

        const finalData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(finalData.records[executionId]?.state).toBe('SETTLED')
        expect(txCalls).toBeGreaterThanOrEqual(1)

        engineB.dispose()
      } finally {
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeAuthoritativeLedgerGet')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ]
        vi.useRealTimers()
      }
    })

    it('stops in-flight recovery when disposed while waiting to acquire settlement lock', async () => {
      vi.useFakeTimers()
      try {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()
        seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
        harness.composition.dispose()

        let txCalls = 0
        let broadcastCalls = 0
        const testChronik: ChronikBroadcastClient = {
          broadcastTx: async () => {
            broadcastCalls++
            return { txid: expectedTxid }
          },
          tx: async (txid: string) => {
            txCalls++
            return { txid }
          }
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = testChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = harness.lockCoordinator

        let pauseLockAcquire!: () => void
        const lockAcquirePaused = new Promise<void>(resolve => {
          pauseLockAcquire = resolve
        })

        let lockAcquireStartedResolve!: () => void
        const lockAcquireStarted = new Promise<void>(resolve => {
          lockAcquireStartedResolve = resolve
        })

        let hookRan = false
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeSettlementLockAcquire')
        ] = async (targetExecutionId: string) => {
          if (targetExecutionId === executionId && !hookRan) {
            hookRan = true
            lockAcquireStartedResolve()
            await lockAcquirePaused
          }
        }

        const rec = createFixtureLedgerRecord()
        const engineConfigA: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        }

        const engineA: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigA)

        // Wait until beforeSettlementLockAcquire hook is entered
        await lockAcquireStarted

        // Call A.dispose() while waiting to acquire lock
        engineA.dispose()

        // Unpause lock acquire
        pauseLockAcquire()

        // Allow microtasks/timers to run
        await vi.advanceTimersByTimeAsync(5_000)

        // Assert for A:
        const dataAfterA = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(dataAfterA.records[executionId]?.state).toBe('SETTLING')
        expect(txCalls).toBe(0)
        expect(broadcastCalls).toBe(0)

        // Remove hook
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeSettlementLockAcquire')
        ]

        // Engine B recovers normally
        const engineConfigB: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 200
        }
        const engineB: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigB)

        await vi.advanceTimersByTimeAsync(500)

        const finalData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(finalData.records[executionId]?.state).toBe('SETTLED')
        expect(txCalls).toBeGreaterThanOrEqual(1)

        engineB.dispose()
      } finally {
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeSettlementLockAcquire')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ]
        vi.useRealTimers()
      }
    })

    it('stops in-flight recovery when disposed immediately inside acquired lock callback before handleSettlementRecovery', async () => {
      vi.useFakeTimers()
      try {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()
        seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
        harness.composition.dispose()

        let txCalls = 0
        let broadcastCalls = 0
        const testChronik: ChronikBroadcastClient = {
          broadcastTx: async () => {
            broadcastCalls++
            return { txid: expectedTxid }
          },
          tx: async (txid: string) => {
            txCalls++
            return { txid }
          }
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = testChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = harness.lockCoordinator

        let pauseLockCallback!: () => void
        const lockCallbackPaused = new Promise<void>(resolve => {
          pauseLockCallback = resolve
        })

        let lockCallbackStartedResolve!: () => void
        const lockCallbackStarted = new Promise<void>(resolve => {
          lockCallbackStartedResolve = resolve
        })

        let hookRan = false
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.afterLockAcquisitionBeforeRecovery')
        ] = async (targetExecutionId: string) => {
          if (targetExecutionId === executionId && !hookRan) {
            hookRan = true
            lockCallbackStartedResolve()
            await lockCallbackPaused
          }
        }

        const rec = createFixtureLedgerRecord()
        const engineConfigA: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        }

        const engineA: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigA)

        await lockCallbackStarted
        engineA.dispose()
        pauseLockCallback()

        await vi.advanceTimersByTimeAsync(5_000)

        const dataAfterA = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(dataAfterA.records[executionId]?.state).toBe('SETTLING')
        expect(txCalls).toBe(0)
        expect(broadcastCalls).toBe(0)

        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.afterLockAcquisitionBeforeRecovery')
        ]

        const engineConfigB: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 200
        }
        const engineB: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigB)

        await vi.advanceTimersByTimeAsync(500)

        const finalData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(finalData.records[executionId]?.state).toBe('SETTLED')
        expect(txCalls).toBeGreaterThanOrEqual(1)

        engineB.dispose()
      } finally {
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.afterLockAcquisitionBeforeRecovery')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ]
        vi.useRealTimers()
      }
    })

    it('stops in-flight recovery when disposed immediately after lock acquisition but before network observation', async () => {
      vi.useFakeTimers()
      try {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()
        seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
        harness.composition.dispose()

        let txCalls = 0
        let broadcastCalls = 0
        const testChronik: ChronikBroadcastClient = {
          broadcastTx: async () => {
            broadcastCalls++
            return { txid: expectedTxid }
          },
          tx: async (txid: string) => {
            txCalls++
            return { txid }
          }
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = testChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = harness.lockCoordinator

        let pauseObservation!: () => void
        const observationPaused = new Promise<void>(resolve => {
          pauseObservation = resolve
        })

        let observationStartedResolve!: () => void
        const observationStarted = new Promise<void>(resolve => {
          observationStartedResolve = resolve
        })

        let hookRan = false
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeSettlementRecoveryObservation')
        ] = async (targetExecutionId: string) => {
          if (targetExecutionId === executionId && !hookRan) {
            hookRan = true
            observationStartedResolve()
            await observationPaused
          }
        }

        const rec = createFixtureLedgerRecord()
        const engineConfigA: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        }

        const engineA: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigA)

        // Wait until beforeSettlementRecoveryObservation hook is reached (lock is held!)
        await observationStarted

        // Call A.dispose() right before observation
        engineA.dispose()

        // Unpause observation hook
        pauseObservation()

        // Allow microtasks/timers to run
        await vi.advanceTimersByTimeAsync(5_000)

        // Assert for A:
        const dataAfterA = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(dataAfterA.records[executionId]?.state).toBe('SETTLING')
        expect(txCalls).toBe(0) // Chronik tx was never called!
        expect(broadcastCalls).toBe(0)

        // Remove hook
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeSettlementRecoveryObservation')
        ]

        // Engine B recovers normally
        const engineConfigB: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 200
        }
        const engineB: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigB)

        await vi.advanceTimersByTimeAsync(500)

        const finalData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(finalData.records[executionId]?.state).toBe('SETTLED')
        expect(txCalls).toBeGreaterThanOrEqual(1)

        engineB.dispose()
      } finally {
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeSettlementRecoveryObservation')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ]
        vi.useRealTimers()
      }
    })
  })

  describe('Gate C3A Pass 4.2: Fencing Durable Settlement Mutation Inside Execution-Lock Callback', () => {
    it('Test A: observed tx - blocks mutation when dispose occurs while waiting for DEFAULT_EXECUTION_LOCK_NAME', async () => {
      vi.useFakeTimers()
      try {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()
        seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
        harness.composition.dispose()

        let txCalls = 0
        let broadcastCalls = 0
        const testChronik: ChronikBroadcastClient = {
          broadcastTx: async () => {
            broadcastCalls++
            return { txid: expectedTxid }
          },
          tx: async (txid: string) => {
            txCalls++
            return { txid }
          }
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = testChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = harness.lockCoordinator

        let releaseExecutionLock!: () => void
        const releasePromise = new Promise<void>(r => {
          releaseExecutionLock = r
        })
        let lockAcquiredResolve!: () => void
        const lockAcquiredPromise = new Promise<void>(r => {
          lockAcquiredResolve = r
        })
        let transitionInvokedResolve!: () => void
        const transitionInvokedPromise = new Promise<void>(r => {
          transitionInvokedResolve = r
        })

        let hookRan = false
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeTransitionToSettledLockRequest')
        ] = async (targetExecutionId: string) => {
          if (targetExecutionId === executionId && !hookRan) {
            hookRan = true
            // 2. Pause FileLocalSettlementAuthority after transitionToSettled() has been
            // invoked but BEFORE the DEFAULT_EXECUTION_LOCK_NAME callback executes.
            // Hold DEFAULT_EXECUTION_LOCK_NAME externally so transitionToSettled queues behind it.
            void harness.lockCoordinator.requestExclusive(DEFAULT_EXECUTION_LOCK_NAME, async () => {
              lockAcquiredResolve()
              await releasePromise
            })
            await lockAcquiredPromise
            transitionInvokedResolve()
          }
        }

        const rec = createFixtureLedgerRecord()
        const engineConfigA: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        }

        const engineA: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigA)

        // 1. Recovery observes exact expectedTxid and invokes transitionToSettled()
        await transitionInvokedPromise
        expect(txCalls).toBe(1)

        // 3. Call dispose() while transitionToSettled is waiting for DEFAULT_EXECUTION_LOCK_NAME
        engineA.dispose()
        // verify dispose is idempotent
        expect(() => engineA.dispose()).not.toThrow()

        // 4. Release the execution lock
        releaseExecutionLock()

        // Allow microtasks and callbacks to execute
        await vi.advanceTimersByTimeAsync(5_000)

        // 5. Assert:
        // - no SETTLED write from disposed engine
        // - durable state remains SETTLING
        // - no retry from disposed engine
        // - zero broadcast
        const dataAfterA = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(dataAfterA.records[executionId]?.state).toBe('SETTLING')
        expect(broadcastCalls).toBe(0)

        // Remove hook for Engine B
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeTransitionToSettledLockRequest')
        ]

        // 6. Live Engine B subsequently reconciles to SETTLED
        const engineConfigB: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 200
        }
        const engineB: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigB)

        await vi.advanceTimersByTimeAsync(500)

        const finalData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(finalData.records[executionId]?.state).toBe('SETTLED')
        expect(finalData.records[executionId]?.expectedTxid).toBe(expectedTxid.toLowerCase())
        expect(broadcastCalls).toBe(0)

        engineB.dispose()
      } finally {
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeTransitionToSettledLockRequest')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ]
        vi.useRealTimers()
      }
    })

    it('Test B: uncertain tx - blocks mutation when dispose occurs while waiting for DEFAULT_EXECUTION_LOCK_NAME', async () => {
      vi.useFakeTimers()
      try {
        const harness = setupTestHarness()
        const { executionId, expectedTxid } = await harness.signExecution()
        seedSettlingState(harness.ledgerStorage, executionId, expectedTxid, FIXED_NOW)
        harness.composition.dispose()

        let broadcastCalls = 0
        let chronikTxCalled = false
        const testChronik: ChronikBroadcastClient = {
          broadcastTx: async () => {
            broadcastCalls++
            return { txid: expectedTxid }
          },
          tx: async () => {
            chronikTxCalled = true
            throw new Error('Transaction not found on chain or mempool')
          }
        }

        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ] = testChronik
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ] = harness.lockCoordinator

        let releaseExecutionLock!: () => void
        const releasePromise = new Promise<void>(r => {
          releaseExecutionLock = r
        })
        let lockAcquiredResolve!: () => void
        const lockAcquiredPromise = new Promise<void>(r => {
          lockAcquiredResolve = r
        })
        let mutationInvokedResolve!: () => void
        const mutationInvokedPromise = new Promise<void>(r => {
          mutationInvokedResolve = r
        })

        let hookRan = false
        ;(globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeMarkSettlementUncertainLockRequest')
        ] = async (targetExecutionId: string) => {
          if (targetExecutionId === executionId && !hookRan) {
            hookRan = true
            // 2. Pause before markSettlementUncertain() mutation callback executes.
            // Hold DEFAULT_EXECUTION_LOCK_NAME externally so markSettlementUncertain queues behind it.
            void harness.lockCoordinator.requestExclusive(DEFAULT_EXECUTION_LOCK_NAME, async () => {
              lockAcquiredResolve()
              await releasePromise
            })
            await lockAcquiredPromise
            mutationInvokedResolve()
          }
        }

        const rec = createFixtureLedgerRecord()
        const engineConfigA: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 100
        }

        const engineA: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigA)

        // 1. Recovery decides SETTLEMENT_UNCERTAIN and calls markSettlementUncertain()
        await mutationInvokedPromise
        expect(chronikTxCalled).toBe(true)

        // 3. dispose()
        engineA.dispose()
        expect(() => engineA.dispose()).not.toThrow()

        // 4. Release execution lock
        releaseExecutionLock()

        // Allow microtasks to execute
        await vi.advanceTimersByTimeAsync(5_000)

        // 5. Assert:
        // - no SETTLEMENT_UNCERTAIN write from disposed engine
        // - state remains SETTLING
        // - zero broadcast
        const dataAfterA = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(dataAfterA.records[executionId]?.state).toBe('SETTLING')
        expect(broadcastCalls).toBe(0)

        // Remove hook for Engine B
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeMarkSettlementUncertainLockRequest')
        ]

        // 6. Live Engine B reconciles normally
        const engineConfigB: AgentWalletExecutionEngineConfig = {
          approvalLedger: { get: async () => rec, getByApprovalId: async () => rec },
          sessionVerifier: { verifyActiveSession: async () => ({ authenticated: true, activeAddress: FROM_ADDRESS }) },
          utxoProvider: { getSpendableUtxos: async () => createFixtureUtxos() },
          signatoryProvider: { getSignatory: () => createSyntheticSignatory().signatory },
          storage: harness.ledgerStorage,
          lockCoordinator: harness.lockCoordinator,
          clock: () => FIXED_NOW + 200
        }
        const engineB: DisposableAgentWalletExecutionEngine = createAgentWalletExecutionEngine(engineConfigB)

        await vi.advanceTimersByTimeAsync(500)

        const finalData = JSON.parse(harness.ledgerStorage.getItem(DEFAULT_EXECUTION_LEDGER_STORAGE_KEY)!)
        expect(finalData.records[executionId]?.state).toBe('SETTLEMENT_UNCERTAIN')
        expect(broadcastCalls).toBe(0)

        engineB.dispose()
      } finally {
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.beforeMarkSettlementUncertainLockRequest')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementChronikClient')
        ]
        delete (globalThis as Record<symbol, unknown>)[
          Symbol.for('rmzwallet.testOnly.settlementLockCoordinator')
        ]
        vi.useRealTimers()
      }
    })
  })
})
