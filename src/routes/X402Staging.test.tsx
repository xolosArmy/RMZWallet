import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, test, vi } from 'vitest'
import App from '../App'
import {
  X402_STAGING_ALLOWLIST,
  X402_STAGING_MAX_PAYMENT_SATS,
  X402_STAGING_PATH,
  X402_STAGING_TEST_ENABLED,
  isX402StagingTestEnabled
} from '../integrations/x402/x402StagingFeature'
import { runX402StagingAuthorization } from '../integrations/x402/runX402StagingAuthorization'
import type { UseTrustedX402ClientOptions } from '../integrations/x402/useTrustedX402Client'
import Dashboard from './Dashboard'
import X402Staging, { X402StagingResultView } from './X402Staging'

const capturedOptions = vi.hoisted(() => [] as UseTrustedX402ClientOptions[])

vi.mock('../integrations/x402/useTrustedX402Client', () => ({
  useTrustedX402Client: (options: UseTrustedX402ClientOptions) => {
    capturedOptions.push(options)
    return null
  }
}))

vi.mock('../components/TopBar', () => ({ default: () => <div>Top bar</div> }))

vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    address: 'ecash:qptest',
    balance: null,
    initialized: true,
    refreshBalances: vi.fn(),
    rescanWallet: vi.fn(),
    loading: false,
    error: null
  })
}))

const successData = {
  notice: 'Authorization verified',
  authorizationOnly: true as const,
  broadcasted: false as const,
  payer: 'ecash:qppayer'
}

describe('trusted x402 staging route', () => {
  test('route and Dashboard link are absent when staging is disabled', () => {
    expect(isX402StagingTestEnabled(undefined)).toBe(false)
    expect(isX402StagingTestEnabled('false')).toBe(false)
    expect(X402_STAGING_TEST_ENABLED).toBe(false)

    const dashboard = renderToStaticMarkup(
      <MemoryRouter><Dashboard /></MemoryRouter>
    )
    const route = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/x402-staging']}><App /></MemoryRouter>
    )

    expect(dashboard).not.toContain('/x402-staging')
    expect(route).not.toContain('Test real staging authorization')
  })

  test('hook receives the exact frozen allowlist and explicit staging cap', () => {
    capturedOptions.length = 0
    renderToStaticMarkup(
      <MemoryRouter><X402Staging /></MemoryRouter>
    )

    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]?.allowlist).toBe(X402_STAGING_ALLOWLIST)
    expect(capturedOptions[0]?.allowlist).toEqual([{
      method: 'GET',
      path: '/v1/x402/authorization-test',
      match: 'exact'
    }])
    expect(capturedOptions[0]?.maxPaymentSats).toBe(X402_STAGING_MAX_PAYMENT_SATS)
    expect(Object.isFrozen(X402_STAGING_ALLOWLIST)).toBe(true)
    expect(Object.isFrozen(X402_STAGING_ALLOWLIST[0])).toBe(true)
  })

  test('disabled trusted client fails closed without making a request', async () => {
    const request = vi.fn()

    await expect(runX402StagingAuthorization(null, new AbortController().signal))
      .rejects.toThrow('X402 staging authorization failed')

    expect(request).not.toHaveBeenCalled()
  })

  test('only the exact GET staging path is requested and bounded data is returned', async () => {
    const get = vi.fn(async () => ({
      status: 200,
      data: successData
    }))
    const controller = new AbortController()

    const result = await runX402StagingAuthorization({ get }, controller.signal)

    expect(get).toHaveBeenCalledOnce()
    expect(get).toHaveBeenCalledWith(X402_STAGING_PATH, { signal: controller.signal })
    expect(result).toEqual(successData)
  })

  test.each([
    { status: 201, data: successData },
    { status: 200, data: null },
    { status: 200, data: { ...successData, authorizationOnly: false } },
    { status: 200, data: { ...successData, broadcasted: true } },
    { status: 200, data: { ...successData, notice: '' } }
  ])('invalid or non-200 response fails closed', async (response) => {
    const get = vi.fn(async () => response)

    await expect(runX402StagingAuthorization({ get }, new AbortController().signal))
      .rejects.toThrow('X402 staging authorization failed')

    expect(get).toHaveBeenCalledOnce()
  })

  test('sensitive protocol values are neither retained, rendered, nor logged', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const sensitive = {
      'PAYMENT-SIGNATURE': 'payment-signature-secret',
      signature: 'authorization-signature-secret',
      invoice: 'invoice-secret',
      nonce: 'nonce-secret',
      mnemonic: 'mnemonic-secret',
      privateKey: 'private-key-secret',
      WIF: 'wif-secret',
      signatory: 'signatory-secret'
    }
    const get = vi.fn(async () => ({
      status: 200,
      data: { ...successData, ...sensitive }
    }))

    const result = await runX402StagingAuthorization({ get }, new AbortController().signal)
    const output = renderToStaticMarkup(<X402StagingResultView result={result} />)
    const serialized = JSON.stringify(result)

    expect(output).toContain('Authorization verified')
    expect(output).toContain('ecash:qppayer')
    for (const [name, value] of Object.entries(sensitive)) {
      expect(output).not.toContain(name)
      expect(output).not.toContain(value)
      expect(serialized).not.toContain(name)
      expect(serialized).not.toContain(value)
    }
    expect(consoleLog).not.toHaveBeenCalled()
    consoleLog.mockRestore()
  })

  test('request boundary never invokes transaction or broadcast methods', async () => {
    const signPreparedTransaction = vi.fn()
    const sendXEC = vi.fn()
    const sendRMZ = vi.fn()
    const chronik = vi.fn()
    const broadcast = vi.fn()
    const get = vi.fn(async () => ({ status: 200, data: successData }))

    await runX402StagingAuthorization({ get }, new AbortController().signal)

    expect(signPreparedTransaction).not.toHaveBeenCalled()
    expect(sendXEC).not.toHaveBeenCalled()
    expect(sendRMZ).not.toHaveBeenCalled()
    expect(chronik).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
  })
})
