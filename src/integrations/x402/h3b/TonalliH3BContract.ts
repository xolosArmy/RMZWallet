export const H3B_SOURCE_ORIGIN = 'https://x402.ecash.mx'
export const H3B_RETURN_URL = 'https://x402.ecash.mx/experiments/webmcp/'
export const H3B_RESOURCE_URL = 'https://api.x402.ecash.mx/v1/resource/demo'
export const H3B_PAY_TO = 'ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w'
export const H3B_MAX_REQUEST_BASE64URL_LENGTH = 16_384

export type H3BPaymentRequired = Readonly<{
  x402Version: 2
  error: 'PAYMENT-SIGNATURE header is required'
  resource: Readonly<{
    url: typeof H3B_RESOURCE_URL
    description: 'x402eCash WebMCP Challenge demo resource'
    mimeType: 'application/json'
    serviceName: 'x402eCash'
  }>
  accepts: readonly [Readonly<{
    scheme: 'xec-prepaid-utxo'
    network: 'xec:mainnet'
    amount: '10000'
    asset: 'XEC'
    payTo: typeof H3B_PAY_TO
    maxTimeoutSeconds: 60
    extra: Readonly<{
      displayAmount: '100 XEC'
      experimental: true
      gate: 'H2A'
    }>
  }>]
  extensions: Readonly<Record<string, never>>
}>

export type TonalliH3BRequest = Readonly<{
  type: 'x402ecash-h3b-request'
  version: 1
  targetGate: 'H3B'
  sourceOrigin: typeof H3B_SOURCE_ORIGIN
  returnUrl: typeof H3B_RETURN_URL
  challengeId: string
  issuedAt: number
  expiresAt: number
  paymentRequired: H3BPaymentRequired
  approval: Readonly<{
    status: 'payment_approved'
    gate: 'H3A'
    approved: true
    performed: false
  }>
}>

export class H3BRequestValidationError extends Error {
  constructor() {
    super('H3B_REQUEST_INVALID')
    this.name = 'H3BRequestValidationError'
  }
}

const fail = (): never => {
  throw new H3BRequestValidationError()
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) return fail()
  return value
}

const requireExactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  if (
    actual.length !== canonicalExpected.length ||
    actual.some((key, index) => key !== canonicalExpected[index])
  ) {
    fail()
  }
}

const encodeBase64UrlBytes = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '')
}

export const decodeCanonicalBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) fail()

  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  let binary = ''
  try {
    binary = atob(padded)
  } catch {
    return fail()
  }

  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64UrlBytes(bytes) !== value) fail()
  return bytes
}

export const encodeCanonicalBase64Url = (value: unknown): string => (
  encodeBase64UrlBytes(new TextEncoder().encode(canonicalizeJson(value)))
)

export const canonicalizeJson = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('H3B_CANONICAL_JSON_INVALID')
    return Object.is(value, -0) ? '0' : JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`
    )).join(',')}}`
  }
  throw new TypeError('H3B_CANONICAL_JSON_INVALID')
}

const requireLiteral = <T extends string | number | boolean>(
  value: unknown,
  expected: T
): T => {
  if (value !== expected) fail()
  return expected
}

const validatePaymentRequired = (value: unknown): H3BPaymentRequired => {
  const paymentRequired = requireRecord(value)
  requireExactKeys(paymentRequired, ['x402Version', 'error', 'resource', 'accepts', 'extensions'])
  requireLiteral(paymentRequired.x402Version, 2)
  requireLiteral(paymentRequired.error, 'PAYMENT-SIGNATURE header is required')

  const resource = requireRecord(paymentRequired.resource)
  requireExactKeys(resource, ['url', 'description', 'mimeType', 'serviceName'])
  requireLiteral(resource.url, H3B_RESOURCE_URL)
  requireLiteral(resource.description, 'x402eCash WebMCP Challenge demo resource')
  requireLiteral(resource.mimeType, 'application/json')
  requireLiteral(resource.serviceName, 'x402eCash')

  const accepts = paymentRequired.accepts
  if (!Array.isArray(accepts) || accepts.length !== 1) return fail()
  const acceptance = requireRecord(accepts[0])
  requireExactKeys(acceptance, [
    'scheme',
    'network',
    'amount',
    'asset',
    'payTo',
    'maxTimeoutSeconds',
    'extra'
  ])
  requireLiteral(acceptance.scheme, 'xec-prepaid-utxo')
  requireLiteral(acceptance.network, 'xec:mainnet')
  requireLiteral(acceptance.amount, '10000')
  requireLiteral(acceptance.asset, 'XEC')
  requireLiteral(acceptance.payTo, H3B_PAY_TO)
  requireLiteral(acceptance.maxTimeoutSeconds, 60)

  const extra = requireRecord(acceptance.extra)
  requireExactKeys(extra, ['displayAmount', 'experimental', 'gate'])
  requireLiteral(extra.displayAmount, '100 XEC')
  requireLiteral(extra.experimental, true)
  requireLiteral(extra.gate, 'H2A')

  const extensions = requireRecord(paymentRequired.extensions)
  requireExactKeys(extensions, [])
  return paymentRequired as H3BPaymentRequired
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

const parseRequestValue = (encoded: string, nowSeconds: number): TonalliH3BRequest => {
  if (encoded.length > H3B_MAX_REQUEST_BASE64URL_LENGTH) fail()
  let decoded = ''
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(decodeCanonicalBase64Url(encoded))
  } catch {
    return fail()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    fail()
  }

  const request = requireRecord(parsed)
  requireExactKeys(request, [
    'type',
    'version',
    'targetGate',
    'sourceOrigin',
    'returnUrl',
    'challengeId',
    'issuedAt',
    'expiresAt',
    'paymentRequired',
    'approval'
  ])
  requireLiteral(request.type, 'x402ecash-h3b-request')
  requireLiteral(request.version, 1)
  requireLiteral(request.targetGate, 'H3B')
  requireLiteral(request.sourceOrigin, H3B_SOURCE_ORIGIN)
  requireLiteral(request.returnUrl, H3B_RETURN_URL)

  if (
    typeof request.challengeId !== 'string' ||
    request.challengeId.length < 22 ||
    request.challengeId.length > 64 ||
    decodeCanonicalBase64Url(request.challengeId).byteLength < 16
  ) {
    fail()
  }

  if (!Number.isSafeInteger(request.issuedAt) || !Number.isSafeInteger(request.expiresAt)) fail()
  const issuedAt = request.issuedAt as number
  const expiresAt = request.expiresAt as number
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 300 ||
    expiresAt <= nowSeconds ||
    issuedAt > nowSeconds + 60 ||
    nowSeconds - issuedAt > 300
  ) {
    fail()
  }

  validatePaymentRequired(request.paymentRequired)

  const approval = requireRecord(request.approval)
  requireExactKeys(approval, ['status', 'gate', 'approved', 'performed'])
  requireLiteral(approval.status, 'payment_approved')
  requireLiteral(approval.gate, 'H3A')
  requireLiteral(approval.approved, true)
  requireLiteral(approval.performed, false)

  return deepFreeze(request as TonalliH3BRequest)
}

export const parseTonalliH3BRequest = ({
  hash,
  search,
  nowSeconds = Math.floor(Date.now() / 1000)
}: {
  hash: string
  search: string
  nowSeconds?: number
}): TonalliH3BRequest => {
  if (search !== '' || !Number.isSafeInteger(nowSeconds)) fail()
  const match = /^#request=([A-Za-z0-9_-]+)$/u.exec(hash)
  if (!match) return fail()
  return parseRequestValue(match[1], nowSeconds)
}
