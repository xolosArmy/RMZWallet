export const TONALLI_PENDING_REQUEST_KEY = 'tonalli_pending_req_v1'

export type PendingConnectRequest = {
  path: '/connect' | '/connect/sign-message'
  search: string
}

export const storePendingConnectRequest = (pending: PendingConnectRequest) => {
  localStorage.setItem(TONALLI_PENDING_REQUEST_KEY, JSON.stringify(pending))
}

export const resolvePendingConnectTarget = (raw: string) => {
  if (raw.startsWith('?')) {
    return `/connect${raw}`
  }

  try {
    const parsed = JSON.parse(raw) as { path?: string; search?: string }
    const path = parsed.path === '/connect/sign-message' ? '/connect/sign-message' : '/connect'
    const search = typeof parsed.search === 'string' ? parsed.search : ''
    return `${path}${search}`
  } catch {
    return '/connect'
  }
}
