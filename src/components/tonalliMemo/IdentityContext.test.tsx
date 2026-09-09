/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdentityContext } from './IdentityContext'

afterEach(() => {
  cleanup()
})

describe('IdentityContext Component', () => {
  const defaultAlias = 'satoshi.xec'
  const defaultAddress = 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'

  it('renders alias and owner address correctly', () => {
    render(
      <IdentityContext
        alias={defaultAlias}
        ownerAddress={defaultAddress}
        verificationStatus="unverified"
      />
    )

    expect(screen.getByTestId('identity-alias').textContent).toBe(defaultAlias)
    expect(screen.getByTestId('identity-address').textContent).toBe(defaultAddress)
    expect(screen.getByTestId('identity-status-unverified').textContent).toContain('Pendiente de verificación')
  })

  it('renders verifying state when verification is in progress', () => {
    render(
      <IdentityContext
        alias={defaultAlias}
        ownerAddress={defaultAddress}
        verificationStatus="verifying"
      />
    )

    expect(screen.getByTestId('identity-status-verifying').textContent).toContain('Verificando titularidad...')
    // "Verificar ahora" button should not be displayed when verifying
    expect(screen.queryByTestId('identity-verify-button')).toBeNull()
  })

  it('renders verified state when ownership has been proven', () => {
    render(
      <IdentityContext
        alias={defaultAlias}
        ownerAddress={defaultAddress}
        verificationStatus="verified"
      />
    )

    expect(screen.getByTestId('identity-status-verified').textContent).toContain('Titularidad verificada')
    // "Verificar ahora" button should not be displayed when already verified
    expect(screen.queryByTestId('identity-verify-button')).toBeNull()
  })

  it('renders failed state with error message when verification fails', () => {
    const errorMsg = 'El alias no pertenece a la dirección configurada.'
    render(
      <IdentityContext
        alias={defaultAlias}
        ownerAddress={defaultAddress}
        verificationStatus="failed"
        verificationError={errorMsg}
      />
    )

    expect(screen.getByTestId('identity-status-failed').textContent).toContain('Verificación fallida')
    const errorContainer = screen.getByTestId('identity-verification-error')
    expect(errorContainer.textContent).toContain(errorMsg)
  })

  it('allows clicking "Verificar ahora" when unverified', () => {
    const handleVerify = vi.fn()
    render(
      <IdentityContext
        alias={defaultAlias}
        ownerAddress={defaultAddress}
        verificationStatus="unverified"
        onVerify={handleVerify}
      />
    )

    const button = screen.getByTestId('identity-verify-button')
    fireEvent.click(button)
    expect(handleVerify).toHaveBeenCalledTimes(1)
  })

  it('disables "Verificar ahora" button when disabled prop is true', () => {
    const handleVerify = vi.fn()
    render(
      <IdentityContext
        alias={defaultAlias}
        ownerAddress={defaultAddress}
        verificationStatus="unverified"
        onVerify={handleVerify}
        disabled={true}
      />
    )

    const button = screen.getByTestId('identity-verify-button') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(handleVerify).not.toHaveBeenCalled()
  })
})
