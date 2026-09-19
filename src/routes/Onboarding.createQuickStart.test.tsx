// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { WalletContext } from '../context/walletContext'
import { walletContextFixture } from '../test/walletContextFixture'
import { CreateWallet } from './Onboarding'
import { QuickStartUnavailableError } from '../services/quickStartStorage'

afterEach(() => {
  cleanup()
})

function renderCreate(overrides: Parameters<typeof walletContextFixture>[0] = {}) {
  const value = walletContextFixture(overrides)
  render(
    <MemoryRouter>
      <WalletContext.Provider value={value}>
        <CreateWallet />
      </WalletContext.Provider>
    </MemoryRouter>
  )
  return value
}

describe('/onboarding/create refuse overwrite and IndexedDB fallback', () => {
  test('encrypted backed wallet CTA cannot create and offers unlock', () => {
    const wallet = renderCreate({ hasBackedWalletOnDevice: true })
    expect(screen.getByTestId('create-tonalli')).toHaveProperty('disabled', true)
    fireEvent.submit(screen.getByTestId('create-tonalli').closest('form')!)
    expect(wallet.startQuickStartWallet).not.toHaveBeenCalled()
    expect(screen.getByTestId('unlock-existing-wallet').getAttribute('href')).toBe('/onboarding/unlock')
    expect(screen.queryByText('Continuar con PIN local')).toBeNull()
  })

  test('secure-storage unavailable shows PIN fallback on a fresh profile', async () => {
    const startQuickStartWallet = vi.fn().mockRejectedValue(
      new QuickStartUnavailableError('QUICK_START_SECURE_STORAGE_UNAVAILABLE')
    )
    renderCreate({ startQuickStartWallet })
    fireEvent.submit(screen.getByTestId('create-tonalli').closest('form')!)
    expect(await screen.findByText('Continuar con PIN local')).toBeTruthy()
    expect(screen.getByText('Continuar con PIN local').getAttribute('href')).toBe('/onboarding/create-backed')
  })

  test('recovery failed does not offer PIN create that would overwrite', () => {
    const wallet = renderCreate({ quickStartBootstrap: 'failed' })
    fireEvent.submit(screen.getByTestId('create-tonalli').closest('form')!)
    expect(wallet.startQuickStartWallet).not.toHaveBeenCalled()
    expect(screen.queryByText('Continuar con PIN local')).toBeNull()
    expect(screen.getAllByRole('alert').some((node) => /no se pudo recuperar/.test(node.textContent ?? ''))).toBe(true)
  })
})
