const PINATA_UPLOAD_URL = '/api/pinata/upload'
const PINATA_TIMEOUT_MS = 20000

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
  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '')

  if (response.ok) {
    return payload
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error('El backend rechazó la subida a IPFS. Revisa la configuración del servidor.')
  }
  if (response.status === 413) {
    throw new Error('El archivo es demasiado grande para Pinata.')
  }
  const message =
    typeof payload === 'string'
      ? payload
      : payload && typeof payload === 'object'
      ? String(
          (payload as { error?: unknown; message?: unknown }).error ??
            (payload as { error?: unknown; message?: unknown }).message ??
            ''
        )
      : ''
  throw new Error(message || 'No pudimos subir el archivo a Pinata.')
}

export const uploadFileToPinata = async (file: File): Promise<{ cid: string }> => {
  if (!file) {
    throw new Error('Selecciona un archivo válido para subir a IPFS.')
  }
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetchWithTimeout(PINATA_UPLOAD_URL, {
    method: 'POST',
    body: formData
  })

  const data = await parsePinataResponse(response)
  if (!data?.IpfsHash) {
    throw new Error('Pinata no devolvió un CID válido.')
  }
  return { cid: data.IpfsHash }
}

export const uploadJsonToPinata = async (json: unknown | string): Promise<{ cid: string }> => {
  const response = await fetchWithTimeout(PINATA_UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: typeof json === 'string' ? json : JSON.stringify(json)
  })

  const data = await parsePinataResponse(response)
  if (!data?.IpfsHash) {
    throw new Error('Pinata no devolvió un CID válido.')
  }
  return { cid: data.IpfsHash }
}
