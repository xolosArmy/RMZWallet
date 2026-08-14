// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WalletContext } from '../context/walletContext'
import type { WalletContextValue } from '../context/walletContext'
import {
  ECASH_STANDARD_PROFILE_ID,
  TONALLI_LEGACY_PROFILE_ID
} from '../services/derivationProfiles'
import type { DerivationProfileActivity } from '../services/dualDerivationDiscovery'
import { ImportWallet, UnlockWallet } from './Onboarding'

const PUBLIC_TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const activity = (
  profileId: typeof TONALLI_LEGACY_PROFILE_ID | typeof ECASH_STANDARD_PROFILE_ID,
  xecSats: bigint
): DerivationProfileActivity => Object.freeze({
  profileId,
  hasActivity: true,
  xecSats,
  tokenUtxoCount: 1,
  activeAddressCount: 1,
  scannedAddressCount: 2,
  tokens: Object.freeze([])
})

const dualDetection = Object.freeze({
  kind: 'choice-required' as const,
  reason: 'dual-activity' as const,
  profiles: Object.freeze({
    [TONALLI_LEGACY_PROFILE_ID]: activity(TONALLI_LEGACY_PROFILE_ID, 100n),
    [ECASH_STANDARD_PROFILE_ID]: activity(ECASH_STANDARD_PROFILE_ID, 200n)
  })
})

function walletValue(
  restoreWallet: WalletContextValue['restoreWallet'],
  loadExistingWallet: WalletContextValue['loadExistingWallet'] = vi.fn()
): WalletContextValue {
  return {
    address: null,
    balance: null,
    loading: false,
    error: null,
    initialized: false,
    backupVerified: false,
    createNewWallet: vi.fn(),
    restoreWallet,
    loadExistingWallet,
    encryptAndStore: vi.fn(),
    refreshBalances: vi.fn(),
    rescanWallet: vi.fn(),
    sendRMZ: vi.fn(),
    prepareFirmaSend: vi.fn(),
    sendFirma: vi.fn(),
    sendXEC: vi.fn(),
    estimateAliasRegistration: vi.fn(),
    reserveAliasRegistrationUtxos: vi.fn(),
    buildAliasRegistrationRawTx: vi.fn(),
    registerAliasOnChain: vi.fn(),
    estimateXecSend: vi.fn(),
    getMnemonic: vi.fn(),
    unlockEncryptedWallet: vi.fn()
  }
}

describe('dual-profile restore resolution UI', () => {
  afterEach(cleanup)

  test('requires and forwards an explicit profile choice when both profiles are active', async () => {
    const restoreWallet = vi.fn<WalletContextValue['restoreWallet']>()
      .mockResolvedValueOnce({
        status: 'choice-required',
        detection: dualDetection,
        notice: 'Elige un perfil.'
      })
      .mockResolvedValueOnce({
        status: 'restored',
        detection: dualDetection,
        selectedProfileId: ECASH_STANDARD_PROFILE_ID,
        notice: 'Se encontró una wallet compatible con eCash/Cashtab.'
      })

    render(
      <MemoryRouter initialEntries={['/onboarding/import']}>
        <WalletContext.Provider value={walletValue(restoreWallet)}>
          <ImportWallet />
        </WalletContext.Provider>
      </MemoryRouter>
    )

    fireEvent.change(screen.getByLabelText('Frase seed'), {
      target: { value: PUBLIC_TEST_MNEMONIC }
    })
    fireEvent.change(screen.getByLabelText('Nuevo Password/PIN local'), {
      target: { value: '123456' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Restaurar wallet' }))

    expect(await screen.findByText('Actividad encontrada en dos perfiles')).toBeTruthy()
    expect(screen.getByText(/Tonalli no combinará sus UTXOs/)).toBeTruthy()
    expect(restoreWallet).toHaveBeenCalledTimes(1)
    expect(restoreWallet).toHaveBeenNthCalledWith(1, PUBLIC_TEST_MNEMONIC)

    fireEvent.click(screen.getByRole('button', { name: 'Abrir eCash / Cashtab' }))
    await waitFor(() => expect(restoreWallet).toHaveBeenCalledTimes(2))
    expect(restoreWallet).toHaveBeenNthCalledWith(
      2,
      PUBLIC_TEST_MNEMONIC,
      ECASH_STANDARD_PROFILE_ID
    )
  })

  test('requires an explicit profile when encrypted-wallet recovery detects dual activity', async () => {
    const loadExistingWallet = vi.fn<WalletContextValue['loadExistingWallet']>()
      .mockResolvedValueOnce({
        status: 'choice-required',
        detection: dualDetection,
        notice: 'Elige un perfil.'
      })
      .mockResolvedValueOnce({
        status: 'loaded',
        detection: dualDetection,
        selectedProfileId: ECASH_STANDARD_PROFILE_ID,
        notice: 'Perfil recuperado.'
      })

    render(
      <MemoryRouter initialEntries={['/onboarding/unlock']}>
        <WalletContext.Provider value={walletValue(vi.fn(), loadExistingWallet)}>
          <UnlockWallet />
        </WalletContext.Provider>
      </MemoryRouter>
    )

    fireEvent.change(screen.getByLabelText('Password/PIN'), {
      target: { value: '123456' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Desbloquear' }))

    expect(await screen.findByText('Actividad encontrada en dos perfiles')).toBeTruthy()
    expect(loadExistingWallet).toHaveBeenNthCalledWith(1, '123456')

    fireEvent.click(screen.getByRole('button', { name: 'Abrir eCash / Cashtab' }))
    await waitFor(() => expect(loadExistingWallet).toHaveBeenCalledTimes(2))
    expect(loadExistingWallet).toHaveBeenNthCalledWith(
      2,
      '123456',
      ECASH_STANDARD_PROFILE_ID
    )
  })
})
