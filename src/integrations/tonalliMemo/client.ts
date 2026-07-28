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
import type { TonalliMemoFeed, TonalliMemoTxDetail } from './types'

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
