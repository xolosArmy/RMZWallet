import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { normalizeFirmaBid, proxyFirmaBid } from './firmaBidProxy'

const PROXY_URL = 'https://tonalli.example/api/firma-bid'
const UPSTREAM_URL = 'https://stakedxec.com/api/bid'

const request = (method = 'GET') => new Request(`${PROXY_URL}?url=https://attacker.example/bid`, {
  method,
  headers: {
    Authorization: 'Bearer caller-secret',
    Cookie: 'wallet=session'
  }
})

const upstreamResponse = (
  body: string,
  init: ResponseInit = {},
  finalUrl = UPSTREAM_URL,
  redirected = false
) => {
  const response = new Response(body, init)
  Object.defineProperties(response, {
    url: { value: finalUrl },
    redirected: { value: redirected }
  })
  return response
}

const bodyOf = (response: Response) => response.json() as Promise<Record<string, unknown>>

describe('Firma bid server-side proxy', () => {
  it('returns a normalized positive bid without forwarding caller credentials or caching it', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => upstreamResponse(
      JSON.stringify({ bid: 147_306.27 }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    ))

    const response = await proxyFirmaBid(request(), { fetchImpl })

    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ bid: '147306.27' })
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0')
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(fetchImpl).toHaveBeenCalledWith(UPSTREAM_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      cache: 'no-store',
      signal: expect.any(AbortSignal)
    })
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization')
    expect(fetchImpl.mock.calls[0][1]?.headers).not.toHaveProperty('Cookie')
  })

  it('follows a same-origin upstream redirect and accepts only the final validated JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => upstreamResponse(
      JSON.stringify({ bid: '7000.00' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
      'https://stakedxec.com/api/current-bid',
      true
    ))

    const response = await proxyFirmaBid(request(), { fetchImpl })

    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('follow')
    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ bid: '7000' })
  })

  it('fails closed when redirect following ends at an unexpected origin', async () => {
    const response = await proxyFirmaBid(request(), {
      fetchImpl: async () => upstreamResponse(
        JSON.stringify({ bid: '7000' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
        'https://firma.cash/',
        true
      )
    })

    expect(response.status).toBe(502)
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'El oráculo de redención de Firma no está disponible temporalmente.',
      code: 'FIRMA_BID_REDIRECT_REJECTED'
    })
  })

  it('fails closed on an upstream non-2xx response without reflecting its body', async () => {
    const response = await proxyFirmaBid(request(), {
      fetchImpl: async () => upstreamResponse('<html>internal detail</html>', {
        status: 500,
        headers: { 'Content-Type': 'text/html' }
      })
    })

    expect(response.status).toBe(502)
    const body = await bodyOf(response)
    expect(body).toEqual({
      error: 'El oráculo de redención de Firma no está disponible temporalmente.',
      code: 'FIRMA_BID_UPSTREAM_UNAVAILABLE'
    })
    expect(JSON.stringify(body)).not.toContain('internal detail')
  })

  it('aborts a timed-out upstream request and reports only the safe timeout taxonomy', async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))

    const response = await proxyFirmaBid(request(), { fetchImpl, timeoutMs: 1 })

    expect(response.status).toBe(504)
    await expect(bodyOf(response)).resolves.toEqual({
      error: 'El oráculo de redención de Firma no respondió a tiempo.',
      code: 'FIRMA_BID_TIMEOUT'
    })
  })

  it('rejects an HTML response even when upstream returns HTTP 200', async () => {
    const response = await proxyFirmaBid(request(), {
      fetchImpl: async () => upstreamResponse('<html>{"bid":"7000"}</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      })
    })

    expect(response.status).toBe(502)
    await expect(bodyOf(response)).resolves.toMatchObject({ code: 'FIRMA_BID_INVALID_PAYLOAD' })
  })

  it('rejects valid JSON without its own bid field', async () => {
    const inheritedBid = Object.create({ bid: '7000' }) as Record<string, unknown>
    const response = await proxyFirmaBid(request(), {
      fetchImpl: async () => upstreamResponse(
        JSON.stringify(inheritedBid),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    expect(response.status).toBe(502)
    await expect(bodyOf(response)).resolves.toMatchObject({ code: 'FIRMA_BID_INVALID_PAYLOAD' })
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['non-numeric', 'not-a-price'],
    ['too many XEC decimals', '1.001'],
    ['exponential notation', '1e3']
  ])('rejects a %s bid', async (_label, bid) => {
    const response = await proxyFirmaBid(request(), {
      fetchImpl: async () => upstreamResponse(
        JSON.stringify({ bid }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    })

    expect(response.status).toBe(502)
    await expect(bodyOf(response)).resolves.toMatchObject({ code: 'FIRMA_BID_INVALID_PAYLOAD' })
  })

  it('accepts only GET and never calls the upstream for another method', async () => {
    const fetchImpl = vi.fn()

    const response = await proxyFirmaBid(request('POST'), { fetchImpl })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps both upstream URLs out of browser code and the current URL singular in the server proxy', () => {
    const browserSources = [
      readFileSync(new URL('../src/config/firmaAlpha.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/services/firmaAlphaExchange.ts', import.meta.url), 'utf8')
    ].join('\n')
    const serverSource = readFileSync(new URL('./firmaBidProxy.ts', import.meta.url), 'utf8')

    expect(browserSources).not.toContain('firmaprotocol.com/api/bid')
    expect(browserSources).not.toContain('stakedxec.com/api/bid')
    expect(serverSource).not.toContain('firmaprotocol.com/api/bid')
    expect(serverSource.match(/https:\/\/stakedxec\.com\/api\/bid/g)).toHaveLength(1)
  })
})

describe('Firma bid decimal normalization', () => {
  it('returns only values representable by the two-decimal XEC pricing logic', () => {
    expect(normalizeFirmaBid('000147306.20')).toBe('147306.2')
    expect(normalizeFirmaBid('0.01')).toBe('0.01')
  })
})
