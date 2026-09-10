/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchNftDetails } from './nftService'
import * as chronikClientModule from './ChronikClient'
import * as ipfsModule from '../utils/ipfs'

type ChronikInstance = ReturnType<typeof chronikClientModule.getChronik>

describe('nftService - fetchNftDetails', () => {
  const tokenId = '17c807b364516916efbcfe64eac15b212935cce9e96aa58596bfbacfdba0d7c4'
  const parentTokenId = 'bf8e0b5cd60fe4d6354c662b28542e0f3c3d69941eb039426d65bcdb7fe9f48c'
  const metadataCid = 'QmSd8veFkA9EdYKUaAL4L4tHWdregyKWWaHPrW4hGUUkG8'
  const imageCid = 'QmU2BMQsuLZFJjan5DbRkAB8mxD5q45orM8pQWLpGGuF4m'

  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('correctly derives metadataCid, imageCid, imageUrl, genesisInfo, and groupTokenId', async () => {
    const mockChronik = {
      token: vi.fn().mockResolvedValue({
        tokenId,
        genesisInfo: {
          tokenTicker: 'XOLOSNFT',
          tokenName: 'Evangelio RMZ del Xoloitzcuintle — Bloque Génesis',
          url: `ipfs://${metadataCid}`,
          decimals: 0
        }
      })
    }
    vi.spyOn(chronikClientModule, 'getChronik').mockReturnValue(mockChronik as unknown as ChronikInstance)

    vi.spyOn(ipfsModule, 'fetchIpfsJson').mockResolvedValue({
      data: {
        name: 'Evangelio RMZ del Xoloitzcuintle — Bloque Génesis',
        description: 'NFT conmemorativo',
        image: `ipfs://${imageCid}`,
        parent: parentTokenId,
        collection: { name: 'xolosArmy NFTs', family: 'Xolos Ramírez' }
      },
      url: `https://tomato-rational-rat-921.mypinata.cloud/ipfs/${metadataCid}`,
      gateway: 'https://tomato-rational-rat-921.mypinata.cloud/ipfs/'
    })

    const details = await fetchNftDetails(tokenId)

    expect(details.tokenId).toBe(tokenId)
    expect(details.metadataCid).toBe(metadataCid)
    expect(details.imageCid).toBe(imageCid)
    expect(details.imageUrl).toContain(imageCid)
    expect(details.groupTokenId).toBe(parentTokenId)
    expect(details.genesisInfo?.tokenName).toBe(
      'Evangelio RMZ del Xoloitzcuintle — Bloque Génesis'
    )
    expect(details.metadata?.name).toBe('Evangelio RMZ del Xoloitzcuintle — Bloque Génesis')
  })

  it('resolves metadata.image when it is a direct https URL', async () => {
    const mockChronik = {
      token: vi.fn().mockResolvedValue({
        tokenId,
        genesisInfo: {
          tokenTicker: 'NFT',
          tokenName: 'HTTPS Image NFT',
          url: `ipfs://${metadataCid}`,
          decimals: 0
        }
      })
    }
    vi.spyOn(chronikClientModule, 'getChronik').mockReturnValue(mockChronik as unknown as ChronikInstance)

    const directHttpsImage = 'https://example.com/assets/picture.png'
    vi.spyOn(ipfsModule, 'fetchIpfsJson').mockResolvedValue({
      data: {
        name: 'HTTPS Image NFT',
        image: directHttpsImage
      },
      url: `https://tomato-rational-rat-921.mypinata.cloud/ipfs/${metadataCid}`,
      gateway: 'https://tomato-rational-rat-921.mypinata.cloud/ipfs/'
    })

    const details = await fetchNftDetails(tokenId)

    expect(details.imageUrl).toBe(directHttpsImage)
    expect(details.imageCid).toBeUndefined()
  })

  it('resolves metadata.image with CID path (ipfs://CID/path.png)', async () => {
    const mockChronik = {
      token: vi.fn().mockResolvedValue({
        tokenId,
        genesisInfo: {
          tokenTicker: 'NFT',
          tokenName: 'Path NFT',
          url: `ipfs://${metadataCid}`,
          decimals: 0
        }
      })
    }
    vi.spyOn(chronikClientModule, 'getChronik').mockReturnValue(mockChronik as unknown as ChronikInstance)

    vi.spyOn(ipfsModule, 'fetchIpfsJson').mockResolvedValue({
      data: {
        name: 'Path NFT',
        image: `ipfs://${imageCid}/subpath/artwork.png`
      },
      url: `https://tomato-rational-rat-921.mypinata.cloud/ipfs/${metadataCid}`,
      gateway: 'https://tomato-rational-rat-921.mypinata.cloud/ipfs/'
    })

    const details = await fetchNftDetails(tokenId)

    expect(details.imageCid).toBe(imageCid)
    expect(details.imageUrl).toContain(`${imageCid}/subpath/artwork.png`)
  })

  it('uses cached metadata when available without refetching IPFS', async () => {
    const mockChronik = {
      token: vi.fn().mockResolvedValue({
        tokenId,
        genesisInfo: {
          tokenTicker: 'CACHED',
          tokenName: 'Cached NFT',
          url: `ipfs://${metadataCid}`,
          decimals: 0
        }
      })
    }
    vi.spyOn(chronikClientModule, 'getChronik').mockReturnValue(mockChronik as unknown as ChronikInstance)

    // Pre-populate cache
    const cacheState = {
      tokenIds: [tokenId],
      metadataByTokenId: {
        [tokenId]: {
          metadata: { name: 'From Cache' },
          metadataCid
        }
      },
      parentByTokenId: {}
    }
    localStorage.setItem('tonalli_nft_cache_v1', JSON.stringify(cacheState))

    const fetchIpfsSpy = vi.spyOn(ipfsModule, 'fetchIpfsJson')

    const details = await fetchNftDetails(tokenId)

    expect(fetchIpfsSpy).not.toHaveBeenCalled()
    expect(details.metadata?.name).toBe('From Cache')
  })

  it('refetches IPFS when refreshMetadata option is true even if cached', async () => {
    const mockChronik = {
      token: vi.fn().mockResolvedValue({
        tokenId,
        genesisInfo: {
          tokenTicker: 'CACHED',
          tokenName: 'Cached NFT',
          url: `ipfs://${metadataCid}`,
          decimals: 0
        }
      })
    }
    vi.spyOn(chronikClientModule, 'getChronik').mockReturnValue(mockChronik as unknown as ChronikInstance)

    const cacheState = {
      tokenIds: [tokenId],
      metadataByTokenId: {
        [tokenId]: {
          metadata: { name: 'From Old Cache' },
          metadataCid
        }
      },
      parentByTokenId: {}
    }
    localStorage.setItem('tonalli_nft_cache_v1', JSON.stringify(cacheState))

    vi.spyOn(ipfsModule, 'fetchIpfsJson').mockResolvedValue({
      data: { name: 'From Fresh Network' },
      url: `https://gw.test/ipfs/${metadataCid}`,
      gateway: 'https://gw.test/ipfs/'
    })

    const details = await fetchNftDetails(tokenId, { refreshMetadata: true })

    expect(details.metadata?.name).toBe('From Fresh Network')
  })

  it('gracefully handles Chronik or IPFS failure without throwing', async () => {
    const mockChronik = {
      token: vi.fn().mockRejectedValue(new Error('Chronik offline'))
    }
    vi.spyOn(chronikClientModule, 'getChronik').mockReturnValue(mockChronik as unknown as ChronikInstance)

    const details = await fetchNftDetails(tokenId)

    expect(details.tokenId).toBe(tokenId)
    expect(details.metadata).toBeUndefined()
    expect(details.imageUrl).toBe('')
  })
})
