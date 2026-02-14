export type WcRequestHistoryEntry = {
  offerId: string
  peer: string
  topic: string
  status: 'success' | 'error' | 'rejected'
  txid?: string
  error?: string
  createdAt: number
  method: string
}

const STORAGE_KEY = 'tonalli_wc_request_history'
const MAX_ITEMS = 30

let inMemoryHistory: WcRequestHistoryEntry[] | null = null

function loadFromStorage(): WcRequestHistoryEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.offerId === 'string' && typeof item.createdAt === 'number')
  } catch {
    return []
  }
}

function saveHistory(next: WcRequestHistoryEntry[]) {
  const normalized = next.slice(Math.max(0, next.length - MAX_ITEMS))
  inMemoryHistory = normalized
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // ignore storage errors
  }
}

export function readWcRequestHistory(): WcRequestHistoryEntry[] {
  if (inMemoryHistory) return [...inMemoryHistory]
  const loaded = loadFromStorage()
  inMemoryHistory = loaded
  return [...loaded]
}

export function appendWcRequestHistory(entry: WcRequestHistoryEntry): WcRequestHistoryEntry[] {
  const current = readWcRequestHistory()
  const next = [...current, entry]
  saveHistory(next)
  return [...next]
}
