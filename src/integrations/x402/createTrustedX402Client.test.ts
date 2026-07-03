import axios, {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig
} from 'axios'
import {
  computeInvoiceHash,
  computeResourceHash,
  type Invoice,
  type ResourceRequest
} from '@x402-xec/core'
import type {
  BrowserWalletAdapter,
  WalletApprovalResponse
} from '@x402-xec/payments'
import { describe, expect, test, vi } from 'vitest'
import {
  createTrustedX402Client,
  type CreateTrustedX402ClientOptions,
  type TrustedX402ClientEnvironment
} from './createTrustedX402Client'

const NOW = 4_000_000_000
const ORIGIN = 'https://trusted.example'
const PATH = '/v1/protected'
const address = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'
const publicKey = `02${'33'.repeat(32)}`
const allowlist = [{ method: 'GET', path: PATH }] as const

const enabledEnvironment: TrustedX402ClientEnvironment = {
  VITE_X402_TRUSTED_CLIENT: 'true',
  VITE_X402_TRUSTED_ORIGIN: ORIGIN,
  MODE: 'production',
  PROD: true
}

const response = <T,>(
  data: T,
  status: number,
  config: InternalAxiosRequestConfig,
  finalUrl = `${ORIGIN}${PATH}`,
  headers = new AxiosHeaders()
): AxiosResponse<T> => ({
  data,
  status,
  statusText: String(status),
  headers,
  config,
  request: { responseURL: finalUrl }
})

const offerFor = (
  amountSats = '100',
  resourceOverrides: Partial<ResourceRequest> = {},
  invoiceOverrides: Partial<Invoice> = {}
) => {
  const resource: ResourceRequest = {
    serverOrigin: ORIGIN,
    method: 'GET',
    path: PATH,
    ...resourceOverrides
  }
  const invoice: Invoice = {
    x402Version: 1,
    scheme: 'exact',
    network: 'xec:mainnet',
    resourceHash: computeResourceHash(resource),
    amountSats,
    payTo: address,
    nonce: 'Uk1aV2FsbGV0LXRydXN0ZWQtY2xpZW50',
    issuedAt: NOW,
    expiresAt: NOW + 300,
    ...invoiceOverrides
  }
  return {
    x402Version: 1,
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
}

const paymentRequired = (
  config: InternalAxiosRequestConfig,
  offer: unknown = offerFor(),
  finalUrl?: string
) => {
  const paymentResponse = response(offer, 402, config, finalUrl)
  return new AxiosError(
    'Payment Required',
    AxiosError.ERR_BAD_REQUEST,
    config,
    undefined,
    paymentResponse
  )
}

const createWalletAdapter = (
  approval: WalletApprovalResponse = { status: 'approved' }
) => {
  const order: string[] = []
  const requestApproval = vi.fn(async () => {
    order.push('approval')
    return approval
  })
  const signAuthorization = vi.fn(async () => {
    order.push('sign')
    return {
      status: 'approved' as const,
      signature: 'trusted_wallet_authorization_signature',
      publicKey
    }
  })
  const signPreparedTransaction = vi.fn()
  const walletAdapter: BrowserWalletAdapter = {
    getActiveAccount: () => ({
      status: 'available',
      account: { address, publicKey }
    }),
    requestApproval,
    signAuthorization,
    signPreparedTransaction
  }
  return {
    walletAdapter,
    order,
    requestApproval,
    signAuthorization,
    signPreparedTransaction
  }
}

const createClient = (
  adapter: AxiosAdapter,
  overrides: Partial<CreateTrustedX402ClientOptions> = {}
) => {
  const wallet = createWalletAdapter()
  const client = createTrustedX402Client({
    allowlist,
    walletAdapter: wallet.walletAdapter,
    environment: enabledEnvironment,
    adapter,
    now: () => NOW,
    maxPaymentSats: 200n,
    ...overrides
  })
  if (client === null) throw new Error('test client unexpectedly disabled')
  return { client, ...wallet }
}

describe('allowlisted trusted-backend x402 client', () => {
  test('disabled flag returns no enabled client', () => {
    const wallet = createWalletAdapter()
    const client = createTrustedX402Client({
      allowlist,
      walletAdapter: wallet.walletAdapter,
      environment: {
        VITE_X402_TRUSTED_CLIENT: 'false',
        VITE_X402_TRUSTED_ORIGIN: ORIGIN,
        MODE: 'production'
      }
    })

    expect(client).toBeNull()
  })

  test('missing trusted origin fails closed', () => {
    const wallet = createWalletAdapter()
    expect(() => createTrustedX402Client({
      allowlist,
      walletAdapter: wallet.walletAdapter,
      environment: {
        VITE_X402_TRUSTED_CLIENT: 'true',
        MODE: 'production'
      }
    })).toThrow('VITE_X402_TRUSTED_ORIGIN is required')
  })

  test('non-HTTPS production origin fails closed', () => {
    const wallet = createWalletAdapter()
    expect(() => createTrustedX402Client({
      allowlist,
      walletAdapter: wallet.walletAdapter,
      environment: {
        VITE_X402_TRUSTED_CLIENT: 'true',
        VITE_X402_TRUSTED_ORIGIN: 'http://trusted.example',
        MODE: 'production'
      }
    })).toThrow('must use HTTPS')
  })

  test('localhost HTTP is accepted only in development', () => {
    const wallet = createWalletAdapter()
    const developmentClient = createTrustedX402Client({
      allowlist,
      walletAdapter: wallet.walletAdapter,
      environment: {
        VITE_X402_TRUSTED_CLIENT: 'true',
        VITE_X402_TRUSTED_ORIGIN: 'http://127.0.0.1:4010',
        MODE: 'development',
        DEV: true
      }
    })

    expect(developmentClient?.defaults.baseURL).toBe('http://127.0.0.1:4010')
    expect(() => createTrustedX402Client({
      allowlist,
      walletAdapter: wallet.walletAdapter,
      environment: {
        VITE_X402_TRUSTED_CLIENT: 'true',
        VITE_X402_TRUSTED_ORIGIN: 'http://localhost:4010',
        MODE: 'production',
        PROD: true
      }
    })).toThrow('must use HTTPS')
  })

  test('unallowlisted path is rejected before the adapter runs', async () => {
    const adapter = vi.fn<AxiosAdapter>()
    const { client } = createClient(adapter)

    await expect(client.get('/v1/not-allowed')).rejects.toThrow('not allowlisted')
    expect(adapter).not.toHaveBeenCalled()
  })

  test('unsupported method is rejected before the adapter runs', async () => {
    const adapter = vi.fn<AxiosAdapter>()
    const { client } = createClient(adapter)

    await expect(client.delete(PATH)).rejects.toThrow('unsupported method DELETE')
    expect(adapter).not.toHaveBeenCalled()
  })

  test('absolute and cross-origin URLs are rejected before the adapter runs', async () => {
    const adapter = vi.fn<AxiosAdapter>()
    const { client } = createClient(adapter)

    await expect(client.get(`${ORIGIN}${PATH}`)).rejects.toThrow('not an absolute URL')
    await expect(client.get(`https://evil.example${PATH}`)).rejects.toThrow('not an absolute URL')
    expect(adapter).not.toHaveBeenCalled()
  })

  test('cross-origin redirects are rejected without a retry', async () => {
    const adapter: AxiosAdapter = async (config) =>
      response({}, 302, config, `https://evil.example${PATH}`)
    const { client, requestApproval } = createClient(adapter)

    await expect(client.get(PATH)).rejects.toThrow('cross-origin redirect rejected')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  test('valid trusted 402 requests approval before signing and retries once', async () => {
    const configs: InternalAxiosRequestConfig[] = []
    const adapter: AxiosAdapter = async (config) => {
      configs.push(config)
      if (!AxiosHeaders.from(config.headers).has('PAYMENT-SIGNATURE')) {
        throw paymentRequired(config)
      }
      return response({ ok: true }, 200, config)
    }
    const { client, order } = createClient(adapter)

    const result = await client.get(PATH)

    expect(result.data).toEqual({ ok: true })
    expect(order).toEqual(['approval', 'sign'])
    expect(configs).toHaveLength(2)
  })

  test('reports only a validated trusted HTTP 402 offer', async () => {
    const onPaymentRequired = vi.fn()
    const invalidAdapter: AxiosAdapter = async (config) => {
      throw paymentRequired(config, { invalid: true })
    }
    const invalid = createClient(invalidAdapter, { onPaymentRequired })

    await expect(invalid.client.get(PATH)).rejects.toThrow('invalid x402 invoice')
    expect(onPaymentRequired).not.toHaveBeenCalled()

    const validAdapter: AxiosAdapter = async (config) => {
      throw paymentRequired(config)
    }
    const valid = createClient(validAdapter, {
      onPaymentRequired,
      walletAdapter: createWalletAdapter({ status: 'rejected' }).walletAdapter
    })

    await expect(valid.client.get(PATH)).rejects.toThrow('orchestrator payment failed')
    expect(onPaymentRequired).toHaveBeenCalledOnce()
  })

  test.each(['rejected', 'cancelled'] as const)(
    '%s approval prevents signing and retry',
    async (status) => {
      const calls: InternalAxiosRequestConfig[] = []
      const adapter: AxiosAdapter = async (config) => {
        calls.push(config)
        throw paymentRequired(config)
      }
      const wallet = createWalletAdapter({ status })
      const { client } = createClient(adapter, { walletAdapter: wallet.walletAdapter })

      await expect(client.get(PATH)).rejects.toThrow('orchestrator payment failed')
      expect(wallet.signAuthorization).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
    }
  )

  test('PAYMENT-SIGNATURE is attached only to the trusted retry', async () => {
    const seen: Array<{ url: string | undefined; signature: unknown }> = []
    const adapter: AxiosAdapter = async (config) => {
      const signature = AxiosHeaders.from(config.headers).get('PAYMENT-SIGNATURE')
      seen.push({ url: config.url, signature })
      if (signature === undefined) throw paymentRequired(config)
      return response({ ok: true }, 200, config)
    }
    const { client } = createClient(adapter)

    await client.get(PATH)

    expect(seen).toHaveLength(2)
    expect(seen[0]).toEqual({ url: PATH, signature: undefined })
    expect(seen[1]?.url).toBe(PATH)
    expect(typeof seen[1]?.signature).toBe('string')
    await expect(client.get(PATH, {
      headers: { 'PAYMENT-SIGNATURE': 'caller-controlled' }
    })).rejects.toThrow('caller-supplied PAYMENT-SIGNATURE rejected')
  })

  test('a repeated 402 is not retried more than once', async () => {
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      throw paymentRequired(config)
    })
    const { client, requestApproval } = createClient(adapter)

    await expect(client.get(PATH)).rejects.toThrow('Payment Required')
    expect(adapter).toHaveBeenCalledTimes(2)
    expect(requestApproval).toHaveBeenCalledOnce()
  })

  test('amount above maxPaymentSats fails before approval', async () => {
    const adapter: AxiosAdapter = async (config) => {
      throw paymentRequired(config, offerFor('201'))
    }
    const { client, requestApproval } = createClient(adapter)

    await expect(client.get(PATH)).rejects.toThrow('amount exceeds maxPaymentSats')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  test.each([
    ['cross-origin resource', offerFor('100', { serverOrigin: 'https://evil.example' })],
    ['unallowlisted resource path', offerFor('100', { path: '/v1/other' })],
    ['expired invoice', offerFor('100', {}, {
      issuedAt: NOW - 300,
      expiresAt: NOW
    })],
    ['future invoice', offerFor('100', {}, { issuedAt: NOW + 1 })],
    ['unsupported network', {
      ...offerFor(),
      invoice: { ...offerFor().invoice, network: 'xec:testnet' }
    }],
    ['unsupported scheme', {
      ...offerFor(),
      invoice: { ...offerFor().invoice, scheme: 'other' }
    }]
  ])('%s invoice fails closed before approval', async (_label, offer) => {
    const adapter: AxiosAdapter = async (config) => {
      throw paymentRequired(config, offer)
    }
    const { client, requestApproval } = createClient(adapter)

    await expect(client.get(PATH)).rejects.toThrow()
    expect(requestApproval).not.toHaveBeenCalled()
  })

  test('global Axios defaults and interceptors are not modified', () => {
    const defaults = axios.defaults
    const requestInterceptors = axios.interceptors.request
    const responseInterceptors = axios.interceptors.response
    const globalRequestUse = vi.spyOn(requestInterceptors, 'use')
    const globalResponseUse = vi.spyOn(responseInterceptors, 'use')
    const wallet = createWalletAdapter()

    createTrustedX402Client({
      allowlist,
      walletAdapter: wallet.walletAdapter,
      environment: enabledEnvironment
    })

    expect(axios.defaults).toBe(defaults)
    expect(axios.interceptors.request).toBe(requestInterceptors)
    expect(axios.interceptors.response).toBe(responseInterceptors)
    expect(globalRequestUse).not.toHaveBeenCalled()
    expect(globalResponseUse).not.toHaveBeenCalled()
    globalRequestUse.mockRestore()
    globalResponseUse.mockRestore()
  })

  test('authorization-only flow never signs transactions, sends, queries Chronik, or broadcasts', async () => {
    const signPreparedTransaction = vi.fn()
    const sendXEC = vi.fn()
    const sendRMZ = vi.fn()
    const chronik = vi.fn()
    const broadcast = vi.fn()
    const wallet = createWalletAdapter()
    wallet.walletAdapter.signPreparedTransaction = signPreparedTransaction
    const adapter: AxiosAdapter = async (config) => {
      if (!AxiosHeaders.from(config.headers).has('PAYMENT-SIGNATURE')) {
        throw paymentRequired(config)
      }
      return response({ ok: true }, 200, config)
    }
    const { client } = createClient(adapter, { walletAdapter: wallet.walletAdapter })

    await client.get(PATH)

    expect(signPreparedTransaction).not.toHaveBeenCalled()
    expect(sendXEC).not.toHaveBeenCalled()
    expect(sendRMZ).not.toHaveBeenCalled()
    expect(chronik).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })
})
