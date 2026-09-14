export type TonalliMemoVerificationStatus =
  | 'VERIFIED'
  | 'UNAUTHORIZED'
  | 'NO_MEMO'
  | 'INVALID_MEMO'
  | 'MULTIPLE_MEMOS'

export type TonalliMemoAttachment = {
  type: 'NFT'
  tokenId: string
  ownership: 'VERIFIED_AT_INDEXING' | 'UNVERIFIED'
}

export type TonalliMemoFeedItem = {
  txid: string
  status: 'VERIFIED'
  profileAlias: string
  profileCode: string | null
  eventType: string
  payload: string
  displayPayload: string
  attachment: TonalliMemoAttachment | null
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
  profileCode: string | null
  eventType: string
  payload: string
  displayPayload: string
  attachment: TonalliMemoAttachment | null
  chainStatus: string
  blockHeight: number | null
  timestamp: string | number | null
}

export type TonalliMemoTxDetail = {
  txid: string
  transaction: TonalliMemoFeedItem
  verification: TonalliMemoVerification | null
}

export type TonalliMemoIndexRequestStatus = 'queued' | 'already_queued' | 'already_indexed'

export type TonalliMemoIndexRequestResult = {
  txid: string
  status: TonalliMemoIndexRequestStatus
}

export type TonalliMemoIndexingResult =
  | { status: 'verified'; detail: TonalliMemoTxDetail }
  | {
      status: 'policy_rejected'
      detail: TonalliMemoTxDetail
      verificationStatus: Exclude<TonalliMemoVerificationStatus, 'VERIFIED'>
    }
  | { status: 'timed_out' }

export interface TonalliMemoIndexingClient {
  requestIndex(txid: string, signal?: AbortSignal): Promise<TonalliMemoIndexRequestResult>
  waitForResult(
    txid: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<TonalliMemoIndexingResult>
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
