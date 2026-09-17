export type WelcomeClaimStatus =
  | 'available'
  | 'completed'
  | 'already_claimed'
  | 'pending_review'
  | 'retryable'
  | 'rate_limited'
  | 'error'

export type WelcomeStarterPack = Readonly<{
  xecSats: string
  xec: string
}>

export type WelcomeClaimResponse = Readonly<{
  ok: boolean
  status: WelcomeClaimStatus
  address?: string
  starterPack?: WelcomeStarterPack
  txid?: string | null
  dryRun?: boolean
  message?: string
  error?: string
}>

export type WelcomeFaucetConfig = Readonly<{
  ok: boolean
  enabled: boolean
  oneTimePerAddress: boolean
  dryRun: boolean
  turnstileRequired?: boolean
  quickStartCompatible?: boolean
  starterPack: WelcomeStarterPack
}>

export function isWelcomeQuickStartCompatible(config: WelcomeFaucetConfig): boolean {
  if (config.quickStartCompatible === false) return false
  if (config.turnstileRequired === true) return false
  if (!config.enabled) return false
  return true
}

const configuredBaseUrl = String(import.meta.env.VITE_TONALLI_FAUCET_URL ?? '').trim().replace(/\/$/, '')

function endpoint(path: string): string {
  if (!configuredBaseUrl) {
    throw new Error('WELCOME_FAUCET_NOT_CONFIGURED')
  }
  return `${configuredBaseUrl}/v1/faucet${path}`
}

function asClaimStatus(value: unknown): WelcomeClaimStatus | null {
  if (
    value === 'available'
    || value === 'completed'
    || value === 'already_claimed'
    || value === 'pending_review'
    || value === 'retryable'
    || value === 'rate_limited'
    || value === 'error'
  ) {
    return value
  }
  return null
}

async function parseResponse(response: Response): Promise<WelcomeClaimResponse> {
  let body: Partial<WelcomeClaimResponse> = {}
  try {
    body = await response.json() as Partial<WelcomeClaimResponse>
  } catch {
    if (response.status === 429) {
      return { ok: false, status: 'rate_limited', error: 'WELCOME_FAUCET_RATE_LIMITED' }
    }
    throw new Error('WELCOME_FAUCET_INVALID_RESPONSE')
  }

  const status = asClaimStatus(body.status) ?? (
    response.status === 429
      ? 'rate_limited'
      : response.status === 202
        ? 'pending_review'
        : !response.ok
          ? 'error'
          : null
  )
  if (!status) {
    throw new Error(body.error || 'WELCOME_FAUCET_UNAVAILABLE')
  }

  return {
    ok: body.ok === true && (status === 'completed' || status === 'already_claimed' || status === 'available'),
    status,
    address: body.address,
    starterPack: body.starterPack,
    txid: body.txid,
    dryRun: body.dryRun,
    message: body.message,
    error: body.error
  }
}

export function isWelcomeFaucetConfigured(): boolean {
  return configuredBaseUrl.length > 0
}

export async function getWelcomeFaucetConfig(signal?: AbortSignal): Promise<WelcomeFaucetConfig> {
  const response = await fetch(endpoint('/starter-pack/config'), {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal
  })
  if (!response.ok) throw new Error('WELCOME_FAUCET_CONFIG_UNAVAILABLE')
  return await response.json() as WelcomeFaucetConfig
}

export async function getWelcomeClaimStatus(
  address: string,
  signal?: AbortSignal
): Promise<WelcomeClaimResponse> {
  const url = new URL(endpoint('/starter-pack/status'))
  url.searchParams.set('address', address)
  const response = await fetch(url, {
    method: 'GET',
    headers: { accept: 'application/json' },
    signal
  })
  return parseResponse(response)
}

export async function claimWelcomeXec(
  address: string,
  options: { turnstileToken?: string; signal?: AbortSignal } = {}
): Promise<WelcomeClaimResponse> {
  const response = await fetch(endpoint('/starter-pack'), {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      address,
      ...(options.turnstileToken ? { turnstileToken: options.turnstileToken } : {})
    }),
    signal: options.signal
  })
  return parseResponse(response)
}
