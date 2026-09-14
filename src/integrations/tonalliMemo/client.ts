import {
  isValidTonalliMemoTxid,
  parseTonalliMemoFeed,
  parseTonalliMemoTxDetail
} from './guards'
import {
  buildTonalliMemoApiUrl,
  buildTonalliMemoTxPath,
  DEFAULT_TONALLI_MEMO_API_BASE_URL
} from './format'
import { TonalliMemoClientError } from './types'
import type {
  TonalliMemoFeed,
  TonalliMemoIndexRequestResult,
  TonalliMemoIndexRequestStatus,
  TonalliMemoIndexingClient,
  TonalliMemoIndexingResult,
  TonalliMemoTxDetail
} from './types'

const TX_INDEXING_TIMEOUT_MS = 60_000
const TX_INDEXING_POLL_DELAYS_MS = [500, 1_000, 2_000, 3_000, 5_000, 8_000, 10_000] as const
const INDEX_REQUEST_STATUSES = new Set<TonalliMemoIndexRequestStatus>([
  'queued',
  'already_queued',
  'already_indexed'
])

const env = import.meta.env as ImportMetaEnv & {
  readonly VITE_TONALLI_MEMO_API_BASE_URL?: string
}

export function getTonalliMemoApiBaseUrl() {
  return env.VITE_TONALLI_MEMO_API_BASE_URL?.trim() || DEFAULT_TONALLI_MEMO_API_BASE_URL
}

function validateFeedLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TonalliMemoClientError('invalid-response', 'El limite del feed debe estar entre 1 y 100.')
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new TonalliMemoClientError(
      'malformed-json',
      response.ok ? 'La respuesta de Tonalli Memo no es JSON valido.' : 'Tonalli Memo respondio con un cuerpo no JSON.',
      response.status
    )
  }
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      signal
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new TonalliMemoClientError('network', 'No se pudo conectar con Tonalli Memo.')
  }

  const json = await readJson(response)
  if (!response.ok) {
    throw new TonalliMemoClientError('http', `Tonalli Memo respondio HTTP ${response.status}.`, response.status)
  }
  return json
}

async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new TonalliMemoClientError('network', 'No se pudo solicitar la indexación de Tonalli Memo.')
  }

  const json = await readJson(response)
  if (!response.ok) {
    throw new TonalliMemoClientError('http', `Tonalli Memo respondió HTTP ${response.status}.`, response.status)
  }
  return json
}

export async function fetchTonalliMemoHealth(signal?: AbortSignal) {
  await fetchJson(buildTonalliMemoApiUrl(getTonalliMemoApiBaseUrl(), 'health'), signal)
}

export async function fetchTonalliMemoFeed(limit = 25, signal?: AbortSignal): Promise<TonalliMemoFeed> {
  validateFeedLimit(limit)
  const url = `${buildTonalliMemoApiUrl(getTonalliMemoApiBaseUrl(), 'feed')}?limit=${limit}`
  const json = await fetchJson(url, signal)
  const feed = parseTonalliMemoFeed(json)
  if (!feed) {
    throw new TonalliMemoClientError('invalid-response', 'Tonalli Memo envio un feed invalido.')
  }
  return feed
}

export async function fetchTonalliMemoTx(txid: string, signal?: AbortSignal): Promise<TonalliMemoTxDetail> {
  if (!isValidTonalliMemoTxid(txid)) {
    throw new TonalliMemoClientError('invalid-response', 'TXID invalido.')
  }
  const json = await fetchJson(buildTonalliMemoApiUrl(getTonalliMemoApiBaseUrl(), buildTonalliMemoTxPath(txid)), signal)
  const detail = parseTonalliMemoTxDetail(json, txid)
  if (!detail) {
    throw new TonalliMemoClientError('invalid-response', 'Tonalli Memo envio un detalle invalido.')
  }
  return detail
}

export async function requestTonalliMemoIndex(
  txid: string,
  signal?: AbortSignal
): Promise<TonalliMemoIndexRequestResult> {
  if (!isValidTonalliMemoTxid(txid)) {
    throw new TonalliMemoClientError('invalid-response', 'TXID inválido.')
  }
  const json = await postJson(
    buildTonalliMemoApiUrl(getTonalliMemoApiBaseUrl(), 'index-requests'),
    { txid },
    signal
  )
  if (!isRecord(json) || json.txid !== txid || typeof json.status !== 'string' || !INDEX_REQUEST_STATUSES.has(json.status as TonalliMemoIndexRequestStatus)) {
    throw new TonalliMemoClientError('invalid-response', 'Tonalli Memo envió una respuesta de indexación inválida.')
  }
  return { txid, status: json.status as TonalliMemoIndexRequestStatus }
}

export async function waitForTonalliMemoIndexing(
  txid: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<TonalliMemoIndexingResult> {
  if (!isValidTonalliMemoTxid(txid)) {
    throw new TonalliMemoClientError('invalid-response', 'TXID inválido.')
  }
  const timeoutMs = options.timeoutMs ?? TX_INDEXING_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new TonalliMemoClientError('invalid-response', 'El tiempo de espera de indexación es inválido.')
  }

  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (true) {
    try {
      const detail = await fetchTonalliMemoTx(txid, options.signal)
      if (detail.verification?.status === 'VERIFIED') {
        return { status: 'verified', detail }
      }
      if (detail.verification !== null) {
        return {
          status: 'policy_rejected',
          detail,
          verificationStatus: detail.verification.status
        }
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      if (!isRetryableIndexingError(error)) throw error
    }

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return { status: 'timed_out' }
    }
    const delayMs = TX_INDEXING_POLL_DELAYS_MS[Math.min(attempt, TX_INDEXING_POLL_DELAYS_MS.length - 1)]
    attempt += 1
    await abortableDelay(Math.min(delayMs, remainingMs), options.signal)
  }
}

export const tonalliMemoIndexingClient: TonalliMemoIndexingClient = {
  requestIndex: requestTonalliMemoIndex,
  waitForResult: waitForTonalliMemoIndexing
}

function isRetryableIndexingError(error: unknown): boolean {
  if (!(error instanceof TonalliMemoClientError)) return false
  return error.kind === 'network' ||
    (error.kind === 'http' && error.status !== null && [404, 429, 502, 503, 504].includes(error.status))
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
