import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_PUBLIC_IPFS_GATEWAYS,
  fetchIpfsJson,
  getIpfsGatewayUrls,
  ipfsToCid,
  ipfsToGatewayUrl,
  resolveIpfsGatewayBases
} from './ipfs'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('IPFS gateway resolution and fetch utilities', () => {
  it('contains expected public fallback gateways including pinata and ipfs.io', () => {
    expect(FALLBACK_PUBLIC_IPFS_GATEWAYS).toContain('https://tomato-rational-rat-921.mypinata.cloud/ipfs/')
    expect(FALLBACK_PUBLIC_IPFS_GATEWAYS).toContain('https://gateway.pinata.cloud/ipfs/')
    expect(FALLBACK_PUBLIC_IPFS_GATEWAYS).toContain('https://ipfs.io/ipfs/')
    expect(FALLBACK_PUBLIC_IPFS_GATEWAYS).toContain('https://dweb.link/ipfs/')
  })

  it('resolves gateway bases with custom gateway prioritized and deduplicated', () => {
    const bases = resolveIpfsGatewayBases('https://custom-gateway.io/ipfs')
    expect(bases[0]).toBe('https://custom-gateway.io/ipfs/')
    const unique = Array.from(new Set(bases))
    expect(bases.length).toBe(unique.length)
  })

  it('extracts CID from various IPFS URI formats', () => {
    const cid = 'QmSd8veFkA9EdYKUaAL4L4tHWdregyKWWaHPrW4hGUUkG8'
    expect(ipfsToCid(`ipfs://${cid}`)).toBe(cid)
    expect(ipfsToCid(`ipfs://${cid}/metadata.json`)).toBe(cid)
    expect(ipfsToCid(`https://ipfs.io/ipfs/${cid}`)).toBe(cid)
    expect(ipfsToCid(cid)).toBe(cid)
  })

  it('generates prioritized candidate URLs for IPFS URIs', () => {
    const cid = 'QmSd8veFkA9EdYKUaAL4L4tHWdregyKWWaHPrW4hGUUkG8'
    const urls = getIpfsGatewayUrls(`ipfs://${cid}/avatar.png`)
    expect(urls.length).toBeGreaterThanOrEqual(FALLBACK_PUBLIC_IPFS_GATEWAYS.length)
    expect(urls[0]).toContain(cid)
    expect(urls[0]).toContain('/avatar.png')
  })

  it('returns direct HTTPS URL unchanged when not an IPFS gateway URL', () => {
    const directUrl = 'https://example.com/images/nft.png'
    const urls = getIpfsGatewayUrls(directUrl)
    expect(urls).toEqual([directUrl])
  })

  it('ipfsToGatewayUrl returns the first candidate URL', () => {
    const cid = 'QmSd8veFkA9EdYKUaAL4L4tHWdregyKWWaHPrW4hGUUkG8'
    const url = ipfsToGatewayUrl(`ipfs://${cid}`)
    expect(url).toBeTruthy()
    expect(url?.endsWith(cid)).toBe(true)
  })

  it('fetchIpfsJson successfully fetches valid JSON on first gateway', async () => {
    const mockData = { name: 'Xolo NFT', description: 'Test NFT' }
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    const result = await fetchIpfsJson<{ name: string; description: string }>(
      'ipfs://QmSd8veFkA9EdYKUaAL4L4tHWdregyKWWaHPrW4hGUUkG8'
    )

    expect(result).not.toBeNull()
    expect(result?.data.name).toBe('Xolo NFT')
    expect(result?.data.description).toBe('Test NFT')
  })

  it('fetchIpfsJson sequentially falls back to second gateway when first gateway returns 429', async () => {
    const mockData = { name: 'Recovered via Fallback', description: 'Fallback successful' }

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // Gateway 1 fails with 429
      .mockResolvedValueOnce(new Response('Rate Limited', { status: 429 }))
      // Gateway 2 succeeds with 200
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )

    const result = await fetchIpfsJson<{ name: string }>(
      'ipfs://QmSd8veFkA9EdYKUaAL4L4tHWdregyKWWaHPrW4hGUUkG8'
    )

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result).not.toBeNull()
    expect(result?.data.name).toBe('Recovered via Fallback')
  })

  it('fetchIpfsJson gracefully skips invalid JSON and continues to next gateway', async () => {
    const mockData = { name: 'Valid JSON NFT' }

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // Gateway 1 returns non-JSON html error page
      .mockResolvedValueOnce(new Response('<html>502 Bad Gateway</html>', { status: 200 }))
      // Gateway 2 returns valid JSON
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )

    const result = await fetchIpfsJson<{ name: string }>(
      'ipfs://QmSd8veFkA9EdYKUaAL4L4tHWdregyKWWaHPrW4hGUUkG8'
    )

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(result?.data.name).toBe('Valid JSON NFT')
  })

  it('fetchIpfsJson returns null without throwing when all gateways fail', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

    const result = await fetchIpfsJson(
      'ipfs://QmSd8veFkA9EdYKUaAL4L4tHWdregyKWWaHPrW4hGUUkG8',
      { customGateways: ['https://gw1.test/ipfs/', 'https://gw2.test/ipfs/'] }
    )

    expect(result).toBeNull()
  })

  it('fetchIpfsJson aborts early if parent signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await fetchIpfsJson('ipfs://QmHash', { signal: controller.signal })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })
})
