import axios from 'axios'
import type { BrowserWalletAdapter, WalletApprovalResponse } from '@x402-xec/payments'
import { describe, expect, test, vi } from 'vitest'
import { isX402DryRunEnabled } from '../integrations/x402/x402DryRunFeature'
import { TonalliX402AuthorizationDryRunOrchestrator } from '../integrations/x402/TonalliX402AuthorizationDryRunOrchestrator'
import {
  createX402DemoClient,
  createX402DemoMockAdapter,
  type X402DemoStep
} from '../integrations/x402/X402DemoClient'

const NOW = 3_000
const address = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'
const publicKey = `02${'33'.repeat(32)}`

const createFlow = (approval: WalletApprovalResponse = { status: 'approved' }) => {
  const steps: X402DemoStep[] = []
  const signAuthorization = vi.fn(async () => ({
    status: 'approved' as const,
    signature: 'real_wallet_authorization_signature',
    publicKey
  }))
  const signPreparedTransaction = vi.fn()
  const adapter: BrowserWalletAdapter = {
    getActiveAccount: () => ({ status: 'available', account: { address, publicKey } }),
    requestApproval: vi.fn(async () => approval),
    signAuthorization,
    signPreparedTransaction
  }
  const orchestrator = new TonalliX402AuthorizationDryRunOrchestrator({
    walletAdapter: adapter,
    now: () => NOW,
    onStatus: (status) => steps.push(status)
  })
  const mock = createX402DemoMockAdapter((step) => steps.push(step), () => NOW)
  const client = createX402DemoClient(orchestrator, mock.adapter, () => NOW)
  return { client, mock, steps, signAuthorization, signPreparedTransaction }
}

describe('isolated x402 Axios demo', () => {
  test('feature flag fails closed unless its value is exactly true', () => {
    expect(isX402DryRunEnabled(undefined)).toBe(false)
    expect(isX402DryRunEnabled(false)).toBe(false)
    expect(isX402DryRunEnabled('false')).toBe(false)
    expect(isX402DryRunEnabled('1')).toBe(false)
    expect(isX402DryRunEnabled('true')).toBe(true)
  })

  test('only the component-scoped client receives the interceptor', () => {
    const globalDefaults = axios.defaults
    const globalResponseInterceptors = axios.interceptors.response
    const flow = createFlow()

    expect(flow.client).not.toBe(axios)
    expect(axios.defaults).toBe(globalDefaults)
    expect(axios.interceptors.response).toBe(globalResponseInterceptors)
    expect(flow.client.defaults.baseURL).toBe('https://x402-demo.local')
  })

  test('mocked 402 is approved, retried once with PAYMENT-SIGNATURE, and returns 200', async () => {
    const flow = createFlow()

    const result = await flow.client.get('/protected')

    expect(result.status).toBe(200)
    expect(result.data).toEqual({
      ok: true,
      broadcasted: false,
      notice: 'DRY RUN ONLY'
    })
    expect(flow.steps).toEqual([
      'request-received-402',
      'approval-requested',
      'approval-accepted',
      'authorization-signature-returned',
      'payment-signature-attached',
      'mocked-protected-resource-returned'
    ])
    expect(flow.mock.getState()).toEqual({ requestCount: 2, retryCount: 1 })
    expect(flow.signAuthorization).toHaveBeenCalledOnce()
    expect(flow.signPreparedTransaction).not.toHaveBeenCalled()
  })

  test.each(['rejected', 'cancelled'] as const)(
    '%s approval prevents signing and retry',
    async (status) => {
      const flow = createFlow({ status })

      await expect(flow.client.get('/protected'))
        .rejects.toThrow('x402-XEC orchestrator payment failed')

      expect(flow.signAuthorization).not.toHaveBeenCalled()
      expect(flow.mock.getState()).toEqual({ requestCount: 1, retryCount: 0 })
      expect(flow.steps).toContain(
        status === 'rejected' ? 'approval-rejected' : 'approval-cancelled'
      )
      expect(flow.steps).not.toContain('payment-signature-attached')
    }
  )

  test('expired mocked invoice fails before approval, signing, or retry', async () => {
    const steps: X402DemoStep[] = []
    const execute = vi.fn()
    const mock = createX402DemoMockAdapter((step) => steps.push(step), () => NOW)
    const client = createX402DemoClient({ execute }, mock.adapter, () => NOW + 300)

    await expect(client.get('/protected')).rejects.toThrow('invoice has expired')

    expect(execute).not.toHaveBeenCalled()
    expect(mock.getState()).toEqual({ requestCount: 1, retryCount: 0 })
    expect(steps).toEqual(['request-received-402'])
  })
})
