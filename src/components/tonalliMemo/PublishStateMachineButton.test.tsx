/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PublishStateMachineButton } from './PublishStateMachineButton'

afterEach(() => {
  cleanup()
})

describe('PublishStateMachineButton Component', () => {
  it('renders idle state button and handles onPublish click', () => {
    const handlePublish = vi.fn()
    render(
      <PublishStateMachineButton
        phase="idle"
        onPublish={handlePublish}
        disabled={false}
      />
    )

    const btn = screen.getByTestId('publish-button-idle')
    expect(btn.textContent).toContain('Publicar Tonalli Memo')
    expect((btn as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(btn)
    expect(handlePublish).toHaveBeenCalledTimes(1)
  })

  it('disables idle button when disabled prop is true', () => {
    const handlePublish = vi.fn()
    render(
      <PublishStateMachineButton
        phase="idle"
        onPublish={handlePublish}
        disabled={true}
      />
    )

    const btn = screen.getByTestId('publish-button-idle') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    fireEvent.click(btn)
    expect(handlePublish).not.toHaveBeenCalled()
  })

  it('renders verifying_ownership phase with busy status and stepper step 1 active', () => {
    render(
      <PublishStateMachineButton
        phase="verifying_ownership"
        onPublish={vi.fn()}
      />
    )

    const btn = screen.getByTestId('publish-button-verifying') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-busy')).toBe('true')
    expect(btn.textContent).toContain('1/3 Verificando titularidad')

    const step1 = screen.getByTestId('step-ownership')
    expect(step1.className).toContain('state-step--active')

    const step2 = screen.getByTestId('step-authorization')
    expect(step2.className).not.toContain('state-step--active')
  })

  it('renders requesting_authorization phase with busy status and stepper step 2 active', () => {
    render(
      <PublishStateMachineButton
        phase="requesting_authorization"
        onPublish={vi.fn()}
      />
    )

    const btn = screen.getByTestId('publish-button-authorizing') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-busy')).toBe('true')
    expect(btn.textContent).toContain('2/3 Solicitando autorización')

    const step1 = screen.getByTestId('step-ownership')
    expect(step1.className).toContain('state-step--completed')

    const step2 = screen.getByTestId('step-authorization')
    expect(step2.className).toContain('state-step--active')
  })

  it('renders broadcasting phase with busy status and stepper step 3 active', () => {
    render(
      <PublishStateMachineButton
        phase="broadcasting"
        onPublish={vi.fn()}
      />
    )

    const btn = screen.getByTestId('publish-button-broadcasting') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-busy')).toBe('true')
    expect(btn.textContent).toContain('3/3 Transmitiendo a la red')

    const step1 = screen.getByTestId('step-ownership')
    expect(step1.className).toContain('state-step--completed')

    const step2 = screen.getByTestId('step-authorization')
    expect(step2.className).toContain('state-step--completed')

    const step3 = screen.getByTestId('step-broadcasting')
    expect(step3.className).toContain('state-step--active')
  })

  it('renders success phase with txid, explorer link, and reset button', () => {
    const handleReset = vi.fn()
    const testTxid = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

    render(
      <PublishStateMachineButton
        phase="success"
        onPublish={vi.fn()}
        onReset={handleReset}
        txid={testTxid}
      />
    )

    expect(screen.getByTestId('publish-success-card')).toBeTruthy()
    expect(screen.getByTestId('success-txid').textContent).toBe(testTxid)

    const explorerLink = screen.getByTestId('explorer-link') as HTMLAnchorElement
    expect(explorerLink.href).toBe(`https://explorer.e.cash/tx/${testTxid}`)
    expect(explorerLink.getAttribute('target')).toBe('_blank')

    const resetBtn = screen.getByTestId('publish-reset-button')
    fireEvent.click(resetBtn)
    expect(handleReset).toHaveBeenCalledTimes(1)
  })

  it('renders error phase with error message and retry button', () => {
    const handleRetry = vi.fn()
    const handleCancel = vi.fn()
    const errorMsg = 'Error de conexión con el nodo de difusión'

    render(
      <PublishStateMachineButton
        phase="error"
        onPublish={handleRetry}
        onReset={handleCancel}
        error={errorMsg}
      />
    )

    expect(screen.getByTestId('publish-error-card')).toBeTruthy()
    expect(screen.getByTestId('publish-error-message').textContent).toContain(errorMsg)

    const retryBtn = screen.getByTestId('publish-retry-button')
    fireEvent.click(retryBtn)
    expect(handleRetry).toHaveBeenCalledTimes(1)

    const cancelBtn = screen.getByTestId('publish-cancel-button')
    fireEvent.click(cancelBtn)
    expect(handleCancel).toHaveBeenCalledTimes(1)
  })
})
