import {
  DEFAULT_NEW_WALLET_PROFILE_ID,
  isDerivationProfileId
} from './derivationProfiles'
import type { DerivationProfileId } from './derivationProfiles'

const DB_NAME = 'tonalli-quickstart-v1'
const DB_VERSION = 1
const STORE_NAME = 'wallet'
const KEY_RECORD = 'device-key'
const SEED_RECORD = 'seed-ciphertext'
const PROBE_KEY_RECORD = 'device-key-probe'
export const QUICK_START_RECORD_VERSION = 1 as const

export class QuickStartUnavailableError extends Error {
  constructor(message = 'QUICK_START_SECURE_STORAGE_UNAVAILABLE') {
    super(message)
    this.name = 'QuickStartUnavailableError'
  }
}

export type QuickStartSeedRecord = Readonly<{
  id: typeof SEED_RECORD
  version: typeof QUICK_START_RECORD_VERSION
  iv: Uint8Array
  ciphertext: ArrayBuffer
  derivationProfileId: DerivationProfileId
  address: string | null
  createdAt: string
}>

export type QuickStartMetadata = Readonly<{
  version: typeof QUICK_START_RECORD_VERSION
  derivationProfileId: DerivationProfileId
  address: string | null
  createdAt: string
}>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const QUICK_START_CREATION_LOCK_NAME = 'tonalli-quickstart-create'

type QuickStartCreationLockRunner = <T>(operation: () => Promise<T>) => Promise<T>

let testCreationLock: QuickStartCreationLockRunner | null = null

export function setQuickStartCreationLockForTests(
  runner: QuickStartCreationLockRunner | null
): void {
  testCreationLock = runner
}

function toAvailabilityError(error: unknown): QuickStartUnavailableError {
  if (error instanceof QuickStartUnavailableError) return error
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'DataCloneError') {
    return new QuickStartUnavailableError('QUICK_START_DEVICE_KEY_NOT_PERSISTED')
  }
  return new QuickStartUnavailableError('QUICK_START_SECURE_STORAGE_UNAVAILABLE')
}

function assertAvailable() {
  if (
    typeof indexedDB === 'undefined' ||
    !globalThis.crypto?.subtle ||
    typeof globalThis.crypto.getRandomValues !== 'function'
  ) {
    throw new QuickStartUnavailableError()
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(toAvailabilityError(request.error ?? new Error('INDEXEDDB_REQUEST_FAILED')))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(toAvailabilityError(transaction.error ?? new Error('INDEXEDDB_TRANSACTION_FAILED')))
    transaction.onabort = () => reject(toAvailabilityError(transaction.error ?? new Error('INDEXEDDB_TRANSACTION_ABORTED')))
  })
}

async function openDb(): Promise<IDBDatabase> {
  assertAvailable()
  try {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    return await requestResult(request)
  } catch (error) {
    throw toAvailabilityError(error)
  }
}

async function readRecord<T>(id: string): Promise<T | undefined> {
  const db = await openDb()
  try {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const result = await requestResult(transaction.objectStore(STORE_NAME).get(id))
    await transactionDone(transaction)
    return result as T | undefined
  } catch (error) {
    throw toAvailabilityError(error)
  } finally {
    db.close()
  }
}

async function writeRecords(records: Array<Record<string, unknown>>): Promise<void> {
  const db = await openDb()
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    for (const record of records) store.put(record)
    await transactionDone(transaction)
  } catch (error) {
    throw toAvailabilityError(error)
  } finally {
    db.close()
  }
}

export async function withQuickStartCreationLock<T>(operation: () => Promise<T>): Promise<T> {
  if (testCreationLock) {
    return testCreationLock(operation)
  }

  const locks = globalThis.navigator?.locks
  if (!locks || typeof locks.request !== 'function') {
    throw new QuickStartUnavailableError('QUICK_START_CREATION_LOCK_UNAVAILABLE')
  }

  return new Promise<T>((resolve, reject) => {
    let operationStarted = false
    void locks.request(
      QUICK_START_CREATION_LOCK_NAME,
      { mode: 'exclusive' },
      async (lock) => {
        if (!lock) {
          reject(new QuickStartUnavailableError('QUICK_START_CREATION_LOCK_UNAVAILABLE'))
          return
        }
        operationStarted = true
        try {
          resolve(await operation())
        } catch (error) {
          reject(error)
        }
      }
    ).catch((error: unknown) => {
      if (operationStarted) return
      if (error instanceof QuickStartUnavailableError) {
        reject(error)
        return
      }
      reject(new QuickStartUnavailableError('QUICK_START_CREATION_LOCK_UNAVAILABLE'))
    })
  })
}

function assertNonExtractableAesGcmKey(key: CryptoKey): void {
  if (!(key instanceof CryptoKey)) {
    throw new QuickStartUnavailableError('QUICK_START_DEVICE_KEY_INVALID')
  }
  if (key.extractable) {
    throw new QuickStartUnavailableError('QUICK_START_DEVICE_KEY_EXTRACTABLE')
  }
  if (key.algorithm.name !== 'AES-GCM' || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) {
    throw new QuickStartUnavailableError('QUICK_START_DEVICE_KEY_INVALID')
  }
}

function asUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]') {
    return new Uint8Array(value as ArrayBuffer)
  }
  return null
}

function asArrayBuffer(value: unknown): ArrayBuffer | null {
  const bytes = asUint8Array(value)
  if (!bytes) return null
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function parseSeedRecord(raw: unknown): QuickStartSeedRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as {
    id?: unknown
    version?: unknown
    v?: unknown
    iv?: unknown
    ciphertext?: unknown
    derivationProfileId?: unknown
    address?: unknown
    createdAt?: unknown
  }
  if (candidate.id !== SEED_RECORD) return null
  const version = candidate.version === QUICK_START_RECORD_VERSION
    ? QUICK_START_RECORD_VERSION
    : candidate.v === QUICK_START_RECORD_VERSION
      ? QUICK_START_RECORD_VERSION
      : null
  const iv = asUint8Array(candidate.iv)
  const ciphertext = asArrayBuffer(candidate.ciphertext)
  if (version !== QUICK_START_RECORD_VERSION || !iv || !ciphertext) return null
  const derivationProfileId = isDerivationProfileId(candidate.derivationProfileId)
    ? candidate.derivationProfileId
    : DEFAULT_NEW_WALLET_PROFILE_ID
  return {
    id: SEED_RECORD,
    version,
    iv,
    ciphertext,
    derivationProfileId,
    address: typeof candidate.address === 'string' ? candidate.address : null,
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : ''
  }
}

async function deleteRecord(id: string): Promise<void> {
  const db = await openDb()
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(id)
    await transactionDone(transaction)
  } catch (error) {
    throw toAvailabilityError(error)
  } finally {
    db.close()
  }
}

export async function assertQuickStartStorageAvailable(): Promise<void> {
  assertAvailable()
  const existingSeed = await readRecord<unknown>(SEED_RECORD)
  if (existingSeed) {
    return
  }
  const existingKey = await readRecord<{ id: string; key: CryptoKey }>(KEY_RECORD)
  if (existingKey?.key) {
    assertNonExtractableAesGcmKey(existingKey.key)
    return
  }

  const probeKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  assertNonExtractableAesGcmKey(probeKey)
  await writeRecords([{ id: PROBE_KEY_RECORD, key: probeKey }])
  try {
    const stored = await readRecord<{ id: string; key: CryptoKey }>(PROBE_KEY_RECORD)
    if (!stored?.key) {
      throw new QuickStartUnavailableError('QUICK_START_DEVICE_KEY_NOT_PERSISTED')
    }
    assertNonExtractableAesGcmKey(stored.key)
  } finally {
    await deleteRecord(PROBE_KEY_RECORD)
  }
}

export async function storeQuickStartMnemonic(
  mnemonic: string,
  metadata: {
    derivationProfileId: DerivationProfileId
    address?: string | null
  }
): Promise<QuickStartMetadata> {
  const normalized = mnemonic.trim()
  if (!normalized) throw new Error('QUICK_START_MNEMONIC_REQUIRED')
  if (!isDerivationProfileId(metadata.derivationProfileId)) {
    throw new Error('QUICK_START_DERIVATION_PROFILE_REQUIRED')
  }

  const existing = parseSeedRecord(await readRecord<unknown>(SEED_RECORD))
  if (existing) {
    throw new Error('QUICK_START_RECORD_EXISTS')
  }

  assertAvailable()
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  assertNonExtractableAesGcmKey(key)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toBufferSource(iv) },
    key,
    encoder.encode(normalized)
  )
  const record: QuickStartSeedRecord = {
    id: SEED_RECORD,
    version: QUICK_START_RECORD_VERSION,
    iv,
    ciphertext,
    derivationProfileId: metadata.derivationProfileId,
    address: metadata.address ?? null,
    createdAt: new Date().toISOString()
  }
  await writeRecords([
    { id: KEY_RECORD, key },
    record as unknown as Record<string, unknown>
  ])

  const storedKey = await readRecord<{ id: string; key: CryptoKey }>(KEY_RECORD)
  const parsed = parseSeedRecord(await readRecord<unknown>(SEED_RECORD))
  if (!storedKey?.key || !parsed) throw new Error('QUICK_START_STORAGE_CORRUPT')
  assertNonExtractableAesGcmKey(storedKey.key)
  const persistedBytes = new Uint8Array(parsed.ciphertext)
  if (decoder.decode(persistedBytes) === normalized) {
    await clearQuickStartMnemonic()
    throw new Error('QUICK_START_PLAINTEXT_FALLBACK_FORBIDDEN')
  }
  try {
    const plain = decoder.decode(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(parsed.iv) },
      storedKey.key,
      parsed.ciphertext
    ))
    if (plain !== normalized) {
      throw new Error('QUICK_START_IDENTITY_MISMATCH')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'QUICK_START_IDENTITY_MISMATCH') throw error
    throw new Error('QUICK_START_DECRYPT_FAILED')
  }
  if (metadata.address && parsed.address && parsed.address !== metadata.address) {
    throw new Error('QUICK_START_IDENTITY_MISMATCH')
  }
  return {
    version: parsed.version,
    derivationProfileId: parsed.derivationProfileId,
    address: parsed.address,
    createdAt: parsed.createdAt
  }
}

export async function loadQuickStartMetadata(): Promise<QuickStartMetadata | null> {
  const raw = await readRecord<unknown>(SEED_RECORD)
  if (!raw) return null
  const parsed = parseSeedRecord(raw)
  if (!parsed) throw new Error('QUICK_START_STORAGE_CORRUPT')
  return {
    version: parsed.version,
    derivationProfileId: parsed.derivationProfileId,
    address: parsed.address,
    createdAt: parsed.createdAt
  }
}

export async function loadQuickStartMnemonic(): Promise<string | null> {
  const raw = await readRecord<unknown>(SEED_RECORD)
  if (!raw) return null
  const parsed = parseSeedRecord(raw)
  if (!parsed) throw new Error('QUICK_START_STORAGE_CORRUPT')

  const storedKey = await readRecord<{ id: string; key: CryptoKey }>(KEY_RECORD)
  if (!storedKey?.key) throw new Error('QUICK_START_DEVICE_KEY_MISSING')
  assertNonExtractableAesGcmKey(storedKey.key)

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBufferSource(parsed.iv) },
      storedKey.key,
      parsed.ciphertext
    )
    return decoder.decode(plain)
  } catch {
    throw new Error('QUICK_START_DECRYPT_FAILED')
  }
}

export async function clearQuickStartMnemonic(): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const db = await openDb()
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.delete(SEED_RECORD)
    store.delete(KEY_RECORD)
    await transactionDone(transaction)
  } finally {
    db.close()
  }
}

export async function hasQuickStartMnemonic(): Promise<boolean> {
  try {
    return Boolean(await loadQuickStartMetadata())
  } catch (error) {
    if (error instanceof QuickStartUnavailableError) return false
    throw error
  }
}
