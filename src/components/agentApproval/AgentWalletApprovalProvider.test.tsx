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
})
