/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoNftAttachmentCard } from './MemoNftAttachmentCard'
import * as nftServiceModule from '../../services/nftService'
import * as ipfsUtils from '../../utils/ipfs'

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

  it('renders VERIFIED state, shows loading, and resolves NFT details with full visual card', async () => {
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      imageUrl: 'https://tomato-rational-rat-921.mypinata.cloud/ipfs/QmHash/image.png',
      metadata: {
        name: 'Evangelio RMZ del Xoloitzcuintle — Bloque Génesis',
        description: 'NFT conmemorativo del Evangelio RMZ del Xoloitzcuintle.',
        collection: { name: 'xolosArmy NFTs', family: 'Xolos Ramírez' },
        attributes: [{ trait_type: 'Rarity', value: 'Legendary' }]
      },
      genesisInfo: {
        tokenName: 'Evangelio RMZ',
        tokenTicker: 'XOLOSNFT',
        url: 'ipfs://QmMetadata',
        decimals: 0
      }
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
      expect(screen.getByTestId('memo-nft-name').textContent).toBe(
        'Evangelio RMZ del Xoloitzcuintle — Bloque Génesis'
      )
    })

    expect(screen.getByTestId('memo-nft-verified-badge').textContent).toBe('NFT Verificado')
    expect(screen.getByTestId('memo-nft-description').textContent).toContain(
      'NFT conmemorativo del Evangelio RMZ'
    )
    expect(screen.getByTestId('memo-nft-collection').textContent).toContain('xolosArmy NFTs')
    expect(screen.getByTestId('memo-nft-token-id').textContent).toBe('8539b6...955ff8')
    expect(screen.getByTestId('memo-nft-attributes').textContent).toContain('Rarity: Legendary')

    const img = screen.getByTestId('memo-nft-image') as HTMLImageElement
    expect(img.src).toContain('QmHash/image.png')
    expect(img.alt).toBe('Evangelio RMZ del Xoloitzcuintle — Bloque Génesis')
  })

  it('name fallback: uses metadata.name when present', async () => {
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValueOnce({
      tokenId,
      metadata: { name: 'Name From Metadata' },
      genesisInfo: {
        tokenName: 'Name From TokenName',
        tokenTicker: 'TICKER',
        url: '',
        decimals: 0
      }
    })

    render(
      <MemoNftAttachmentCard
        attachment={{ type: 'NFT', tokenId, ownership: 'VERIFIED_AT_INDEXING' }}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('memo-nft-name').textContent).toBe('Name From Metadata')
    })
  })

  it('name fallback: uses genesisInfo.tokenName when metadata.name is absent', async () => {
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValueOnce({
      tokenId,
      metadata: {},
      genesisInfo: {
        tokenName: 'Name From TokenName',
        tokenTicker: 'TICKER',
        url: '',
        decimals: 0
      }
    })

    render(
      <MemoNftAttachmentCard
        attachment={{ type: 'NFT', tokenId, ownership: 'VERIFIED_AT_INDEXING' }}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('memo-nft-name').textContent).toBe('Name From TokenName')
    })
  })

  it('name fallback: uses genesisInfo.tokenTicker when tokenName is absent', async () => {
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValueOnce({
      tokenId,
      metadata: {},
      genesisInfo: {
        tokenName: '',
        tokenTicker: 'TICKER',
        url: '',
        decimals: 0
      }
    })

    render(
      <MemoNftAttachmentCard
        attachment={{ type: 'NFT', tokenId, ownership: 'VERIFIED_AT_INDEXING' }}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('memo-nft-name').textContent).toBe('TICKER')
    })
  })

  it('name fallback: defaults to "NFT" when everything is absent', async () => {
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValueOnce({
      tokenId,
      metadata: {},
      genesisInfo: undefined
    })

    render(
      <MemoNftAttachmentCard
        attachment={{ type: 'NFT', tokenId, ownership: 'VERIFIED_AT_INDEXING' }}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('memo-nft-name').textContent).toBe('NFT')
    })
  })

  it('gracefully falls back to placeholder and tokenName when IPFS metadata fetch fails, but retains NFT Verificado badge', async () => {
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      metadata: undefined,
      genesisInfo: {
        tokenName: 'Evangelio RMZ Genesis',
        tokenTicker: 'XOLOSNFT',
        url: 'ipfs://QmFailedCid',
        decimals: 0
      }
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

    await waitFor(() => {
      expect(screen.getByTestId('memo-nft-placeholder')).toBeTruthy()
    })

    expect(screen.getByTestId('memo-nft-verified-badge').textContent).toBe('NFT Verificado')
    expect(screen.getByTestId('memo-nft-name').textContent).toBe('Evangelio RMZ Genesis')
    expect(screen.getByTestId('memo-nft-token-id').textContent).toBe('8539b6...955ff8')
  })

  it('tries next gateway candidate on image error and falls back to placeholder if all fail', async () => {
    vi.spyOn(ipfsUtils, 'getIpfsGatewayUrls').mockReturnValue([
      'https://gw1.test/ipfs/QmImage',
      'https://gw2.test/ipfs/QmImage'
    ])

    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockResolvedValue({
      tokenId,
      metadata: { name: 'Image Retry NFT', image: 'ipfs://QmImage' }
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

    await waitFor(() => {
      expect(screen.getByTestId('memo-nft-image')).toBeTruthy()
    })

    const img = screen.getByTestId('memo-nft-image') as HTMLImageElement
    expect(img.src).toBe('https://gw1.test/ipfs/QmImage')

    // Simulate error on first gateway candidate
    fireEvent.error(img)

    // Should switch to second candidate
    expect(img.src).toBe('https://gw2.test/ipfs/QmImage')

    // Simulate error on second gateway candidate
    fireEvent.error(img)

    // All failed -> show placeholder
    await waitFor(() => {
      expect(screen.getByTestId('memo-nft-placeholder')).toBeTruthy()
    })
  })

  it('prevents stale metadata display when tokenId changes', async () => {
    const tokenId1 = '1111111111111111111111111111111111111111111111111111111111111111'
    const tokenId2 = '2222222222222222222222222222222222222222222222222222222222222222'

    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockImplementation(async (id) => {
      if (id === tokenId1) {
        return { tokenId: id, metadata: { name: 'NFT One' } }
      }
      return { tokenId: id, metadata: { name: 'NFT Two' } }
    })

    const { rerender } = render(
      <MemoNftAttachmentCard
        attachment={{ type: 'NFT', tokenId: tokenId1, ownership: 'VERIFIED_AT_INDEXING' }}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('memo-nft-name').textContent).toBe('NFT One')
    })

    // Change tokenId to tokenId2
    rerender(
      <MemoNftAttachmentCard
        attachment={{ type: 'NFT', tokenId: tokenId2, ownership: 'VERIFIED_AT_INDEXING' }}
      />
    )

    // Immediately while loading tokenId2, it must not show 'NFT One'
    expect(screen.queryByText('NFT One')).toBeNull()

    await waitFor(() => {
      expect(screen.getByTestId('memo-nft-name').textContent).toBe('NFT Two')
    })
  })

  it('unmount aborts in-flight request and does not produce unhandled errors', async () => {
    let abortSignalCaptured: AbortSignal | undefined
    vi.spyOn(nftServiceModule, 'fetchNftDetails').mockImplementation(async (_id, options) => {
      abortSignalCaptured = options?.signal
      return new Promise((resolve) => setTimeout(resolve, 500))
    })

    const { unmount } = render(
      <MemoNftAttachmentCard
        attachment={{ type: 'NFT', tokenId, ownership: 'VERIFIED_AT_INDEXING' }}
      />
    )

    expect(abortSignalCaptured).toBeDefined()
    expect(abortSignalCaptured?.aborted).toBe(false)

    unmount()

    expect(abortSignalCaptured?.aborted).toBe(true)
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
