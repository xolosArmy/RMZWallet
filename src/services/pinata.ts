const PINATA_PROXY_URL = '/api/pinata/upload'
const PINATA_TIMEOUT_MS = 20_000

type PinataProxyPayload = {
  cid?: string
  error?: string
  code?: string
}

const fetchWithTimeout = async (input: RequestInfo, init?: RequestInit) => {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), PINATA_TIMEOUT_MS)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('La subida a Pinata tardó demasiado. Intenta de nuevo.')
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

const parseProxyResponse = async (response: Response): Promise<{ cid: string }> => {
  const payload = (await response.json().catch(() => null)) as PinataProxyPayload | null
  if (!response.ok) {
    throw new Error(payload?.error || 'No pudimos subir el contenido a Pinata.')
  }
  if (!payload?.cid) {
    throw new Error(payload?.error || 'El endpoint interno no devolvió un CID válido.')
  }
  return { cid: payload.cid }
}

export const uploadFileToPinata = async (file: File): Promise<{ cid: string }> => {
  if (!file) {
    throw new Error('Selecciona un archivo válido para subir a IPFS.')
  }

  const formData = new FormData()
  formData.append('file', file)

  const response = await fetchWithTimeout(PINATA_PROXY_URL, {
    method: 'POST',
    body: formData
  })

  return parseProxyResponse(response)
}

export const uploadJsonToPinata = async (json: unknown | string): Promise<{ cid: string }> => {
  const response = await fetchWithTimeout(PINATA_PROXY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: typeof json === 'string' ? json : JSON.stringify(json)
  })

  return parseProxyResponse(response)
}
