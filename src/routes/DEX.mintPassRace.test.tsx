// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const OFFICIAL_PARENT_TOKEN_ID =
  'bf8e0b5cd60fe4d6354c662b28542e0f3c3d69941eb039426d65bcdb7fe9f48c'
const COMMUNITY_PARENT_TOKEN_ID =
  'd6ff881413733a1a6407fa5e1e86537e5fc9f48246bae89b732ca7044993e57a'

const mocks = vi.hoisted(() => ({
  loadOfferById: vi.fn(),
  acceptOfferById: vi.fn(),
  createSellOfferToken: vi.fn(),
  getSignatory: vi.fn(),
  withPrivateKey: vi.fn(),
  chronikToken: vi.fn(),
  chronikBroadcast: vi.fn(),
  refreshBalances: vi.fn(),
  rescanWallet: vi.fn()
}))

vi.mock('../components/TopBar', () => ({ default: () => <div>Top bar</div> }))
vi.mock('../components/WcDebugPanel', () => ({ default: () => null }))
vi.mock('../features/dex/components/DexTakerRmz', () => ({ default: () => null }))
vi.mock('../features/dex/components/FirmaAlphaMarket', () => ({ default: () => null }))

vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    address: 'ecash:qplm2jhzuteklx9naquzwfe97tx3h8eu4gyq385tw8',
    initialized: true,
    refreshBalances: mocks.refreshBalances,
    rescanWallet: mocks.rescanWallet,
    loading: false,
    error: null,
    backupVerified: true
  })
}))

vi.mock('../services/ChronikClient', () => ({
  getChronik: () => ({
    token: mocks.chronikToken,
    broadcastTx: mocks.chronikBroadcast,
    address: () => ({ utxos: vi.fn(async () => ({ utxos: [] })) }),
    tx: vi.fn()
  })
}))

vi.mock('../services/XolosWalletService', () => ({
  EXTENDED_GAP_LIMIT: 145,
  xolosWalletService: {
    getSignatory: mocks.getSignatory,
    withPrivateKey: mocks.withPrivateKey
  }
}))

vi.mock('../services/nftService', () => ({
  fetchNftDetails: vi.fn(),
  fetchOwnedNfts: vi.fn(async () => [])
}))

vi.mock('../services/agoraExchange', () => ({
  acceptOfferById: mocks.acceptOfferById,
  createSellOfferToken: mocks.createSellOfferToken,
  loadOfferById: mocks.loadOfferById
}))

vi.mock('../services/buyOfferById', () => ({
  MISSING_OR_SPENT_MESSAGE: 'missing',
  buyOfferById: vi.fn()
}))

vi.mock('../lib/walletconnect/WcWallet', () => ({
  wcWallet: {
    getOfferEventTargetsSummary: vi.fn(() => ({
      totalSessions: 0,
      eligibleTopics: [],
      eligibleChains: []
    })),
    publishOrQueueOffer: vi.fn()
  }
}))

vi.mock('../services/slpNftTxBuilder', () => ({
  MINT_PASS_MAX_QUANTITY: 100,
  NFT_PARENT_MINT_BATON_VOUT: 2,
  XOLOSARMY_MINT_PASS_ADMIN_ADDRESS: 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk',
  getMintPassAdminState: vi.fn(),
  mintSlpNft1GroupPasses: vi.fn()
}))

import DEX from './DEX'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const offerResult = (tokenId: string, offerId = `${'1'.repeat(64)}:1`) => ({
  offer: {},
  summary: {
    offerId,
    tokenId,
    tokenAtoms: 1n,
    priceSats: 1_000n,
    priceXec: '10.00'
  }
})

function NavigationControls() {
  const navigate = useNavigate()
  return (
    <div>
      <button
        type="button"
        onClick={() => navigate('/dex?mode=mintpass&collectionId=official')}
      >
        Route Official
      </button>
      <button
        type="button"
        onClick={() => navigate('/dex?mode=mintpass&collectionId=community')}
      >
        Route Community
      </button>
    </div>
  )
}

const renderDex = (collectionId: 'official' | 'community' | string) =>
  render(
    <MemoryRouter initialEntries={[`/dex?mode=mintpass&collectionId=${collectionId}`]}>
      <Routes>
        <Route
          path="/dex"
          element={
            <>
              <DEX />
              <NavigationControls />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  )

describe('DEX Mint Pass collection race boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.chronikToken.mockResolvedValue({ genesisInfo: { decimals: 0 } })
    mocks.acceptOfferById.mockResolvedValue({ txid: 'accepted' })
  })

  afterEach(() => cleanup())

  test.each([
    {
      from: 'official' as const,
      to: 'community' as const,
      staleParent: OFFICIAL_PARENT_TOKEN_ID,
      routeButton: 'Route Community',
      selectedLabel: 'xolosArmy Community'
    },
    {
      from: 'community' as const,
      to: 'official' as const,
      staleParent: COMMUNITY_PARENT_TOKEN_ID,
      routeButton: 'Route Official',
      selectedLabel: 'Official / Xolos Ramírez'
    }
  ])(
    'discards a late $from offer after switching to $to and never reaches acceptance/signing',
    async ({ from, staleParent, routeButton, selectedLabel }) => {
      const pending = deferred<ReturnType<typeof offerResult>>()
      mocks.loadOfferById.mockReturnValueOnce(pending.promise)
      renderDex(from)

      const offerInput = await screen.findByLabelText('Offer ID')
      fireEvent.change(offerInput, { target: { value: `${'1'.repeat(64)}:1` } })
      fireEvent.click(screen.getByRole('button', { name: 'Cargar oferta' }))
      await waitFor(() => expect(mocks.loadOfferById).toHaveBeenCalledTimes(1))

      fireEvent.click(screen.getByRole('button', { name: routeButton }))
      await waitFor(() =>
        expect(
          (screen.getByRole('radio', { name: selectedLabel }) as HTMLInputElement).checked
        ).toBe(true)
      )

      await act(async () => pending.resolve(offerResult(staleParent)))
      expect(screen.queryByText('Cantidad: 1')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Comprar' }))
      expect(mocks.acceptOfferById).not.toHaveBeenCalled()
      expect(mocks.getSignatory).not.toHaveBeenCalled()
      expect(mocks.withPrivateKey).not.toHaveBeenCalled()
      expect(mocks.chronikBroadcast).not.toHaveBeenCalled()
    }
  )

  test('rejects a cached summary whose token differs from the current canonical Parent', async () => {
    mocks.loadOfferById.mockResolvedValueOnce(offerResult(OFFICIAL_PARENT_TOKEN_ID))
    renderDex('community')

    const offerInput = await screen.findByLabelText('Offer ID')
    fireEvent.change(offerInput, { target: { value: `${'1'.repeat(64)}:1` } })
    fireEvent.click(screen.getByRole('button', { name: 'Cargar oferta' }))
    expect(await screen.findByText('Cantidad: 1')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Comprar' }))
    expect(await screen.findByText('La oferta cargada no corresponde a la colección seleccionada.')).toBeTruthy()
    expect(mocks.acceptOfferById).not.toHaveBeenCalled()
    expect(mocks.getSignatory).not.toHaveBeenCalled()
    expect(mocks.withPrivateKey).not.toHaveBeenCalled()
    expect(mocks.chronikBroadcast).not.toHaveBeenCalled()
  })

  test('rejects a hostile free-form collection query without exposing a raw Parent authority', async () => {
    renderDex('a'.repeat(64))

    await waitFor(() =>
      expect(screen.queryByText('Colección del Mint Pass')).toBeNull()
    )
    expect(mocks.loadOfferById).not.toHaveBeenCalled()
    expect(mocks.acceptOfferById).not.toHaveBeenCalled()
    expect(mocks.getSignatory).not.toHaveBeenCalled()
    expect(mocks.withPrivateKey).not.toHaveBeenCalled()
    expect(mocks.chronikBroadcast).not.toHaveBeenCalled()
  })
})
