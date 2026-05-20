const PINATA_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS'
const PINATA_JSON_URL = 'https://api.pinata.cloud/pinning/pinJSONToIPFS'

const jsonResponse = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    }
  })

const textResponse = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8'
    }
  })

const resolvePinataUrl = (contentType: string) => {
  if (contentType.includes('multipart/form-data')) {
    return PINATA_FILE_URL
  }
  if (contentType.includes('application/json')) {
    return PINATA_JSON_URL
  }
  return null
}

export const handlePinataUpload = async (
  request: Request,
  pinataJwt = process.env.PINATA_JWT
): Promise<Response> => {
  if (request.method !== 'POST') {
    return textResponse(405, 'Method Not Allowed')
  }

  if (!pinataJwt) {
    return textResponse(500, 'PINATA_JWT is not configured on the server.')
  }

  const contentType = request.headers.get('content-type') || ''
  const pinataUrl = resolvePinataUrl(contentType)

  if (!pinataUrl) {
    return textResponse(415, 'Unsupported content type. Use multipart/form-data or application/json.')
  }

  const body = await request.arrayBuffer()
  if (body.byteLength === 0) {
    return textResponse(400, 'Request body is required.')
  }

  const upstream = await fetch(pinataUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pinataJwt}`,
      'Content-Type': contentType
    },
    body
  })

  const upstreamContentType = upstream.headers.get('content-type') || ''
  if (!upstream.ok) {
    const errorMessage = upstreamContentType.includes('application/json')
      ? await upstream
          .json()
          .then((payload) =>
            typeof payload === 'object' && payload !== null
              ? String(
                  (payload as { error?: unknown; message?: unknown }).error ??
                    (payload as { error?: unknown; message?: unknown }).message ??
                    ''
                )
              : ''
          )
          .catch(() => '')
      : await upstream.text().catch(() => '')

    return textResponse(upstream.status, errorMessage || 'Pinata request failed.')
  }

  const payload = (await upstream.json().catch(() => null)) as { IpfsHash?: string } | null
  if (!payload?.IpfsHash) {
    return jsonResponse(502, { error: 'Pinata did not return a valid IpfsHash.' })
  }

  return jsonResponse(200, { IpfsHash: payload.IpfsHash })
}
