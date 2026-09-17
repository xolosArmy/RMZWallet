const DB_NAME = 'tonalli-quickstart-v1'
const DB_VERSION = 1
const STORE_NAME = 'wallet'
const KEY_RECORD = 'device-key'
const SEED_RECORD = 'seed-ciphertext'

export class QuickStartUnavailableError extends Error {
  constructor(message = 'QUICK_START_SECURE_STORAGE_UNAVAILABLE') {
    super(message)
    this.name = 'QuickStartUnavailableError'
  }
}

type SeedCipherRecord = Readonly<{
  id: typeof SEED_RECORD
  v: 1
  iv: Uint8Array
  ciphertext: ArrayBuffer
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

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  const stored = await readRecord<{ id: string; key: CryptoKey }>(KEY_RECORD)
  if (stored?.key) return stored.key

  assertAvailable()
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
  await writeRecords([{ id: KEY_RECORD, key }])
  return key
}

export async function storeQuickStartMnemonic(mnemonic: string): Promise<void> {
  const normalized = mnemonic.trim()
  if (!normalized) throw new Error('QUICK_START_MNEMONIC_REQUIRED')

  const key = await getOrCreateDeviceKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(normalized)
  )
  const record: SeedCipherRecord = {
    id: SEED_RECORD,
    v: 1,
    iv,
    ciphertext
  }
  await writeRecords([record as unknown as Record<string, unknown>])
}

export async function loadQuickStartMnemonic(): Promise<string | null> {
  const record = await readRecord<SeedCipherRecord>(SEED_RECORD)
  if (!record) return null
  if (record.v !== 1 || !(record.iv instanceof Uint8Array) || !(record.ciphertext instanceof ArrayBuffer)) {
    throw new Error('QUICK_START_STORAGE_CORRUPT')
  }

  const storedKey = await readRecord<{ id: string; key: CryptoKey }>(KEY_RECORD)
  if (!storedKey?.key) throw new Error('QUICK_START_DEVICE_KEY_MISSING')

  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv },
      storedKey.key,
      record.ciphertext
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
    return Boolean(await readRecord<SeedCipherRecord>(SEED_RECORD))
  } catch (error) {
    if (error instanceof QuickStartUnavailableError) return false
    throw error
  }
}
