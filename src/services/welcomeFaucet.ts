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
  starterPack: WelcomeStarterPack
}>

const configuredBaseUrl = String(import.meta.env.VITE_TONALLI_FAUCET_URL ?? '').trim().replace(/\/$/, '')

function endpoint(path: string): string {
  if (!configuredBaseUrl) {
    throw new Error('WELCOME_FAUCET_NOT_CONFIGURED')
  }
  return `${configuredBaseUrl}/v1/faucet${path}`
}

async function parseResponse(response: Response): Promise<WelcomeClaimResponse> {
  let body: WelcomeClaimResponse
  try {
    body = await response.json() as WelcomeClaimResponse
  } catch {
    throw new Error('WELCOME_FAUCET_INVALID_RESPONSE')
  }
  if (!response.ok && response.status !== 202) {
    throw new Error(body.error || 'WELCOME_FAUCET_UNAVAILABLE')
  }
  return body
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
