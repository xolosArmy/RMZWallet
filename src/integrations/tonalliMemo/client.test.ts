import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  fetchTonalliMemoFeed,
  fetchTonalliMemoTx,
  requestTonalliMemoIndex,
  waitForTonalliMemoIndexing
} from './client'
import { buildTonalliMemoApiUrl, buildTonalliMemoTxPath } from './format'
import { TonalliMemoClientError } from './types'

const TXID = 'a'.repeat(64)

const item = {
  txid: TXID,
  status: 'VERIFIED',
  profile: { alias: 'Tonalli', code: 'TONALLI' },
  eventType: 'ANNOUNCEMENT',
  payload: 'Mensaje oficial',
  chainStatus: 'CONFIRMED',
  blockHeight: 900001,
  timestamp: '2026-07-28T12:00:00.000Z'
}

const feedItem = {
  transaction: item,
  verification: item
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Tonalli Memo URL builder', () => {
  test('relative API base', () => {
    expect(buildTonalliMemoApiUrl('/tonalli-memo-api/v1', 'feed')).toBe('/tonalli-memo-api/v1/feed')
  })

  test('trailing slash', () => {
    expect(buildTonalliMemoApiUrl('/tonalli-memo-api/v1/', '/feed')).toBe('/tonalli-memo-api/v1/feed')
  })

  test('absolute API base', () => {
    expect(buildTonalliMemoApiUrl('https://memo-api.example/api/v1', 'tx')).toBe('https://memo-api.example/api/v1/tx')
  })

  test('default relative API base', () => {
    expect(buildTonalliMemoApiUrl(undefined, 'feed')).toBe('/tonalli-memo-api/v1/feed')
  })

  test('existing api v1 suffix', () => {
    expect(buildTonalliMemoApiUrl('/custom/api/v1', 'feed')).toBe('/custom/api/v1/feed')
  })

  test('blank base fallback', () => {
    expect(buildTonalliMemoApiUrl('   ', 'health')).toBe('/tonalli-memo-api/v1/health')
  })

  test('does not duplicate api v1 and encodes txid path segments', () => {
    expect(buildTonalliMemoApiUrl('https://memo-api.example/api/v1/api/v1/', buildTonalliMemoTxPath('a/b'))).toBe(
      'https://memo-api.example/api/v1/tx/a%2Fb'
    )
  })
})

describe('Tonalli Memo client', () => {
  test('feed success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [feedItem] }))

    await expect(fetchTonalliMemoFeed()).resolves.toEqual({
      items: [
        {
          txid: TXID,
          status: 'VERIFIED',
          profileAlias: 'Tonalli',
          profileCode: 'TONALLI',
          eventType: 'ANNOUNCEMENT',
          payload: 'Mensaje oficial',
          displayPayload: 'Mensaje oficial',
          attachment: null,
          chainStatus: 'CONFIRMED',
          blockHeight: 900001,
          timestamp: '2026-07-28T12:00:00.000Z'
        }
      ]
    })
    expect(fetchMock).toHaveBeenCalledWith('/tonalli-memo-api/v1/feed?limit=25', expect.objectContaining({ credentials: 'omit' }))
  })

  test('empty feed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [] }))

    await expect(fetchTonalliMemoFeed()).resolves.toEqual({ items: [] })
  })

  test('malformed JSON preserves HTTP status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>bad</html>', { status: 502 }))

    await expect(fetchTonalliMemoFeed()).rejects.toMatchObject({
      kind: 'malformed-json',
      status: 502
    })
  })

  test('invalid DTO', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [{ transaction: item, verification: { ...item, status: 'UNAUTHORIZED' } }] }))

    await expect(fetchTonalliMemoFeed()).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  test('feed rejects missing verification', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [item] }))

    await expect(fetchTonalliMemoFeed()).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  test('feed rejects transaction and verification TXID mismatch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      items: [{ transaction: item, verification: { ...item, txid: 'b'.repeat(64) } }]
    }))

    await expect(fetchTonalliMemoFeed()).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  test('404 JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'not found' }, 404))

    await expect(fetchTonalliMemoFeed()).rejects.toMatchObject({
      kind: 'http',
      status: 404
    })
  })

  test('502 HTML', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<h1>Bad gateway</h1>', { status: 502 }))

    await expect(fetchTonalliMemoFeed()).rejects.toMatchObject({
      kind: 'malformed-json',
      status: 502
    })
  })

  test('empty non-2xx response preserves status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 502 }))

    await expect(fetchTonalliMemoFeed()).rejects.toMatchObject({
      kind: 'malformed-json',
      status: 502
    })
  })

  test('network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'))

    await expect(fetchTonalliMemoFeed()).rejects.toMatchObject({ kind: 'network' })
  })

  test('AbortSignal forwarding', async () => {
    const controller = new AbortController()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ items: [] }))

    await fetchTonalliMemoFeed(25, controller.signal)

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: controller.signal, credentials: 'omit' })
    )
  })

  test('aborted request preserves AbortError', async () => {
    const abortError = new DOMException('aborted', 'AbortError')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abortError)

    await expect(fetchTonalliMemoFeed()).rejects.toBe(abortError)
  })

  test('invalid TXID rejected before fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}))

    await expect(fetchTonalliMemoTx('ABC')).rejects.toBeInstanceOf(TonalliMemoClientError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('detail with verification', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ transaction: item, verification: item }))

    await expect(fetchTonalliMemoTx(TXID)).resolves.toMatchObject({
      txid: TXID,
      transaction: { status: 'VERIFIED' },
      verification: { txid: TXID, status: 'VERIFIED' }
    })
  })

  test('detail with verification null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ transaction: item, verification: null }))

    await expect(fetchTonalliMemoTx(TXID)).resolves.toMatchObject({
      txid: TXID,
      verification: null
    })
  })

  test('requires transaction and verification TXIDs to match', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      transaction: item,
      verification: { ...item, txid: 'b'.repeat(64) }
    }))

    await expect(fetchTonalliMemoTx(TXID)).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  test('validates feed limit', async () => {
    await expect(fetchTonalliMemoFeed(101)).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  test('requests indexing with only the lowercase TXID and no credentials', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ txid: TXID, status: 'queued' }, 202)
    )

    await expect(requestTonalliMemoIndex(TXID)).resolves.toEqual({
      txid: TXID,
      status: 'queued'
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/tonalli-memo-api/v1/index-requests',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ txid: TXID })
      })
    )
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty('authorization')
  })

  test('rejects an uppercase indexing TXID before making a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(requestTonalliMemoIndex(TXID.toUpperCase())).rejects.toMatchObject({
      kind: 'invalid-response'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('rejects an undocumented index-request status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ txid: TXID, status: 'accepted_content' }, 202)
    )

    await expect(requestTonalliMemoIndex(TXID)).rejects.toMatchObject({
      kind: 'invalid-response'
    })
  })

  test('recognizes a verified transaction during indexing polling', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ transaction: item, verification: item })
    )

    await expect(waitForTonalliMemoIndexing(TXID)).resolves.toMatchObject({
      status: 'verified',
      detail: { txid: TXID, verification: { status: 'VERIFIED' } }
    })
  })

  test('distinguishes a durable feed-policy rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        transaction: item,
        verification: { ...item, status: 'UNAUTHORIZED' }
      })
    )

    await expect(waitForTonalliMemoIndexing(TXID)).resolves.toMatchObject({
      status: 'policy_rejected',
      verificationStatus: 'UNAUTHORIZED'
    })
  })

  test('retries a missing transaction and later observes verification', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'not found' }, 404))
      .mockResolvedValueOnce(jsonResponse({ transaction: item, verification: item }))

    const result = waitForTonalliMemoIndexing(TXID, { timeoutMs: 1_000 })
    await vi.advanceTimersByTimeAsync(500)

    await expect(result).resolves.toMatchObject({ status: 'verified' })
  })

  test('preserves on-chain success when bounded polling times out', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ error: 'not found' }, 404)
    )

    const result = waitForTonalliMemoIndexing(TXID, { timeoutMs: 60_000 })
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(result).resolves.toEqual({ status: 'timed_out' })
  })

  test('enforces the deadline when a transaction request remains pending', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const rejectAborted = () => reject(new DOMException('aborted', 'AbortError'))
        if (signal?.aborted) {
          rejectAborted()
          return
        }
        signal?.addEventListener('abort', rejectAborted, { once: true })
      })
    )

    const result = waitForTonalliMemoIndexing(TXID, { timeoutMs: 60_000 })
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(result).resolves.toEqual({ status: 'timed_out' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
