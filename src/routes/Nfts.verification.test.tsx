// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import Nfts from './Nfts'

const CHILD_TOKEN_ID = '1'.repeat(64)

const mocks = vi.hoisted(() => ({
  fetchOwnedNfts: vi.fn(),
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
  mintXolosarmyNftChild: vi.fn()
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
})
