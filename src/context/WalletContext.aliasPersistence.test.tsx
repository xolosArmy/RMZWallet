// @vitest-environment jsdom

import { useState } from 'react'
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
  }),
  registerAliasOnChain: vi.fn().mockResolvedValue({
    txid: 'mock-txid-12345',
    status: 'broadcast_pending_index' as const,
    rawTx: '01000000',
    debug: {} as any
  }),
  findAliasForAddress: vi.fn().mockResolvedValue(null)
}))

vi.mock('../services/XolosWalletService', () => ({
  EXTENDED_GAP_LIMIT: 100,
  xolosWalletService: serviceMocks
}))

function TestHarness() {
  const wallet = useWallet()
  const [lastRegisterTxid, setLastRegisterTxid] = useState<string | null>(null)
  const [lastRegisterError, setLastRegisterError] = useState<string | null>(null)

  return (
    <div>
      <div data-testid="current-address">{wallet.address ?? 'no-address'}</div>
      <div data-testid="current-alias">{wallet.alias ?? 'no-alias'}</div>
      <div data-testid="register-txid">{lastRegisterTxid ?? 'no-txid'}</div>
      <div data-testid="register-error">{lastRegisterError ?? 'no-error'}</div>
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
      <button
        type="button"
        onClick={async () => {
          try {
            const res = await wallet.registerAliasOnChain(
              { alias: 'charlie' } as any,
              [],
              null
            )
            setLastRegisterTxid(typeof res === 'string' ? res : (res as any)?.txid ?? null)
          } catch (err: any) {
            setLastRegisterError(err.message)
          }
        }}
      >
        Register Charlie
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
    serviceMocks.findAliasForAddress.mockResolvedValue(null)
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.restoreAllMocks()
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

  it('Finding 3: isolates local storage persistence errors when registerAliasOnChain succeeds on-chain', async () => {
    localStorage.setItem('xoloswallet_backup_verified', 'true')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <WalletProvider>
        <TestHarness />
      </WalletProvider>
    )

    // Initialize wallet
    fireEvent.click(screen.getByText('Switch to Addr1'))
    await waitFor(() => {
      expect(screen.getByTestId('current-address').textContent).toBe(addr1)
    })

    // Mock localStorage.setItem to throw on alias persistence
    const originalSetItem = localStorage.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      if (key.startsWith('rmzwallet_alias_')) {
        throw new Error('QuotaExceededError: LocalStorage quota exceeded')
      }
      return originalSetItem(key, value)
    })

    // Click register alias
    fireEvent.click(screen.getByText('Register Charlie'))

    // The transaction should succeed and return txid without rethrowing
    await waitFor(() => {
      expect(screen.getByTestId('register-txid').textContent).toBe('mock-txid-12345')
      expect(screen.getByTestId('register-error').textContent).toBe('no-error')
    })

    // Assert that the error was caught and logged
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to persist registered alias locally:',
      expect.any(Error)
    )

    consoleErrorSpy.mockRestore()
  })

  it('Finding 4: hydrates alias asynchronously from blockchain/service when mounting or switching address with empty localStorage', async () => {
    serviceMocks.findAliasForAddress.mockImplementation(async (addr: string) => {
      if (addr === addr1) return 'hydrated-alice.xec'
      if (addr === addr2) return 'hydrated-bob.xec'
      return null
    })

    render(
      <WalletProvider>
        <TestHarness />
      </WalletProvider>
    )

    // Mount hydration for initial address (addr1)
    await waitFor(() => {
      expect(screen.getByTestId('current-address').textContent).toBe(addr1)
      expect(screen.getByTestId('current-alias').textContent).toBe('hydrated-alice.xec')
    })
    expect(localStorage.getItem(`rmzwallet_alias_${addr1}`)).toBe('hydrated-alice.xec')

    // Switch to addr2 which also has empty localStorage
    fireEvent.click(screen.getByText('Switch to Addr2'))

    await waitFor(() => {
      expect(screen.getByTestId('current-address').textContent).toBe(addr2)
      expect(screen.getByTestId('current-alias').textContent).toBe('hydrated-bob.xec')
    })
    expect(localStorage.getItem(`rmzwallet_alias_${addr2}`)).toBe('hydrated-bob.xec')
  })
})
