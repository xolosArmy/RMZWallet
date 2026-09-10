/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoNftAttachmentCard } from './MemoNftAttachmentCard'
import * as nftServiceModule from '../../services/nftService'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('MemoNftAttachmentCard Component', () => {
  const tokenId = '8539b6f59912009f8f4fd322bf67266063233c101a4b54aa0a765ad0c9955ff8'

  it('renders UNVERIFIED state without fetching NFT details', () => {
    const fetchSpy = vi.spyOn(nftServiceModule, 'fetchNftDetails')
    const handleRemove = vi.fn()

    render(
      <MemoNftAttachmentCard
        attachment={{
          type: 'NFT',
          tokenId,
          ownership: 'UNVERIFIED'
        }}
        onRemove={handleRemove}
      />
    )

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId('memo-nft-unverified')).toBeTruthy()
    expect(screen.getByText('No verificado')).toBeTruthy()
    expect(screen.getByText('8539b6...955ff8')).toBeTruthy()

    const removeBtn = screen.getByTestId('memo-nft-remove-btn')
    fireEvent.click(removeBtn)
    expect(handleRemove).toHaveBeenCalledTimes(1)
  })

  it('renders VERIFIED state, shows loading, and resolves NFT details', async () => {
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      imageUrl: 'https://ipfs.io/ipfs/QmHash/image.png',
      metadata: { name: 'Xoloitzcuintle #42' }
    })

    render(
      <MemoNftAttachmentCard
        attachment={{
          type: 'NFT',
          tokenId,
          ownership: 'VERIFIED_AT_INDEXING'
        }}
      />
    )

    expect(screen.getByTestId('memo-nft-loading')).toBeTruthy()

    await waitFor(() => {
      expect(screen.getByText('Xoloitzcuintle #42')).toBeTruthy()
    })

    expect(screen.getByText('NFT Verificado')).toBeTruthy()
    const img = screen.getByTestId('memo-nft-image') as HTMLImageElement
    expect(img.src).toBe('https://ipfs.io/ipfs/QmHash/image.png')
    expect(img.alt).toBe('Xoloitzcuintle #42')
  })

  it('gracefully falls back to placeholder when metadata fetch fails', async () => {
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockRejectedValue(new Error('Network error'))

    render(
      <MemoNftAttachmentCard
        attachment={{
          type: 'NFT',
          tokenId,
          ownership: 'VERIFIED_AT_INDEXING'
        }}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('memo-nft-placeholder')).toBeTruthy()
    })

    expect(screen.getByText('NFT Verificado')).toBeTruthy()
    expect(screen.getByText('8539b6...955ff8')).toBeTruthy()
  })

  it('calls onRemove when Quitar NFT is clicked in verified card', async () => {
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      metadata: { name: 'Xolo #1' }
    })
    const handleRemove = vi.fn()

    render(
      <MemoNftAttachmentCard
        attachment={{
          type: 'NFT',
          tokenId,
          ownership: 'VERIFIED_AT_INDEXING'
        }}
        onRemove={handleRemove}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('Xolo #1')).toBeTruthy()
    })

    const removeBtn = screen.getByTestId('memo-nft-remove-btn')
    fireEvent.click(removeBtn)
    expect(handleRemove).toHaveBeenCalledTimes(1)
  })

  it('renders selection mode with "NFT seleccionado" badge and NEVER renders "NFT Verificado"', () => {
    const handleRemove = vi.fn()

    render(
      <MemoNftAttachmentCard
        mode="selection"
        attachment={{
          type: 'NFT',
          tokenId,
          ownership: 'UNVERIFIED'
        }}
        selectedAsset={{
          name: 'Xoloitzcuintle Guardián',
          imageUrl: 'https://ipfs.io/ipfs/QmHash/guardian.png'
        }}
        onRemove={handleRemove}
      />
    )

    expect(screen.getByTestId('memo-nft-selection')).toBeTruthy()
    expect(screen.getByTestId('memo-nft-selection-badge').textContent).toBe('NFT seleccionado')
    expect(screen.queryByText('NFT Verificado')).toBeNull()
    expect(screen.queryByTestId('memo-nft-verified')).toBeNull()
    expect(screen.queryByText('No verificado')).toBeNull()
    expect(screen.getByText('Xoloitzcuintle Guardián')).toBeTruthy()
    expect(screen.getByText('8539b6...955ff8')).toBeTruthy()

    const removeBtn = screen.getByTestId('memo-nft-remove-btn')
    fireEvent.click(removeBtn)
    expect(handleRemove).toHaveBeenCalledTimes(1)
  })
})
