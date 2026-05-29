export const config = {
  runtime: 'edge'
}

const PINATA_TIMEOUT_MS = 20_000
const PINATA_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS'
const PINATA_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS'

type JsonRecord = Record<string, unknown>

type PinataSuccess = {
  IpfsHash?: string
  [key: string]: unknown
}

class HttpError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

const json = (status: number, body: JsonRecord, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  })

const getEnv = (key: string) => {
  try {
    return process.env[key]
  } catch {
    return undefined
  }
}

const resolveAuthHeaders = (): HeadersInit => {
  const jwt = getEnv('PINATA_JWT') || getEnv('VITE_PINATA_JWT')
  if (jwt) {
    return { Authorization: `Bearer ${jwt}` }
  }

  const apiKey = getEnv('PINATA_API_KEY')
  const apiSecret = getEnv('PINATA_SECRET')
  if (apiKey && apiSecret) {
    return {
      pinata_api_key: apiKey,
      pinata_secret_api_key: apiSecret
    }
  }

  throw new HttpError(
    500,
    'PINATA_CONFIG_MISSING',
    'Falta configurar Pinata. Define PINATA_JWT o VITE_PINATA_JWT en Vercel.'
  )
}

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PINATA_TIMEOUT_MS)

  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new HttpError(504, 'PINATA_TIMEOUT', 'Pinata tardó demasiado en responder. Intenta de nuevo.')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

const readPinataError = async (response: Response) => {
  const contentType = response.headers.get('content-type') || ''

  if (contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => null)) as JsonRecord | null
    const message = payload?.error || payload?.message || payload?.Message
    if (typeof message === 'string' && message.trim()) {
      return message
    }
  }

  const text = await response.text().catch(() => '')
  return text.trim()
}

const parsePinataResponse = async (response: Response): Promise<PinataSuccess> => {
  if (response.ok) {
    const payload = (await response.json().catch(() => null)) as PinataSuccess | null
    if (!payload?.IpfsHash) {
      throw new HttpError(502, 'PINATA_CID_MISSING', 'Pinata respondió correctamente, pero no devolvió un CID.')
    }
    return payload
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, 'PINATA_AUTH_REJECTED', 'Pinata rechazó la autenticación. Revisa PINATA_JWT en Vercel.')
  }

  if (response.status === 413) {
    throw new HttpError(413, 'PINATA_FILE_TOO_LARGE', 'El archivo es demasiado grande para subirlo a Pinata.')
  }

  const detail = await readPinataError(response)
  throw new HttpError(
    response.status || 502,
    'PINATA_UPLOAD_FAILED',
    detail ? `Pinata rechazó la subida: ${detail}` : 'No pudimos subir el contenido a Pinata.'
  )
}

const uploadFile = async (request: Request) => {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    throw new HttpError(400, 'INVALID_MULTIPART', 'El formulario multipart no es válido.')
  }

  if (!formData.has('file')) {
    throw new HttpError(400, 'FILE_MISSING', 'No se recibió ningún archivo para subir a Pinata.')
  }

  const response = await fetchWithTimeout(PINATA_FILE_URL, {
    method: 'POST',
    headers: resolveAuthHeaders(),
    body: formData
  })

  const payload = await parsePinataResponse(response)
  return json(200, { cid: payload.IpfsHash })
}

const uploadJson = async (request: Request) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'El cuerpo de la petición no es JSON válido.')
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'INVALID_JSON', 'La metadata debe ser un objeto JSON.')
  }

  const response = await fetchWithTimeout(PINATA_JSON_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...resolveAuthHeaders()
    },
    body: JSON.stringify(body)
  })

  const payload = await parsePinataResponse(response)
  return json(200, { cid: payload.IpfsHash })
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return json(405, { error: 'Método no permitido. Usa POST.', code: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' })
  }

  try {
    const contentType = request.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      return await uploadFile(request)
    }

    if (contentType.includes('application/json') || !contentType) {
      return await uploadJson(request)
    }

    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Formato no soportado. Usa multipart/form-data o application/json.')
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: error.message, code: error.code })
    }

    return json(500, {
      error: error instanceof Error ? error.message : 'No pudimos procesar la subida a Pinata.',
      code: 'PINATA_PROXY_ERROR'
    })
  }
}
