const PINATA_TIMEOUT_MS = 20_000
const PINATA_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS'
const PINATA_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS'

type JsonRecord = Record<string, unknown>

const resolveAuthHeaders = (): HeadersInit => {
  const jwt = process.env.PINATA_JWT
  if (jwt) {
    return { Authorization: `Bearer ${jwt}` }
  }

  const apiKey = process.env.PINATA_API_KEY
  const apiSecret = process.env.PINATA_SECRET
  if (apiKey && apiSecret) {
    return {
      pinata_api_key: apiKey,
      pinata_secret_api_key: apiSecret
    }
  }

  throw new Error('Pinata no está configurado en el entorno serverless.')
}

const json = (status: number, body: JsonRecord) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  })

const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PINATA_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

const parsePinataResponse = async (response: Response) => {
  if (response.ok) {
    return response.json() as Promise<{ IpfsHash?: string }>
  }

  if (response.status === 401) {
    throw new Error('Pinata rechazó la autenticación.')
  }
  if (response.status === 413) {
    throw new Error('El archivo es demasiado grande para Pinata.')
  }

  const message = await response.text()
  throw new Error(message || 'No pudimos subir el contenido a Pinata.')
}

export const proxyPinataUpload = async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  try {
    const contentType = request.headers.get('content-type') || ''

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData()
      const response = await fetchWithTimeout(PINATA_FILE_URL, {
        method: 'POST',
        headers: resolveAuthHeaders(),
        body: formData
      })
      const data = await parsePinataResponse(response)
      if (!data.IpfsHash) {
        throw new Error('Pinata no devolvió un CID válido.')
      }
      return json(200, { cid: data.IpfsHash })
    }

    const rawBody = await request.text()
    const response = await fetchWithTimeout(PINATA_JSON_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...resolveAuthHeaders()
      },
      body: rawBody
    })
    const data = await parsePinataResponse(response)
    if (!data.IpfsHash) {
      throw new Error('Pinata no devolvió un CID válido.')
    }
    return json(200, { cid: data.IpfsHash })
  } catch (err) {
    return json(500, {
      error: (err as Error).message || 'No pudimos procesar la subida a Pinata.'
    })
  }
}
