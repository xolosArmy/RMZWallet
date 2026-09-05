export const H3WC_ENABLED_ENV = 'VITE_X402_H3WC_ENABLED' as const
export const H3WC_PROJECT_ID_ENV = 'VITE_X402_H3WC_PROJECT_ID' as const
export const H3WC_REQUESTER_ORIGIN_ENV = 'VITE_X402_H3WC_REQUESTER_ORIGIN' as const

export const H3WC_PRODUCTION_REQUESTER_ORIGIN = 'https://x402.ecash.mx' as const
export const H3WC_PRODUCTION_WALLET_ORIGIN = 'https://app.tonalli.cash' as const

export function isH3wcEnabled(value: unknown = import.meta.env.VITE_X402_H3WC_ENABLED): boolean {
  return String(value).trim().toLowerCase() === 'true'
}

export const H3WC_ENABLED = isH3wcEnabled()

/** No legacy project-ID fallback is permitted. */
export function readH3wcProjectId(value: unknown = import.meta.env.VITE_X402_H3WC_PROJECT_ID): string | null {
  if (typeof value !== 'string') return null
  const projectId = value.trim()
  if (!projectId || /\s/u.test(projectId)) return null
  return projectId
}

/**
 * Production is pinned.  Development must name its exact requester origin;
 * an absent value is a fail-closed configuration error rather than localhost
 * trust or a production fallback.
 */
export function readH3wcRequesterOrigin(
  mode: string = import.meta.env.MODE,
  value: unknown = import.meta.env.VITE_X402_H3WC_REQUESTER_ORIGIN
): string | null {
  if (mode === 'production') return H3WC_PRODUCTION_REQUESTER_ORIGIN
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.trim()
}

