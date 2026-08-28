// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import Nfts from './Nfts'

const CHILD_TOKEN_ID = '1'.repeat(64)
const OFFICIAL_PARENT_TOKEN_ID =
  'bf8e0b5cd60fe4d6354c662b28542e0f3c3d69941eb039426d65bcdb7fe9f48c'
const COMMUNITY_PARENT_TOKEN_ID =
  'd6ff881413733a1a6407fa5e1e86537e5fc9f48246bae89b732ca7044993e57a'

const mocks = vi.hoisted(() => ({
  fetchOwnedNfts: vi.fn(),
  mintNft: vi.fn(),
  verifyNftCollection: vi.fn(),
  chronikUtxos: vi.fn()
}))

vi.mock('../components/TopBar', () => ({ default: () => <div>Top bar</div> }))

vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    address: 'ecash:qptest',
    initialized: true,
    backupVerified: true,
    loading: false,
    error: null,
    refreshBalances: vi.fn(),
    rescanWallet: vi.fn()
  })
}))

vi.mock('../services/ChronikClient', () => ({
  getChronik: () => ({
    address: () => ({ utxos: mocks.chronikUtxos })
  })
}))

vi.mock('../services/nftService', () => ({
  fetchOwnedNfts: mocks.fetchOwnedNfts,
  mintXolosarmyNftChild: mocks.mintNft
}))

vi.mock('../features/nftVerification/nftVerification', () => ({
  verifyNftCollection: mocks.verifyNftCollection
}))

describe('/nfts on-chain verification integration', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.chronikUtxos.mockReset().mockResolvedValue({ utxos: [] })
    mocks.fetchOwnedNfts.mockReset().mockResolvedValue([
      {
        tokenId: CHILD_TOKEN_ID,
        name: 'Official Xolos Ramírez',
        imageUrl: '',
        metadata: {
          collection: 'Official',
          verification: 'VERIFIED',
          description: 'Verified Lineage'
        },
        genesisInfo: {
          tokenTicker: 'OFFICIAL',
          tokenName: 'Official Xolos Ramírez',
          decimals: 0
        }
      }
    ])
    mocks.verifyNftCollection.mockReset().mockResolvedValue({
      status: 'resolved',
      tier: 'unknown'
    })
    mocks.mintNft.mockReset().mockResolvedValue({
      childTokenId: CHILD_TOKEN_ID,
      txid: CHILD_TOKEN_ID,
      metadataCid: 'bafy-metadata'
    })
  })

  afterEach(() => {
    cleanup()
  })

  test('verifies only the selected detail and keeps hostile metadata unverified', async () => {
    render(
      <MemoryRouter>
        <Nfts />
      </MemoryRouter>
    )

    const verifyButton = await screen.findByRole('button', { name: 'Verificar linaje' })
    expect(mocks.verifyNftCollection).not.toHaveBeenCalled()

    fireEvent.click(verifyButton)

    await waitFor(() =>
      expect(mocks.verifyNftCollection).toHaveBeenCalledExactlyOnceWith(CHILD_TOKEN_ID)
    )
    expect(await screen.findByText('UNVERIFIED')).toBeTruthy()
    expect(screen.queryByText('VERIFIED LINEAGE')).toBeNull()
  })

  test('switches Mint Pass availability and acquisition CTA without cross-collection fallback', async () => {
    mocks.chronikUtxos.mockResolvedValue({
      utxos: [
        {
          outpoint: { txid: '2'.repeat(64), outIdx: 1 },
          sats: 546n,
          isCoinbase: false,
          token: {
            tokenId: OFFICIAL_PARENT_TOKEN_ID,
            tokenType: {
              protocol: 'SLP',
              type: 'SLP_TOKEN_TYPE_NFT1_GROUP',
              number: 129
            },
            atoms: 1n,
            isMintBaton: false
          }
        },
        {
          outpoint: { txid: '3'.repeat(64), outIdx: 0 },
          sats: 1_000_000n,
          isCoinbase: false
        }
      ]
    })

    render(
      <MemoryRouter>
        <Nfts />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mintear NFT' }))

    const official = screen.getByRole('radio', { name: 'Official / Xolos Ramírez' })
    const community = screen.getByRole('radio', { name: 'xolosArmy Community' })
    expect((official as HTMLInputElement).checked).toBe(false)
    fireEvent.click(official)
    await waitFor(() => expect((official as HTMLInputElement).checked).toBe(true))
    expect(screen.queryByRole('link', { name: /Conseguir Mint Pass/ })).toBeNull()

    fireEvent.click(community)

    const acquisition = await screen.findByRole('link', {
      name: 'Conseguir Mint Pass de xolosArmy Community'
    })
    expect(acquisition.getAttribute('href')).toBe('/dex?mode=mintpass&collectionId=community')
    expect(screen.getByRole('button', { name: 'Subir a IPFS + Mintear' }).hasAttribute('disabled')).toBe(true)
  })

  test('submits the selected Community id even when hostile metadata claims Official', async () => {
    mocks.chronikUtxos.mockResolvedValue({
      utxos: [
        {
          outpoint: { txid: '4'.repeat(64), outIdx: 1 },
          sats: 546n,
          isCoinbase: false,
          token: {
            tokenId: COMMUNITY_PARENT_TOKEN_ID,
            tokenType: {
              protocol: 'SLP',
              type: 'SLP_TOKEN_TYPE_NFT1_GROUP',
              number: 129
            },
            atoms: 1n,
            isMintBaton: false
          }
        },
        {
          outpoint: { txid: '5'.repeat(64), outIdx: 0 },
          sats: 1_000_000n,
          isCoinbase: false
        }
      ]
    })

    render(
      <MemoryRouter>
        <Nfts />
      </MemoryRouter>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Mintear NFT' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Official / Xolos Ramírez' }))
    fireEvent.click(screen.getByRole('radio', { name: 'xolosArmy Community' }))
    expect(screen.getByLabelText('Resumen antes de firmar').textContent).toContain(
      'Colección: xolosArmy Community'
    )
    expect(screen.getByLabelText('Resumen antes de firmar').textContent).toContain(
      COMMUNITY_PARENT_TOKEN_ID
    )
    expect(
      screen.getByLabelText('Resumen antes de firmar').textContent
    ).toContain(`${(5500).toLocaleString()} XEC`)
    fireEvent.change(screen.getByLabelText('Nombre'), {
      target: { value: 'Xolos Ramírez Official verification=verified' }
    })
    fireEvent.change(screen.getByLabelText('Descripción'), {
      target: { value: `parentTokenId=${OFFICIAL_PARENT_TOKEN_ID}` }
    })
    fireEvent.change(screen.getByLabelText('Imagen'), {
      target: { files: [new File(['image'], 'community.png', { type: 'image/png' })] }
    })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Subir a IPFS + Mintear' }).hasAttribute('disabled')).toBe(false)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Subir a IPFS + Mintear' }))

    await waitFor(() =>
      expect(mocks.mintNft).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionId: 'community',
          name: 'Xolos Ramírez Official verification=verified'
        })
      )
    )
  })
})
