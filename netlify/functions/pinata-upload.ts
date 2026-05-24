import { proxyPinataUpload } from '../../server/pinataProxy'

type NetlifyEvent = {
  httpMethod: string
  headers?: Record<string, string | undefined>
  body?: string | null
  isBase64Encoded?: boolean
  rawUrl?: string
}

type NetlifyResponse = {
  statusCode: number
  headers?: Record<string, string>
  body: string
}

const toRequest = (event: NetlifyEvent): Request => {
  const body = event.body
    ? event.isBase64Encoded
      ? Uint8Array.from(Buffer.from(event.body, 'base64'))
      : event.body
    : undefined

  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).filter((entry): entry is [string, string] => Boolean(entry[1])))

  return new Request(event.rawUrl || 'http://localhost/.netlify/functions/pinata-upload', {
    method: event.httpMethod,
    headers,
    body
  })
}

export async function handler(event: NetlifyEvent): Promise<NetlifyResponse> {
  const response = await proxyPinataUpload(toRequest(event))
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })

  return {
    statusCode: response.status,
    headers,
    body: await response.text()
  }
}
