/**
 * @file settlementStore.test.ts
 *
 * Gate C2 settlement-store module is constants-only. No writer/reader API.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY,
  DEFAULT_SETTLEMENT_STORE_LOCK_NAME
} from './index'

describe('Wallet Internal Settlement Store (Gate C2 constants-only)', () => {
  it('does not export any raw-tx read or write API', async () => {
    const settlementModule = await import('./index')
    const forbidden = [
      'storeInternalSignedTransaction',
      'writeSignedTransaction',
      'putSettlementArtifact',
      'replaceSettlementArtifact',
      'getInternalSignedTransaction',
      'getSignedTransaction',
      'getRawSignedTx',
      'readSettlementTx',
      'getInternalSignedTransactionHex',
      'clearInternalSettlementStore',
      'createSettlementStore',
      'createSettlementWriter'
    ]
    for (const name of forbidden) {
      expect((settlementModule as Record<string, unknown>)[name]).toBeUndefined()
    }
    expect(Object.keys(settlementModule).sort()).toEqual(
      ['DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY', 'DEFAULT_SETTLEMENT_STORE_LOCK_NAME'].sort()
    )
    expect(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY).toBe('rmzwallet_internal_settlement_v2')
    expect(DEFAULT_SETTLEMENT_STORE_LOCK_NAME).toBe('rmzwallet:internal-settlement:lock:v2')
  })
})
