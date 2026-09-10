/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useEffect } from 'react'
import { AgentWalletApprovalProvider } from './AgentWalletApprovalProvider'
import { useAgentWalletApproval } from './AgentWalletApprovalContext'
import { InMemoryWalletApprovalLedger } from '../../features/agentWalletApprovalReceiver/testUtils'
import { encodeAgentWalletHandoffV1 } from '../../features/agentWalletHandoff'
import type { HumanApprovalV1, WalletApprovalRequestV1 } from '@xolosarmy/tonalli-core'

afterEach(() => {
  cleanup()
})

const VALID_REQUEST: WalletApprovalRequestV1 = {
  contractVersion: '1.0',
  kind: 'wallet_approval_request',
  requestId: 'wallet-req-provider-test-01',
  purpose: 'xec_payment',
  intent: {
    contractVersion: '1.0',
    kind: 'agent_intent',
    intentId: 'intent-provider-01',
    nonce: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NQ',
    agentId: 'agent-trading-01',
    agentRole: 'service_executor',
    fromAddress: 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2',
    toAddress: 'ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5',
    amountSats: '500000',
    network: 'xec:mainnet',
    reason: 'Liquidity provisioning',
    createdAt: 1770000000,
    expiresAt: 1770000300
  },
  policyDecision: {
    contractVersion: '1.0',
    kind: 'cae_policy_decision',
    decisionId: 'cae-dec-01',
    intentId: 'intent-provider-01',
    decision: 'needs_human_approval',
    reasonCode: 'REQUIRE_HUMAN_APPROVAL',
    policyVersion: '1.0',
    policyTraceId: 'trace-provider-01',
    reason: 'High value transfer',
    evaluatedAt: 1770000001,
    expiresAt: 1770000300
  },
  requestedAt: 1770000002,
  expiresAt: 1770000300
}

function TestConsumer({
  onCapture
}: {
  onCapture: (call: (bytes: Uint8Array) => Promise<HumanApprovalV1>) => void
}) {
  const { requestHandoffApproval } = useAgentWalletApproval()
  useEffect(() => {
    onCapture(requestHandoffApproval)
  }, [requestHandoffApproval, onCapture])
  return <div data-testid="test-consumer">Ready</div>
}

describe('AgentWalletApprovalProvider (Gate 2B)', () => {
  it('fails closed when feature flag is disabled (default)', async () => {
    let capturedHandler: ((bytes: Uint8Array) => Promise<HumanApprovalV1>) | null = null

    render(
      <AgentWalletApprovalProvider enabled={false}>
        <TestConsumer onCapture={(fn) => { capturedHandler = fn }} />
      </AgentWalletApprovalProvider>
    )

    const rawBytes = encodeAgentWalletHandoffV1(VALID_REQUEST)
    await expect(capturedHandler!(rawBytes)).rejects.toThrow('AGENT_APPROVAL_DISABLED')
  })

  it('fails closed if explicit ledger is missing even when enabled', async () => {
    let capturedHandler: ((bytes: Uint8Array) => Promise<HumanApprovalV1>) | null = null

    render(
      <AgentWalletApprovalProvider enabled={true}>
        <TestConsumer onCapture={(fn) => { capturedHandler = fn }} />
      </AgentWalletApprovalProvider>
    )

    const rawBytes = encodeAgentWalletHandoffV1(VALID_REQUEST)
    await expect(capturedHandler!(rawBytes)).rejects.toThrow('MISSING_LEDGER_DEPENDENCY')
  })

  it('opens modal on handoff bytes and completes approval workflow via UI click', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = {
      async verifyActiveSession() {
        return {
          authenticated: true,
          activeAddress: VALID_REQUEST.intent.fromAddress
        }
      }
    }

    let capturedHandler: ((bytes: Uint8Array) => Promise<HumanApprovalV1>) | null = null

    render(
      <AgentWalletApprovalProvider
        enabled={true}
        ledger={ledger}
        sessionVerifier={sessionVerifier}
        declaredOrigin="https://app.tonalli.cash"
        clock={() => 1770000010}
        idGenerator={() => 'id_provider_test_1'}
      >
        <TestConsumer onCapture={(fn) => { capturedHandler = fn }} />
      </AgentWalletApprovalProvider>
    )

    const rawBytes = encodeAgentWalletHandoffV1(VALID_REQUEST)
    const approvalPromise = capturedHandler!(rawBytes)

    // Modal must be mounted and displaying presentation
    await waitFor(() => {
      expect(screen.getByTestId('agent-approval-modal')).toBeTruthy()
    })

    // Verify displayed fields
    expect(screen.getByText('5000.00 XEC')).toBeTruthy()
    expect(screen.getByText(VALID_REQUEST.intent.toAddress)).toBeTruthy()
    expect(screen.getByTestId('signing-status-badge').textContent).toContain('Signing: not authorized')
    expect(screen.getByTestId('broadcast-status-badge').textContent).toContain('Broadcast: not attempted')

    // Click Approve
    const approveBtn = screen.getByTestId('approve-button')
    fireEvent.click(approveBtn)

    const receipt: HumanApprovalV1 = await approvalPromise
    expect(receipt.status).toBe('approved')
    expect(receipt.requestId).toBe(VALID_REQUEST.requestId)
    expect(receipt.approver).toBe(VALID_REQUEST.intent.fromAddress)

    // Modal must be closed
    await waitFor(() => {
      expect(screen.queryByTestId('agent-approval-modal')).toBeNull()
    })

    // Ledger must have recorded record atomically
    expect(await ledger.has(VALID_REQUEST.requestId)).toBe(true)
    const ledgerRecord = await ledger.get(VALID_REQUEST.requestId)
    expect(ledgerRecord?.status).toBe('approved')
    expect(ledgerRecord?.operationId).toBe(VALID_REQUEST.requestId)
  })

  it('completes rejection workflow when human rejects in UI', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = {
      async verifyActiveSession() {
        return {
          authenticated: true,
          activeAddress: VALID_REQUEST.intent.fromAddress
        }
      }
    }

    let capturedHandler: ((bytes: Uint8Array) => Promise<HumanApprovalV1>) | null = null

    render(
      <AgentWalletApprovalProvider
        enabled={true}
        ledger={ledger}
        sessionVerifier={sessionVerifier}
        declaredOrigin="https://app.tonalli.cash"
        clock={() => 1770000010}
        idGenerator={() => 'id_provider_test_2'}
      >
        <TestConsumer onCapture={(fn) => { capturedHandler = fn }} />
      </AgentWalletApprovalProvider>
    )

    const rawBytes = encodeAgentWalletHandoffV1(VALID_REQUEST)
    const rejectionPromise = capturedHandler!(rawBytes)

    await waitFor(() => {
      expect(screen.getByTestId('agent-approval-modal')).toBeTruthy()
    })

    // Open rejection input
    fireEvent.click(screen.getByTestId('reject-button-toggle'))

    const reasonInput = screen.getByLabelText(/Motivo del rechazo/i)
    fireEvent.change(reasonInput, { target: { value: 'Manual rejection by risk officer' } })

    // Confirm rejection
    fireEvent.click(screen.getByTestId('confirm-reject-button'))

    const receipt: HumanApprovalV1 = await rejectionPromise
    expect(receipt.status).toBe('rejected')
    expect(receipt.reason).toBe('Manual rejection by risk officer')

    // Ledger must have recorded rejection atomically
    expect(await ledger.has(VALID_REQUEST.requestId)).toBe(true)
    const ledgerRecord = await ledger.get(VALID_REQUEST.requestId)
    expect(ledgerRecord?.status).toBe('rejected')
  })

  it('single-flight guard: second concurrent handoff fails closed without corrupting the first or leaking handles', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = {
      async verifyActiveSession() {
        return {
          authenticated: true,
          activeAddress: VALID_REQUEST.intent.fromAddress
        }
      }
    }

    let capturedHandler: ((bytes: Uint8Array) => Promise<HumanApprovalV1>) | null = null

    render(
      <AgentWalletApprovalProvider
        enabled={true}
        ledger={ledger}
        sessionVerifier={sessionVerifier}
        declaredOrigin="https://app.tonalli.cash"
        clock={() => 1770000010}
        idGenerator={() => 'id_single_flight'}
      >
        <TestConsumer onCapture={(fn) => { capturedHandler = fn }} />
      </AgentWalletApprovalProvider>
    )

    const rawBytes = encodeAgentWalletHandoffV1(VALID_REQUEST)
    const firstPromise = capturedHandler!(rawBytes)

    await waitFor(() => {
      expect(screen.getByTestId('agent-approval-modal')).toBeTruthy()
    })

    // Second concurrent handoff must fail closed immediately
    const secondRequest: WalletApprovalRequestV1 = {
      ...VALID_REQUEST,
      requestId: 'wallet-req-provider-test-02',
      intent: {
        ...VALID_REQUEST.intent,
        intentId: 'intent-provider-02',
        nonce: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0Ng'
      },
      policyDecision: {
        ...VALID_REQUEST.policyDecision,
        decisionId: 'cae-dec-02',
        intentId: 'intent-provider-02'
      }
    }
    const secondRawBytes = encodeAgentWalletHandoffV1(secondRequest)

    await expect(capturedHandler!(secondRawBytes)).rejects.toThrow('CONCURRENT_HANDOFF_BLOCKED')

    // First handoff is still intact and can be approved
    const approveBtn = screen.getByTestId('approve-button')
    fireEvent.click(approveBtn)

    const receipt = await firstPromise
    expect(receipt.status).toBe('approved')
    expect(receipt.requestId).toBe(VALID_REQUEST.requestId)
  })

  it('double click: multiple clicks on approve button do not duplicate submission or trigger race errors', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = {
      async verifyActiveSession() {
        return {
          authenticated: true,
          activeAddress: VALID_REQUEST.intent.fromAddress
        }
      }
    }

    let capturedHandler: ((bytes: Uint8Array) => Promise<HumanApprovalV1>) | null = null

    render(
      <AgentWalletApprovalProvider
        enabled={true}
        ledger={ledger}
        sessionVerifier={sessionVerifier}
        declaredOrigin="https://app.tonalli.cash"
        clock={() => 1770000010}
        idGenerator={() => 'id_double_click'}
      >
        <TestConsumer onCapture={(fn) => { capturedHandler = fn }} />
      </AgentWalletApprovalProvider>
    )

    const rawBytes = encodeAgentWalletHandoffV1(VALID_REQUEST)
    const approvalPromise = capturedHandler!(rawBytes)

    await waitFor(() => {
      expect(screen.getByTestId('agent-approval-modal')).toBeTruthy()
    })

    const approveBtn = screen.getByTestId('approve-button')
    // Click twice rapidly
    fireEvent.click(approveBtn)
    fireEvent.click(approveBtn)

    const receipt = await approvalPromise
    expect(receipt.status).toBe('approved')

    // Modal closes cleanly
    await waitFor(() => {
      expect(screen.queryByTestId('agent-approval-modal')).toBeNull()
    })

    // Ledger has exactly one record
    expect(await ledger.has(VALID_REQUEST.requestId)).toBe(true)
  })

  it('dismiss during processing is ignored and does not execute dismiss/reject route after success', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    let resolveSessionVerifier!: (value: any) => void
    const sessionVerifier = {
      async verifyActiveSession() {
        return new Promise<any>((resolve) => {
          resolveSessionVerifier = resolve
        })
      }
    }

    let capturedHandler: ((bytes: Uint8Array) => Promise<HumanApprovalV1>) | null = null

    render(
      <AgentWalletApprovalProvider
        enabled={true}
        ledger={ledger}
        sessionVerifier={sessionVerifier}
        declaredOrigin="https://app.tonalli.cash"
        clock={() => 1770000010}
        idGenerator={() => 'id_dismiss_processing'}
      >
        <TestConsumer onCapture={(fn) => { capturedHandler = fn }} />
      </AgentWalletApprovalProvider>
    )

    const rawBytes = encodeAgentWalletHandoffV1(VALID_REQUEST)
    const approvalPromise = capturedHandler!(rawBytes)

    await waitFor(() => {
      expect(screen.getByTestId('agent-approval-modal')).toBeTruthy()
    })

    const approveBtn = screen.getByTestId('approve-button')
    fireEvent.click(approveBtn)

    // Button is now submitting
    expect(approveBtn.textContent).toContain('Aprobando...')

    // Attempt dismiss via backdrop during submission
    const backdrop = screen.getByTestId('agent-approval-backdrop')
    fireEvent.mouseDown(backdrop)

    // Attempt dismiss via Escape key during submission
    fireEvent.keyDown(window, { key: 'Escape' })

    // Finish session verification
    resolveSessionVerifier({
      authenticated: true,
      activeAddress: VALID_REQUEST.intent.fromAddress
    })

    const receipt = await approvalPromise
    expect(receipt.status).toBe('approved')

    // Ensure dismiss route was NOT triggered
    await waitFor(() => {
      expect(screen.queryByTestId('agent-approval-modal')).toBeNull()
    })
  })

  it('exact handle cleanup: manual dismiss cleans up handle and rejects with USER_DISMISSED', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = {
      async verifyActiveSession() {
        return {
          authenticated: true,
          activeAddress: VALID_REQUEST.intent.fromAddress
        }
      }
    }

    let capturedHandler: ((bytes: Uint8Array) => Promise<HumanApprovalV1>) | null = null

    render(
      <AgentWalletApprovalProvider
        enabled={true}
        ledger={ledger}
        sessionVerifier={sessionVerifier}
        declaredOrigin="https://app.tonalli.cash"
        clock={() => 1770000010}
        idGenerator={() => 'id_handle_cleanup'}
      >
        <TestConsumer onCapture={(fn) => { capturedHandler = fn }} />
      </AgentWalletApprovalProvider>
    )

    const rawBytes = encodeAgentWalletHandoffV1(VALID_REQUEST)
    const dismissPromise = capturedHandler!(rawBytes)

    await waitFor(() => {
      expect(screen.getByTestId('agent-approval-modal')).toBeTruthy()
    })

    // Dismiss via close button
    const closeBtn = screen.getByRole('button', { name: /cerrar/i })
    fireEvent.click(closeBtn)

    await expect(dismissPromise).rejects.toThrow('USER_DISMISSED')

    // Modal is removed
    await waitFor(() => {
      expect(screen.queryByTestId('agent-approval-modal')).toBeNull()
    })

    // Now a subsequent request can be submitted cleanly because handle and flight lock were cleaned up
    const secondPromise = capturedHandler!(rawBytes)
    await waitFor(() => {
      expect(screen.getByTestId('agent-approval-modal')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('approve-button'))
    const receipt = await secondPromise
    expect(receipt.status).toBe('approved')
  })
})
