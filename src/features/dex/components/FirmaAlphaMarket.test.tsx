// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FirmaBuyPreview } from '../../../services/firmaAlphaExchange'
import FirmaAlphaMarket from './FirmaAlphaMarket'

const mocks = vi.hoisted(() => ({
  discoverFirmaOffers: vi.fn(),
  prepareBestFirmaBuy: vi.fn(),
  prepareFirmaSale: vi.fn(),
  executeFirmaBuy: vi.fn(),
  executeFirmaSale: vi.fn(),
  refreshBalances: vi.fn()
}))

vi.mock('../../../context/useWallet', () => ({
  useWallet: () => ({
    balance: {
      firmaFormatted: '2.5000',
      xecFormatted: '10000.00'
    },
    backupVerified: true,
    refreshBalances: mocks.refreshBalances
  })
}))

vi.mock('../../../services/firmaAlphaExchange', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../services/firmaAlphaExchange')>()
  return {
    ...original,
    discoverFirmaOffers: mocks.discoverFirmaOffers,
    prepareBestFirmaBuy: mocks.prepareBestFirmaBuy,
    prepareFirmaSale: mocks.prepareFirmaSale,
    executeFirmaBuy: mocks.executeFirmaBuy,
    executeFirmaSale: mocks.executeFirmaSale
  }
})

const preview: FirmaBuyPreview = {
  kind: 'buy',
  offerId: `${'a'.repeat(64)}:1`,
  requestedAtoms: 10_000n,
  acceptedAtoms: 10_000n,
  askedSats: 700_000n,
  effectivePriceXecPerFirma: '7000',
  networkFeeSats: 800n,
  totalSats: 700_800n,
  payoutAddress: 'ecash:qptest',
  adjustedForAgora: false,
  inputOutpoints: [`${'c'.repeat(64)}:0`]
}

describe('FirmaAlphaMarket preview boundary', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.discoverFirmaOffers.mockResolvedValue({
      tokenInfo: {},
      totalLiquidityAtoms: 100_000n,
      offers: [{
        offerId: preview.offerId,
        offeredAtoms: 100_000n,
        minAcceptedAtoms: 100n,
        askedSats: 7_000_000n,
        makerPubkeyHex: '03',
        priceNanoSatsPerAtom: 1n,
        source: 'peer'
      }]
    })
    mocks.prepareBestFirmaBuy.mockResolvedValue(preview)
    mocks.executeFirmaBuy.mockResolvedValue('b'.repeat(64))
    mocks.refreshBalances.mockResolvedValue(undefined)
  })

  it('does not sign or broadcast while preparing the mandatory preview', async () => {
    render(<FirmaAlphaMarket />)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Previsualizar operación' }) as HTMLButtonElement).disabled).toBe(false))

    fireEvent.change(screen.getByLabelText('Cantidad FIRMA'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Previsualizar operación' }))

    await screen.findByRole('region', { name: 'Previsualización obligatoria FIRMA' })
    expect(mocks.prepareBestFirmaBuy).toHaveBeenCalledWith('1')
    expect(mocks.executeFirmaBuy).not.toHaveBeenCalled()
    expect(screen.getByText(/Precio efectivo: 7000 XEC\/FIRMA/)).toBeTruthy()
    expect(screen.getByText(/Pago al maker: 7000 XEC/)).toBeTruthy()
  })

  it('presents permissionless FIRMA liquidity without claiming every maker is official', async () => {
    render(<FirmaAlphaMarket />)
    expect(await screen.findByText('Liquidez FIRMA disponible')).toBeTruthy()
    expect(await screen.findByText(/liquidez peer/)).toBeTruthy()
    expect(screen.queryByText('Liquidez oficial visible')).toBeNull()
  })

  it('executes only after the explicit local-signing confirmation', async () => {
    render(<FirmaAlphaMarket />)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Previsualizar operación' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.change(screen.getByLabelText('Cantidad FIRMA'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Previsualizar operación' }))
    fireEvent.click(await screen.findByRole('button', { name: /Confirmar, firmar localmente/ }))

    await waitFor(() => expect(mocks.executeFirmaBuy).toHaveBeenCalledWith(preview))
    expect(await screen.findByText(/Operación transmitida/)).toBeTruthy()
  })
})
