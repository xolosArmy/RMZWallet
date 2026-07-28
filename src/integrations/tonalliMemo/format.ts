import type { TonalliMemoFeedItem } from './types'

export const DEFAULT_TONALLI_MEMO_API_BASE_URL = '/tonalli-memo-api/v1'

export function buildTonalliMemoApiUrl(base: string | undefined, path: string) {
  const trimmedBase = base?.trim() || DEFAULT_TONALLI_MEMO_API_BASE_URL
  const normalizedBase = trimmedBase.replace(/\/+$/, '').replace(/(?:\/api\/v1)+$/i, '/api/v1')
  const normalizedPath = path.trim().replace(/^\/+/, '')
  return `${normalizedBase}/${normalizedPath}`
}

export function buildTonalliMemoTxPath(txid: string) {
  return `tx/${encodeURIComponent(txid)}`
}

export function abbreviateTxid(txid: string) {
  return `${txid.slice(0, 10)}...${txid.slice(-8)}`
}

export function formatTonalliMemoTimestamp(value: TonalliMemoFeedItem['timestamp']) {
  if (value === null) return 'Fecha no disponible'
  const date = typeof value === 'number'
    ? new Date(value > 10_000_000_000 ? value : value * 1000)
    : new Date(value)
  if (Number.isNaN(date.getTime())) return 'Fecha no disponible'
  return date.toLocaleString()
}
