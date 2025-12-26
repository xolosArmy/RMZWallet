export type OpReturnApp = 'tonalli' | 'unknown'

export interface TxRecord {
  txid: string
  timestamp: number | null
  opReturnMessage?: string
  opReturnApp?: OpReturnApp
}
