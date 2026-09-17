export type TonalliIntent = {
  kind: 'conversation'
  peer: string
  source?: 'xolosramirez'
}

export const TONALLI_INTENT_STORAGE_KEY = 'tonalli_safe_intent_v1'

type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storage(): IntentStorage | null {
  if (typeof sessionStorage === 'undefined') return null
  return sessionStorage
}

function isSafePeer(peer: string): boolean {
  const trimmed = peer.trim()
  if (!trimmed || trimmed.length > 128) return false
  return /^[a-zA-Z0-9._:@-]+$/.test(trimmed)
}

export function parseTonalliIntent(value: unknown): TonalliIntent | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { kind?: unknown; peer?: unknown; source?: unknown }
  if (candidate.kind !== 'conversation' || typeof candidate.peer !== 'string') return null
  if (!isSafePeer(candidate.peer)) return null
  const intent: TonalliIntent = {
    kind: 'conversation',
    peer: candidate.peer.trim()
  }
  if (candidate.source === 'xolosramirez') intent.source = 'xolosramirez'
  return intent
}

export function parseTonalliIntentFromSearch(search: string): TonalliIntent | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const kind = params.get('intent')
  const peer = params.get('peer')
  const source = params.get('source')
  if (kind !== 'conversation' || !peer) return null
  return parseTonalliIntent({
    kind: 'conversation',
    peer,
    source: source === 'xolosramirez' ? 'xolosramirez' : undefined
  })
}

export function persistTonalliIntent(intent: TonalliIntent, store = storage()): void {
  const parsed = parseTonalliIntent(intent)
  if (!parsed || !store) return
  store.setItem(TONALLI_INTENT_STORAGE_KEY, JSON.stringify(parsed))
}

export function readTonalliIntent(store = storage()): TonalliIntent | null {
  if (!store) return null
  const raw = store.getItem(TONALLI_INTENT_STORAGE_KEY)
  if (!raw) return null
  try {
    return parseTonalliIntent(JSON.parse(raw) as unknown)
  } catch {
    store.removeItem(TONALLI_INTENT_STORAGE_KEY)
    return null
  }
}

export function consumeTonalliIntent(store = storage()): TonalliIntent | null {
  const intent = readTonalliIntent(store)
  store?.removeItem(TONALLI_INTENT_STORAGE_KEY)
  return intent
}

export function captureTonalliIntentFromLocation(
  search: string,
  store = storage()
): TonalliIntent | null {
  const intent = parseTonalliIntentFromSearch(search)
  if (!intent) return readTonalliIntent(store)
  persistTonalliIntent(intent, store)
  return intent
}
