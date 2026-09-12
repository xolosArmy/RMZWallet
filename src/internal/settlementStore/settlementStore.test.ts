/**
 * @file settlementStore.test.ts
 *
 * TESTS FOR CANONICAL WALLET-INTERNAL SETTLEMENT STORE (Gate C2 -> C3 Bridge)
 */

import { describe, expect, it } from 'vitest'
import {
  clearInternalSettlementStore,
  DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY,
  getInternalSignedTransaction,
  storeInternalSignedTransaction
} from './index'
import { MockStorage } from '../../features/agentWalletExecution/testUtils'

describe('Wallet Internal Settlement Store (Gate C2 -> C3)', () => {
  it('stores and retrieves raw signed transactions in target storage', async () => {
    const storage = new MockStorage()
    const executionId = 'exec_c2_test_1'
    const rawTxHex = '0200000001deadbeef00000000'

    await storeInternalSignedTransaction(executionId, rawTxHex, storage)

    const retrieved = await getInternalSignedTransaction(executionId, storage)
    expect(retrieved).toBe(rawTxHex)

    // Verify raw storage payload uses the internal settlement key
    const rawStored = storage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
    expect(rawStored).toBeDefined()
    const parsed = JSON.parse(rawStored!)
    expect(parsed[executionId]).toBe(rawTxHex)
  })

  it('returns undefined for non-existent executionId', async () => {
    const storage = new MockStorage()
    const retrieved = await getInternalSignedTransaction('non_existent', storage)
    expect(retrieved).toBeUndefined()
  })

  it('clears internal settlement store', async () => {
    const storage = new MockStorage()
    const executionId = 'exec_c2_clear'
    await storeInternalSignedTransaction(executionId, '0123456789abcdef', storage)
    expect(await getInternalSignedTransaction(executionId, storage)).toBeDefined()

    await clearInternalSettlementStore(storage)
    expect(await getInternalSignedTransaction(executionId, storage)).toBeUndefined()
    expect(storage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)).toBeNull()
  })
})
