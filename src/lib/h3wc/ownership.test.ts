import { describe, expect, test, vi } from 'vitest'
import { deriveH3wcRequestKey, runAsH3wcOwner } from './ownership'

const cryptoFixture = {
  randomUUID: () => 'epoch-a',
  subtle: globalThis.crypto.subtle
} as unknown as Crypto

describe('H3WC Web Locks ownership', () => {
  test('only the exclusive owner may enter request processing', async () => {
    const names: string[] = []
    const locks = {
      request: vi.fn(async (name: string, _options: LockOptions, callback: (lock: Lock) => Promise<unknown>) => {
        names.push(name)
        return callback({ name, mode: 'exclusive' } as Lock)
      })
    } as unknown as Pick<LockManager, 'request'>
    const result = await runAsH3wcOwner(async owner => {
      expect(owner.ownerEpoch).toBe('epoch-a')
      return owner.withRequestLock('request-hash', () => 'terminal')
    }, {
      navigatorLike: { locks } as Navigator,
      cryptoLike: cryptoFixture
    })
    expect(result).toBe('terminal')
    expect(names).toEqual(['tonalli:wc:owner:v1', 'tonalli:wc:request:request-hash'])
  })

  test('ifAvailable returns follower without a takeover or a new epoch', async () => {
    const locks = {
      request: vi.fn(async (_name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<unknown>) => callback(null))
    } as unknown as Pick<LockManager, 'request'>
    await expect(runAsH3wcOwner(() => 'not-owner', {
      ifAvailable: true,
      navigatorLike: { locks } as Navigator,
      cryptoLike: cryptoFixture
    })).resolves.toBeNull()
  })

  test('missing Web Locks fails closed', async () => {
    await expect(runAsH3wcOwner(() => 'never', { navigatorLike: null })).rejects.toMatchObject({
      code: 'H3WC_OWNERSHIP_UNAVAILABLE'
    })
  })

  test('request key is deterministic and binds topic plus request ID', async () => {
    const first = await deriveH3wcRequestKey('topic-a', 4, cryptoFixture)
    const second = await deriveH3wcRequestKey('topic-a', 4, cryptoFixture)
    const different = await deriveH3wcRequestKey('topic-a', 5, cryptoFixture)
    expect(first).toBe(second)
    expect(first).not.toBe(different)
    expect(first).toMatch(/^[0-9a-f]{64}$/u)
  })
})
