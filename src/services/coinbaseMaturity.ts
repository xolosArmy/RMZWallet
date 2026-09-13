/**
 * Canonical eCash coinbase maturity predicate.
 *
 * Confirmations are counted as `tipHeight - blockHeight + 1`.
 * A coinbase output is spendable only when confirmations >= COINBASE_MATURITY_CONFIRMATIONS.
 * Unknown tip height, missing blockHeight, or mempool coinbase (blockHeight < 0)
 * cannot prove maturity and are treated as immature (fail closed / exclude).
 *
 * This is the single maturity definition used by TM1 walletPublisherExecutor
 * and Gate C2 production UTXO selection.
 */

export const COINBASE_MATURITY_CONFIRMATIONS = 100

export interface CoinbaseMaturityUtxoFields {
  readonly isCoinbase?: boolean
  readonly blockHeight?: number
}

export function isImmatureCoinbaseUtxo(
  utxo: CoinbaseMaturityUtxoFields,
  tipHeight: number | undefined,
  maturity: number = COINBASE_MATURITY_CONFIRMATIONS
): boolean {
  if (!utxo.isCoinbase) {
    return false
  }
  if (tipHeight === undefined || typeof utxo.blockHeight !== 'number' || utxo.blockHeight < 0) {
    return true
  }
  const confirmations = tipHeight - utxo.blockHeight + 1
  return confirmations < maturity
}
