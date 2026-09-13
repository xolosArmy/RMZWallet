/**
 * @vitest-environment jsdom
 */

import { StrictMode, useEffect } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ALL_BIP143, Ecc, P2PKHSignatory, Script, toHex } from 'ecash-lib'
import {
  TrustedWalletExecutionProvider,
  resetTrustedExecutionShellForTests,
  useTrustedWalletExecution
} from './index'
import { InMemoryWalletApprovalLedger, createMockSessionVerifier } from '../../features/agentWalletApprovalReceiver/testUtils'
import { createAgentWalletApprovalReceiver } from '../../features/agentWalletApprovalReceiver/receiver'
import { encodeAgentWalletHandoffV1 } from '../../features/agentWalletHandoff'
import {
  DurableTransactionalExecutionLedger
} from '../../features/agentWalletExecution/ledger'
import { MockStorage, TestExecutionLockCoordinator } from '../../features/agentWalletExecution/testUtils'
import { DurableWalletApprovalLedger } from './durableWalletApprovalLedger'
import type { AgentWalletExecutionEngine } from '../../features/agentWalletExecution'
import { DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY } from '../settlementStore'

const TEST_ONLY_PRIVATE_SETTLEMENT_STORAGE = Symbol.for(
  'rmzwallet.testOnly.privateSettlementStorage'
)

function bindTestPrivateSettlementStorage(storage: Storage): void {
  Object.defineProperty(globalThis, TEST_ONLY_PRIVATE_SETTLEMENT_STORAGE, {
    value: storage,
    configurable: true,
    enumerable: false,
    writable: true
  })
}

afterEach(() => {
  cleanup()
  resetTrustedExecutionShellForTests()
  Object.defineProperty(globalThis, TEST_ONLY_PRIVATE_SETTLEMENT_STORAGE, {
    value: undefined,
    configurable: true,
    enumerable: false,
    writable: true
  })
})

const FROM_ADDRESS = 'ecash:qpumqqygwcnt999fz3gp5nxjy66ckg6esvxaqmtclv'
const DESTINATION_ADDRESS = 'ecash:qr4upmst92u7sfm6vqxz29r4ug4rysdpcyk8hcgvqm'
const CLOCK_NOW = 1_770_000_010

const REQUEST = {
  contractVersion: '1.0',
  kind: 'wallet_approval_request' as const,
  requestId: 'req-shell-c2-001',
  purpose: 'xec_payment' as const,
  intent: {
    contractVersion: '1.0',
    kind: 'agent_intent' as const,
    intentId: 'intent-shell-c2-001',
    nonce: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NQ',
    agentId: 'agent-treasury-01',
    agentRole: 'service_executor',
    network: 'xec:mainnet' as const,
    fromAddress: FROM_ADDRESS,
    toAddress: DESTINATION_ADDRESS,
    amountSats: '500000',
    reason: 'Autonomous payout test',
    createdAt: 1770000000,
    expiresAt: 1770000300
  },
  policyDecision: {
    contractVersion: '1.0',
    kind: 'cae_policy_decision' as const,
    decisionId: 'cae-shell-c2-001',
    intentId: 'intent-shell-c2-001',
    decision: 'needs_human_approval' as const,
    reasonCode: 'AMOUNT_EXCEEDS_LIMIT',
    reason: 'Requires custodian sign-off',
    policyTraceId: 'trace-shell-c2-001',
    policyVersion: 'cae-policy-v1.0.0',
    evaluatedAt: 1770000001,
    expiresAt: 1770000300
  },
  requestedAt: 1770000002,
  expiresAt: 1770000300
}

function createSignatory() {
  const ecc = new Ecc()
  const secretKey = new Uint8Array(32).fill(9)
  const publicKey = ecc.derivePubkey(secretKey)
  return P2PKHSignatory(secretKey, publicKey, ALL_BIP143)
}

function CaptureEngine({
  onReady
}: {
  onReady: (engine: AgentWalletExecutionEngine) => void
}) {
  const { publicEngine } = useTrustedWalletExecution()
  useEffect(() => {
    if (publicEngine) onReady(publicEngine)
  }, [publicEngine, onReady])
  return null
}

describe('TrustedWalletExecutionProvider production shell (Gate C2)', () => {
  it('wires Gate 2B approval through publicEngine to the review modal and local signing', async () => {
    const approvalLedger = new InMemoryWalletApprovalLedger()
    const ledgerStorage = new MockStorage()
    const settlementStorage = new MockStorage()
    const lockCoordinator = new TestExecutionLockCoordinator()
    const executionLedger = new DurableTransactionalExecutionLedger({
      storage: ledgerStorage,
      lockCoordinator,
      clock: () => CLOCK_NOW
    })
    let receiverSeq = 0
    const receiver = createAgentWalletApprovalReceiver({
      ledger: approvalLedger,
      sessionVerifier: createMockSessionVerifier(FROM_ADDRESS),
      clock: () => CLOCK_NOW,
      idGenerator: () => `shell_${++receiverSeq}`,
      declaredOrigin: 'https://app.tonalli.cash'
    })
    const review = await receiver.prepareHandoff(encodeAgentWalletHandoffV1(REQUEST))
    const receipt = await receiver.approveHandle(review.handle)

    bindTestPrivateSettlementStorage(settlementStorage)
    let engine: AgentWalletExecutionEngine | null = null
    render(
      <TrustedWalletExecutionProvider
        approvalLedger={approvalLedger}
        executionLedger={executionLedger}
        sessionVerifier={{
          async verifyActiveSession() {
            return { authenticated: true, activeAddress: FROM_ADDRESS }
          }
        }}
        utxoProvider={{
          async getSpendableUtxos() {
            return [
              {
                txid: '33'.repeat(32),
                outIdx: 0,
                sats: 1_000_000n,
                lockingScriptHex: toHex(Script.fromAddress(FROM_ADDRESS).bytecode)
              }
            ]
          }
        }}
        signatoryProvider={{
          async getSignatory() {
            return createSignatory()
          }
        }}
        ledgerStorage={ledgerStorage}
        lockCoordinator={lockCoordinator}
        clock={() => CLOCK_NOW}
        idGenerator={() => 'shell_c2'}
      >
        <CaptureEngine onReady={value => { engine = value }} />
      </TrustedWalletExecutionProvider>
    )

    await waitFor(() => {
      expect(engine).not.toBeNull()
    })
    await engine!.prepareExecution(receipt)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Revisión Final de Ejecución (Gate C2)')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y Firmar' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    const raw = settlementStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!)['exec_shell_c2']).toBeDefined()
    expect(ledgerStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)).toBeNull()
  })

  it('does not open the C2 signing UI for a rejected Gate 2B decision', async () => {
    const approvalLedger = new InMemoryWalletApprovalLedger()
    const ledgerStorage = new MockStorage()
    const lockCoordinator = new TestExecutionLockCoordinator()
    let receiverSeq = 0
    const receiver = createAgentWalletApprovalReceiver({
      ledger: approvalLedger,
      sessionVerifier: createMockSessionVerifier(FROM_ADDRESS),
      clock: () => CLOCK_NOW,
      idGenerator: () => `rej_${++receiverSeq}`,
      declaredOrigin: 'https://app.tonalli.cash'
    })
    const rejectRequest = {
      ...REQUEST,
      requestId: 'req-shell-c2-rej',
      intent: { ...REQUEST.intent, intentId: 'intent-shell-c2-rej' },
      policyDecision: {
        ...REQUEST.policyDecision,
        decisionId: 'cae-shell-c2-rej',
        intentId: 'intent-shell-c2-rej'
      }
    }
    const review = await receiver.prepareHandoff(encodeAgentWalletHandoffV1(rejectRequest))
    const rejected = await receiver.rejectHandle(review.handle, { reason: 'No' })

    let engine: AgentWalletExecutionEngine | null = null
    render(
      <TrustedWalletExecutionProvider
        approvalLedger={approvalLedger}
        executionLedger={new DurableTransactionalExecutionLedger({
          storage: ledgerStorage,
          lockCoordinator,
          clock: () => CLOCK_NOW
        })}
        sessionVerifier={{
          async verifyActiveSession() {
            return { authenticated: true, activeAddress: FROM_ADDRESS }
          }
        }}
        utxoProvider={{ async getSpendableUtxos() { return [] } }}
        signatoryProvider={{ async getSignatory() { return createSignatory() } }}
        ledgerStorage={ledgerStorage}
        lockCoordinator={lockCoordinator}
        clock={() => CLOCK_NOW}
      >
        <CaptureEngine onReady={value => { engine = value }} />
      </TrustedWalletExecutionProvider>
    )
    await waitFor(() => expect(engine).not.toBeNull())
    await expect(engine!.prepareExecution(rejected)).rejects.toMatchObject({
      code: 'RECEIPT_NOT_APPROVED'
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  function testPorts(lockCoordinator: TestExecutionLockCoordinator, ledgerStorage: MockStorage) {
    return {
      approvalLedger: {
        async get() {
          return undefined
        }
      },
      sessionVerifier: {
        async verifyActiveSession() {
          return { authenticated: true, activeAddress: FROM_ADDRESS }
        }
      },
      utxoProvider: {
        async getSpendableUtxos() {
          return []
        }
      },
      signatoryProvider: {
        async getSignatory() {
          return createSignatory()
        }
      },
      executionLedger: new DurableTransactionalExecutionLedger({
        storage: ledgerStorage,
        lockCoordinator,
        clock: () => CLOCK_NOW
      }),
      ledgerStorage,
      lockCoordinator
    }
  }

  it('keeps a single composition across StrictMode double mount', async () => {
    const engines: AgentWalletExecutionEngine[] = []
    const ledgerStorage = new MockStorage()
    const lockCoordinator = new TestExecutionLockCoordinator()
    render(
      <StrictMode>
        <TrustedWalletExecutionProvider {...testPorts(lockCoordinator, ledgerStorage)}>
          <CaptureEngine onReady={value => engines.push(value)} />
        </TrustedWalletExecutionProvider>
      </StrictMode>
    )
    await waitFor(() => expect(engines.length).toBeGreaterThan(0))
    const unique = new Set(engines)
    expect(unique.size).toBe(1)
  })

  it('does not expose walletUIHost or settlement store on the public context', async () => {
    let captured: unknown
    function Probe() {
      captured = useTrustedWalletExecution()
      return null
    }
    const ledgerStorage = new MockStorage()
    const lockCoordinator = new TestExecutionLockCoordinator()
    render(
      <TrustedWalletExecutionProvider {...testPorts(lockCoordinator, ledgerStorage)}>
        <Probe />
      </TrustedWalletExecutionProvider>
    )
    expect(captured).toEqual({ publicEngine: expect.any(Object) })
    expect((captured as { publicEngine: object }).publicEngine).not.toHaveProperty('walletUIHost')
    expect((captured as { publicEngine: object }).publicEngine).not.toHaveProperty('confirm')
    expect((captured as { publicEngine: object }).publicEngine).not.toHaveProperty('dispose')
  })

  it('survives mount then unmount then remount without duplicate heartbeat or durable rejection', async () => {
    const ledgerStorage = new MockStorage()
    const settlementStorage = new MockStorage()
    const lockCoordinator = new TestExecutionLockCoordinator()
    const ports = testPorts(lockCoordinator, ledgerStorage)
    bindTestPrivateSettlementStorage(settlementStorage)
    const first = render(
      <TrustedWalletExecutionProvider {...ports}>
        <CaptureEngine onReady={() => undefined} />
      </TrustedWalletExecutionProvider>
    )
    first.unmount()
    await Promise.resolve()
    const engines: AgentWalletExecutionEngine[] = []
    render(
      <TrustedWalletExecutionProvider {...ports}>
        <CaptureEngine onReady={value => engines.push(value)} />
      </TrustedWalletExecutionProvider>
    )
    await waitFor(() => expect(engines.length).toBeGreaterThan(0))
    expect(engines[0]).not.toHaveProperty('dispose')
  })

  it('wires a shared durable Gate 2B ledger through production C2 publicEngine to SIGNED', async () => {
    const approvalStorage = new MockStorage()
    const lockCoordinator = new TestExecutionLockCoordinator()
    const approvalLedger = new DurableWalletApprovalLedger({
      storage: approvalStorage,
      lockCoordinator
    })
    const ledgerStorage = new MockStorage()
    const settlementStorage = new MockStorage()
    const executionLedger = new DurableTransactionalExecutionLedger({
      storage: ledgerStorage,
      lockCoordinator,
      clock: () => CLOCK_NOW
    })
    let receiverSeq = 0
    const receiver = createAgentWalletApprovalReceiver({
      ledger: approvalLedger,
      sessionVerifier: createMockSessionVerifier(FROM_ADDRESS),
      clock: () => CLOCK_NOW,
      idGenerator: () => `prod_${++receiverSeq}`,
      declaredOrigin: 'https://app.tonalli.cash'
    })
    const review = await receiver.prepareHandoff(encodeAgentWalletHandoffV1(REQUEST))
    const receipt = await receiver.approveHandle(review.handle)
    expect(await approvalLedger.get(REQUEST.requestId)).toBeDefined()

    bindTestPrivateSettlementStorage(settlementStorage)
    let engine: AgentWalletExecutionEngine | null = null
    render(
      <TrustedWalletExecutionProvider
        approvalLedger={approvalLedger}
        executionLedger={executionLedger}
        sessionVerifier={{
          async verifyActiveSession() {
            return { authenticated: true, activeAddress: FROM_ADDRESS }
          }
        }}
        utxoProvider={{
          async getSpendableUtxos() {
            return [
              {
                txid: '44'.repeat(32),
                outIdx: 0,
                sats: 1_000_000n,
                lockingScriptHex: toHex(Script.fromAddress(FROM_ADDRESS).bytecode)
              }
            ]
          }
        }}
        signatoryProvider={{
          async getSignatory() {
            return createSignatory()
          }
        }}
        ledgerStorage={ledgerStorage}
        lockCoordinator={lockCoordinator}
        clock={() => CLOCK_NOW}
        idGenerator={() => 'prod_c2'}
      >
        <CaptureEngine onReady={value => { engine = value }} />
      </TrustedWalletExecutionProvider>
    )
    await waitFor(() => expect(engine).not.toBeNull())
    await engine!.prepareExecution(receipt)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar y Firmar' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    const raw = settlementStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!)['exec_prod_c2']).toBeDefined()
    expect((await approvalLedger.get(REQUEST.requestId))?.status).toBe('approved')
  })
})
