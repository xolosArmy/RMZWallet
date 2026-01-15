export type OpReturnApp = 'tonalli' | 'unknown'
export type SenderType = 'p2pkh' | 'p2sh' | 'unknown'

export interface TxRecord {
  txid: string
  timestamp: number | null
  opReturnMessage?: string
  opReturnApp?: OpReturnApp
  senderAddress?: string
  senderType?: SenderType
}
