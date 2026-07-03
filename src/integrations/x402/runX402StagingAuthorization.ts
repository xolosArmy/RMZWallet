import { X402_STAGING_PATH } from './x402StagingFeature'
import {
  parseX402StagingResponse,
  type X402StagingResponse
} from './X402StagingResponse'

type StagingResponse = Readonly<{
  status: number
  data: unknown
}>

export type X402StagingHttpClient = Readonly<{
  get: (
    path: string,
    config: Readonly<{ signal: AbortSignal }>
  ) => Promise<StagingResponse>
}>

const STAGING_REQUEST_FAILED = 'X402 staging authorization failed'

export const runX402StagingAuthorization = async (
  client: X402StagingHttpClient | null,
  signal: AbortSignal
): Promise<X402StagingResponse> => {
  if (client === null) throw new Error(STAGING_REQUEST_FAILED)

  const response = await client.get(X402_STAGING_PATH, { signal })
  if (response.status !== 200) throw new Error(STAGING_REQUEST_FAILED)

  const boundedResult = parseX402StagingResponse(response.data)
  if (boundedResult === null) throw new Error(STAGING_REQUEST_FAILED)
  return boundedResult
}
