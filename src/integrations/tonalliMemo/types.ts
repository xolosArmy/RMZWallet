export type TonalliMemoVerificationStatus =
  | 'VERIFIED'
  | 'UNAUTHORIZED'
  | 'NO_MEMO'
  | 'INVALID_MEMO'
  | 'MULTIPLE_MEMOS'

export type TonalliMemoFeedItem = {
  txid: string
  status: 'VERIFIED'
  profileAlias: string
  profileCode: string
  eventType: string
  payload: string
  chainStatus: string
  blockHeight: number | null
  timestamp: string | number | null
}

export type TonalliMemoFeed = {
  items: TonalliMemoFeedItem[]
}

export type TonalliMemoVerification = {
  txid: string
  status: TonalliMemoVerificationStatus
  profileAlias: string
  profileCode: string
  eventType: string
  payload: string
  chainStatus: string
  blockHeight: number | null
  timestamp: string | number | null
}

export type TonalliMemoTxDetail = {
  txid: string
  transaction: TonalliMemoFeedItem
  verification: TonalliMemoVerification | null
}

export type TonalliMemoClientErrorKind = 'network' | 'http' | 'malformed-json' | 'invalid-response'

export class TonalliMemoClientError extends Error {
  readonly kind: TonalliMemoClientErrorKind
  readonly status: number | null

  constructor(kind: TonalliMemoClientErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'TonalliMemoClientError'
    this.kind = kind
    this.status = status
  }
}
