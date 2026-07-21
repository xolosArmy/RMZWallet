import { describe, expect, test, vi } from 'vitest'
import { EXTERNAL_SIGN_REQUEST_STORAGE_KEY, EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY } from '../utils/externalSign'
import { TONALLI_PENDING_REQUEST_KEY } from '../utils/tonalliConnect'
import { resolvePendingTonalliResume } from './useResumePendingTonalliRequest'

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key)
    })
  }
}

describe('resolvePendingTonalliResume', () => {
  test('does not resume until wallet initialization and backup verification are ready', () => {
    const sessionStorageRef = createStorage({ [EXTERNAL_SIGN_REQUEST_STORAGE_KEY]: '{}' })
    const localStorageRef = createStorage({ [TONALLI_PENDING_REQUEST_KEY]: '?' })

    expect(resolvePendingTonalliResume({
      backupVerified: false,
      initialized: true,
      localStorageRef,
      sessionStorageRef
    })).toBeNull()
    expect(resolvePendingTonalliResume({
      backupVerified: true,
      initialized: false,
      localStorageRef,
      sessionStorageRef
    })).toBeNull()
    expect(sessionStorageRef.removeItem).not.toHaveBeenCalled()
    expect(localStorageRef.removeItem).not.toHaveBeenCalled()
  })

  test('resumes external sign requests without changing storage key names', () => {
    const sessionStorageRef = createStorage({
      [EXTERNAL_SIGN_REQUEST_STORAGE_KEY]: '{"unsignedTxHex":"00"}',
      [EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY]: '/external-sign?flow=pledge'
    })
    const localStorageRef = createStorage()

    const result = resolvePendingTonalliResume({
      backupVerified: true,
      initialized: true,
      localStorageRef,
      requestedReturnTo: '/fallback',
      sessionStorageRef
    })

    expect(EXTERNAL_SIGN_REQUEST_STORAGE_KEY).toBe('rmz_external_sign_request')
    expect(EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY).toBe('rmz_external_sign_return_to')
    expect(result).toEqual({ target: '/external-sign?flow=pledge', type: 'external-sign' })
    expect(sessionStorageRef.removeItem).toHaveBeenCalledWith(EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY)
  })

  test('resumes Tonalli Connect requests without changing storage key names', () => {
    const pending = JSON.stringify({ path: '/connect/sign-message', search: '?request=abc' })
    const sessionStorageRef = createStorage()
    const localStorageRef = createStorage({ [TONALLI_PENDING_REQUEST_KEY]: pending })

    const result = resolvePendingTonalliResume({
      backupVerified: true,
      initialized: true,
      localStorageRef,
      sessionStorageRef
    })

    expect(TONALLI_PENDING_REQUEST_KEY).toBe('tonalli_pending_req_v1')
    expect(result).toEqual({ target: '/connect/sign-message?request=abc', type: 'tonalli-connect' })
    expect(localStorageRef.removeItem).toHaveBeenCalledWith(TONALLI_PENDING_REQUEST_KEY)
  })
})
