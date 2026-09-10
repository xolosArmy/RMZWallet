import {
  H3WC_JOURNAL_DATABASE,
  H3WC_JOURNAL_STORE,
  type H3wcMethod
} from './contracts'

export type H3wcJournalStatus =
  | 'observed'
  | 'pending'
  | 'unlock-required'
  | 'ready-for-human'
  | 'human-approved'
  | 'human-rejected'
  | 'responded'
  | 'expired'
  | 'failed'

export type H3wcJournalRecord = Readonly<{
  requestKey: string
  sessionRef: string
  requestId: number
  method: H3wcMethod
  peerBindingHash: string
  challengeId?: string
  ownerEpoch: string
  qualificationEpoch: number
  status: H3wcJournalStatus
  createdAt: number
  expiresAt: number
  completedAt?: number
  responseState?: 'none' | 'sent' | 'rejected'
}>

export class H3wcJournalError extends Error {
  readonly code = 'H3WC_JOURNAL_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'H3wcJournalError'
  }
}

const isJournalStatus = (value: unknown): value is H3wcJournalStatus => (
  value === 'observed'
  || value === 'pending'
  || value === 'unlock-required'
  || value === 'ready-for-human'
  || value === 'human-approved'
  || value === 'human-rejected'
  || value === 'responded'
  || value === 'expired'
  || value === 'failed'
)

const copyRecord = (record: H3wcJournalRecord): H3wcJournalRecord => Object.freeze({ ...record })

function validateRecord(value: unknown): H3wcJournalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new H3wcJournalError('H3WC journal record is malformed')
  }
  const record = value as Partial<H3wcJournalRecord>
  if (
    typeof record.requestKey !== 'string'
    || typeof record.sessionRef !== 'string'
    || !Number.isSafeInteger(record.requestId)
    || (record.method !== 'ecash_getAccountIdentity' && record.method !== 'ecash_signMessage')
    || typeof record.peerBindingHash !== 'string'
    || typeof record.ownerEpoch !== 'string'
    || !Number.isSafeInteger(record.qualificationEpoch)
    || !isJournalStatus(record.status)
    || !Number.isFinite(record.createdAt)
    || !Number.isFinite(record.expiresAt)
  ) {
    throw new H3wcJournalError('H3WC journal record is malformed')
  }
  return copyRecord(record as H3wcJournalRecord)
}

const requestAsPromise = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new H3wcJournalError('H3WC journal request failed'))
})

export interface H3wcJournal {
  put(record: H3wcJournalRecord): Promise<void>
  get(requestKey: string): Promise<H3wcJournalRecord | null>
  list(): Promise<readonly H3wcJournalRecord[]>
  prune(now: number): Promise<number>
  close(): void
}

class IndexedDbH3wcJournal implements H3wcJournal {
  private readonly database: IDBDatabase

  constructor(database: IDBDatabase) {
    this.database = database
  }

  async put(record: H3wcJournalRecord): Promise<void> {
    const valid = validateRecord(record)
    const transaction = this.database.transaction(H3WC_JOURNAL_STORE, 'readwrite')
    await requestAsPromise(transaction.objectStore(H3WC_JOURNAL_STORE).put({ ...valid }))
  }

  async get(requestKey: string): Promise<H3wcJournalRecord | null> {
    if (!requestKey) throw new H3wcJournalError('H3WC journal key is empty')
    const transaction = this.database.transaction(H3WC_JOURNAL_STORE, 'readonly')
    const value = await requestAsPromise(transaction.objectStore(H3WC_JOURNAL_STORE).get(requestKey))
    return value === undefined ? null : validateRecord(value)
  }

  async list(): Promise<readonly H3wcJournalRecord[]> {
    const transaction = this.database.transaction(H3WC_JOURNAL_STORE, 'readonly')
    const values = await requestAsPromise(transaction.objectStore(H3WC_JOURNAL_STORE).getAll())
    return Object.freeze(values.map(validateRecord))
  }

  async prune(now: number): Promise<number> {
    const records = await this.list()
    const expired = records.filter(record => record.expiresAt <= now)
    if (expired.length === 0) return 0
    const transaction = this.database.transaction(H3WC_JOURNAL_STORE, 'readwrite')
    const store = transaction.objectStore(H3WC_JOURNAL_STORE)
    await Promise.all(expired.map(record => requestAsPromise(store.delete(record.requestKey))))
    return expired.length
  }

  close(): void {
    this.database.close()
  }
}

export async function openH3wcJournal(
  factory: IDBFactory | undefined = globalThis.indexedDB
): Promise<H3wcJournal> {
  if (!factory || typeof factory.open !== 'function') {
    throw new H3wcJournalError('IndexedDB is unavailable for H3WC')
  }
  const request = factory.open(H3WC_JOURNAL_DATABASE, 1)
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(H3WC_JOURNAL_STORE)) {
      const store = database.createObjectStore(H3WC_JOURNAL_STORE, { keyPath: 'requestKey' })
      store.createIndex('expiresAt', 'expiresAt', { unique: false })
      store.createIndex('status', 'status', { unique: false })
    }
  }
  const database = await requestAsPromise(request)
  return new IndexedDbH3wcJournal(database)
}
