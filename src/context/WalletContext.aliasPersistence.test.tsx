// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletProvider } from './WalletContext'
import { useWallet } from './useWallet'

const addr1 = 'ecash:qz9d5h88eecg8n6g0gsw2q247u882p4r7ypfnx7472'
const addr2 = 'ecash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'

let currentAddress: string | null = addr1

const serviceMocks = vi.hoisted(() => ({
  loadFromStorage: vi.fn().mockResolvedValue({ status: 'success' }),
  getAddress: vi.fn(() => currentAddress),
  getBalances: vi.fn().mockResolvedValue({
    xec: 100000n,
    xecFormatted: '1000.00',
    tokenUtxoSats: 0n,
    tokenUtxoXecFormatted: '0.00',
    rmzAtoms: 0n,
    rmzFormatted: '0',
    rmzDecimals: 0,
    firmaAtoms: 0n,
    firmaFormatted: '0',
    firmaDecimals: 4
  })
}))

vi.mock('../services/XolosWalletService', () => ({
  EXTENDED_GAP_LIMIT: 100,
  xolosWalletService: serviceMocks
}))

function TestHarness() {
  const wallet = useWallet()

  return (
    <div>
      <div data-testid="current-address">{wallet.address ?? 'no-address'}</div>
      <div data-testid="current-alias">{wallet.alias ?? 'no-alias'}</div>
      <button
        type="button"
        onClick={() => {
          currentAddress = addr1
          void wallet.loadExistingWallet('password')
        }}
      >
        Switch to Addr1
      </button>
      <button
        type="button"
        onClick={() => {
          currentAddress = addr2
          void wallet.loadExistingWallet('password')
        }}
      >
        Switch to Addr2
      </button>
      <button
        type="button"
        onClick={() => wallet.setAlias?.('satoshi.xec')}
      >
        Set Satoshi
      </button>
      <button
        type="button"
        onClick={() => wallet.setAlias?.('nakamoto.xec')}
      >
        Set Nakamoto
      </button>
      <button
        type="button"
        onClick={() => wallet.setAlias?.(null)}
      >
        Clear Alias
      </button>
    </div>
  )
}

describe('WalletContext wallet-specific alias persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    currentAddress = addr1
    vi.clearAllMocks()
    serviceMocks.getAddress.mockImplementation(() => currentAddress)
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('persists alias under address-specific localStorage key and reads it correctly', async () => {
    localStorage.setItem(`rmzwallet_alias_${addr1}`, 'satoshi.xec')

    render(
      <WalletProvider>
        <TestHarness />
      </WalletProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-address').textContent).toBe(addr1)
      expect(screen.getByTestId('current-alias').textContent).toBe('satoshi.xec')
    })
  })

  it('clears or updates alias in context when switching active wallet accounts', async () => {
    // Pre-seed alias for addr1 only
    localStorage.setItem(`rmzwallet_alias_${addr1}`, 'satoshi.xec')

    render(
      <WalletProvider>
        <TestHarness />
      </WalletProvider>
    )

    // Initial state: addr1 with satoshi.xec
    await waitFor(() => {
      expect(screen.getByTestId('current-address').textContent).toBe(addr1)
      expect(screen.getByTestId('current-alias').textContent).toBe('satoshi.xec')
    })

    // Switch to addr2 which has no alias stored
    fireEvent.click(screen.getByText('Switch to Addr2'))

    await waitFor(() => {
      expect(screen.getByTestId('current-address').textContent).toBe(addr2)
      // Alias must update to null for addr2
      expect(screen.getByTestId('current-alias').textContent).toBe('no-alias')
    })

    // Set alias for addr2
    fireEvent.click(screen.getByText('Set Nakamoto'))

    await waitFor(() => {
      expect(screen.getByTestId('current-alias').textContent).toBe('nakamoto.xec')
    })

    // Verify localStorage has distinct entries for both addresses
    expect(localStorage.getItem(`rmzwallet_alias_${addr1}`)).toBe('satoshi.xec')
    expect(localStorage.getItem(`rmzwallet_alias_${addr2}`)).toBe('nakamoto.xec')
    // Legacy global key should not have overwritten
    expect(localStorage.getItem('rmzwallet_alias')).toBeNull()

    // Switch back to addr1
    fireEvent.click(screen.getByText('Switch to Addr1'))

    await waitFor(() => {
      expect(screen.getByTestId('current-address').textContent).toBe(addr1)
      // Alias must revert to addr1's persisted alias
      expect(screen.getByTestId('current-alias').textContent).toBe('satoshi.xec')
    })
  })

  it('removes address-specific key when alias is set to null', async () => {
    localStorage.setItem(`rmzwallet_alias_${addr1}`, 'satoshi.xec')

    render(
      <WalletProvider>
        <TestHarness />
      </WalletProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('current-alias').textContent).toBe('satoshi.xec')
    })

    fireEvent.click(screen.getByText('Clear Alias'))

    await waitFor(() => {
      expect(screen.getByTestId('current-alias').textContent).toBe('no-alias')
    })

    expect(localStorage.getItem(`rmzwallet_alias_${addr1}`)).toBeNull()
  })
})
