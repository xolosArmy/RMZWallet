// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import { encodeCanonicalBase64Url } from '../integrations/x402/h3b/TonalliH3BContract'
import type { TonalliH3BWalletPort } from '../integrations/x402/h3b/TonalliH3BAuthorizationProof'
import X402AuthorizeRequest from './X402AuthorizeRequest'

vi.mock('../components/TopBar', () => ({ default: () => <div>Tonalli Wallet</div> }))

const NOW = 1_800_000_000
const CHALLENGE = 'AQIDBAUGBwgJCgsMDQ4PEA'
const PAYER = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'
const PUBLIC_KEY = `02${'11'.repeat(32)}`
const nowSeconds = () => NOW

const requestFixture = () => ({
  type: 'x402ecash-h3b-request',
  version: 1,
  targetGate: 'H3B',
  sourceOrigin: 'https://x402.ecash.mx',
  returnUrl: 'https://x402.ecash.mx/experiments/webmcp/',
  challengeId: CHALLENGE,
  issuedAt: NOW - 10,
  expiresAt: NOW + 240,
  paymentRequired: {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: {
      url: 'https://api.x402.ecash.mx/v1/resource/demo',
      description: 'x402eCash WebMCP Challenge demo resource',
      mimeType: 'application/json',
      serviceName: 'x402eCash'
    },
    accepts: [{
      scheme: 'xec-prepaid-utxo',
      network: 'xec:mainnet',
      amount: '10000',
      asset: 'XEC',
      payTo: 'ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w',
      maxTimeoutSeconds: 60,
      extra: { displayAmount: '100 XEC', experimental: true, gate: 'H2A' }
    }],
    extensions: {}
  },
  approval: { status: 'payment_approved', gate: 'H3A', approved: true, performed: false }
})

const routeFor = (request: unknown = requestFixture()) => (
  `/connect/x402-authorize#request=${encodeCanonicalBase64Url(request)}`
)

const createWallet = (account: { address: string; publicKey: string } | null = {
  address: PAYER,
  publicKey: PUBLIC_KEY
}) => ({
  getX402ActiveAccount: vi.fn(() => account),
  signX402AuthorizationMessage: vi.fn(async (message: string) => {
    void message
    return {
      signature: 'opaque-tonalli-message-signature',
      publicKey: PUBLIC_KEY
    }
  })
})

const renderRoute = (wallet: TonalliH3BWalletPort, route = routeFor()) => {
  window.history.replaceState(null, '', route)
  return render(
    <MemoryRouter initialEntries={[route]}>
      <X402AuthorizeRequest wallet={wallet} nowSeconds={nowSeconds} />
    </MemoryRouter>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Gate H3B wallet confirmation route', () => {
  test('valid request renders the exact authorization-only card without signing by default', async () => {
    const wallet = createWallet()
    const historySpy = vi.spyOn(window.history, 'replaceState')
    renderRoute(wallet)

    expect(await screen.findByRole('heading', { name: 'Wallet confirmation required' })).toBeTruthy()
    expect(screen.getByText('Gate H3B — Tonalli Authorization Proof')).toBeTruthy()
    expect(screen.getByText('x402eCash', { selector: 'dd' })).toBeTruthy()
    expect(screen.getAllByText('100 XEC').length).toBeGreaterThan(0)
    expect(screen.getByText('10000')).toBeTruthy()
    expect(screen.getByText('xec:mainnet')).toBeTruthy()
    expect(screen.getByText('XEC')).toBeTruthy()
    expect(screen.getByText('Approved')).toBeTruthy()
    expect(screen.getAllByText('AUTHORIZATION DRY RUN').length).toBeGreaterThan(0)
    expect(screen.getByText(/This signs an authorization proof only/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Sign authorization proof' }) as HTMLButtonElement).disabled).toBe(false)
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(historySpy).toHaveBeenCalledWith(history.state, '', '/connect/x402-authorize')
    expect(window.location.hash).toBe('')
  })

  test('Reject signs nothing, becomes terminal and exposes only an explicit callback', async () => {
    const wallet = createWallet()
    renderRoute(wallet)
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))

    expect(await screen.findByRole('heading', { name: 'Authorization request rejected' })).toBeTruthy()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Sign authorization proof' })).toBeNull()
    expect(screen.getAllByText('false', { selector: 'dd' })).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Return to x402eCash' }).getAttribute('href')).toBe(
      `https://x402.ecash.mx/experiments/webmcp/#h3bStatus=rejected&challengeId=${CHALLENGE}`
    )
    expect(window.location.pathname).toBe('/connect/x402-authorize')
  })

  test('explicit Sign invokes the wallet once and returns a signed authorization-only result', async () => {
    const wallet = createWallet()
    renderRoute(wallet)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign authorization proof' }))

    expect(await screen.findByRole('heading', { name: 'Authorization proof signed' })).toBeTruthy()
    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/No transaction was created or broadcast/)).toBeTruthy()
    const callback = screen.getByRole('link', { name: 'Return to x402eCash' }).getAttribute('href')
    expect(callback).toMatch(
      new RegExp(`^https://x402\\.ecash\\.mx/experiments/webmcp/#h3bStatus=signed&challengeId=${CHALLENGE}&proof=[A-Za-z0-9_-]+$`)
    )
    expect(window.location.pathname).toBe('/connect/x402-authorize')
  })

  test('double click cannot invoke the signing primitive twice', async () => {
    let resolveSignature: ((value: { signature: string; publicKey: string }) => void) | undefined
    const pending = new Promise<{ signature: string; publicKey: string }>((resolve) => {
      resolveSignature = resolve
    })
    const wallet = createWallet()
    wallet.signX402AuthorizationMessage.mockImplementation(() => pending)
    renderRoute(wallet)
    const sign = await screen.findByRole('button', { name: 'Sign authorization proof' })

    fireEvent.click(sign)
    fireEvent.click(sign)
    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledTimes(1)
    resolveSignature?.({ signature: 'opaque-tonalli-message-signature', publicKey: PUBLIC_KEY })
    expect(await screen.findByRole('heading', { name: 'Authorization proof signed' })).toBeTruthy()
    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledTimes(1)
  })

  test('remains explicitly actionable under the application StrictMode boundary', async () => {
    const wallet = createWallet()
    const route = routeFor()
    window.history.replaceState(null, '', route)
    render(
      <StrictMode>
        <MemoryRouter initialEntries={[route]}>
          <X402AuthorizeRequest wallet={wallet} nowSeconds={nowSeconds} />
        </MemoryRouter>
      </StrictMode>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Sign authorization proof' }))
    expect(await screen.findByRole('heading', { name: 'Authorization proof signed' })).toBeTruthy()
    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledTimes(1)
  })

  test('cancels the active request and binds a same-route navigation to the new challenge', async () => {
    const wallet = createWallet()
    const firstRoute = routeFor()
    const nextRequest = { ...requestFixture(), challengeId: 'AgMEBQYHCAkKCwwNDg8QEQ' }
    const router = createMemoryRouter([{
      path: '/connect/x402-authorize',
      element: <X402AuthorizeRequest wallet={wallet} nowSeconds={nowSeconds} />
    }], { initialEntries: [firstRoute] })
    window.history.replaceState(null, '', firstRoute)
    render(<RouterProvider router={router} />)
    await screen.findByRole('button', { name: 'Sign authorization proof' })

    await act(async () => {
      await router.navigate(routeFor(nextRequest))
    })
    await waitFor(() => expect(wallet.getX402ActiveAccount).toHaveBeenCalledTimes(2))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign authorization proof' }))
    await screen.findByRole('heading', { name: 'Authorization proof signed' })

    const message = wallet.signX402AuthorizationMessage.mock.calls[0][0]
    expect(message).toContain('"challengeId":"AgMEBQYHCAkKCwwNDg8QEQ"')
    expect(message).not.toContain(`"challengeId":"${CHALLENGE}"`)
    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledTimes(1)
  })

  test('wallet unavailable fails closed without rendering signing controls or clearing the fragment', async () => {
    const wallet = createWallet(null)
    const route = routeFor()
    renderRoute(wallet, route)

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign authorization proof' })).toBeNull()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(window.location.hash).toContain('request=')
  })

  test('malformed or non-approved request never renders signing controls', async () => {
    const wallet = createWallet()
    const malformed = requestFixture()
    malformed.approval.approved = false
    renderRoute(wallet, routeFor(malformed))

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign authorization proof' })).toBeNull()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('signer failure leaves no stale or retryable signing control', async () => {
    const wallet = createWallet()
    wallet.signX402AuthorizationMessage.mockRejectedValue(new Error('internal detail'))
    renderRoute(wallet)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign authorization proof' }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy())
    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Sign authorization proof' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Return to x402eCash' })).toBeNull()
  })
})
