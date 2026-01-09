const PINATA_BASE_URL = 'https://api.pinata.cloud/pinning'
const PINATA_TIMEOUT_MS = 20000

const resolveAuthHeaders = (): Record<string, string> => {
  const jwt = import.meta.env.VITE_PINATA_JWT
  if (jwt) {
    return { Authorization: `Bearer ${jwt}` }
  }
  const apiKey = import.meta.env.VITE_PINATA_API_KEY
  const apiSecret = import.meta.env.VITE_PINATA_SECRET
  if (apiKey && apiSecret) {
    return {
      pinata_api_key: apiKey,
      pinata_secret_api_key: apiSecret
    }
  }
  throw new Error('Pinata no está configurado. Agrega VITE_PINATA_JWT o VITE_PINATA_API_KEY/VITE_PINATA_SECRET.')
}

const fetchWithTimeout = async (input: RequestInfo, init?: RequestInit) => {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), PINATA_TIMEOUT_MS)
  try {
    const response = await fetch(input, { ...init, signal: controller.signal })
    return response
  } finally {
    window.clearTimeout(timeout)
  }
}

const parsePinataResponse = async (response: Response) => {
  if (response.ok) {
    return response.json()
  }
  if (response.status === 401) {
    throw new Error('Pinata rechazó la autenticación. Revisa tu JWT o API keys.')
  }
  if (response.status === 413) {
    throw new Error('El archivo es demasiado grande para Pinata.')
  }
  const message = await response.text()
  throw new Error(message || 'No pudimos subir el archivo a Pinata.')
}

export const uploadFileToPinata = async (file: File): Promise<{ cid: string }> => {
  if (!file) {
    throw new Error('Selecciona un archivo válido para subir a IPFS.')
  }
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetchWithTimeout(`${PINATA_BASE_URL}/pinFileToIPFS`, {
    method: 'POST',
    headers: resolveAuthHeaders(),
    body: formData
  })

  const data = await parsePinataResponse(response)
  if (!data?.IpfsHash) {
    throw new Error('Pinata no devolvió un CID válido.')
  }
  return { cid: data.IpfsHash }
}

export const uploadJsonToPinata = async (json: unknown): Promise<{ cid: string }> => {
  const response = await fetchWithTimeout(`${PINATA_BASE_URL}/pinJSONToIPFS`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...resolveAuthHeaders()
    },
    body: JSON.stringify(json)
  })

  const data = await parsePinataResponse(response)
  if (!data?.IpfsHash) {
    throw new Error('Pinata no devolvió un CID válido.')
  }
  return { cid: data.IpfsHash }
}
