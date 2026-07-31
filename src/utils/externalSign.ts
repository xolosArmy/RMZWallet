import { Tx, toHexRev } from 'ecash-lib'

export type ExternalSignOutpoint = Readonly<{
  txid: string
  vout: number
}>

export function extractOutpointsFromUnsignedTxHex(unsignedTxHex: string): ExternalSignOutpoint[] {
  const normalized = unsignedTxHex.trim()
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('unsignedTxHex inválido: no es hex válido.')
  }

  const tx = Tx.fromHex(normalized)
  if (tx.toHex().toLowerCase() !== normalized.toLowerCase()) {
    throw new Error('unsignedTxHex inválido: contiene bytes residuales.')
  }
  if (!tx.inputs.length) throw new Error('unsignedTxHex inválido: no contiene inputs.')

  return tx.inputs.map((input, index) => {
    const txid = typeof input.prevOut.txid === 'string' ? input.prevOut.txid : toHexRev(input.prevOut.txid)
    const vout = Number(input.prevOut.outIdx)
    if (!Number.isSafeInteger(vout) || vout < 0) {
      throw new Error(`unsignedTxHex inválido: input ${index} tiene vout inválido.`)
    }
    return { txid: txid.toLowerCase(), vout }
  })
}
