// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Address, shaRmd160 } from 'ecash-lib'
import { DUMMY_KEYPAIR } from 'ecash-agora'
import type { AliasResolutionStatus } from '../hooks/useAliasResolution'
import type { FirmaSendPreview } from '../services/firmaAlphaSend'
import SendFirma from './SendFirma'

const destination = Address.p2pkh(shaRmd160(DUMMY_KEYPAIR.pk)).toString()

const mocks = vi.hoisted(() => ({
  aliasStatus: 'confirmed' as AliasResolutionStatus,
  aliasInputType: 'ecash-address' as 'empty' | 'ecash-address' | 'alias' | 'invalid',
  resolvedAddress: '',
  aliasError: null as string | null,
  initialized: true,
  backupVerified: true,
  prepareFirmaSend: vi.fn(),
  sendFirma: vi.fn()
}))

vi.mock('../components/TopBar', () => ({ default: () => <div>Top bar</div> }))

vi.mock('../hooks/useAliasResolution', () => ({
  useAliasResolution: () => ({
    inputType: mocks.aliasInputType,
    status: mocks.aliasStatus,
    alias: mocks.aliasInputType === 'alias' ? 'destino' : null,
    resolvedAddress: mocks.resolvedAddress,
    errorMessage: mocks.aliasError,
    aliasRecord: mocks.aliasInputType === 'alias' && mocks.resolvedAddress
      ? { alias: 'destino', address: mocks.resolvedAddress, txid: 'a'.repeat(64), status: 'confirmed' }
      : null
  })
}))

vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    prepareFirmaSend: mocks.prepareFirmaSend,
    sendFirma: mocks.sendFirma,
    initialized: mocks.initialized,
    backupVerified: mocks.backupVerified,
    loading: false,
    error: null
  })
}))

const preview: FirmaSendPreview = {
  tokenId: '0387947fd575db4fb19a3e322f635dec37fd192b5941625b66bc4b2c3008cbf0',
  destination,
  amountAtoms: 100n,
  balanceBeforeAtoms: 250n,
  balanceAfterAtoms: 150n,
  firmaChangeAtoms: 150n,
  networkFeeSats: 321n,
  inputOutpoints: [`${'b'.repeat(64)}:0`, `${'c'.repeat(64)}:0`],
  tokenInputOutpoints: [`${'b'.repeat(64)}:0`],
  xecInputOutpoints: [`${'c'.repeat(64)}:0`],
  changeAddress: destination,
  changeHdPath: `m/44'/899'/0'/0/0`,
  planFingerprint: 'firma-plan'
}

const renderRoute = () => render(<MemoryRouter><SendFirma /></MemoryRouter>)

const fillForm = () => {
  fireEvent.change(screen.getByLabelText(/Destino/), { target: { value: 'destino.xec' } })
  fireEvent.change(screen.getByLabelText('Monto FIRMA'), { target: { value: '0.0100' } })
}

describe('/send-firma', () => {
  beforeEach(() => {
    mocks.aliasStatus = 'confirmed'
    mocks.aliasInputType = 'ecash-address'
    mocks.resolvedAddress = destination
    mocks.aliasError = null
    mocks.initialized = true
    mocks.backupVerified = true
    mocks.prepareFirmaSend.mockReset().mockResolvedValue(preview)
    mocks.sendFirma.mockReset().mockResolvedValue('d'.repeat(64))
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the dedicated ALP send flow and does not sign during preview', async () => {
    renderRoute()
    fillForm()

    fireEvent.click(screen.getByRole('button', { name: 'Preparar / Previsualizar' }))

    await waitFor(() => expect(mocks.prepareFirmaSend).toHaveBeenCalledWith(destination, '0.0100'))
    expect(mocks.sendFirma).not.toHaveBeenCalled()
    expect(screen.getByText('0.0100 FIRMA')).toBeTruthy()
    expect(screen.getByText('0.0250 FIRMA')).toBeTruthy()
    expect(screen.getAllByText('0.0150 FIRMA')).toHaveLength(2)
    expect(screen.getByText('3.21 XEC')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirmar, firmar localmente y transmitir' })).toBeTruthy()
  })

  it('does not allow an unresolved alias to reach preview', () => {
    mocks.aliasStatus = 'loading'
    mocks.aliasInputType = 'alias'
    mocks.resolvedAddress = ''
    renderRoute()
    fillForm()

    expect((screen.getByRole('button', { name: 'Preparar / Previsualizar' }) as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.prepareFirmaSend).not.toHaveBeenCalled()
  })

  it('blocks preview when onboarding or seed backup is incomplete', () => {
    mocks.backupVerified = false
    renderRoute()
    fillForm()

    expect(screen.getByText(/completar el onboarding y el respaldo/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Preparar / Previsualizar' }) as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.prepareFirmaSend).not.toHaveBeenCalled()
  })

  it('enables preview only after a .xec alias is confirmed', () => {
    mocks.aliasStatus = 'loading'
    mocks.aliasInputType = 'alias'
    mocks.resolvedAddress = ''
    const view = renderRoute()
    fillForm()
    expect((screen.getByRole('button', { name: 'Preparar / Previsualizar' }) as HTMLButtonElement).disabled).toBe(true)

    mocks.aliasStatus = 'confirmed'
    mocks.resolvedAddress = destination
    view.rerender(<MemoryRouter><SendFirma /></MemoryRouter>)

    expect((screen.getByRole('button', { name: 'Preparar / Previsualizar' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('clears a stale preview when an input changes', async () => {
    renderRoute()
    fillForm()
    fireEvent.click(screen.getByRole('button', { name: 'Preparar / Previsualizar' }))
    await screen.findByText('Revisa antes de firmar')

    fireEvent.change(screen.getByLabelText('Monto FIRMA'), { target: { value: '0.0200' } })

    expect(screen.queryByText('Revisa antes de firmar')).toBeNull()
  })

  it('confirms explicitly and renders the explorer-linked success TXID', async () => {
    renderRoute()
    fillForm()
    fireEvent.click(screen.getByRole('button', { name: 'Preparar / Previsualizar' }))
    const confirm = await screen.findByRole('button', { name: 'Confirmar, firmar localmente y transmitir' })

    fireEvent.click(confirm)

    await screen.findByText('FIRMA enviada correctamente')
    expect(mocks.sendFirma).toHaveBeenCalledWith(preview)
    const link = screen.getByRole('link', { name: 'd'.repeat(64) })
    expect(link.getAttribute('href')).toBe(`https://explorer.e.cash/tx/${'d'.repeat(64)}`)
  })
})
