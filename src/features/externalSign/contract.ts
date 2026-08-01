export const UNIVERSAL_AUTHORIZATION_SCHEMA = 'tonalli.authorization-envelope'
export const UNIVERSAL_AUTHORIZATION_VERSION = 1

export type UniversalAuthorizationEnvelopeV1 = Readonly<{
  schema: typeof UNIVERSAL_AUTHORIZATION_SCHEMA
  version: typeof UNIVERSAL_AUTHORIZATION_VERSION
  operationId: string
  profileId: string
  issuedAt: number
  expiresAt: number
  requester: Readonly<{
    declaredOrigin: string
    displayName: string
  }>
}>

export class UniversalAuthorizationError extends Error {
  readonly code: string

  constructor(code: string, message = code) {
    super(message)
    this.name = 'UniversalAuthorizationError'
    this.code = code
  }
}

const ROOT_KEYS = new Set([
  'schema',
  'version',
  'operationId',
  'profileId',
  'issuedAt',
  'expiresAt',
  'requester'
])
const REQUESTER_KEYS = new Set(['declaredOrigin', 'displayName'])
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/

const parseJsonWithoutDuplicateMembers = (input: string): unknown => {
  let index = 0
  const fail = (code: string): never => { throw new UniversalAuthorizationError(code) }
  const skipWhitespace = () => {
    while (' \t\r\n'.includes(input[index] ?? '\0')) index += 1
  }
  const parseString = (): string => {
    if (input[index] !== '"') fail('INVALID_JSON')
    const start = index
    index += 1
    while (index < input.length) {
      const character = input[index]
      if (character === '"') {
        index += 1
        try {
          return JSON.parse(input.slice(start, index)) as string
        } catch {
          return fail('INVALID_JSON')
        }
      }
      if (character === '\\') index += 2
      else {
        if ((character?.charCodeAt(0) ?? 0) < 0x20) fail('INVALID_JSON')
        index += 1
      }
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
  const parseValue = (): unknown => {
    skipWhitespace()
    const character = input[index]
    if (character === '"') return parseString()
    if (character === '{') return parseObject()
    if (character === '[') return parseArray()
    const remainder = input.slice(index)
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (remainder.startsWith(literal)) {
        index += literal.length
        return value
      }
    }
    const number = remainder.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/)
    if (!number) return fail('INVALID_JSON')
    index += number[0].length
    const value = Number(number[0])
    if (!Number.isFinite(value)) return fail('INVALID_JSON')
    return value
  }
  const parsed = parseValue()
  skipWhitespace()
  if (index !== input.length) fail('INVALID_JSON')
  return parsed
}

const assertClosedObject = (
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  code: string
): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UniversalAuthorizationError(code)
  }
  const object = value as Record<string, unknown>
  const unknownKey = Object.keys(object).find(key => !allowedKeys.has(key))
  if (unknownKey) throw new UniversalAuthorizationError('UNKNOWN_ENVELOPE_FIELD', unknownKey)
  return object
}

const normalizedText = (value: unknown, code: string, maximumBytes: number): string => {
  if (typeof value !== 'string') throw new UniversalAuthorizationError(code)
  const normalized = value.normalize('NFC')
  const bytes = new TextEncoder().encode(normalized)
  if (bytes.length === 0 || bytes.length > maximumBytes) throw new UniversalAuthorizationError(code)
  if (Array.from(normalized).some(character => {
    const point = character.codePointAt(0) ?? 0
    return point <= 0x1f || point === 0x7f
  })) throw new UniversalAuthorizationError(code)
  return normalized
}

const normalizedDeclaredOrigin = (value: unknown): string => {
  const normalized = normalizedText(value, 'INVALID_DECLARED_ORIGIN', 2048)
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new UniversalAuthorizationError('INVALID_DECLARED_ORIGIN')
  }
  const localHttp = parsed.protocol === 'http:' && (
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
  )
  if (parsed.origin !== normalized || (parsed.protocol !== 'https:' && !localHttp)) {
    throw new UniversalAuthorizationError('INVALID_DECLARED_ORIGIN')
  }
  return parsed.origin
}

export function parseUniversalAuthorizationEnvelopeJson(
  input: string,
  now = Date.now()
): UniversalAuthorizationEnvelopeV1 {
  return parseUniversalAuthorizationEnvelope(parseJsonWithoutDuplicateMembers(input), now)
}

export function parseUniversalAuthorizationEnvelope(
  value: unknown,
  now = Date.now()
): UniversalAuthorizationEnvelopeV1 {
  const root = assertClosedObject(value, ROOT_KEYS, 'INVALID_ENVELOPE')
  const requester = assertClosedObject(root.requester, REQUESTER_KEYS, 'INVALID_REQUESTER')
  const operationId = normalizedText(root.operationId, 'INVALID_OPERATION_ID', 128)
  const profileId = normalizedText(root.profileId, 'INVALID_PROFILE_ID', 128)
  if (!OPERATION_ID.test(operationId)) throw new UniversalAuthorizationError('INVALID_OPERATION_ID')
  if (!PROFILE_ID.test(profileId)) throw new UniversalAuthorizationError('INVALID_PROFILE_ID')
  if (!Number.isSafeInteger(root.issuedAt) || !Number.isSafeInteger(root.expiresAt)) {
    throw new UniversalAuthorizationError('INVALID_LIFETIME')
  }
  const issuedAt = root.issuedAt as number
  const expiresAt = root.expiresAt as number
  if (issuedAt > now || expiresAt <= issuedAt || expiresAt <= now) {
    throw new UniversalAuthorizationError('REQUEST_EXPIRED_OR_NOT_YET_VALID')
  }
  if (root.schema !== UNIVERSAL_AUTHORIZATION_SCHEMA || root.version !== UNIVERSAL_AUTHORIZATION_VERSION) {
    throw new UniversalAuthorizationError('UNSUPPORTED_ENVELOPE')
  }
  return Object.freeze({
    schema: UNIVERSAL_AUTHORIZATION_SCHEMA,
    version: UNIVERSAL_AUTHORIZATION_VERSION,
    operationId,
    profileId,
    issuedAt,
    expiresAt,
    requester: Object.freeze({
      declaredOrigin: normalizedDeclaredOrigin(requester.declaredOrigin),
      displayName: normalizedText(requester.displayName, 'INVALID_REQUESTER_NAME', 256)
    })
  })
}
