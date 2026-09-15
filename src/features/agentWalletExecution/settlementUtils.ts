/**
 * @file settlementUtils.ts
 *
 * Settlement utilities for Gate C3A (RMZWallet Settlement Engine).
 * Pure functions for canonical TXID computation.
 *
 * Boundary Rules:
 * - NEVER exports private keys, signatories, or raw-tx accessors.
 * - Local TXID computation independently verifies deserialization and hash format.
 */

import { Tx } from 'ecash-lib'
import { WalletExecutionError } from './errors'

function isValidHexString(str: string): boolean {
  return str.length > 0 && str.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(str)
}

/**
 * Independently deserialize verified raw signed transaction bytes
 * and compute canonical 64-character lowercase eCash TXID.
 */
export function deriveExpectedTxidFromRawTxHex(rawSignedTxHex: string): string {
  if (typeof rawSignedTxHex !== 'string') {
    throw new WalletExecutionError(
      'INVALID_SIGNED_TRANSACTION',
      'Raw signed transaction artifact must be a string.'
    )
  }
  const normalizedHex = rawSignedTxHex.trim().toLowerCase()
  if (!normalizedHex || !isValidHexString(normalizedHex)) {
    throw new WalletExecutionError(
      'INVALID_SIGNED_TRANSACTION',
      'Raw signed transaction artifact is not a valid hex string.'
    )
  }
  let tx: Tx
  try {
    tx = Tx.fromHex(normalizedHex)
  } catch (err) {
    throw new WalletExecutionError(
      'INVALID_SIGNED_TRANSACTION',
      `Failed to deserialize raw signed transaction: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  let expectedTxid: string
  try {
    expectedTxid = tx.txid().toLowerCase()
  } catch (err) {
    throw new WalletExecutionError(
      'INVALID_SIGNED_TRANSACTION',
      `Failed to compute txid from deserialized transaction: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!/^[0-9a-f]{64}$/.test(expectedTxid)) {
    throw new WalletExecutionError(
      'INVALID_SIGNED_TRANSACTION',
      `Derived expected txid "${expectedTxid}" is not a valid 64-character hex string.`
    )
  }
  return expectedTxid
}


