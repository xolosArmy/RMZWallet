// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { WalletContext } from '../context/walletContext'
import { walletContextFixture } from '../test/walletContextFixture'
import { CreateBackedWallet } from './Onboarding'

const mockLocks = {
  request: vi.fn(async (_name: string, _opts: unknown, callback: (lock: unknown) => Promise<unknown>) => callback({}))
}

beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: mockLocks })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderCreateBacked(overrides: Parameters<typeof walletContextFixture>[0] = {}) {
  const value = walletContextFixture(overrides)
  render(
    <MemoryRouter>
      <WalletContext.Provider value={value}>
        <CreateBackedWallet />
      </WalletContext.Provider>
    </MemoryRouter>
  )
  return value
}

describe('/onboarding/create-backed refuse overwrite', () => {
  test('recovered Quick Start does not call createNewWallet', () => {
    const wallet = renderCreateBacked({
      initialized: true,
      address: 'ecash:qoriginal',
      quickStartBootstrap: 'recovered'
    })
    fireEvent.change(screen.getByLabelText('Password/PIN local'), { target: { value: '123456' } })
    fireEvent.submit(screen.getByTestId('create-backed-tonalli').closest('form')!)
    expect(wallet.createNewWallet).not.toHaveBeenCalled()
    expect(screen.getAllByRole('alert').some((node) => /Ya hay una Tonalli/.test(node.textContent ?? ''))).toBe(true)
  })

  test('corrupt/missing Quick Start key blocks create-backed', () => {
    const wallet = renderCreateBacked({
      initialized: false,
      quickStartBootstrap: 'failed'
    })
    fireEvent.change(screen.getByLabelText('Password/PIN local'), { target: { value: '123456' } })
    fireEvent.submit(screen.getByTestId('create-backed-tonalli').closest('form')!)
    expect(wallet.createNewWallet).not.toHaveBeenCalled()
    expect(screen.getAllByRole('alert').some((node) => /no se pudo recuperar/.test(node.textContent ?? ''))).toBe(true)
  })

  test('bootstrap pending blocks create-backed', () => {
    const wallet = renderCreateBacked({
      initialized: false,
      quickStartBootstrap: 'pending'
    })
    expect(screen.getByTestId('create-backed-tonalli')).toHaveProperty('disabled', true)
    fireEvent.submit(screen.getByTestId('create-backed-tonalli').closest('form')!)
    expect(wallet.createNewWallet).not.toHaveBeenCalled()
  })

  test('navigator.locks absent renders unsupported-browser state, blocks create-backed, zero seed persistence', () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })
    const wallet = renderCreateBacked({ initialized: false })
    expect(screen.getByTestId('create-backed-tonalli')).toHaveProperty('disabled', true)
    expect(screen.getByTestId('unsupported-browser-state')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Password/PIN local'), { target: { value: '123456' } })
    fireEvent.submit(screen.getByTestId('create-backed-tonalli').closest('form')!)
    expect(wallet.createNewWallet).not.toHaveBeenCalled()
    expect(localStorage.getItem('xoloswallet_encrypted_mnemonic')).toBeNull()
  })

  test('create-backed flow navigates to /backup when createNewWallet succeeds (discussion_r4066507409)', async () => {
    const wallet = walletContextFixture({
      initialized: false,
      createNewWallet: vi.fn(async () => 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
    })
    render(
      <MemoryRouter initialEntries={['/onboarding/create-backed']}>
        <WalletContext.Provider value={wallet}>
          <Routes>
            <Route path="/onboarding/create-backed" element={<CreateBackedWallet />} />
            <Route path="/backup" element={<div data-testid="backup-route-screen">Backup route screen</div>} />
          </Routes>
        </WalletContext.Provider>
      </MemoryRouter>
    )

    fireEvent.change(screen.getByLabelText('Password/PIN local'), { target: { value: '123456' } })
    fireEvent.submit(screen.getByTestId('create-backed-tonalli').closest('form')!)

    expect(await screen.findByTestId('backup-route-screen')).toBeTruthy()
    expect(wallet.createNewWallet).toHaveBeenCalledWith('123456')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
