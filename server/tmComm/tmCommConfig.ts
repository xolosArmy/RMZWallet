import { isAbsolute, resolve } from 'node:path'

export const TM_COMM_COOKIE_NAME = 'tm_comm_a0_session'
export const TM_COMM_SESSION_CONTEXT = 'tm-comm-a0-staging:v1'
export const TM_COMM_DEFAULT_HOST = '127.0.0.1'
export const TM_COMM_DEFAULT_PORT = 4178
export const TM_COMM_DEFAULT_ORIGIN = 'http://127.0.0.1:5174'
export const TM_COMM_CHALLENGE_TTL_MS = 5 * 60 * 1000
export const TM_COMM_SESSION_TTL_MS = 8 * 60 * 60 * 1000
export const TM_COMM_ENROLLMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const TM_COMM_MAX_BODY_BYTES = 32 * 1024

export type TmCommRuntimeConfig = Readonly<{
  environment: 'staging'
  listenHost: string
  listenPort: number
  databasePath: string
  expectedOrigin: string
  sessionContext: string
  sessionTtlMs: number
  challengeTtlMs: number
  enrollmentTtlMs: number
  cookieName: string
  cookieSecure: boolean
}>

const forbiddenPathFragments = ['production', 'prod-data', 'mainnet-secrets']

export function assertTmCommStagingPath(databasePath: string): string {
  const resolved = isAbsolute(databasePath) ? databasePath : resolve(databasePath)
  const normalized = resolved.toLowerCase()
  for (const fragment of forbiddenPathFragments) {
    if (normalized.includes(fragment)) {
      throw new Error('TM-COMM refuses database paths that look like production.')
    }
  }
  if (process.env.TM_COMM_ENVIRONMENT === 'production') {
    throw new Error('TM-COMM A0 must not start in production.')
  }
  return resolved
}

export function loadTmCommRuntimeConfig(
  overrides: Partial<TmCommRuntimeConfig> = {}
): TmCommRuntimeConfig {
  const listenPort = overrides.listenPort ??
    Number.parseInt(process.env.TM_COMM_LISTEN_PORT ?? String(TM_COMM_DEFAULT_PORT), 10)
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new Error('TM_COMM_LISTEN_PORT is invalid.')
  }

  const databasePath = assertTmCommStagingPath(
    overrides.databasePath ??
      process.env.TM_COMM_DATABASE_PATH ??
      resolve('.tmp/tm-comm-staging/tm-comm-a0.sqlite')
  )

  return Object.freeze({
    environment: 'staging',
    listenHost: overrides.listenHost ?? process.env.TM_COMM_LISTEN_HOST ?? TM_COMM_DEFAULT_HOST,
    listenPort,
    databasePath,
    expectedOrigin: overrides.expectedOrigin ??
      process.env.TM_COMM_EXPECTED_ORIGIN ??
      TM_COMM_DEFAULT_ORIGIN,
    sessionContext: overrides.sessionContext ?? TM_COMM_SESSION_CONTEXT,
    sessionTtlMs: overrides.sessionTtlMs ?? TM_COMM_SESSION_TTL_MS,
    challengeTtlMs: overrides.challengeTtlMs ?? TM_COMM_CHALLENGE_TTL_MS,
    enrollmentTtlMs: overrides.enrollmentTtlMs ?? TM_COMM_ENROLLMENT_TTL_MS,
    cookieName: overrides.cookieName ?? TM_COMM_COOKIE_NAME,
    cookieSecure: overrides.cookieSecure ?? process.env.TM_COMM_COOKIE_SECURE === 'true'
  })
}
