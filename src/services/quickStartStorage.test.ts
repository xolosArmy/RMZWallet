// @vitest-environment jsdom

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ECASH_STANDARD_PROFILE_ID } from './derivationProfiles'
import {
  clearQuickStartMnemonic,
  loadQuickStartMetadata,
  loadQuickStartMnemonic,
  storeQuickStartMnemonic
} from './quickStartStorage'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

async function allStoreRecords() {
  const request = indexedDB.open('tonalli-quickstart-v1', 1)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const tx = db.transaction('wallet', 'readonly')
  const records = await new Promise<unknown[]>((resolve, reject) => {
    const req = tx.objectStore('wallet').getAll()
    req.onsuccess = () => resolve(req.result as unknown[])
    req.onerror = () => reject(req.error)
  })
  db.close()
  return records
}

describe('Quick Start encrypted storage', () => {
  beforeEach(async () => {
    await clearQuickStartMnemonic()
    localStorage.clear()
    sessionStorage.clear()
  })

  afterEach(async () => {
    await clearQuickStartMnemonic()
  })

  test('ciphertext is not the plaintext mnemonic and the CryptoKey is non-extractable', async () => {
    await storeQuickStartMnemonic(MNEMONIC, {
      derivationProfileId: ECASH_STANDARD_PROFILE_ID,
      address: 'ecash:qtest'
    })
    const records = await allStoreRecords()
    const serialized = JSON.stringify(records, (_key, value) => {
      if (value instanceof ArrayBuffer) return new Uint8Array(value).join(',')
      if (value instanceof Uint8Array) return Array.from(value).join(',')
      if (value instanceof CryptoKey) {
        return { type: value.type, extractable: value.extractable, algorithm: value.algorithm, usages: value.usages }
      }
      return value
    })
    expect(serialized).not.toContain(MNEMONIC)
    expect(localStorage.getItem('xoloswallet_encrypted_mnemonic')).toBeNull()
    expect(Object.values(localStorage)).not.toContain(MNEMONIC)
    expect(Object.values(sessionStorage)).not.toContain(MNEMONIC)

    const keyRecord = records.find((record) => (
      record && typeof record === 'object' && 'key' in record && (record as { key?: CryptoKey }).key instanceof CryptoKey
    )) as { key: CryptoKey } | undefined
    expect(keyRecord?.key.extractable).toBe(false)
    expect(keyRecord?.key.algorithm.name).toBe('AES-GCM')

    const loaded = await loadQuickStartMnemonic()
    expect(loaded).toBe(MNEMONIC)
    const metadata = await loadQuickStartMetadata()
    expect(metadata?.derivationProfileId).toBe(ECASH_STANDARD_PROFILE_ID)
    expect(metadata?.version).toBe(1)
  })

  test('missing device key fails closed', async () => {
    await storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
    const request = indexedDB.open('tonalli-quickstart-v1', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('wallet', 'readwrite')
      tx.objectStore('wallet').delete('device-key')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    await expect(loadQuickStartMnemonic()).rejects.toThrow('QUICK_START_DEVICE_KEY_MISSING')
  })

  test('corrupt ciphertext fails closed', async () => {
    await storeQuickStartMnemonic(MNEMONIC, { derivationProfileId: ECASH_STANDARD_PROFILE_ID })
    const request = indexedDB.open('tonalli-quickstart-v1', 1)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('wallet', 'readwrite')
      tx.objectStore('wallet').put({
        id: 'seed-ciphertext',
        version: 1,
        iv: new Uint8Array(12),
        ciphertext: 'not-cipher',
        derivationProfileId: ECASH_STANDARD_PROFILE_ID
      })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
    await expect(loadQuickStartMnemonic()).rejects.toThrow('QUICK_START_STORAGE_CORRUPT')
  })
})
