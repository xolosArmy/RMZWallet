import type { Tx } from 'chronik-client'
import type { TxRecord } from '../types/tx'
import { decodeOpReturn, TONALLI_PREFIX_HEX } from './opReturn'

export const mapChronikTxToRecord = (tx: Tx): TxRecord => {
  const opReturnData = tx.outputs
    .map((output) => decodeOpReturn(output.outputScript))
    .find((result) => result?.message)

  const opReturnMessage = opReturnData?.message
  const opReturnApp = opReturnMessage
    ? opReturnData?.prefix === TONALLI_PREFIX_HEX
      ? 'tonalli'
      : 'unknown'
    : undefined

  const timestamp =
    tx.block?.timestamp ??
    (tx.timeFirstSeen && tx.timeFirstSeen > 0 ? tx.timeFirstSeen : null)

  return {
    txid: tx.txid,
    timestamp,
    opReturnMessage,
    opReturnApp
  }
}
