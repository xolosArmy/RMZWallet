// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletBalance } from '../services/XolosWalletService'
import type { FirmaSendPreview } from '../services/firmaAlphaSend'
import { WalletProvider } from './WalletContext'
import { useWallet } from './useWallet'

const serviceMocks = vi.hoisted(() => ({
  loadFromStorage: vi.fn(),
  getAddress: vi.fn(),
  getBalances: vi.fn(),
  prepareFirmaSend: vi.fn(),
  sendFirma: vi.fn()
}))

vi.mock('../services/XolosWalletService', () => ({
  EXTENDED_GAP_LIMIT: 100,
  xolosWalletService: serviceMocks
}))

const destination = 'ecash:qqau9rtdjtvsw0a4uwklfqtet6h5g67wa5lh4qk2vv'
const preview: FirmaSendPreview = {
  tokenId: '0387947fd575db4fb19a3e322f635dec37fd192b5941625b66bc4b2c3008cbf0',
  destination,
  amountAtoms: 100n,
  balanceBeforeAtoms: 100n,
  balanceAfterAtoms: 0n,
  firmaChangeAtoms: 0n,
  networkFeeSats: 300n,
  inputOutpoints: [`${'a'.repeat(64)}:0`, `${'b'.repeat(64)}:0`],
  tokenInputOutpoints: [`${'a'.repeat(64)}:0`],
  xecInputOutpoints: [`${'b'.repeat(64)}:0`],
  planFingerprint: 'context-plan'
}

const balance = (firmaAtoms: bigint, firmaFormatted: string): WalletBalance => ({
  xec: 20_000n,
  xecFormatted: '200.00',
  rmzAtoms: 42n,
  rmzFormatted: '42',
  rmzDecimals: 0,
  firmaAtoms,
  firmaFormatted,
  firmaDecimals: 4
})

function Harness() {
  const wallet = useWallet()
  const [message, setMessage] = useState('')

  return (
    <div>
      <div data-testid="firma-balance">{wallet.balance?.firmaFormatted ?? 'sin saldo'}</div>
      <button type="button" onClick={() => void wallet.loadExistingWallet('password')}>Cargar</button>
      <button
        type="button"
        onClick={() => void wallet.prepareFirmaSend(destination, '0.0100').then(() => setMessage('preview ok'))}
      >
        Preparar válido
      </button>
      <button
        type="button"
        onClick={() => void wallet.prepareFirmaSend(destination, '0.00001').catch((error: Error) => setMessage(error.message))}
      >
        Preparar inválido
      </button>
      <button type="button" onClick={() => void wallet.sendFirma(preview)}>Enviar FIRMA</button>
      <div data-testid="message">{message}</div>
    </div>
  )
}

describe('WalletContext FIRMA operations', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('xoloswallet_backup_verified', 'true')
    serviceMocks.loadFromStorage.mockReset().mockResolvedValue(undefined)
    serviceMocks.getAddress.mockReset().mockReturnValue(destination)
    serviceMocks.getBalances.mockReset()
      .mockResolvedValueOnce(balance(100n, '0.0100'))
      .mockResolvedValueOnce(balance(0n, '0.0000'))
    serviceMocks.prepareFirmaSend.mockReset().mockResolvedValue(preview)
    serviceMocks.sendFirma.mockReset().mockResolvedValue('c'.repeat(64))
  })

  afterEach(() => {
    cleanup()
  })

  it('parses four decimals exactly and rejects excess precision before the service', async () => {
    render(<WalletProvider><Harness /></WalletProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Cargar' }))
    await waitFor(() => expect(screen.getByTestId('firma-balance').textContent).toBe('0.0100'))

    fireEvent.click(screen.getByRole('button', { name: 'Preparar válido' }))
    await waitFor(() => expect(serviceMocks.prepareFirmaSend).toHaveBeenCalledWith(destination, 100n))

    fireEvent.click(screen.getByRole('button', { name: 'Preparar inválido' }))
    await waitFor(() => expect(screen.getByTestId('message').textContent).toMatch(/Máximo 4 decimales/))
    expect(serviceMocks.prepareFirmaSend).toHaveBeenCalledTimes(1)
  })

  it('refreshes the existing WalletBalance after a successful broadcast result', async () => {
    render(<WalletProvider><Harness /></WalletProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Cargar' }))
    await waitFor(() => expect(screen.getByTestId('firma-balance').textContent).toBe('0.0100'))

    fireEvent.click(screen.getByRole('button', { name: 'Enviar FIRMA' }))

    await waitFor(() => expect(screen.getByTestId('firma-balance').textContent).toBe('0.0000'))
    expect(serviceMocks.sendFirma).toHaveBeenCalledWith(preview)
    expect(serviceMocks.getBalances).toHaveBeenCalledTimes(2)
  })
})
