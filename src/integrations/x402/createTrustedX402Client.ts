import axios, {
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig
} from 'axios'
import {
  invoiceSchema,
  parseAmountSats,
  XEC_MAINNET,
  XEC_SCHEME
} from '@x402-xec/core'
import { withX402XecPaymentInterceptor } from '@x402-xec/axios'
import type { BrowserWalletAdapter } from '@x402-xec/payments'
import {
  TonalliX402AuthorizationDryRunOrchestrator,
  type TonalliX402AuthorizationDryRunStatus
} from './TonalliX402AuthorizationDryRunOrchestrator'

const PAYMENT_HEADER = 'PAYMENT-SIGNATURE'
const DEFAULT_MAX_PAYMENT_SATS = 1_000n
const SUPPORTED_METHODS = new Set(['GET', 'POST'])
const REDIRECT_STATUSES = new Set([300, 301, 302, 303, 305, 307, 308])

export type TrustedX402Method = 'GET' | 'POST'

export type TrustedX402PathRule = Readonly<{
  method: TrustedX402Method
  path: string
  match?: 'exact' | 'prefix'
}>

export type TrustedX402ClientEnvironment = Readonly<{
  VITE_X402_TRUSTED_CLIENT?: unknown
  VITE_X402_TRUSTED_ORIGIN?: unknown
  MODE?: string
  DEV?: boolean
  PROD?: boolean
}>

export interface CreateTrustedX402ClientOptions {
  readonly allowlist: readonly TrustedX402PathRule[]
  readonly walletAdapter: BrowserWalletAdapter
  readonly maxPaymentSats?: bigint
  readonly environment?: TrustedX402ClientEnvironment
  readonly adapter?: AxiosAdapter
  readonly now?: () => number
  readonly onStatus?: (status: TonalliX402AuthorizationDryRunStatus) => void
  readonly onPaymentRequired?: () => void
}

type PaymentOfferShape = {
  readonly invoice?: unknown
  readonly resource?: unknown
}

function fail(message: string): never {
  throw new Error(`Trusted x402 client: ${message}`)
}

const isEnabled = (value: unknown) =>
  String(value).trim().toLowerCase() === 'true'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const normalizeAllowlist = (rules: readonly TrustedX402PathRule[]) =>
  rules.map((rule) => {
    const method = rule.method.toUpperCase()
    if (!SUPPORTED_METHODS.has(method)) fail(`unsupported allowlist method ${method}`)
    if (
      !rule.path.startsWith('/')
      || rule.path.startsWith('//')
      || rule.path.includes('?')
      || rule.path.includes('#')
    ) {
      fail('allowlist paths must be absolute paths without query strings or fragments')
    }
    const match = rule.match ?? 'exact'
    if (match !== 'exact' && match !== 'prefix') fail('invalid allowlist match')
    if (match === 'prefix' && !rule.path.endsWith('/')) {
      fail('allowlist prefixes must end with /')
    }
    return Object.freeze({ method, path: rule.path, match })
  })

const pathIsAllowed = (
  rules: ReturnType<typeof normalizeAllowlist>,
  method: string,
  path: string
) => rules.some((rule) =>
  rule.method === method
  && (
    rule.match === 'exact'
      ? path === rule.path
      : path.startsWith(rule.path)
  )
)

const parseTrustedOrigin = (
  value: unknown,
  environment: TrustedX402ClientEnvironment
) => {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail('VITE_X402_TRUSTED_ORIGIN is required when enabled')
  }

  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return fail('VITE_X402_TRUSTED_ORIGIN must be a valid origin')
  }

  const authority = value.trim().replace(/^[a-z][a-z\d+.-]*:\/\//iu, '').split('/')[0]
  if (parsed.username !== '' || parsed.password !== '' || authority?.includes('@')) {
    return fail('trusted origin must not contain credentials')
  }
  if (
    (parsed.pathname !== '/' && parsed.pathname !== '')
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    return fail('VITE_X402_TRUSTED_ORIGIN must contain only an origin')
  }

  const production = environment.PROD === true || environment.MODE === 'production'
  const development = environment.DEV === true || environment.MODE === 'development'
  if (parsed.protocol === 'https:') return parsed.origin
  if (
    parsed.protocol === 'http:'
    && development
    && !production
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  ) {
    return parsed.origin
  }
  return fail(
    production
      ? 'production trusted origin must use HTTPS'
      : 'HTTP is permitted only for localhost or 127.0.0.1 in development'
  )
}

const resolveRequest = (
  config: InternalAxiosRequestConfig,
  trustedOrigin: string,
  rules: ReturnType<typeof normalizeAllowlist>
) => {
  const rawUrl = config.url
  if (
    typeof rawUrl !== 'string'
    || !rawUrl.startsWith('/')
    || rawUrl.startsWith('//')
    || rawUrl.includes('#')
  ) {
    return fail('requests must use an allowlisted absolute path, not an absolute URL')
  }

  const method = (config.method ?? 'get').toUpperCase()
  if (!SUPPORTED_METHODS.has(method)) fail(`unsupported method ${method}`)

  const requested = new URL(rawUrl, trustedOrigin)
  if (requested.origin !== trustedOrigin) fail('cross-origin request rejected')
  if (!pathIsAllowed(rules, method, requested.pathname)) {
    fail(`path is not allowlisted for ${method}`)
  }
  return { method, path: requested.pathname }
}

const responseUrl = (response: AxiosResponse): string | undefined => {
  const request = response.request as
    | { responseURL?: unknown; res?: { responseUrl?: unknown } }
    | undefined
  if (typeof request?.responseURL === 'string') return request.responseURL
  if (typeof request?.res?.responseUrl === 'string') return request.res.responseUrl
  return undefined
}

const assertNoRedirect = (response: AxiosResponse, trustedOrigin: string) => {
  const finalUrl = responseUrl(response)
  if (finalUrl !== undefined) {
    let finalOrigin: string
    try {
      finalOrigin = new URL(finalUrl).origin
    } catch {
      return fail('invalid final response URL')
    }
    if (finalOrigin !== trustedOrigin) fail('cross-origin redirect rejected')
  }
  if (response.status === 0 || REDIRECT_STATUSES.has(response.status)) {
    fail('redirect responses are not accepted')
  }
  const location = response.headers instanceof AxiosHeaders
    ? response.headers.get('location')
    : response.headers.location
  if (typeof location === 'string') {
    const destination = new URL(location, trustedOrigin)
    if (destination.origin !== trustedOrigin) fail('cross-origin redirect rejected')
  }
}

const assertTrustedOffer = (
  input: unknown,
  trustedOrigin: string,
  rules: ReturnType<typeof normalizeAllowlist>,
  maxPaymentSats: bigint,
  now: number
) => {
  if (!isRecord(input)) fail('invalid x402 response')
  const offer = input as PaymentOfferShape
  const parsedInvoice = invoiceSchema.safeParse(offer.invoice)
  if (!parsedInvoice.success) fail('invalid x402 invoice')
  const invoice = parsedInvoice.data
  if (invoice === undefined) fail('invalid x402 invoice')
  if (invoice.network !== XEC_MAINNET) fail('unsupported x402 network')
  if (invoice.scheme !== XEC_SCHEME) fail('unsupported x402 scheme')
  if (
    !Number.isSafeInteger(now)
    || now < 0
    || now < invoice.issuedAt
    || now >= invoice.expiresAt
  ) {
    fail('invalid x402 invoice expiry')
  }
  if (parseAmountSats(invoice.amountSats) > maxPaymentSats) {
    fail('x402 amount exceeds maxPaymentSats')
  }
  const resource = offer.resource
  if (!isRecord(resource)) fail('invalid x402 resource')
  const serverOrigin = resource.serverOrigin
  const method = typeof resource.method === 'string'
    ? resource.method.toUpperCase()
    : ''
  const path = resource.path
  if (serverOrigin !== trustedOrigin) fail('x402 resource origin is not trusted')
  if (!SUPPORTED_METHODS.has(method)) fail('unsupported x402 resource method')
  if (typeof path !== 'string' || !pathIsAllowed(rules, method, path)) {
    fail('x402 resource path is not allowlisted')
  }
}

export function createTrustedX402Client(
  options: CreateTrustedX402ClientOptions
): AxiosInstance | null {
  const environment = options.environment ?? import.meta.env
  if (!isEnabled(environment.VITE_X402_TRUSTED_CLIENT)) return null

  const trustedOrigin = parseTrustedOrigin(
    environment.VITE_X402_TRUSTED_ORIGIN,
    environment
  )
  const rules = normalizeAllowlist(options.allowlist)
  const maxPaymentSats = options.maxPaymentSats ?? DEFAULT_MAX_PAYMENT_SATS
  if (maxPaymentSats < 0n) fail('maxPaymentSats must be non-negative')
  const now = options.now ?? (() => Math.floor(Date.now() / 1_000))
  const retrySignatures = new Set<string>()
  const orchestrator = new TonalliX402AuthorizationDryRunOrchestrator({
    walletAdapter: options.walletAdapter,
    now,
    onStatus: options.onStatus
  })
  const guardedOrchestrator = {
    execute: async (...args: Parameters<typeof orchestrator.execute>) => {
      const result = await orchestrator.execute(...args)
      retrySignatures.add(result.paymentSignature)
      return result
    }
  }

  const client = axios.create({
    baseURL: trustedOrigin,
    adapter: options.adapter ?? 'fetch',
    maxRedirects: 0,
    withCredentials: false,
    fetchOptions: { redirect: 'manual' }
  })
  const trustedAdapter = client.defaults.adapter

  client.interceptors.request.use((config) => {
    resolveRequest(config, trustedOrigin, rules)
    config.baseURL = trustedOrigin
    config.adapter = trustedAdapter
    config.maxRedirects = 0
    config.withCredentials = false
    config.fetchOptions = { ...config.fetchOptions, redirect: 'manual' }

    const headers = AxiosHeaders.from(config.headers)
    const paymentSignature = headers.get(PAYMENT_HEADER)
    if (paymentSignature !== undefined) {
      if (typeof paymentSignature !== 'string' || !retrySignatures.delete(paymentSignature)) {
        fail('caller-supplied PAYMENT-SIGNATURE rejected')
      }
    }
    config.headers = headers
    return config
  })

  client.interceptors.response.use(
    (response) => {
      assertNoRedirect(response, trustedOrigin)
      return response
    },
    (error: unknown) => {
      if (axios.isAxiosError(error) && error.response) {
        assertNoRedirect(error.response, trustedOrigin)
        if (error.response.status === 402) {
          assertTrustedOffer(
            error.response.data,
            trustedOrigin,
            rules,
            maxPaymentSats,
            now()
          )
          options.onPaymentRequired?.()
        }
      }
      return Promise.reject(error)
    }
  )

  return withX402XecPaymentInterceptor(client, {
    orchestrator: guardedOrchestrator,
    enableOrchestratorPayments: true,
    maxPaymentSats,
    now
  })
}

