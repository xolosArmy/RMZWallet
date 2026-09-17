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
    request.onerror = () => reject(request.error ?? new Error('INDEXEDDB_REQUEST_FAILED'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('INDEXEDDB_TRANSACTION_FAILED'))
    transaction.onabort = () => reject(transaction.error ?? new Error('INDEXEDDB_TRANSACTION_ABORTED'))
  })
}

async function openDb(): Promise<IDBDatabase> {
  assertAvailable()
  const request = indexedDB.open(DB_NAME, DB_VERSION)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
  }
  return requestResult(request)
}

async function readRecord<T>(id: string): Promise<T | undefined> {
  const db = await openDb()
  try {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const result = await requestResult(transaction.objectStore(STORE_NAME).get(id))
    await transactionDone(transaction)
    return result as T | undefined
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
  } finally {
    db.close()
  }
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

async function persistNonExtractableDeviceKey(): Promise<CryptoKey> {
  assertAvailable()
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  assertNonExtractableAesGcmKey(key)
  await writeRecords([{ id: KEY_RECORD, key }])
  const stored = await readRecord<{ id: string; key: CryptoKey }>(KEY_RECORD)
  if (!stored?.key) {
    throw new QuickStartUnavailableError('QUICK_START_DEVICE_KEY_NOT_PERSISTED')
  }
  assertNonExtractableAesGcmKey(stored.key)
  return stored.key
}

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  const stored = await readRecord<{ id: string; key: CryptoKey }>(KEY_RECORD)
  if (stored?.key) {
    assertNonExtractableAesGcmKey(stored.key)
    return stored.key
  }
  return persistNonExtractableDeviceKey()
}

export async function assertQuickStartStorageAvailable(): Promise<void> {
  assertAvailable()
  const probe = await persistNonExtractableDeviceKey()
  assertNonExtractableAesGcmKey(probe)
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

  const key = await getOrCreateDeviceKey()
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
  await writeRecords([record as unknown as Record<string, unknown>])

  const persisted = await readRecord<unknown>(SEED_RECORD)
  const parsed = parseSeedRecord(persisted)
  if (!parsed) throw new Error('QUICK_START_STORAGE_CORRUPT')
  const persistedBytes = new Uint8Array(parsed.ciphertext)
  if (decoder.decode(persistedBytes) === normalized) {
    await clearQuickStartMnemonic()
    throw new Error('QUICK_START_PLAINTEXT_FALLBACK_FORBIDDEN')
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
