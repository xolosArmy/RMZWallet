import type { ExternalSignContentHash } from './contentHash'
import { ExternalSignError } from './contract'

export type ExternalSignTerminalState = 'consumed' | 'rejected' | 'cancelled' | 'expired'

export type ExternalSignReplayTombstoneV1 = Readonly<{
  requestId: string
  contentHash: ExternalSignContentHash | null
  terminalState: ExternalSignTerminalState
  terminalAt: number
  retainUntil: number
}>

export interface ExternalSignReplayStore {
  has(requestId: string): Promise<boolean>
  record(tombstone: ExternalSignReplayTombstoneV1): Promise<void>
  purgeExpired(now: number): Promise<void>
}

const DATABASE_NAME = 'tonalli-external-sign-v1'
const STORE_NAME = 'replay-tombstones'

export class IndexedDbExternalSignReplayStore implements ExternalSignReplayStore {
  private readonly indexedDb: IDBFactory

  constructor(indexedDb: IDBFactory) {
    this.indexedDb = indexedDb
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.indexedDb.open(DATABASE_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'requestId' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new ExternalSignError('REPLAY_STORE_UNAVAILABLE'))
      request.onblocked = () => reject(new ExternalSignError('REPLAY_STORE_UNAVAILABLE'))
    })
  }

  async has(requestId: string): Promise<boolean> {
    const database = await this.open()
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly')
        const request = transaction.objectStore(STORE_NAME).getKey(requestId)
        request.onsuccess = () => resolve(request.result !== undefined)
        request.onerror = () => reject(new ExternalSignError('REPLAY_STORE_UNAVAILABLE'))
        transaction.onabort = () => reject(new ExternalSignError('REPLAY_STORE_UNAVAILABLE'))
      })
    } finally {
      database.close()
    }
  }

  async record(tombstone: ExternalSignReplayTombstoneV1): Promise<void> {
    const database = await this.open()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        transaction.objectStore(STORE_NAME).add(tombstone)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(new ExternalSignError('REQUEST_REPLAYED'))
        transaction.onabort = () => reject(new ExternalSignError('REQUEST_REPLAYED'))
      })
    } finally {
      database.close()
    }
  }

  async purgeExpired(now: number): Promise<void> {
    const database = await this.open()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        const cursorRequest = transaction.objectStore(STORE_NAME).openCursor()
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (!cursor) return
          const tombstone = cursor.value as ExternalSignReplayTombstoneV1
          if (tombstone.retainUntil < now) cursor.delete()
          cursor.continue()
        }
        cursorRequest.onerror = () => reject(new ExternalSignError('REPLAY_STORE_UNAVAILABLE'))
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(new ExternalSignError('REPLAY_STORE_UNAVAILABLE'))
      })
    } finally {
      database.close()
    }
  }
}

export class MemoryExternalSignReplayStore implements ExternalSignReplayStore {
  private readonly tombstones = new Map<string, ExternalSignReplayTombstoneV1>()

  async has(requestId: string): Promise<boolean> {
    return this.tombstones.has(requestId)
  }

  async record(tombstone: ExternalSignReplayTombstoneV1): Promise<void> {
    if (this.tombstones.has(tombstone.requestId)) throw new ExternalSignError('REQUEST_REPLAYED')
    this.tombstones.set(tombstone.requestId, Object.freeze({ ...tombstone }))
  }

  async purgeExpired(now: number): Promise<void> {
    for (const [requestId, tombstone] of this.tombstones) {
      if (tombstone.retainUntil < now) this.tombstones.delete(requestId)
    }
  }

  get(requestId: string): ExternalSignReplayTombstoneV1 | undefined {
    return this.tombstones.get(requestId)
  }
}

export function terminalTombstone(
  requestId: string,
  expiresAt: number,
  terminalState: ExternalSignTerminalState,
  terminalAt: number,
  contentHash: ExternalSignContentHash | null = null
): ExternalSignReplayTombstoneV1 {
  return Object.freeze({
    requestId,
    contentHash,
    terminalState,
    terminalAt,
    retainUntil: expiresAt + 300_000
  })
}
