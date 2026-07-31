import { Tx } from 'ecash-lib'
import {
  EXTERNAL_SIGN_CHAIN_ID,
  EXTERNAL_SIGN_MAX_REQUEST_TTL_MS,
  EXTERNAL_SIGN_MAX_TX_BYTES,
  EXTERNAL_SIGN_MODE,
  EXTERNAL_SIGN_PROTOCOL_ID,
  EXTERNAL_SIGN_PROTOCOL_VERSION
} from './config'

export const EXTERNAL_SIGN_REQUEST_STORAGE_KEY = 'tonalli_external_sign_request_v1'
export const EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY = 'tonalli_external_sign_return_to_v1'

export type ExternalSignWireRequestV1 = Readonly<{
  protocolId: typeof EXTERNAL_SIGN_PROTOCOL_ID
  protocolVersion: typeof EXTERNAL_SIGN_PROTOCOL_VERSION
  chainId: typeof EXTERNAL_SIGN_CHAIN_ID
  requestId: string
  intentId?: string
  expiresAt: number
  mode: typeof EXTERNAL_SIGN_MODE
  unsignedTxHex: string
  requester: Readonly<{
    displayName: string
    applicationUrl?: string
    declaredOrigin?: string
  }>
}>

export type OriginContextV1 = Readonly<{
  status: 'authenticated' | 'declared-unverified' | 'unknown'
  authenticatedOrigin: string | null
  declaredOrigin: string | null
  evidence: 'postMessage-opener' | 'metadata-only' | 'none'
}>

export class ExternalSignError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = 'ExternalSignError'
    this.code = code
  }
}

const ROOT_KEYS = new Set([
  'protocolId',
  'protocolVersion',
  'chainId',
  'requestId',
  'intentId',
  'expiresAt',
  'mode',
  'unsignedTxHex',
  'requester'
])
const REQUESTER_KEYS = new Set(['displayName', 'applicationUrl', 'declaredOrigin'])
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HEX = /^[0-9a-fA-F]+$/
const hasControlCharacter = (value: string) => Array.from(value).some(character => {
  const code = character.codePointAt(0) ?? 0
  return code <= 0x1f || code === 0x7f
})

const utf8Length = (value: string) => new TextEncoder().encode(value).length

function parseJsonWithoutDuplicateMembers(input: string): unknown {
  let index = 0

  const fail = (code: string): never => {
    throw new ExternalSignError(code)
  }
  const skipWhitespace = () => {
    while (' \t\r\n'.includes(input[index] ?? '\0')) index += 1
  }
  const parseString = (): string => {
    if (input[index] !== '"') fail('INVALID_JSON')
    const start = index
    index += 1
    while (index < input.length) {
      const char = input[index]
      if (char === '"') {
        index += 1
        try {
          return JSON.parse(input.slice(start, index)) as string
        } catch {
          return fail('INVALID_JSON')
        }
      }
      if (char === '\\') {
        index += 2
      } else {
        if ((char?.charCodeAt(0) ?? 0) < 0x20) fail('INVALID_JSON')
        index += 1
      }
    }
    return fail('INVALID_JSON')
  }
  const parseValue = (): unknown => {
    skipWhitespace()
    const char = input[index]
    if (char === '"') return parseString()
    if (char === '{') return parseObject()
    if (char === '[') return parseArray()
    const remainder = input.slice(index)
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (remainder.startsWith(literal)) {
        index += literal.length
        return value
      }
    }
    const numberMatch = remainder.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (!numberMatch) return fail('INVALID_JSON')
    index += numberMatch[0].length
    const value = Number(numberMatch[0])
    if (!Number.isFinite(value)) return fail('INVALID_JSON')
    return value
  }
  const parseObject = (): Record<string, unknown> => {
    const object: Record<string, unknown> = {}
    const keys = new Set<string>()
    index += 1
    skipWhitespace()
    if (input[index] === '}') {
      index += 1
      return object
    }
    while (index < input.length) {
      skipWhitespace()
      const key = parseString()
      if (keys.has(key)) fail('DUPLICATE_JSON_MEMBER')
      keys.add(key)
      skipWhitespace()
      if (input[index] !== ':') fail('INVALID_JSON')
      index += 1
      object[key] = parseValue()
      skipWhitespace()
      if (input[index] === '}') {
        index += 1
        return object
      }
      if (input[index] !== ',') fail('INVALID_JSON')
      index += 1
    }
    return fail('INVALID_JSON')
  }
  const parseArray = (): unknown[] => {
    const array: unknown[] = []
    index += 1
    skipWhitespace()
    if (input[index] === ']') {
      index += 1
      return array
    }
    while (index < input.length) {
      array.push(parseValue())
      skipWhitespace()
      if (input[index] === ']') {
        index += 1
        return array
      }
      if (input[index] !== ',') fail('INVALID_JSON')
      index += 1
    }
    return fail('INVALID_JSON')
  }

  const parsed = parseValue()
  skipWhitespace()
  if (index !== input.length) fail('INVALID_JSON')
  return parsed
}

const assertClosedObject = (value: unknown, allowed: Set<string>, code: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalSignError(code)
  }
  const object = value as Record<string, unknown>
  if (Object.hasOwn(object, 'broadcast')) throw new ExternalSignError('LEGACY_BROADCAST_FORBIDDEN')
  const unknown = Object.keys(object).find(key => !allowed.has(key))
  if (unknown) throw new ExternalSignError('UNKNOWN_FIELD', unknown)
  return object
}

const normalizeText = (value: unknown, min: number, max: number, code: string): string => {
  if (typeof value !== 'string') throw new ExternalSignError(code)
  const normalized = value.normalize('NFC')
  const length = utf8Length(normalized)
  if (length < min || length > max || hasControlCharacter(normalized)) throw new ExternalSignError(code)
  return normalized
}

const normalizeApplicationUrl = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  const normalized = normalizeText(value, 1, 2048, 'INVALID_APPLICATION_URL')
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new ExternalSignError('INVALID_APPLICATION_URL')
  }
  const isLocalHttp = parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  if (parsed.protocol !== 'https:' && !isLocalHttp) throw new ExternalSignError('INVALID_APPLICATION_URL')
  return parsed.href
}

const normalizeDeclaredOrigin = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  const normalized = normalizeText(value, 1, 2048, 'INVALID_DECLARED_ORIGIN')
  try {
    const parsed = new URL(normalized)
    if (parsed.origin !== normalized || parsed.protocol !== 'https:') throw new Error()
    return parsed.origin
  } catch {
    throw new ExternalSignError('INVALID_DECLARED_ORIGIN')
  }
}

const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}

export function parseExternalSignRequestObject(payload: unknown, now = Date.now()): ExternalSignWireRequestV1 {
  const object = assertClosedObject(payload, ROOT_KEYS, 'INVALID_REQUEST')
  if (object.protocolId !== EXTERNAL_SIGN_PROTOCOL_ID) throw new ExternalSignError('UNSUPPORTED_PROTOCOL')
  if (object.protocolVersion !== EXTERNAL_SIGN_PROTOCOL_VERSION) throw new ExternalSignError('UNSUPPORTED_VERSION')
  if (object.chainId !== EXTERNAL_SIGN_CHAIN_ID) throw new ExternalSignError('WRONG_NETWORK')
  if (object.mode !== EXTERNAL_SIGN_MODE) throw new ExternalSignError('MODE_FORBIDDEN')
  if (typeof object.requestId !== 'string' || !UUID_V4.test(object.requestId)) {
    throw new ExternalSignError('INVALID_REQUEST_ID')
  }
  if (!Number.isSafeInteger(object.expiresAt)) throw new ExternalSignError('INVALID_EXPIRATION')
  const expiresAt = object.expiresAt as number
  if (expiresAt <= now) throw new ExternalSignError('REQUEST_EXPIRED')
  if (expiresAt > now + EXTERNAL_SIGN_MAX_REQUEST_TTL_MS) throw new ExternalSignError('EXPIRATION_TOO_FAR')

  if (typeof object.unsignedTxHex !== 'string' || !HEX.test(object.unsignedTxHex) || object.unsignedTxHex.length % 2 !== 0) {
    throw new ExternalSignError('INVALID_UNSIGNED_TX_HEX')
  }
  const unsignedTxHex = object.unsignedTxHex.toLowerCase()
  if (unsignedTxHex.length / 2 > EXTERNAL_SIGN_MAX_TX_BYTES) throw new ExternalSignError('TX_TOO_LARGE')
  try {
    if (Tx.fromHex(unsignedTxHex).toHex().toLowerCase() !== unsignedTxHex) {
      throw new ExternalSignError('TRAILING_OR_NONCANONICAL_TX_BYTES')
    }
  } catch (error) {
    if (error instanceof ExternalSignError) throw error
    throw new ExternalSignError('INVALID_UNSIGNED_TX_HEX')
  }

  const requesterObject = assertClosedObject(object.requester, REQUESTER_KEYS, 'INVALID_REQUESTER')
  const applicationUrl = normalizeApplicationUrl(requesterObject.applicationUrl)
  const declaredOrigin = normalizeDeclaredOrigin(requesterObject.declaredOrigin)
  const requester = {
    displayName: normalizeText(requesterObject.displayName, 1, 80, 'INVALID_DISPLAY_NAME'),
    ...(applicationUrl ? { applicationUrl } : {}),
    ...(declaredOrigin ? { declaredOrigin } : {})
  }
  const intentId = object.intentId === undefined
    ? undefined
    : normalizeText(object.intentId, 1, 128, 'INVALID_INTENT_ID')

  return deepFreeze({
    protocolId: EXTERNAL_SIGN_PROTOCOL_ID,
    protocolVersion: EXTERNAL_SIGN_PROTOCOL_VERSION,
    chainId: EXTERNAL_SIGN_CHAIN_ID,
    requestId: object.requestId,
    ...(intentId ? { intentId } : {}),
    expiresAt,
    mode: EXTERNAL_SIGN_MODE,
    unsignedTxHex,
    requester
  }) as ExternalSignWireRequestV1
}

export function parseExternalSignRequestJson(json: string, now = Date.now()): ExternalSignWireRequestV1 {
  return parseExternalSignRequestObject(parseJsonWithoutDuplicateMembers(json), now)
}

const decodeBase64UrlUtf8 = (encoded: string): string => {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.includes('=')) throw new ExternalSignError('INVALID_REQUEST_ENCODING')
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new ExternalSignError('INVALID_REQUEST_ENCODING')
  }
}

export function parseExternalSignRequestParam(paramValue: string, now = Date.now()): ExternalSignWireRequestV1 {
  return parseExternalSignRequestJson(decodeBase64UrlUtf8(paramValue), now)
}

type StoredPendingRequestV1 = Readonly<{ request: ExternalSignWireRequestV1; persistedAt: number }>

export function storePendingExternalSignRequest(storage: Pick<Storage, 'setItem'>, request: ExternalSignWireRequestV1, now = Date.now()) {
  const pending: StoredPendingRequestV1 = { request, persistedAt: now }
  storage.setItem(EXTERNAL_SIGN_REQUEST_STORAGE_KEY, JSON.stringify(pending))
}

export function takePendingExternalSignRequest(
  storage: Pick<Storage, 'getItem' | 'removeItem'>,
  now = Date.now()
): ExternalSignWireRequestV1 | null {
  const raw = storage.getItem(EXTERNAL_SIGN_REQUEST_STORAGE_KEY)
  storage.removeItem(EXTERNAL_SIGN_REQUEST_STORAGE_KEY)
  if (!raw) return null
  const stored = parseJsonWithoutDuplicateMembers(raw)
  const object = assertClosedObject(stored, new Set(['request', 'persistedAt']), 'INVALID_STORED_REQUEST')
  if (!Number.isSafeInteger(object.persistedAt)) throw new ExternalSignError('INVALID_STORED_REQUEST')
  return parseExternalSignRequestObject(object.request, now)
}
