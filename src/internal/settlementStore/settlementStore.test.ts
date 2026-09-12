/**
 * @file settlementStore.test.ts
 *
 * TESTS FOR CANONICAL WALLET-INTERNAL SETTLEMENT STORE (Gate C2 write-only)
 */

import { describe, expect, it, vi } from 'vitest'
import {
  clearInternalSettlementStore,
  DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY,
  DEFAULT_SETTLEMENT_STORE_LOCK_NAME,
  storeInternalSignedTransaction
} from './index'
import { MockStorage, TestExecutionLockCoordinator } from '../../features/agentWalletExecution/testUtils'
import { WalletExecutionError } from '../../features/agentWalletExecution/errors'

function readStore(storage: Storage): Record<string, string> {
  const raw = storage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, string>
}

describe('Wallet Internal Settlement Store (Gate C2 write-only)', () => {
  it('stores raw signed transactions under the internal settlement key', async () => {
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    const executionId = 'exec_c2_test_1'
    const rawTxHex = '0200000001deadbeef00000000'

    await storeInternalSignedTransaction(executionId, rawTxHex, {
      storage,
      lockCoordinator: coordinator
    })

    const parsed = readStore(storage)
    expect(parsed[executionId]).toBe(rawTxHex)
  })

  it('does not export any raw-tx read/get API', async () => {
    const settlementModule = await import('./index')
    expect((settlementModule as Record<string, unknown>).getInternalSignedTransaction).toBeUndefined()
    expect((settlementModule as Record<string, unknown>).getSignedTransaction).toBeUndefined()
    expect((settlementModule as Record<string, unknown>).getRawSignedTx).toBeUndefined()
    expect((settlementModule as Record<string, unknown>).readSettlementTx).toBeUndefined()
    expect((settlementModule as Record<string, unknown>).getInternalSignedTransactionHex).toBeUndefined()
    expect(typeof settlementModule.storeInternalSignedTransaction).toBe('function')
    expect(settlementModule.DEFAULT_SETTLEMENT_STORE_LOCK_NAME).toBe(
      'rmzwallet:internal-settlement:lock:v2'
    )
  })

  it('fails closed when Web Locks are unavailable and no coordinator is injected', async () => {
    const originalNavigator = globalThis.navigator
    try {
      vi.stubGlobal('navigator', {})
      const storage = new MockStorage()
      await expect(storeInternalSignedTransaction('exec_no_lock', 'aabb', storage)).rejects.toThrow(
        expect.objectContaining({ code: 'COORDINATION_UNAVAILABLE' })
      )
      expect(storage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)).toBeNull()
    } finally {
      vi.stubGlobal('navigator', originalNavigator)
    }
  })

  it('preserves both raw signed transactions when two tabs persist concurrently', async () => {
    const sharedStorage = new MockStorage()
    // Shared in-process coordinator serializes the same lock name the way Web Locks would.
    const sharedCoordinator = new TestExecutionLockCoordinator()

    await Promise.all([
      storeInternalSignedTransaction('exec_tab_1', 'aa'.repeat(20), {
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      }),
      storeInternalSignedTransaction('exec_tab_2', 'bb'.repeat(20), {
        storage: sharedStorage,
        lockCoordinator: sharedCoordinator
      })
    ])

    const parsed = readStore(sharedStorage)
    expect(parsed.exec_tab_1).toBe('aa'.repeat(20))
    expect(parsed.exec_tab_2).toBe('bb'.repeat(20))
    expect(Object.keys(parsed)).toHaveLength(2)
    expect(DEFAULT_SETTLEMENT_STORE_LOCK_NAME).toContain('settlement')
  })

  it('clears internal settlement store', async () => {
    const storage = new MockStorage()
    const coordinator = new TestExecutionLockCoordinator()
    const executionId = 'exec_c2_clear'
    await storeInternalSignedTransaction(executionId, '0123456789abcdef', {
      storage,
      lockCoordinator: coordinator
    })
    expect(readStore(storage)[executionId]).toBeDefined()

    await clearInternalSettlementStore(storage, coordinator)
    expect(storage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)).toBeNull()
  })

  it('fails closed when durable storage is unavailable', async () => {
    const coordinator = new TestExecutionLockCoordinator()
    await expect(
      storeInternalSignedTransaction('exec_no_storage', 'aabb', {
        storage: undefined,
        lockCoordinator: coordinator
      })
    ).rejects.toBeInstanceOf(WalletExecutionError)
  })
})
