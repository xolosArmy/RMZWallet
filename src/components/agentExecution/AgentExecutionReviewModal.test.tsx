/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentExecutionReviewModal } from './AgentExecutionReviewModal'
import type {
  SignedExecutionHandle,
  WalletExecutionReviewSnapshot,
  WalletExecutionSession
} from '../../features/agentWalletExecution'

afterEach(() => {
  cleanup()
})

const MOCK_REVIEW: WalletExecutionReviewSnapshot = {
  recipient: 'ecash:qr4upmst92u7sfm6vqxz29r4ug4rysdpcyk8hcgvqm',
  amountXEC: '2500.00 XEC',
  amountSats: '250000',
  feeXEC: '2.72 XEC',
  feeSats: '272',
  totalDebitXEC: '2502.72 XEC',
  totalDebitSats: '250272',
  fundingAddress: 'ecash:qpumqqygwcnt999fz3gp5nxjy66ckg6esvxaqmtclv',
  network: 'xec:mainnet',
  approvalId: 'appr_test_123',
  requestId: 'req_test_456',
  intentId: 'intent_test_789',
  planHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0'
}

function createMockSession(overrides: Partial<WalletExecutionSession> = {}): WalletExecutionSession {
  return {
    executionId: 'exec_test_001',
    handle: 'exec_test_001',
    plan: {
      network: 'xec:mainnet',
      fromAddress: MOCK_REVIEW.fundingAddress,
      destination: MOCK_REVIEW.recipient,
      paymentAmountSats: 250_000n,
      changeAmountSats: 249_728n,
      changeAddress: MOCK_REVIEW.fundingAddress,
      feeSats: 272n,
      feeRateSatsPerByte: 1.2,
      inputs: [],
      outputs: [],
      totalInputSats: 500_000n,
      transactionVersion: 2,
      locktime: 0,
      approvalId: MOCK_REVIEW.approvalId,
      requestId: MOCK_REVIEW.requestId,
      intentId: MOCK_REVIEW.intentId,
      planHash: MOCK_REVIEW.planHash
    },
    review: MOCK_REVIEW,
    confirmExecution: vi.fn().mockResolvedValue({
      executionId: 'exec_test_001',
      approvalId: MOCK_REVIEW.approvalId,
      requestId: MOCK_REVIEW.requestId,
      status: 'SIGNED',
      planHash: MOCK_REVIEW.planHash,
      signedAt: 1800000050
    } satisfies SignedExecutionHandle),
    rejectExecution: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn(),
    ...overrides
  }
}

describe('AgentExecutionReviewModal Component (Gate C2)', () => {
  it('does not render when isOpen is false', () => {
    const session = createMockSession()
    render(
      <AgentExecutionReviewModal
        session={session}
        isOpen={false}
        onClose={vi.fn()}
      />
    )

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders review fields and prominent local signing banner when open', () => {
    const session = createMockSession()
    render(
      <AgentExecutionReviewModal
        session={session}
        isOpen={true}
        onClose={vi.fn()}
      />
    )

    // Dialog exists
    expect(screen.getByRole('dialog')).toBeTruthy()

    // Title and banner
    expect(screen.getByText('Revisión Final de Ejecución (Gate C2)')).toBeTruthy()
    expect(
      screen.getByText(/🛡️ Firma local en dispositivo; NO transmite a la red\./)
    ).toBeTruthy()

    // Presentation of financial amounts
    expect(screen.getByText(MOCK_REVIEW.recipient)).toBeTruthy()
    expect(screen.getByText(MOCK_REVIEW.amountXEC)).toBeTruthy()
    expect(screen.getByText(MOCK_REVIEW.feeXEC)).toBeTruthy()
    expect(screen.getByText(MOCK_REVIEW.totalDebitXEC)).toBeTruthy()
    expect(screen.getByText(MOCK_REVIEW.fundingAddress)).toBeTruthy()
    expect(screen.getByText('xec:mainnet')).toBeTruthy()
    expect(screen.getByText(MOCK_REVIEW.approvalId)).toBeTruthy()
    expect(screen.getByText(MOCK_REVIEW.requestId)).toBeTruthy()
    expect(screen.getByText(MOCK_REVIEW.planHash)).toBeTruthy()
  })

  it('calls session.confirmExecution and onExecutionSuccess on confirmation', async () => {
    const session = createMockSession()
    const onSuccess = vi.fn()
    const onClose = vi.fn()

    render(
      <AgentExecutionReviewModal
        session={session}
        isOpen={true}
        onExecutionSuccess={onSuccess}
        onClose={onClose}
      />
    )

    const confirmButton = screen.getByRole('button', { name: 'Confirmar y Firmar' })
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(session.confirmExecution).toHaveBeenCalledTimes(1)
      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'SIGNED',
          executionId: 'exec_test_001',
          planHash: MOCK_REVIEW.planHash
        })
      )
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('calls session.rejectExecution and onExecutionRejected when cancelled', async () => {
    const session = createMockSession()
    const onRejected = vi.fn()
    const onClose = vi.fn()

    render(
      <AgentExecutionReviewModal
        session={session}
        isOpen={true}
        onExecutionRejected={onRejected}
        onClose={onClose}
      />
    )

    const rejectButton = screen.getByRole('button', { name: 'Cancelar' })
    fireEvent.click(rejectButton)

    await waitFor(() => {
      expect(session.rejectExecution).toHaveBeenCalledWith('Execution rejected by custodian.')
      expect(onRejected).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('displays error alert when confirmExecution throws', async () => {
    const session = createMockSession({
      confirmExecution: vi.fn().mockRejectedValue(new Error('Signing device disconnected.'))
    })
    const onError = vi.fn()

    render(
      <AgentExecutionReviewModal
        session={session}
        isOpen={true}
        onError={onError}
        onClose={vi.fn()}
      />
    )

    const confirmButton = screen.getByRole('button', { name: 'Confirmar y Firmar' })
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(screen.getByText('Signing device disconnected.')).toBeTruthy()
      expect(onError).toHaveBeenCalledWith(expect.any(Error))
    })
  })

  it('calls session.dismiss and onClose when Escape key is pressed', async () => {
    const session = createMockSession()
    const onClose = vi.fn()

    render(
      <AgentExecutionReviewModal
        session={session}
        isOpen={true}
        onClose={onClose}
      />
    )

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(session.dismiss).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
