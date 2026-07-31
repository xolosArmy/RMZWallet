export const EXTERNAL_SIGN_PROTOCOL_ID = 'tonalli.external-sign' as const
export const EXTERNAL_SIGN_PROTOCOL_VERSION = 1 as const
export const EXTERNAL_SIGN_CHAIN_ID = 'ecash:1' as const
export const EXTERNAL_SIGN_MODE = 'signOnly' as const

export const EXTERNAL_SIGN_MAX_REQUEST_TTL_MS = 300_000
export const EXTERNAL_SIGN_APPROVAL_TTL_MS = 30_000
export const EXTERNAL_SIGN_MAX_TX_BYTES = 100_000
export const EXTERNAL_SIGN_MAX_OUTPUTS = 10
export const EXTERNAL_SIGN_MIN_FEE_RATE_SATS_PER_BYTE = 1n
export const EXTERNAL_SIGN_MAX_FEE_RATE_SATS_PER_BYTE = 10n
export const EXTERNAL_SIGN_MAX_ABSOLUTE_FEE_SATS = 10_000n

type ExternalSignEnv = Record<string, string | boolean | undefined>

const canonicalHttpsOrigin = (value: string): string | null => {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.origin !== value) return null
    return parsed.origin
  } catch {
    return null
  }
}

export type ExternalSignConfig = Readonly<{
  enabled: boolean
  allowedOrigins: readonly string[]
  policyReady: boolean
}>

export function resolveExternalSignConfig(env: ExternalSignEnv): ExternalSignConfig {
  const enabled = env.VITE_EXTERNAL_SIGN_P0_ENABLED === 'true'
  const rawAllowlist = typeof env.VITE_EXTERNAL_SIGN_ALLOWED_ORIGINS === 'string'
    ? env.VITE_EXTERNAL_SIGN_ALLOWED_ORIGINS
    : ''
  const configured = rawAllowlist.split(',').map(value => value.trim()).filter(Boolean)
  const allowedOrigins = configured.map(canonicalHttpsOrigin).filter((value): value is string => value !== null)
  const policyReady = configured.length > 0 && configured.length === allowedOrigins.length

  return Object.freeze({
    enabled,
    allowedOrigins: Object.freeze([...new Set(allowedOrigins)]),
    policyReady
  })
}

const viteEnv = (import.meta as unknown as { env?: ExternalSignEnv }).env ?? {}

export const EXTERNAL_SIGN_CONFIG = resolveExternalSignConfig(viteEnv)
export const EXTERNAL_SIGN_P0_ENABLED = EXTERNAL_SIGN_CONFIG.enabled && EXTERNAL_SIGN_CONFIG.policyReady
