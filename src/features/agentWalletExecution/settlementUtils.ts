/**
 * @file settlementUtils.ts
 *
 * Settlement utilities for Gate C3A (RMZWallet Settlement Engine).
 * Pure functions for canonical TXID computation and consensus rejection discrimination.
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

/**
 * Distinguishes definitive consensus rejections from ambiguous transport/network errors.
 * Transport timeouts, network resets, server 5xx errors, and already-in-mempool MUST return false.
 */
export function isDefinitiveConsensusRejection(err: unknown): boolean {
  if (!err) return false
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  // Mempool already known / in mempool is NOT a consensus rejection;
  // it implies the transaction has already reached the network.
  if (
    msg.includes('txn-already-in-mempool') ||
    msg.includes('already in mempool') ||
    msg.includes('txn-already-known') ||
    msg.includes('already known')
  ) {
    return false
  }

  // Network, transport, timeout, or server errors are ambiguous
  if (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('aborterror') ||
    msg.includes('abort') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('fetch failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('network error') ||
    msg.includes('networkerror') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504')
  ) {
    return false
  }

  // Known definitive consensus rejection patterns from Bitcoin ABC / Chronik
  return (
    msg.includes('mandatory-script-verify-flag-failed') ||
    msg.includes('non-mandatory-script-verify-flag-failed') ||
    msg.includes('txn-mempool-conflict') ||
    msg.includes('bad-txns-inputs-missingorspent') ||
    msg.includes('bad-txns-inputs-spent') ||
    msg.includes('bad-txns-in-belowout') ||
    msg.includes('bad-txns-vout-negative') ||
    msg.includes('bad-txns-vout-toolarge') ||
    msg.includes('bad-txns-oversize') ||
    msg.includes('bad-txns-vin-empty') ||
    msg.includes('bad-txns-vout-empty') ||
    msg.includes('bad-txns-premature-spend') ||
    msg.includes('bad-txns-prevout-null') ||
    msg.includes('bad-txns-fee-outofrange') ||
    msg.includes('scriptsig-not-pushonly') ||
    msg.includes('dust') ||
    msg.includes('tx-size-small') ||
    msg.includes('absurdly-high-fee') ||
    msg.includes('consensus-rule-violated') ||
    msg.includes('definitive-consensus-rejection')
  )
}
