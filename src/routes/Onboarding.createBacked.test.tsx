// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { WalletContext } from '../context/walletContext'
import { walletContextFixture } from '../test/walletContextFixture'
import { CreateBackedWallet } from './Onboarding'

afterEach(() => {
  cleanup()
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
})
