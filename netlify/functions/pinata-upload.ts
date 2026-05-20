import { handlePinataUpload } from '../../server/pinataProxy'

type NetlifyEvent = {
  body: string | null
  headers: Record<string, string | undefined>
  httpMethod: string
  isBase64Encoded: boolean
  rawUrl?: string
}

type NetlifyResult = {
  body: string
  headers?: Record<string, string>
  isBase64Encoded?: boolean
  statusCode: number
}

const toRequest = (event: NetlifyEvent) => {
  const body =
    event.body == null
      ? undefined
      : event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : event.body

  return new Request(event.rawUrl ?? 'http://localhost/.netlify/functions/pinata-upload', {
    method: event.httpMethod,
    headers: event.headers,
    body
  })
}

const toResult = async (response: Response): Promise<NetlifyResult> => ({
  statusCode: response.status,
  headers: Object.fromEntries(response.headers.entries()),
  body: await response.text()
})

export const handler = async (event: NetlifyEvent): Promise<NetlifyResult> => {
  const request = toRequest(event)
  const response = await handlePinataUpload(request)
  return toResult(response)
}
