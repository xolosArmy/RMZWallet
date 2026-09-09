/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentApprovalModal } from './AgentWalletApprovalModal'
import { createAgentWalletApprovalReceiver } from '../../features/agentWalletApprovalReceiver/receiver'
import { InMemoryWalletApprovalLedger, createMockSessionVerifier } from '../../features/agentWalletApprovalReceiver/testUtils'
import type { WalletApprovalPresentation } from '../../features/agentWalletApprovalReceiver/types'

afterEach(() => {
  cleanup()
})

const VALID_PRESENTATION: WalletApprovalPresentation = {
  requestId: 'wallet-req-test-001',
  intentId: 'intent-test-001',
  decisionId: 'cae-test-001',
  amountSats: '1500000',
  amountXEC: '15000.00 XEC',
  fromAddress: 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2',
  destination: 'ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5',
  network: 'xec:mainnet',
  agentId: 'agent-finance-001',
  agentRole: 'automated_treasury',
  reason: 'Automated treasury rebalance',
  memo: 'Monthly allocation',
  policyTraceId: 'trace-cae-test-999',
  policyReasonCode: 'POLICY_MANUAL_REVIEW',
  policyVersion: 'cae-v1.0.0',
  policyReason: 'Amount exceeds autonomous threshold',
  requestedAt: 1770000000,
  requestedAtIso: '2026-02-02T02:40:00.000Z',
  effectiveExpiresAt: 1770000300,
  effectiveExpiresAtIso: '2026-02-02T02:45:00.000Z',
  presentationHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
}

describe('AgentApprovalModal Component (Gate 2B)', () => {
  it('renders all presentation fields and prominent security warning', () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(VALID_PRESENTATION.fromAddress)
    const receiver = createAgentWalletApprovalReceiver({
      ledger,
      sessionVerifier,
      declaredOrigin: 'https://app.tonalli.cash'
    })

    render(
      <AgentApprovalModal
        handle="hnd_test_001"
        presentation={VALID_PRESENTATION}
        receiver={receiver}
        isOpen={true}
        onClose={vi.fn()}
      />
    )

    // Verify prominent security notice
    const banner = screen.getByTestId('security-notice-banner')
    expect(banner).toBeTruthy()
    expect(banner.textContent).toContain('Aprobación únicamente; no firma ni transmite una transacción.')

    // Verify amount in XEC and sats
    expect(screen.getByText('15000.00 XEC')).toBeTruthy()
    expect(screen.getByText('(1500000 satoshis)')).toBeTruthy()

    // Verify addresses
    expect(screen.getByText(VALID_PRESENTATION.destination)).toBeTruthy()
    expect(screen.getByText(VALID_PRESENTATION.fromAddress)).toBeTruthy()

    // Verify agent info
    expect(screen.getByText('agent-finance-001 (automated_treasury)')).toBeTruthy()

    // Verify reason & memo
    expect(screen.getByText('Automated treasury rebalance')).toBeTruthy()
    expect(screen.getByText('Monthly allocation')).toBeTruthy()

    // Verify CAE policy info
    expect(screen.getByText('POLICY_MANUAL_REVIEW (vcae-v1.0.0)')).toBeTruthy()
    expect(screen.getByText('Amount exceeds autonomous threshold')).toBeTruthy()
    expect(screen.getByText('trace-cae-test-999')).toBeTruthy()
  })

  it('approves handle through receiver and fires onApprovalSuccess', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(VALID_PRESENTATION.fromAddress)
    const receiver = createAgentWalletApprovalReceiver({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      idGenerator: () => 'fixed_id',
      declaredOrigin: 'https://app.tonalli.cash'
    })

    // Prepare real request to get real review handle
    const request = {
      contractVersion: '1.0',
      kind: 'wallet_approval_request',
      requestId: VALID_PRESENTATION.requestId,
      purpose: 'xec_payment',
      intent: {
        contractVersion: '1.0',
        kind: 'agent_intent',
        intentId: VALID_PRESENTATION.intentId,
        nonce: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NQ',
        agentId: VALID_PRESENTATION.agentId,
        agentRole: VALID_PRESENTATION.agentRole,
        network: 'xec:mainnet',
        fromAddress: VALID_PRESENTATION.fromAddress,
        toAddress: VALID_PRESENTATION.destination,
        amountSats: VALID_PRESENTATION.amountSats,
        reason: VALID_PRESENTATION.reason,
        memo: VALID_PRESENTATION.memo,
        createdAt: 1770000000,
        expiresAt: 1770000300
      },
      policyDecision: {
        contractVersion: '1.0',
        kind: 'cae_policy_decision',
        decisionId: VALID_PRESENTATION.decisionId,
        intentId: VALID_PRESENTATION.intentId,
        decision: 'needs_human_approval',
        reasonCode: VALID_PRESENTATION.policyReasonCode,
        reason: VALID_PRESENTATION.policyReason,
        policyTraceId: VALID_PRESENTATION.policyTraceId,
        policyVersion: VALID_PRESENTATION.policyVersion,
        evaluatedAt: 1770000001,
        expiresAt: 1770000300
      },
      requestedAt: 1770000002,
      expiresAt: 1770000300
    }

    const reviewState = await receiver.prepareRequest(request)

    const onApprovalSuccess = vi.fn()
    const onClose = vi.fn()

    render(
      <AgentApprovalModal
        handle={reviewState.handle}
        presentation={reviewState.presentation}
        receiver={receiver}
        isOpen={true}
        onApprovalSuccess={onApprovalSuccess}
        onClose={onClose}
      />
    )

    const approveButton = screen.getByTestId('approve-button')
    fireEvent.click(approveButton)

    await waitFor(() => {
      expect(onApprovalSuccess).toHaveBeenCalledOnce()
    })

    const receipt = onApprovalSuccess.mock.calls[0][0]
    expect(receipt.status).toBe('approved')
    expect(receipt.approver).toBe(VALID_PRESENTATION.fromAddress)
    expect(receipt.requestId).toBe(VALID_PRESENTATION.requestId)

    // Check that ledger atomically recorded the approval
    const inLedger = await ledger.get(VALID_PRESENTATION.requestId)
    expect(inLedger).toBeDefined()
    expect(inLedger?.status).toBe('approved')
    expect(inLedger?.humanApproval.status).toBe('approved')
  })

  it('rejects handle through receiver with reason and fires onRejectionSuccess', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    const sessionVerifier = createMockSessionVerifier(VALID_PRESENTATION.fromAddress)
    const receiver = createAgentWalletApprovalReceiver({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      idGenerator: () => 'fixed_id_reject',
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const request = {
      contractVersion: '1.0',
      kind: 'wallet_approval_request',
      requestId: 'req-reject-001',
      purpose: 'xec_payment',
      intent: {
        contractVersion: '1.0',
        kind: 'agent_intent',
        intentId: 'intent-reject-001',
        nonce: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NQ',
        agentId: VALID_PRESENTATION.agentId,
        agentRole: VALID_PRESENTATION.agentRole,
        network: 'xec:mainnet',
        fromAddress: VALID_PRESENTATION.fromAddress,
        toAddress: VALID_PRESENTATION.destination,
        amountSats: '100',
        reason: 'Payment to be rejected',
        createdAt: 1770000000,
        expiresAt: 1770000300
      },
      policyDecision: {
        contractVersion: '1.0',
        kind: 'cae_policy_decision',
        decisionId: 'cae-reject-001',
        intentId: 'intent-reject-001',
        decision: 'needs_human_approval',
        reasonCode: 'POLICY_MANUAL_REVIEW',
        reason: 'Review',
        policyTraceId: 'trace-reject-001',
        policyVersion: 'cae-v1.0.0',
        evaluatedAt: 1770000001,
        expiresAt: 1770000300
      },
      requestedAt: 1770000002,
      expiresAt: 1770000300
    }

    const reviewState = await receiver.prepareRequest(request)
    const onRejectionSuccess = vi.fn()
    const onClose = vi.fn()

    render(
      <AgentApprovalModal
        handle={reviewState.handle}
        presentation={reviewState.presentation}
        receiver={receiver}
        isOpen={true}
        onRejectionSuccess={onRejectionSuccess}
        onClose={onClose}
      />
    )

    // Click reject button toggle to show reason input
    fireEvent.click(screen.getByTestId('reject-button-toggle'))

    // Type reject reason
    const input = screen.getByLabelText('Motivo del rechazo (opcional):')
    fireEvent.change(input, { target: { value: 'Suspicious request reason' } })

    // Confirm reject
    fireEvent.click(screen.getByTestId('confirm-reject-button'))

    await waitFor(() => {
      expect(onRejectionSuccess).toHaveBeenCalledOnce()
    })

    const receipt = onRejectionSuccess.mock.calls[0][0]
    expect(receipt.status).toBe('rejected')
    expect(receipt.reason).toBe('Suspicious request reason')

    // Check that ledger atomically recorded the rejection
    const inLedger = await ledger.get('req-reject-001')
    expect(inLedger).toBeDefined()
    expect(inLedger?.status).toBe('rejected')
    expect(inLedger?.humanApproval.status).toBe('rejected')
    expect(inLedger?.humanApproval.reason).toBe('Suspicious request reason')
  })

  it('fails closed when active address does not match fromAddress and displays error', async () => {
    const ledger = new InMemoryWalletApprovalLedger()
    // Session is for a DIFFERENT address
    const sessionVerifier = createMockSessionVerifier(
      'ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5'
    )
    const receiver = createAgentWalletApprovalReceiver({
      ledger,
      sessionVerifier,
      clock: () => 1770000010,
      declaredOrigin: 'https://app.tonalli.cash'
    })

    const request = {
      contractVersion: '1.0',
      kind: 'wallet_approval_request',
      requestId: 'req-mismatch-001',
      purpose: 'xec_payment',
      intent: {
        contractVersion: '1.0',
        kind: 'agent_intent',
        intentId: 'intent-mismatch-001',
        nonce: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NQ',
        agentId: VALID_PRESENTATION.agentId,
        agentRole: VALID_PRESENTATION.agentRole,
        network: 'xec:mainnet',
        fromAddress: 'ecash:qz2708636snqhsxu8wnlka78h6fdp77ar59j2t0fh2', // Different
        toAddress: 'ecash:qp3wjpa3tjlj042z2wv7hah0ldgwhwy0rq9sywjpy5',
        amountSats: '100',
        reason: 'Payment with address mismatch',
        createdAt: 1770000000,
        expiresAt: 1770000300
      },
      policyDecision: {
        contractVersion: '1.0',
        kind: 'cae_policy_decision',
        decisionId: 'cae-mismatch-001',
        intentId: 'intent-mismatch-001',
        decision: 'needs_human_approval',
        reasonCode: 'POLICY_MANUAL_REVIEW',
        reason: 'Review',
        policyTraceId: 'trace-mismatch-001',
        policyVersion: 'cae-v1.0.0',
        evaluatedAt: 1770000001,
        expiresAt: 1770000300
      },
      requestedAt: 1770000002,
      expiresAt: 1770000300
    }

    const reviewState = await receiver.prepareRequest(request)
    const onError = vi.fn()

    render(
      <AgentApprovalModal
        handle={reviewState.handle}
        presentation={reviewState.presentation}
        receiver={receiver}
        isOpen={true}
        onError={onError}
        onClose={vi.fn()}
      />
    )

    fireEvent.click(screen.getByTestId('approve-button'))

    await waitFor(() => {
      expect(onError).toHaveBeenCalledOnce()
    })

    const error = onError.mock.calls[0][0]
    expect(error.message).toContain('SESSION_ADDRESS_MISMATCH')

    // Error message displayed to user
    const errorDisplay = screen.getByTestId('agent-approval-error')
    expect(errorDisplay.textContent).toContain('SESSION_ADDRESS_MISMATCH')

    // Ensure zero records entered the ledger
    const inLedger = await ledger.get('req-mismatch-001')
    expect(inLedger).toBeUndefined()
  })
})
