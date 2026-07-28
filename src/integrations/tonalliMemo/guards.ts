import type {
  TonalliMemoFeed,
  TonalliMemoFeedItem,
  TonalliMemoTxDetail,
  TonalliMemoVerification,
  TonalliMemoVerificationStatus
} from './types'

const TXID_RE = /^[0-9a-f]{64}$/
const VERIFICATION_STATUSES = new Set<TonalliMemoVerificationStatus>([
  'VERIFIED',
  'UNAUTHORIZED',
  'NO_MEMO',
  'INVALID_MEMO',
  'MULTIPLE_MEMOS'
])

type RecordValue = Record<string, unknown>

export function isValidTonalliMemoTxid(value: string) {
  return TXID_RE.test(value)
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: RecordValue, keys: string[], fallback = '') {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return fallback
}

function nullableHeight(value: unknown) {
  if (value === null || value === undefined) return null
  if (Number.isInteger(value) && (value as number) >= 0) return value as number
  return undefined
}

function nullableTimestamp(value: unknown) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (Number.isFinite(value)) return value as number
  return undefined
}

function profileFields(record: RecordValue) {
  const profile = isRecord(record.profile) ? record.profile : {}
  return {
    profileAlias: stringField(record, ['profileAlias', 'alias'], stringField(profile, ['alias', 'profileAlias'])),
    profileCode: stringField(record, ['profileCode', 'code'], stringField(profile, ['code', 'profileCode']))
  }
}

function parseFeedFields(value: unknown): Omit<TonalliMemoFeedItem, 'status' | 'txid'> | null {
  if (!isRecord(value)) return null

  const blockHeight = nullableHeight(value.blockHeight ?? value.height)
  const timestamp = nullableTimestamp(value.timestamp ?? value.createdAt ?? value.time)
  if (blockHeight === undefined || timestamp === undefined) return null

  const { profileAlias, profileCode } = profileFields(value)
  return {
    profileAlias,
    profileCode,
    eventType: stringField(value, ['eventType', 'type']),
    payload: stringField(value, ['payload', 'memo', 'message']),
    chainStatus: stringField(value, ['chainStatus', 'chain_status']),
    blockHeight,
    timestamp
  }
}

function parseDetailTransaction(value: unknown): TonalliMemoFeedItem | null {
  if (!isRecord(value)) return null
  const txid = stringField(value, ['txid'])
  if (!isValidTonalliMemoTxid(txid)) return null
  if (value.status !== 'VERIFIED') return null

  const fields = parseFeedFields(value)
  if (!fields) return null
  return {
    txid,
    status: 'VERIFIED',
    ...fields
  }
}

function parseFeedItem(value: unknown): TonalliMemoFeedItem | null {
  if (!isRecord(value)) return null

  const rawTransaction = value.transaction ?? value.tx ?? value
  if (!isRecord(rawTransaction)) return null

  const txid = stringField(rawTransaction, ['txid'], stringField(value, ['txid']))
  if (!isValidTonalliMemoTxid(txid)) return null

  const verification = parseVerification(value.verification, txid)
  if (!verification || verification.status !== 'VERIFIED') return null

  const fields = parseFeedFields(rawTransaction) ?? parseFeedFields(value)
  if (!fields) return null

  return {
    txid,
    status: 'VERIFIED',
    ...fields
  }
}

function parseVerification(value: unknown, txid: string): TonalliMemoVerification | null | undefined {
  if (value === null) return null
  if (!isRecord(value)) return undefined
  const verificationTxid = stringField(value, ['txid'])
  if (verificationTxid !== txid || !isValidTonalliMemoTxid(verificationTxid)) return undefined
  if (!VERIFICATION_STATUSES.has(value.status as TonalliMemoVerificationStatus)) return undefined

  const blockHeight = nullableHeight(value.blockHeight ?? value.height)
  const timestamp = nullableTimestamp(value.timestamp ?? value.createdAt ?? value.time)
  if (blockHeight === undefined || timestamp === undefined) return undefined

  const { profileAlias, profileCode } = profileFields(value)
  return {
    txid: verificationTxid,
    status: value.status as TonalliMemoVerificationStatus,
    profileAlias,
    profileCode,
    eventType: stringField(value, ['eventType', 'type']),
    payload: stringField(value, ['payload', 'memo', 'message']),
    chainStatus: stringField(value, ['chainStatus', 'chain_status']),
    blockHeight,
    timestamp
  }
}

function extractItems(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return null
  if (Array.isArray(value.items)) return value.items
  if (Array.isArray(value.feed)) return value.feed
  if (Array.isArray(value.data)) return value.data
  return null
}

export function parseTonalliMemoFeed(value: unknown): TonalliMemoFeed | null {
  const rawItems = extractItems(value)
  if (!rawItems) return null

  const items = rawItems.map(parseFeedItem)
  if (items.some((item) => item === null)) return null
  return { items: items as TonalliMemoFeedItem[] }
}

export function parseTonalliMemoTxDetail(value: unknown, txid: string): TonalliMemoTxDetail | null {
  if (!isRecord(value)) return null
  const rawTransaction = value.transaction ?? value.tx ?? value
  const transaction = parseDetailTransaction(rawTransaction)
  if (!transaction || transaction.txid !== txid) return null

  const verificationValue = Object.prototype.hasOwnProperty.call(value, 'verification')
    ? value.verification
    : rawTransaction
  const verification = parseVerification(verificationValue, txid)
  if (verification === undefined) return null

  return {
    txid,
    transaction,
    verification
  }
}
