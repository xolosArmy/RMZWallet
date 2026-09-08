/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import RegisterAlias from './RegisterAlias'

// Mock TopBar to keep unit tests focused on RegisterAlias
vi.mock('../components/TopBar', () => ({
  default: () => <div data-testid="top-bar">TopBar</div>
}))

const mockWallet = {
  address: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq',
  alias: null as string | null,
  balance: {
    xec: 100000000n,
    tokenUtxoSats: 0n,
    tokenUtxoXecFormatted: '0',
    rmzAtoms: 500000n,
    rmzFormatted: '5000',
    rmzDecimals: 0,
    firmaAtoms: 0n,
    firmaFormatted: '0',
    firmaDecimals: 0,
    xecFormatted: '1,000,000'
  },
  loading: false,
  error: null,
  initialized: true,
  backupVerified: true,
  sendRMZ: vi.fn(),
  estimateAliasRegistration: vi.fn(),
  reserveAliasRegistrationUtxos: vi.fn(),
  buildAliasRegistrationRawTx: vi.fn(),
  registerAliasOnChain: vi.fn(),
  setAlias: vi.fn()
}

vi.mock('../context/useWallet', () => ({
  useWallet: () => mockWallet
}))

describe('RegisterAlias Route - Finding 2: Persist registered alias', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWallet.alias = null
    mockWallet.sendRMZ.mockResolvedValue('rmz-txid-12345')
    mockWallet.estimateAliasRegistration.mockResolvedValue({
      protocolFeeSats: 546,
      networkFeeSats: 250,
      totalCostSats: 796
    })
    mockWallet.reserveAliasRegistrationUtxos.mockResolvedValue([])
    mockWallet.registerAliasOnChain.mockResolvedValue({
      txid: 'alias-txid-67890',
      status: 'success',
      message: 'Alias registered successfully',
      debug: {
        aliasSelectedUtxos: [],
        excludedTxids: [],
        usesRmzChangeOutput: false
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('calls setAlias with canonical alias name upon successful registration', async () => {
    render(
      <MemoryRouter initialEntries={['/register-alias']}>
        <Routes>
          <Route path="/register-alias" element={<RegisterAlias />} />
        </Routes>
      </MemoryRouter>
    )

    const input = screen.getByLabelText(/alias/i)
    fireEvent.change(input, { target: { value: 'satoshixolos' } })

    const submitBtn = screen.getByRole('button', { name: /registrar alias/i })
    expect(submitBtn).toBeDefined()
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(mockWallet.sendRMZ).toHaveBeenCalled()
      expect(mockWallet.registerAliasOnChain).toHaveBeenCalled()
    })

    await waitFor(() => {
      // Must call setAlias with the registered canonical alias
      expect(mockWallet.setAlias).toHaveBeenCalledWith('satoshixolos.xec')
    })
  })

  it('does NOT call setAlias if alias registration fails', async () => {
    mockWallet.registerAliasOnChain.mockRejectedValueOnce(new Error('Chronik node broadcast error'))

    render(
      <MemoryRouter initialEntries={['/register-alias']}>
        <Routes>
          <Route path="/register-alias" element={<RegisterAlias />} />
        </Routes>
      </MemoryRouter>
    )

    const input = screen.getByLabelText(/alias/i)
    fireEvent.change(input, { target: { value: 'satoshixolos' } })

    const submitBtn = screen.getByRole('button', { name: /registrar alias/i })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(mockWallet.sendRMZ).toHaveBeenCalled()
      expect(mockWallet.registerAliasOnChain).toHaveBeenCalled()
    })

    expect(mockWallet.setAlias).not.toHaveBeenCalled()
  })
})
