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

export function isWebLocksSupported(): boolean {
  if (testCreationLock) return true
  return (
    typeof globalThis.navigator !== 'undefined' &&
    Boolean(globalThis.navigator.locks && typeof globalThis.navigator.locks.request === 'function')
  )
}

export const withIdentityMutationLock = withQuickStartCreationLock

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
  setQuickStartMarker()

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
  if (!hasQuickStartMarker()) {
    setQuickStartMarker()
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

export const QUICK_START_MARKER_STORAGE_KEY = 'tonalli_quickstart_marker'

export function setQuickStartMarker(): void {
  if (typeof localStorage === 'undefined') {
    throw new Error('QUICK_START_MARKER_STORAGE_UNAVAILABLE')
  }
  const payload = JSON.stringify({ version: 1, createdAt: Date.now() })
  localStorage.setItem(QUICK_START_MARKER_STORAGE_KEY, payload)
  const readBack = localStorage.getItem(QUICK_START_MARKER_STORAGE_KEY)
  if (!readBack) {
    try {
      localStorage.removeItem(QUICK_START_MARKER_STORAGE_KEY)
    } catch {
      // best-effort
    }
    throw new Error('QUICK_START_MARKER_PERSIST_FAILED')
  }
  let parsed: { version?: unknown; createdAt?: unknown } | null = null
  try {
    parsed = JSON.parse(readBack) as { version?: unknown; createdAt?: unknown }
  } catch {
    try {
      localStorage.removeItem(QUICK_START_MARKER_STORAGE_KEY)
    } catch {
      // best-effort
    }
    throw new Error('QUICK_START_MARKER_PERSIST_FAILED')
  }
  if (!parsed || parsed.version !== 1 || typeof parsed.createdAt !== 'number') {
    try {
      localStorage.removeItem(QUICK_START_MARKER_STORAGE_KEY)
    } catch {
      // best-effort
    }
    throw new Error('QUICK_START_MARKER_PERSIST_FAILED')
  }
}

export function hasQuickStartMarker(): boolean {
  if (typeof localStorage === 'undefined') return false
  try {
    const raw = localStorage.getItem(QUICK_START_MARKER_STORAGE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { version?: unknown; createdAt?: unknown }
    return Boolean(parsed && parsed.version === 1 && typeof parsed.createdAt === 'number')
  } catch {
    return false
  }
}

export function clearQuickStartMarker(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(QUICK_START_MARKER_STORAGE_KEY)
  } catch {
    // best-effort
  }
}

export type QuickStartRecordStatus =
  | 'ABSENT_CONFIRMED'
  | 'PRESENT'
  | 'STORAGE_UNAVAILABLE_UNKNOWN'
  | 'RECOVERY_FAILED'

export async function getQuickStartRecordStatus(): Promise<QuickStartRecordStatus> {
  const marker = hasQuickStartMarker()

  if (typeof indexedDB === 'undefined') {
    return marker ? 'STORAGE_UNAVAILABLE_UNKNOWN' : 'ABSENT_CONFIRMED'
  }

  try {
    const metadata = await loadQuickStartMetadata()
    if (metadata) {
      try {
        setQuickStartMarker()
      } catch {
        // best-effort refresh during status check, status is PRESENT
      }
      return 'PRESENT'
    }
    if (marker) {
      clearQuickStartMarker()
    }
    return 'ABSENT_CONFIRMED'
  } catch (error) {
    if (error instanceof QuickStartUnavailableError) {
      if (marker) {
        return 'STORAGE_UNAVAILABLE_UNKNOWN'
      }
      return 'ABSENT_CONFIRMED'
    }
    return 'RECOVERY_FAILED'
  }
}

export async function clearQuickStartMnemonic(): Promise<void> {
  clearQuickStartMarker()
  if (typeof indexedDB === 'undefined') return
  try {
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
  } catch (error) {
    if (error instanceof QuickStartUnavailableError) {
      return
    }
    throw error
  }
}

export async function hasQuickStartMnemonic(): Promise<boolean> {
  try {
    const status = await getQuickStartRecordStatus()
    if (status === 'PRESENT') return true
    if (status === 'STORAGE_UNAVAILABLE_UNKNOWN') {
      throw new QuickStartUnavailableError('QUICK_START_STORAGE_UNAVAILABLE_UNKNOWN')
    }
    if (status === 'RECOVERY_FAILED') {
      throw new Error('QUICK_START_RECOVERY_FAILED')
    }
    return false
  } catch (error) {
    if (error instanceof QuickStartUnavailableError) {
      if (error.message === 'QUICK_START_STORAGE_UNAVAILABLE_UNKNOWN') {
        throw error
      }
      return false
    }
    throw error
  }
}

export interface PendingIdentityRecord {
  version: 1
  ownerToken: string
  commitment: string
  address: string
  createdAt: number
}

export const PENDING_IDENTITY_STORAGE_KEY = 'xoloswallet_pending_identity'

export function getPendingIdentityRecord(): PendingIdentityRecord | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingIdentityRecord>
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.commitment === 'string' &&
      parsed.commitment.length > 0 &&
      typeof parsed.ownerToken === 'string' &&
      parsed.ownerToken.length > 0 &&
      typeof parsed.address === 'string' &&
      typeof parsed.createdAt === 'number'
    ) {
      return {
        version: 1,
        ownerToken: parsed.ownerToken,
        commitment: parsed.commitment,
        address: parsed.address,
        createdAt: parsed.createdAt
      }
    }
    return null
  } catch {
    return null
  }
}

export function setPendingIdentityRecord(record: {
  version?: 1
  ownerToken: string
  commitment: string
  address: string
  createdAt?: number
}): void {
  if (typeof localStorage === 'undefined') {
    throw new Error('PENDING_IDENTITY_STORAGE_UNAVAILABLE')
  }
  const fullRecord: PendingIdentityRecord = {
    version: 1,
    ownerToken: record.ownerToken,
    commitment: record.commitment,
    address: record.address,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now()
  }
  const payload = JSON.stringify(fullRecord)
  localStorage.setItem(PENDING_IDENTITY_STORAGE_KEY, payload)
  const readBack = localStorage.getItem(PENDING_IDENTITY_STORAGE_KEY)
  if (!readBack) {
    try {
      localStorage.removeItem(PENDING_IDENTITY_STORAGE_KEY)
    } catch {
      // best-effort
    }
    throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
  }
  let parsed: Partial<PendingIdentityRecord> | null = null
  try {
    parsed = JSON.parse(readBack) as Partial<PendingIdentityRecord>
  } catch {
    try {
      localStorage.removeItem(PENDING_IDENTITY_STORAGE_KEY)
    } catch {
      // best-effort
    }
    throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
  }
  if (
    !parsed ||
    parsed.version !== 1 ||
    parsed.ownerToken !== fullRecord.ownerToken ||
    parsed.commitment !== fullRecord.commitment ||
    parsed.address !== fullRecord.address ||
    typeof parsed.createdAt !== 'number'
  ) {
    try {
      localStorage.removeItem(PENDING_IDENTITY_STORAGE_KEY)
    } catch {
      // best-effort
    }
    throw new Error('PENDING_IDENTITY_PERSIST_FAILED')
  }
}


export function clearPendingIdentityRecord(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(PENDING_IDENTITY_STORAGE_KEY)
  } catch {
    // best-effort
  }
}

export async function computeMnemonicCommitment(mnemonic: string): Promise<string> {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    const data = new TextEncoder().encode(normalized)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(hashBuffer), b => b.toString(16).padStart(2, '0')).join('')
  }
  let hash = 0
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0
  }
  return hash.toString(16)
}

