// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WalletContext } from '../context/walletContext'
import type { WalletContextValue } from '../context/walletContext'
import { PENDING_IDENTITY_STATE } from '../services/quickStartStorage'
import { walletContextFixture } from '../test/walletContextFixture'
import { CreateBackedWallet, CreateWallet, ImportWallet, OnboardingHome } from './Onboarding'

const mockLocks = {
  request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) => callback({}))
}

beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: mockLocks })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function legacyPendingValue(overrides: Partial<WalletContextValue> = {}) {
  return walletContextFixture({
    pendingIdentityState: PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING,
    hasPendingIdentity: true,
    ...overrides
  })
}

function renderWithWallet(ui: ReactNode, value = legacyPendingValue()) {
  render(
    <MemoryRouter>
      <WalletContext.Provider value={value}>{ui}</WalletContext.Provider>
    </MemoryRouter>
  )
  return value
}

describe('legacy pending identity upgrade UI', () => {
  test('recoverable pending navigates to offline-capable backup after local recovery succeeds', async () => {
    const value = walletContextFixture({
      pendingIdentityState: PENDING_IDENTITY_STATE.RECOVERABLE_PENDING,
      hasPendingIdentity: true,
      resumePendingIdentity: vi.fn(async () => ({ address: 'ecash:qrecovered' }))
    })
    render(
      <MemoryRouter initialEntries={['/onboarding']}>
        <WalletContext.Provider value={value}>
          <Routes>
            <Route path="/onboarding" element={<OnboardingHome />} />
            <Route path="/backup" element={<div>Offline backup route</div>} />
          </Routes>
        </WalletContext.Provider>
      </MemoryRouter>
    )

    fireEvent.change(screen.getByTestId('pending-pin-input'), { target: { value: 'offline-pin' } })
    fireEvent.click(screen.getByTestId('resume-pending-backup-btn'))

    expect(await screen.findByText('Offline backup route')).toBeTruthy()
    expect(value.resumePendingIdentity).toHaveBeenCalledWith('offline-pin')
  })

  test('surfaces unrecoverable legacy state and requires explicit destructive consent', async () => {
    const value = legacyPendingValue()
    renderWithWallet(<OnboardingHome />, value)

    expect(screen.getByText(
      'Encontramos una creación anterior incompleta que esta versión no puede recuperar automáticamente.'
    )).toBeTruthy()
    expect(screen.queryByTestId('pending-pin-input')).toBeNull()
    expect(screen.queryByTestId('resume-pending-backup-btn')).toBeNull()

    fireEvent.click(screen.getByRole('button', {
      name: 'Descartar creación incompleta y empezar de nuevo'
    }))
    expect(screen.getByText(
      'La dirección creada anteriormente pudo haber recibido fondos. Si no conservas su frase de recuperación, descartarla puede hacer que esos fondos sean inaccesibles permanentemente.'
    )).toBeTruthy()

    fireEvent.click(screen.getByTestId('confirm-abandon-pending-btn'))
    await waitFor(() => expect(value.abandonPendingIdentity).toHaveBeenCalledTimes(1))
  })

  test('reports verified-deletion failure and keeps the legacy reservation UI visible', async () => {
    const value = legacyPendingValue({
      abandonPendingIdentity: vi.fn(async () => {
        throw new Error('PENDING_IDENTITY_ABANDON_FAILED')
      })
    })
    renderWithWallet(<OnboardingHome />, value)

    fireEvent.click(screen.getByTestId('request-abandon-pending-btn'))
    fireEvent.click(screen.getByTestId('confirm-abandon-pending-btn'))

    expect((await screen.findByRole('alert')).textContent).toContain('PENDING_IDENTITY_ABANDON_FAILED')
    expect(screen.getByTestId('pending-identity-recovery-card')).toBeTruthy()
  })

  test('blocks Quick Start, PIN creation, and seed import while legacy pending exists', () => {
    const value = legacyPendingValue()
    renderWithWallet(<CreateWallet />, value)
    expect(screen.getByTestId('create-tonalli')).toHaveProperty('disabled', true)
    cleanup()

    renderWithWallet(<CreateBackedWallet />, value)
    expect(screen.getByTestId('create-backed-tonalli')).toHaveProperty('disabled', true)
    cleanup()

    renderWithWallet(<ImportWallet />, value)
    expect(screen.getByRole('button', { name: 'Restaurar wallet' })).toHaveProperty('disabled', true)
  })
})

describe('corrupt pending identity fail-closed UI', () => {
  function corruptPendingValue(overrides: Partial<WalletContextValue> = {}) {
    return walletContextFixture({
      pendingIdentityState: PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING,
      hasPendingIdentity: true,
      ...overrides
    })
  }

  test('corrupt pending renders corruption UI and explains why Tonalli will not auto-create another identity', () => {
    const value = corruptPendingValue()
    renderWithWallet(<OnboardingHome />, value)

    expect(screen.getByText('Datos de creación dañados detectados')).toBeTruthy()
    expect(screen.getByText('Encontramos datos de una creación anterior que no pueden leerse correctamente.')).toBeTruthy()
    expect(screen.getByText(/Tonalli no creará otra identidad automáticamente porque la información dañada podría corresponder a una wallet que ya recibió fondos/)).toBeTruthy()
    expect(screen.queryByTestId('pending-pin-input')).toBeNull()
    expect(screen.queryByTestId('resume-pending-backup-btn')).toBeNull()
    expect(screen.getByRole('button', { name: 'Descartar datos de creación dañados y empezar de nuevo' })).toBeTruthy()
  })

  test('no explicit confirmation preserves state without calling abandon', () => {
    const value = corruptPendingValue()
    renderWithWallet(<OnboardingHome />, value)

    fireEvent.click(screen.getByTestId('request-abandon-pending-btn'))
    expect(screen.getByText(/Si esta creación anterior correspondía a una dirección que recibió fondos y no conservas su frase de recuperación/)).toBeTruthy()

    fireEvent.click(screen.getByTestId('cancel-abandon-pending-btn'))
    expect(value.abandonPendingIdentity).not.toHaveBeenCalled()
    expect(screen.getByTestId('pending-identity-recovery-card')).toBeTruthy()
  })

  test('confirmed abandonment calls abandon handler', async () => {
    const value = corruptPendingValue()
    renderWithWallet(<OnboardingHome />, value)

    fireEvent.click(screen.getByTestId('request-abandon-pending-btn'))
    fireEvent.click(screen.getByTestId('confirm-abandon-pending-btn'))

    await waitFor(() => expect(value.abandonPendingIdentity).toHaveBeenCalledTimes(1))
  })

  test('reports verified-deletion failure and keeps the corruption UI visible', async () => {
    const value = corruptPendingValue({
      abandonPendingIdentity: vi.fn(async () => {
        throw new Error('PENDING_IDENTITY_ABANDON_FAILED')
      })
    })
    renderWithWallet(<OnboardingHome />, value)

    fireEvent.click(screen.getByTestId('request-abandon-pending-btn'))
    fireEvent.click(screen.getByTestId('confirm-abandon-pending-btn'))

    expect((await screen.findByRole('alert')).textContent).toContain('PENDING_IDENTITY_ABANDON_FAILED')
    expect(screen.getByTestId('pending-identity-recovery-card')).toBeTruthy()
  })

  test('blocks Quick Start, PIN creation, and seed import while corrupt pending exists', () => {
    const value = corruptPendingValue()
    renderWithWallet(<CreateWallet />, value)
    expect(screen.getByTestId('create-tonalli')).toHaveProperty('disabled', true)
    cleanup()

    renderWithWallet(<CreateBackedWallet />, value)
    expect(screen.getByTestId('create-backed-tonalli')).toHaveProperty('disabled', true)
    cleanup()

    renderWithWallet(<ImportWallet />, value)
    expect(screen.getByRole('button', { name: 'Restaurar wallet' })).toHaveProperty('disabled', true)
  })
})
