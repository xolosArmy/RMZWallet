/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TonalliMemoComposer } from './TonalliMemoComposer'
import type { Tm1PublisherExecutor } from './types'

afterEach(() => {
  cleanup()
})

function createMockExecutor(overrides: Partial<Tm1PublisherExecutor> = {}): Tm1PublisherExecutor {
  return {
    verifyOwnership: vi.fn().mockResolvedValue({ evidenceToken: 'mock-evidence-token' }),
    requestAuthorization: vi.fn().mockResolvedValue({ authToken: 'mock-auth-token' }),
    prepareAndSign: vi.fn().mockResolvedValue({
      preparedReview: { preparedId: 'prep-123' },
      signedReview: { preparedId: 'prep-123', signature: 'sig-abc' }
    }),
    broadcastAndFinalize: vi.fn().mockResolvedValue({
      txid: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      submissionId: 'sub-001'
    }),
    ...overrides
  }
}

describe('TonalliMemoComposer Integration', () => {
  it('renders initial state with empty editor, unverified identity, and disabled publish button', () => {
    const mockExecutor = createMockExecutor()
    render(<TonalliMemoComposer executor={mockExecutor} initialAlias="satoshi.xec" />)

    // Identity context
    expect(screen.getByTestId('identity-alias').textContent).toBe('satoshi.xec')
    expect(screen.getByTestId('identity-status-unverified')).toBeTruthy()

    // Editor
    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i }) as HTMLTextAreaElement
    expect(textarea.value).toBe('')

    // Preview
    expect(screen.getByTestId('preview-empty-state')).toBeTruthy()

    // Publish button disabled when empty
    const btn = screen.getByTestId('publish-button-idle') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('updates preview and enables publish button when user types a message', () => {
    const mockExecutor = createMockExecutor()
    render(<TonalliMemoComposer executor={mockExecutor} initialAlias="satoshi.xec" />)

    const textarea = screen.getByRole('textbox', { name: /mensaje de tonalli memo/i })
    fireEvent.change(textarea, { target: { value: 'Hola Mundo TM1' } })

    // Byte counter updated
    const counter = screen.getByTestId('memo-byte-counter')
    expect(counter.textContent).toContain('14') // "Hola Mundo TM1" = 14 bytes

    // Canonical preview generated
    expect(screen.queryByTestId('preview-empty-state')).toBeNull()
    expect(screen.getByTestId('preview-active-content')).toBeTruthy()
    expect(screen.getByTestId('script-hex').textContent?.startsWith('6a04544d4d00')).toBe(true)

    // Publish button enabled
    const btn = screen.getByTestId('publish-button-idle') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('allows manual verification of ownership via IdentityContext', async () => {
    const mockExecutor = createMockExecutor()
    render(<TonalliMemoComposer executor={mockExecutor} initialAlias="satoshi.xec" />)

    const verifyBtn = screen.getByTestId('identity-verify-button')
    fireEvent.click(verifyBtn)

    await waitFor(() => {
      expect(mockExecutor.verifyOwnership).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('identity-status-verified')).toBeTruthy()
    })
  })

  it('runs complete state machine lifecycle: Idle -> Verifying -> Authorizing -> Broadcasting -> Success', async () => {
    let resolveVerify: (val: object) => void
    let resolveAuth: (val: object) => void
    let resolveBroadcast: (val: { txid: string }) => void

    const mockExecutor: Tm1PublisherExecutor = {
      verifyOwnership: vi.fn().mockImplementation(() => new Promise((res) => { resolveVerify = res })),
      requestAuthorization: vi.fn().mockImplementation(() => new Promise((res) => { resolveAuth = res })),
      prepareAndSign: vi.fn().mockResolvedValue({
        preparedReview: { preparedId: 'prep-xyz' },
        signedReview: { preparedId: 'prep-xyz', signature: 'sig-xyz' }
      }),
      broadcastAndFinalize: vi.fn().mockImplementation(() => new Promise((res) => { resolveBroadcast = res }))
    }

    const testTxid = '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff'
    const handleSuccess = vi.fn()

    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialMessage="Mensaje verificado"
        onSuccess={handleSuccess}
      />
    )

    // 1. Initial idle state
    const publishBtn = screen.getByTestId('publish-button-idle')
    fireEvent.click(publishBtn)

    // 2. Verifying Ownership phase
    await waitFor(() => {
      expect(screen.getByTestId('publish-button-verifying')).toBeTruthy()
      expect(screen.getByTestId('step-ownership').className).toContain('state-step--active')
    })

    // Resolve Step 1
    resolveVerify!({ verified: true })

    // 3. Requesting Authorization phase
    await waitFor(() => {
      expect(screen.getByTestId('publish-button-authorizing')).toBeTruthy()
      expect(screen.getByTestId('step-authorization').className).toContain('state-step--active')
    })

    // Resolve Step 2 & 3
    resolveAuth!({ authorized: true })

    // 4. Broadcasting phase
    await waitFor(() => {
      expect(screen.getByTestId('publish-button-broadcasting')).toBeTruthy()
      expect(screen.getByTestId('step-broadcasting').className).toContain('state-step--active')
    })

    // Resolve Step 4
    resolveBroadcast!({ txid: testTxid })

    // 5. Success phase
    await waitFor(() => {
      expect(screen.getByTestId('publish-success-card')).toBeTruthy()
      expect(screen.getByTestId('success-txid').textContent).toBe(testTxid)
      expect(handleSuccess).toHaveBeenCalledWith(testTxid)
    })

    const explorerLink = screen.getByTestId('explorer-link') as HTMLAnchorElement
    expect(explorerLink.href).toBe(`https://explorer.e.cash/tx/${testTxid}`)

    // Reset back to idle
    const resetBtn = screen.getByTestId('publish-reset-button')
    fireEvent.click(resetBtn)

    await waitFor(() => {
      expect(screen.getByTestId('publish-button-idle')).toBeTruthy()
    })
  })

  it('handles error in state machine and allows retry', async () => {
    const mockExecutor = createMockExecutor({
      broadcastAndFinalize: vi
        .fn()
        .mockRejectedValueOnce(new Error('REJECTED_BY_CONSENSUS_NODE'))
        .mockResolvedValue({
          txid: 'retry-txid-1234567890123456789012345678901234567890123456789012345678901234',
          submissionId: 'retry-sub-001'
        })
    })

    render(
      <TonalliMemoComposer
        executor={mockExecutor}
        initialMessage="Mensaje con fallo"
      />
    )

    const publishBtn = screen.getByTestId('publish-button-idle')
    fireEvent.click(publishBtn)

    await waitFor(() => {
      expect(screen.getByTestId('publish-error-card')).toBeTruthy()
      expect(screen.getByTestId('publish-error-message').textContent).toContain('REJECTED_BY_CONSENSUS_NODE')
    })

    // Retry should trigger publish again
    const retryBtn = screen.getByTestId('publish-retry-button')
    fireEvent.click(retryBtn)

    await waitFor(() => {
      expect(mockExecutor.broadcastAndFinalize).toHaveBeenCalledTimes(2)
      // On second try it succeeds (mock resolved)
      expect(screen.getByTestId('publish-success-card')).toBeTruthy()
    })
  })
})
