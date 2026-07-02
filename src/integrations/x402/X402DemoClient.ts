import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig
} from 'axios'
import {
  computeInvoiceHash,
  computeResourceHash,
  type Invoice,
  type ResourceRequest
} from '@x402-xec/core'
import {
  withX402XecPaymentInterceptor,
  type PaymentOrchestrator
} from '@x402-xec/axios'
import type { TonalliX402AuthorizationDryRunStatus } from './TonalliX402AuthorizationDryRunOrchestrator'

export const X402_DEMO_PATH = '/protected'

const DEMO_ORIGIN = 'https://x402-demo.local'
const DEMO_AMOUNT_SATS = '100'
const DEMO_MAX_PAYMENT_SATS = 200n
const DEMO_PAY_TO = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'

export type X402DemoStep =
  | 'request-received-402'
  | TonalliX402AuthorizationDryRunStatus
  | 'payment-signature-attached'
  | 'mocked-protected-resource-returned'

export type X402DemoResponse = {
  readonly ok: true
  readonly broadcasted: false
  readonly notice: 'DRY RUN ONLY'
}

export interface X402DemoMockState {
  readonly requestCount: number
  readonly retryCount: number
}

const createInvoice = (now: number, resource: ResourceRequest): Invoice => ({
  x402Version: 1,
  scheme: 'exact',
  network: 'xec:mainnet',
  resourceHash: computeResourceHash(resource),
  amountSats: DEMO_AMOUNT_SATS,
  payTo: DEMO_PAY_TO,
  nonce: 'Uk1aV2FsbGV0LXg0MDItZGVtbw',
  issuedAt: now,
  expiresAt: now + 5 * 60
})

const response = <T,>(
  data: T,
  status: number,
  config: InternalAxiosRequestConfig
): AxiosResponse<T> => ({
  data,
  status,
  statusText: status === 200 ? 'OK' : 'Payment Required',
  headers: new AxiosHeaders(),
  config
})

export const createX402DemoMockAdapter = (
  onStep: (step: X402DemoStep) => void,
  now: () => number = () => Math.floor(Date.now() / 1_000)
): { adapter: AxiosAdapter; getState: () => X402DemoMockState } => {
  let requestCount = 0
  let retryCount = 0

  const adapter: AxiosAdapter = async (config) => {
    requestCount += 1
    const paymentSignature = AxiosHeaders.from(config.headers).get('PAYMENT-SIGNATURE')

    if (paymentSignature === undefined) {
      const resource: ResourceRequest = {
        serverOrigin: DEMO_ORIGIN,
        method: 'GET',
        path: X402_DEMO_PATH
      }
      const invoice = createInvoice(now(), resource)
      const offer = {
        x402Version: invoice.x402Version,
        invoiceId: computeInvoiceHash(invoice),
        invoice,
        resource,
        accepts: [{
          asset: 'XEC',
          network: invoice.network,
          scheme: 'xec-prepaid-utxo',
          amountSats: invoice.amountSats,
          payTo: invoice.payTo,
          paymentHeader: 'PAYMENT-SIGNATURE'
        }]
      }
      onStep('request-received-402')
      throw new AxiosError(
        'Mocked HTTP 402',
        AxiosError.ERR_BAD_REQUEST,
        config,
        undefined,
        response(offer, 402, config)
      )
    }

    retryCount += 1
    onStep('payment-signature-attached')
    onStep('mocked-protected-resource-returned')
    return response<X402DemoResponse>({
      ok: true,
      broadcasted: false,
      notice: 'DRY RUN ONLY'
    }, 200, config)
  }

  return {
    adapter,
    getState: () => ({ requestCount, retryCount })
  }
}

export const createX402DemoClient = (
  orchestrator: PaymentOrchestrator,
  adapter: AxiosAdapter,
  now?: () => number
): AxiosInstance => {
  const client = axios.create({ baseURL: DEMO_ORIGIN, adapter })
  return withX402XecPaymentInterceptor(client, {
    orchestrator,
    enableOrchestratorPayments: true,
    maxPaymentSats: DEMO_MAX_PAYMENT_SATS,
    ...(now === undefined ? {} : { now })
  })
}
