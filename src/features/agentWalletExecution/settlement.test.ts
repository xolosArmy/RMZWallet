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

import { describe, expect, it, vi } from 'vitest'
import { ALL_BIP143, Ecc, P2PKHSignatory, Tx } from 'ecash-lib'
import { humanApprovalV1Schema, type HumanApprovalV1 } from '@xolosarmy/tonalli-core'
import type { WalletApprovalLedgerRecord } from '../agentWalletApprovalReceiver/types'
import '../../internal/agentWalletExecutionHost/trustedWalletExecutionRuntime'
import type { WalletExecutionComposition } from '../../internal/agentWalletExecutionHost'
import type {
  AgentWalletExecutionEngineConfig,
  ChronikBroadcastClient,
  ExecutionUtxoInput,
  WalletExecutionTrustedOptions
} from './types'
import {
  deriveExpectedTxidFromRawTxHex,
  isDefinitiveConsensusRejection
} from './settlementUtils'
import {
  canonicalOutpointKey,
  DurableTransactionalExecutionLedger,
  WebLocksExecutionCoordinator
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

  let txImpl: (txid: string) => Promise<unknown> = async txid => {
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
    chronik: mockChronik,
    clock: () => FIXED_NOW,
    idGenerator: () => 'exec_test_c3a'
  }

  const composition = createWalletExecutionComposition(config, {
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

  describe('Test 6: Definitive Consensus Rejection', () => {
    it('transitions to SETTLEMENT_REJECTED on definitive consensus rejection', async () => {
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
        /Settlement rejected by network consensus/
      )

      const status = await harness.composition.publicEngine.getExecutionStatus(executionId)
      expect(status?.status).toBe('SETTLEMENT_REJECTED')
      expect(status?.uncertainReason).toContain('txn-mempool-conflict')

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
    it('queries network first and marks SETTLED if observed, with 0 rebroadcast', async () => {
      const harness = setupTestHarness()
      const { executionId, expectedTxid } = await harness.signExecution()

      // Transition to SETTLING manually to simulate a crash during settlement
      const ledger = new DurableTransactionalExecutionLedger({
        storage: harness.ledgerStorage,
        lockCoordinator: harness.lockCoordinator,
        clock: () => FIXED_NOW
      })
      await ledger.transitionToSettling({
        executionId,
        expectedTxid,
        settlingAt: FIXED_NOW
      })
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
          chronik: recoveredChronik,
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
      const ledger = new DurableTransactionalExecutionLedger({
        storage: harness.ledgerStorage,
        lockCoordinator: harness.lockCoordinator,
        clock: () => FIXED_NOW
      })
      await ledger.transitionToSettling({
        executionId,
        expectedTxid,
        settlingAt: FIXED_NOW
      })
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
          chronik: recoveredChronik,
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
          lockCoordinator: harness.lockCoordinator,
          chronik: harness.mockChronik
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
    it('accurately identifies definitive consensus errors vs transient errors', () => {
      // Definitive consensus rejections
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-inputs-spent'))).toBe(true)
      expect(isDefinitiveConsensusRejection(new Error('txn-mempool-conflict'))).toBe(true)
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-in-belowout'))).toBe(true)
      expect(isDefinitiveConsensusRejection(new Error('mandatory-script-verify-flag-failed'))).toBe(true)
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-vin-empty'))).toBe(true)
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-vout-empty'))).toBe(true)
      expect(isDefinitiveConsensusRejection(new Error('bad-txns-oversize'))).toBe(true)
      expect(isDefinitiveConsensusRejection(new Error('dust'))).toBe(true)

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
})
