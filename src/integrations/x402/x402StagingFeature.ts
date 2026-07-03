import type { UseTrustedX402ClientOptions } from './useTrustedX402Client'

export const X402_STAGING_PATH = '/v1/x402/authorization-test'
export const X402_STAGING_MAX_PAYMENT_SATS = 100n

export const X402_STAGING_ALLOWLIST = Object.freeze([
  Object.freeze({
    method: 'GET',
    path: X402_STAGING_PATH,
    match: 'exact'
  })
]) satisfies UseTrustedX402ClientOptions['allowlist']

export const isX402StagingTestEnabled = (
  value: unknown = import.meta.env.VITE_X402_STAGING_TEST
) => String(value).trim().toLowerCase() === 'true'

export const X402_STAGING_TEST_ENABLED = isX402StagingTestEnabled()
