const FIRMA_BID_TIMEOUT_MS = 15_000
const FIRMA_BID_UPSTREAM_URL = 'https://stakedxec.com/api/bid'
const FIRMA_BID_UPSTREAM_ORIGIN = new URL(FIRMA_BID_UPSTREAM_URL).origin

type JsonRecord = Record<string, unknown>

type FirmaBidProxyDependencies = Readonly<{
  fetchImpl?: typeof fetch
  timeoutMs?: number
}>

class FirmaBidProxyError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'FirmaBidProxyError'
    this.status = status
    this.code = code
  }
}

const json = (status: number, body: JsonRecord, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  })

const isJsonContentType = (contentType: string | null) => {
  const mediaType = (contentType ?? '').split(';', 1)[0].trim().toLowerCase()
  return mediaType === 'application/json' || (mediaType.startsWith('application/') && mediaType.endsWith('+json'))
}

const invalidPayload = () => new FirmaBidProxyError(
  502,
  'FIRMA_BID_INVALID_PAYLOAD',
  'Firma devolvió un precio de redención inválido.'
)

export const normalizeFirmaBid = (rawBid: unknown): string => {
  if (typeof rawBid !== 'string' && typeof rawBid !== 'number') throw invalidPayload()
  if (typeof rawBid === 'number' && !Number.isFinite(rawBid)) throw invalidPayload()

  const candidate = String(rawBid).trim()
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(candidate)
  if (!match) throw invalidPayload()

  const whole = BigInt(match[1])
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0')
  const satsPerFirma = whole * 100n + fraction
  if (satsPerFirma <= 0n) throw invalidPayload()

  const canonicalWhole = satsPerFirma / 100n
  const canonicalFraction = (satsPerFirma % 100n).toString().padStart(2, '0').replace(/0+$/, '')
  return canonicalFraction ? `${canonicalWhole}.${canonicalFraction}` : canonicalWhole.toString()
}

const fetchFirmaBid = async (dependencies: FirmaBidProxyDependencies): Promise<string> => {
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? FIRMA_BID_TIMEOUT_MS)

  try {
    let response: Response
    try {
      response = await fetchImpl(FIRMA_BID_UPSTREAM_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal
      })
    } catch {
      if (controller.signal.aborted) {
        throw new FirmaBidProxyError(
          504,
          'FIRMA_BID_TIMEOUT',
          'El oráculo de redención de Firma no respondió a tiempo.'
        )
      }
      throw new FirmaBidProxyError(
        502,
        'FIRMA_BID_UPSTREAM_UNAVAILABLE',
        'El oráculo de redención de Firma no está disponible temporalmente.'
      )
    }

    if (response.url && new URL(response.url).origin !== FIRMA_BID_UPSTREAM_ORIGIN) {
      throw new FirmaBidProxyError(
        502,
        'FIRMA_BID_REDIRECT_REJECTED',
        'El oráculo de redención de Firma no está disponible temporalmente.'
      )
    }
    if (!response.ok) {
      throw new FirmaBidProxyError(
        502,
        'FIRMA_BID_UPSTREAM_UNAVAILABLE',
        'El oráculo de redención de Firma no está disponible temporalmente.'
      )
    }
    if (!isJsonContentType(response.headers.get('content-type'))) throw invalidPayload()

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      if (controller.signal.aborted) {
        throw new FirmaBidProxyError(
          504,
          'FIRMA_BID_TIMEOUT',
          'El oráculo de redención de Firma no respondió a tiempo.'
        )
      }
      throw invalidPayload()
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Object.hasOwn(payload, 'bid')) {
      throw invalidPayload()
    }

    return normalizeFirmaBid((payload as { bid?: unknown }).bid)
  } finally {
    clearTimeout(timeout)
  }
}

export const proxyFirmaBid = async (
  request: Request,
  dependencies: FirmaBidProxyDependencies = {}
): Promise<Response> => {
  if (request.method !== 'GET') {
    return json(
      405,
      { error: 'Método no permitido. Usa GET.', code: 'METHOD_NOT_ALLOWED' },
      { Allow: 'GET' }
    )
  }

  try {
    const bid = await fetchFirmaBid(dependencies)
    return json(200, { bid })
  } catch (error) {
    if (error instanceof FirmaBidProxyError) {
      return json(error.status, { error: error.message, code: error.code })
    }

    return json(502, {
      error: 'El oráculo de redención de Firma no está disponible temporalmente.',
      code: 'FIRMA_BID_PROXY_ERROR'
    })
  }
}
