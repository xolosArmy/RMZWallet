import type { OfferPublishedPayload } from './WcWallet'

export type { OfferPublishedPayload }

const STORAGE_KEY = 'tonalli_wc_offer_queue'
const MAX_QUEUE = 20

let inMemoryQueue: OfferPublishedPayload[] | null = null

function isOfferPayload(value: unknown): value is OfferPublishedPayload {
  if (!value || typeof value !== 'object') return false
  const candidate = value as OfferPublishedPayload
  return typeof candidate.offerId === 'string' && candidate.offerId.trim().length > 0
}

function dedupeAndTrim(queue: OfferPublishedPayload[]): OfferPublishedPayload[] {
  const seen = new Set<string>()
  const dedupedReversed: OfferPublishedPayload[] = []
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const item = queue[i]
    if (!item || seen.has(item.offerId)) continue
    seen.add(item.offerId)
    dedupedReversed.push(item)
  }
  const deduped = dedupedReversed.reverse()
  return deduped.slice(Math.max(0, deduped.length - MAX_QUEUE))
}

function readFromStorage(): OfferPublishedPayload[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isOfferPayload)
  } catch {
    return []
  }
}

export function loadQueue(): OfferPublishedPayload[] {
  if (inMemoryQueue) return [...inMemoryQueue]
  const loaded = dedupeAndTrim(readFromStorage())
  inMemoryQueue = loaded
  return [...loaded]
}

export function saveQueue(queue: OfferPublishedPayload[]) {
  const next = dedupeAndTrim(queue)
  inMemoryQueue = next
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // ignore storage errors
  }
}

export function enqueue(payload: OfferPublishedPayload): OfferPublishedPayload[] {
  const current = loadQueue()
  const next = [...current.filter((item) => item.offerId !== payload.offerId), payload]
  saveQueue(next)
  return [...next]
}

export function peekAll(): OfferPublishedPayload[] {
  return loadQueue()
}

export function clear() {
  saveQueue([])
}

export function removeByOfferId(offerId: string) {
  if (!offerId) return
  const current = loadQueue()
  const next = current.filter((item) => item.offerId !== offerId)
  if (next.length === current.length) return
  saveQueue(next)
}
