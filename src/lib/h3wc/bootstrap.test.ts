import { describe, expect, test, vi } from 'vitest'
import { initializeH3wc } from './bootstrap'

describe('H3WC hard feature flag', () => {
  test('flag off has zero H3WC observable behavior', async () => {
    const locks = { request: vi.fn() }
    const indexedDb = { open: vi.fn() } as unknown as IDBFactory
    const Channel = vi.fn() as unknown as typeof BroadcastChannel
    const result = await initializeH3wc({
      enabled: false,
      projectId: 'ignored',
      navigatorLike: { locks } as unknown as Navigator,
      indexedDb,
      broadcastChannelFactory: Channel
    })
    expect(result.status).toBe('disabled')
    expect(locks.request).not.toHaveBeenCalled()
    expect(indexedDb.open).not.toHaveBeenCalled()
    expect(Channel).not.toHaveBeenCalled()
  })

  test('flag on without its dedicated project ID fails before Web Locks/relay setup', async () => {
    const locks = { request: vi.fn() }
    const result = await initializeH3wc({
      enabled: true,
      projectId: undefined,
      requesterOrigin: 'https://x402.ecash.mx',
      navigatorLike: { locks } as unknown as Navigator
    })
    expect(result).toMatchObject({ status: 'failed', errorCode: 'H3WC_PROJECT_ID_REQUIRED' })
    expect(locks.request).not.toHaveBeenCalled()
  })
})
