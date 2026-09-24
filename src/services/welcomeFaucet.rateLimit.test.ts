import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

describe('Welcome faucet rate-limit metadata', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_TONALLI_FAUCET_URL', 'https://faucet.example')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  test('parses Retry-After seconds and HTTP dates without negative or unbounded timers', async () => {
    const { parseWelcomeRetryAfterMs } = await import('./welcomeFaucet')
    const now = Date.UTC(2015, 9, 21, 7, 26, 0)
    expect(parseWelcomeRetryAfterMs('120', now)).toBe(120_000)
    expect(parseWelcomeRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', now)).toBe(120_000)
    expect(parseWelcomeRetryAfterMs('Wed, 21 Oct 2015 07:25:00 GMT', now)).toBe(0)
    for (const invalid of [null, '', '  ', '-1', 'NaN', '1.5', 'not-a-date', 'Fri, 30 Feb 2024 07:28:00 GMT']) {
      expect(parseWelcomeRetryAfterMs(invalid, now)).toBeNull()
    }
    expect(parseWelcomeRetryAfterMs('999999999999999999999999999999', now)).toBeNull()
  })

  test('POST 429 uses Retry-After even when JSON claims a different status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, status: 'available' }), {
      status: 429,
      headers: { 'Retry-After': '120' }
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { claimWelcomeXec } = await import('./welcomeFaucet')

    expect(await claimWelcomeXec('ecash:qwelcome')).toMatchObject({
      ok: false,
      status: 'rate_limited',
      retryAfterMs: 120_000
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
  })

  test('unparseable 429 body still carries Retry-After; missing or malformed header uses local fallback', async () => {
    const { claimWelcomeXec, getWelcomeClaimStatus, WELCOME_RATE_LIMIT_FALLBACK_MS } = await import('./welcomeFaucet')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('not json', { status: 429, headers: { 'Retry-After': '120' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '-1' } }))
      .mockResolvedValueOnce(new Response('null', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await claimWelcomeXec('ecash:qwelcome')).toMatchObject({
      status: 'rate_limited', retryAfterMs: 120_000
    })
    expect(await claimWelcomeXec('ecash:qwelcome')).toMatchObject({
      status: 'rate_limited', retryAfterMs: WELCOME_RATE_LIMIT_FALLBACK_MS
    })
    expect(await getWelcomeClaimStatus('ecash:qwelcome')).toMatchObject({
      status: 'rate_limited', retryAfterMs: WELCOME_RATE_LIMIT_FALLBACK_MS
    })
    expect(await getWelcomeClaimStatus('ecash:qwelcome')).toMatchObject({
      status: 'rate_limited', retryAfterMs: WELCOME_RATE_LIMIT_FALLBACK_MS
    })
    expect(fetchMock.mock.calls[2][1].method).toBe('GET')
  })
})
