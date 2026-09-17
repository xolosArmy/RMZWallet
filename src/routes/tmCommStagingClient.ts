import { TM_COMM_STAGING_API_PREFIX } from '../config/tmCommStaging'

export type TmCommClientResponse<T> = Readonly<{
  ok: boolean
  status: number
  data: T
}>

export async function tmCommRequest<T>(
  path: string,
  init: RequestInit = {}
): Promise<TmCommClientResponse<T>> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${TM_COMM_STAGING_API_PREFIX}${path}`, {
    ...init,
    credentials: 'include',
    headers
  })
  const data = await response.json() as T
  return { ok: response.ok, status: response.status, data }
}
