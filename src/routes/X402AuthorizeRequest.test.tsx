// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { BrowserRouter, createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router-dom'
import {
  decodeCanonicalBase64Url,
  encodeCanonicalBase64Url
} from '../integrations/x402/h3b/TonalliH3BContract'
import { X402StoredWalletActivationError } from '../services/XolosWalletService'
import type { X402StoredWalletActivationResult } from '../services/XolosWalletService'
import X402AuthorizeRequest from './X402AuthorizeRequest'

vi.mock('../components/TopBar', () => ({ default: () => <div>Tonalli Wallet</div> }))

const NOW = 1_800_000_000
const CHALLENGE = 'AQIDBAUGBwgJCgsMDQ4PEA'
const PAYER = 'ecash:qpumqqygwcnt999fz3gp5nxjy66ckg6esvxaqmtclv'
const PUBLIC_KEY = '031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f'
const ACCOUNT = Object.freeze({ address: PAYER, publicKey: PUBLIC_KEY })
const OTHER_ACCOUNT = Object.freeze({
  address: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq',
  publicKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
})
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

type Account = { address: string; publicKey: string }

const activeResult = (account: Account = ACCOUNT) => ({
  status: 'active' as const,
  account
})

const createWallet = (
  initialAccount: Account | null = ACCOUNT,
  encryptedWalletExists = initialAccount === null
) => {
  const state: { account: Account | null } = { account: initialAccount }
  const forbidden = {
    createNewWallet: vi.fn(),
    restoreFromMnemonic: vi.fn(),
    connectWalletConnect: vi.fn(),
    selectUtxos: vi.fn(),
    createTransaction: vi.fn(),
    signTransaction: vi.fn(),
    sendPaymentSignature: vi.fn(),
    broadcastTx: vi.fn()
  }
  const wallet = {
    getX402ActiveAccount: vi.fn(() => state.account),
    hasEncryptedWalletOnDevice: vi.fn(() => encryptedWalletExists),
    activateStoredWalletForX402: vi.fn(async (
      _password: string
    ): Promise<X402StoredWalletActivationResult> => {
      void _password
      state.account = ACCOUNT
      return activeResult()
    }),
    signX402AuthorizationMessage: vi.fn(async (_message: string) => {
      void _message
      return {
        signature: 'opaque-tonalli-message-signature',
        publicKey: PUBLIC_KEY
      }
    }),
    state,
    forbidden
  }
  return wallet
}

type TestWallet = ReturnType<typeof createWallet>

const renderMemoryRoute = (
  wallet: TestWallet,
  route = routeFor(),
  clock: () => number = nowSeconds
) => render(
  <MemoryRouter initialEntries={[route]}>
    <X402AuthorizeRequest wallet={wallet} nowSeconds={clock} />
  </MemoryRouter>
)

const renderRoute = (
  wallet: TestWallet,
  route = routeFor(),
  clock: () => number = nowSeconds
) => {
  window.history.replaceState(null, '', route)
  return renderMemoryRoute(wallet, route, clock)
}

const enterPasswordAndUnlock = async (password: string) => {
  const input = await screen.findByLabelText('Wallet password')
  fireEvent.change(input, { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Unlock existing wallet' }))
  return input as HTMLInputElement
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})

describe('Gate H3B wallet confirmation route', () => {
  test('valid active wallet scrubs the URL before account access and preserves the exact card', async () => {
    const events: string[] = []
    const wallet = createWallet()
    wallet.getX402ActiveAccount.mockImplementation(() => {
      events.push(`account:${window.location.search}:${window.location.hash}`)
      return wallet.state.account
    })
    const route = routeFor()
    window.history.replaceState(null, '', route)
    const nativeReplaceState = window.history.replaceState.bind(window.history)
    const historySpy = vi.spyOn(window.history, 'replaceState').mockImplementation((...args) => {
      events.push('cleanup')
      nativeReplaceState(...args)
    })
    renderMemoryRoute(wallet, route)

    expect(await screen.findByRole('heading', { name: 'Wallet confirmation required' })).toBeTruthy()
    expect(events[0]).toBe('cleanup')
    expect(events.slice(1).every((event) => event === 'account::')).toBe(true)
    expect(screen.getByText('Gate H3B — Tonalli Authorization Proof')).toBeTruthy()
    expect(screen.getByText('x402eCash', { selector: 'dd' })).toBeTruthy()
    expect(screen.getByText('https://x402.ecash.mx', { selector: 'dd' })).toBeTruthy()
    expect(screen.getByText('https://api.x402.ecash.mx/v1/resource/demo', { selector: 'dd' })).toBeTruthy()
    expect(screen.getAllByText('100 XEC').length).toBeGreaterThan(0)
    expect(screen.getByText('10000')).toBeTruthy()
    expect(screen.getByText('xec:mainnet')).toBeTruthy()
    expect(screen.getByText('XEC')).toBeTruthy()
    expect(screen.getByText('ecash:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyquz9y96w')).toBeTruthy()
    expect(screen.getByText('Approved')).toBeTruthy()
    expect(screen.getAllByText('AUTHORIZATION DRY RUN').length).toBeGreaterThan(0)
    expect(screen.getByText(/This signs an authorization proof only/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Sign authorization proof' }) as HTMLButtonElement).disabled).toBe(false)
    expect(wallet.activateStoredWalletForX402).not.toHaveBeenCalled()
    expect(wallet.hasEncryptedWalletOnDevice).not.toHaveBeenCalled()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(historySpy).toHaveBeenCalledWith(history.state, '', '/connect/x402-authorize')
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('')
  })

  test('Reject signs nothing, becomes terminal and exposes only the explicit canonical callback', async () => {
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
  })

  test('explicit Sign invokes the wallet once and returns the unchanged authorization-only result', async () => {
    const wallet = createWallet()
    renderRoute(wallet)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign authorization proof' }))

    expect(await screen.findByRole('heading', { name: 'Authorization proof signed' })).toBeTruthy()
    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/No transaction was created or broadcast/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Return to x402eCash' }).getAttribute('href')).toMatch(
      new RegExp(`^https://x402\\.ecash\\.mx/experiments/webmcp/#h3bStatus=signed&challengeId=${CHALLENGE}&proof=[A-Za-z0-9_-]+$`)
    )
  })

  test('double Sign click cannot invoke the signing primitive twice', async () => {
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

  test('cancels the active request and binds same-route navigation to the new challenge', async () => {
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
    await waitFor(() => expect(wallet.getX402ActiveAccount.mock.calls.length).toBeGreaterThanOrEqual(4))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign authorization proof' }))
    await screen.findByRole('heading', { name: 'Authorization proof signed' })

    const message = wallet.signX402AuthorizationMessage.mock.calls[0][0]
    expect(message).toContain('"challengeId":"AgMEBQYHCAkKCwwNDg8QEQ"')
    expect(message).not.toContain(`"challengeId":"${CHALLENGE}"`)
    expect(wallet.signX402AuthorizationMessage).toHaveBeenCalledTimes(1)
  })

  test('valid request plus locked stored wallet enters the dedicated in-tab unlock state', async () => {
    const wallet = createWallet(null, true)
    renderRoute(wallet)

    expect(await screen.findByRole('heading', { name: 'Unlock Tonalli Wallet to continue' })).toBeTruthy()
    const input = screen.getByLabelText('Wallet password') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('current-password')
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('')
    expect(wallet.hasEncryptedWalletOnDevice).toHaveBeenCalledTimes(1)
    expect(wallet.activateStoredWalletForX402).not.toHaveBeenCalled()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Sign authorization proof' })).toBeNull()
  })

  test('BrowserRouter production routing scrubs the request before showing the password control', async () => {
    const wallet = createWallet(null, true)
    window.history.replaceState(null, '', routeFor())
    render(
      <BrowserRouter>
        <X402AuthorizeRequest wallet={wallet} nowSeconds={nowSeconds} />
      </BrowserRouter>
    )

    expect(await screen.findByRole('heading', { name: 'Unlock Tonalli Wallet to continue' })).toBeTruthy()
    expect(window.location.pathname).toBe('/connect/x402-authorize')
    expect(window.location.hash).toBe('')
    expect(window.location.search).toBe('')
    expect(screen.getByLabelText('Wallet password')).toBeTruthy()
    expect(wallet.getX402ActiveAccount).toHaveBeenCalled()
  })

  test('non-canonical uppercase active address fails closed before session creation', async () => {
    const wallet = createWallet({ ...ACCOUNT, address: ACCOUNT.address.toUpperCase() }, true)
    renderRoute(wallet)

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(window.location.hash).toBe('')
    expect(wallet.hasEncryptedWalletOnDevice).not.toHaveBeenCalled()
    expect(wallet.activateStoredWalletForX402).not.toHaveBeenCalled()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('an off-curve or address-unbound active account fails closed before session creation', async () => {
    const wallet = createWallet({
      address: 'ecash:qzklee2022djz48rcdsmhclh6swmqc6hzuqf9vutqh',
      publicKey: `02${'11'.repeat(32)}`
    }, true)
    renderRoute(wallet)

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(wallet.hasEncryptedWalletOnDevice).not.toHaveBeenCalled()
    expect(wallet.activateStoredWalletForX402).not.toHaveBeenCalled()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('active identity changing while the session hash is pending fails closed', async () => {
    let resolveDigest: ((value: ArrayBuffer) => void) | undefined
    const pendingDigest = new Promise<ArrayBuffer>((resolve) => {
      resolveDigest = resolve
    })
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(
      async () => await pendingDigest
    )
    const wallet = createWallet()
    renderRoute(wallet)
    await waitFor(() => expect(digest).toHaveBeenCalledTimes(1))

    wallet.state.account = OTHER_ACCOUNT
    await act(async () => {
      resolveDigest?.(new ArrayBuffer(32))
      await Promise.resolve()
    })

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign authorization proof' })).toBeNull()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('valid request with no encrypted wallet fails closed without offering identity replacement', async () => {
    const wallet = createWallet(null, false)
    renderRoute(wallet)

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(window.location.hash).toBe('')
    expect(screen.queryByText(/Create wallet/i)).toBeNull()
    expect(screen.queryByText(/Restore wallet/i)).toBeNull()
    expect(screen.queryByText(/WalletConnect/i)).toBeNull()
    expect(wallet.activateStoredWalletForX402).not.toHaveBeenCalled()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    for (const forbidden of Object.values(wallet.forbidden)) expect(forbidden).not.toHaveBeenCalled()
  })

  test('malformed or non-approved request never clears transport or inspects the wallet', async () => {
    const wallet = createWallet()
    const malformed = requestFixture()
    malformed.approval.approved = false
    renderRoute(wallet, routeFor(malformed))

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(window.location.hash).toContain('request=')
    expect(wallet.getX402ActiveAccount).not.toHaveBeenCalled()
    expect(wallet.hasEncryptedWalletOnDevice).not.toHaveBeenCalled()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test.each(['throw', 'no-op'] as const)(
    'URL cleanup %s fails closed before any wallet operation',
    async (mode) => {
      const wallet = createWallet(null, true)
      const route = routeFor()
      window.history.replaceState(null, '', route)
      const spy = vi.spyOn(window.history, 'replaceState')
      if (mode === 'throw') spy.mockImplementation(() => { throw new Error('blocked') })
      else spy.mockImplementation(() => undefined)
      renderMemoryRoute(wallet, route)

      expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
      expect(screen.getByText(/could not be removed safely/)).toBeTruthy()
      expect(wallet.getX402ActiveAccount).not.toHaveBeenCalled()
      expect(wallet.hasEncryptedWalletOnDevice).not.toHaveBeenCalled()
      expect(wallet.activateStoredWalletForX402).not.toHaveBeenCalled()
      expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    }
  )

  test('wrong password clears the input, stays retryable, and signs nothing', async () => {
    const wallet = createWallet(null, true)
    wallet.activateStoredWalletForX402
      .mockRejectedValueOnce(new X402StoredWalletActivationError('unlock-failed'))
      .mockImplementationOnce(async () => {
        wallet.state.account = ACCOUNT
        return activeResult()
      })
    renderRoute(wallet)

    await enterPasswordAndUnlock('wrong-password')
    expect(await screen.findByText(/could not be unlocked/)).toBeTruthy()
    expect((screen.getByLabelText('Wallet password') as HTMLInputElement).value).toBe('')
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Return to x402eCash' })).toBeNull()

    await enterPasswordAndUnlock('correct-password')
    expect(await screen.findByRole('heading', { name: 'Wallet confirmation required' })).toBeTruthy()
    expect(wallet.activateStoredWalletForX402).toHaveBeenCalledTimes(2)
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('failure after successful decryption is terminal and never presented as a password retry', async () => {
    const wallet = createWallet(null, true)
    wallet.activateStoredWalletForX402.mockRejectedValue(new Error('private activation detail'))
    renderRoute(wallet)
    await enterPasswordAndUnlock('correct-password')

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(screen.queryByLabelText('Wallet password')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign authorization proof' })).toBeNull()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Return to x402eCash' })).toBeNull()
  })

  test('full activation re-reads a valid public account before exposing the second confirmation', async () => {
    const wallet = createWallet(null, true)
    renderRoute(wallet)
    await enterPasswordAndUnlock('correct-password')

    expect(await screen.findByRole('heading', { name: 'Wallet confirmation required' })).toBeTruthy()
    expect(wallet.activateStoredWalletForX402).toHaveBeenCalledWith('correct-password')
    expect(wallet.getX402ActiveAccount.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('unlocked identity changing while the session hash is pending fails closed', async () => {
    let resolveDigest: ((value: ArrayBuffer) => void) | undefined
    const pendingDigest = new Promise<ArrayBuffer>((resolve) => {
      resolveDigest = resolve
    })
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(
      async () => await pendingDigest
    )
    const wallet = createWallet(null, true)
    renderRoute(wallet)
    await enterPasswordAndUnlock('correct-password')
    await waitFor(() => expect(digest).toHaveBeenCalledTimes(1))

    wallet.state.account = OTHER_ACCOUNT
    await act(async () => {
      resolveDigest?.(new ArrayBuffer(32))
      await Promise.resolve()
    })

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign authorization proof' })).toBeNull()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('decrypt-only success with no active account fails closed', async () => {
    const wallet = createWallet(null, true)
    wallet.activateStoredWalletForX402.mockResolvedValue(activeResult())
    renderRoute(wallet)
    await enterPasswordAndUnlock('decrypts-but-does-not-activate')

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign authorization proof' })).toBeNull()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('choice-required fails closed without choosing a derivation profile', async () => {
    const wallet = createWallet(null, true)
    wallet.activateStoredWalletForX402.mockResolvedValue({ status: 'choice-required' })
    renderRoute(wallet)
    await enterPasswordAndUnlock('correct-password')

    expect(await screen.findByRole('heading', { name: 'Authorization stopped safely' })).toBeTruthy()
    expect(screen.getByText(/requires profile selection/)).toBeTruthy()
    expect(wallet.activateStoredWalletForX402).toHaveBeenCalledWith('correct-password')
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Return to x402eCash' })).toBeNull()
  })

  test('request expiring while the password is entered clears controls and requires a fresh request', async () => {
    vi.useFakeTimers()
    let now = NOW
    const request = { ...requestFixture(), expiresAt: NOW + 2 }
    const wallet = createWallet(null, true)
    renderRoute(wallet, routeFor(request), () => now)
    await act(async () => { await Promise.resolve() })
    fireEvent.change(screen.getByLabelText('Wallet password'), { target: { value: 'secret' } })

    now = NOW + 2
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })

    expect(screen.getByRole('heading', { name: 'Authorization request expired' })).toBeTruthy()
    expect(screen.queryByLabelText('Wallet password')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign authorization proof' })).toBeNull()
    expect(wallet.activateStoredWalletForX402).not.toHaveBeenCalled()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('request expiring during activation ignores the stale result and creates no session', async () => {
    vi.useFakeTimers()
    let now = NOW
    let resolveActivation: ((value: ReturnType<typeof activeResult>) => void) | undefined
    const pending = new Promise<ReturnType<typeof activeResult>>((resolve) => {
      resolveActivation = resolve
    })
    const request = { ...requestFixture(), expiresAt: NOW + 2 }
    const wallet = createWallet(null, true)
    wallet.activateStoredWalletForX402.mockImplementation(() => pending)
    renderRoute(wallet, routeFor(request), () => now)
    await act(async () => { await Promise.resolve() })
    fireEvent.change(screen.getByLabelText('Wallet password'), {
      target: { value: 'correct-password' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock existing wallet' }))

    now = NOW + 2
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    wallet.state.account = ACCOUNT
    await act(async () => { resolveActivation?.(activeResult()); await Promise.resolve() })

    expect(screen.getByRole('heading', { name: 'Authorization request expired' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Wallet confirmation required' })).toBeNull()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Return to x402eCash' })).toBeNull()
  })

  test('request expiring immediately before Sign invokes no signer and yields no callback', async () => {
    let now = NOW
    const wallet = createWallet()
    renderRoute(wallet, routeFor(), () => now)
    const sign = await screen.findByRole('button', { name: 'Sign authorization proof' })

    now = NOW + 240
    fireEvent.click(sign)

    expect(await screen.findByRole('heading', { name: 'Authorization request expired' })).toBeTruthy()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Return to x402eCash' })).toBeNull()
  })

  test('request expiring immediately before Reject yields no callback', async () => {
    let now = NOW
    const wallet = createWallet()
    renderRoute(wallet, routeFor(), () => now)
    const reject = await screen.findByRole('button', { name: 'Reject' })

    now = NOW + 240
    fireEvent.click(reject)

    expect(await screen.findByRole('heading', { name: 'Authorization request expired' })).toBeTruthy()
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Authorization request rejected' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Return to x402eCash' })).toBeNull()
  })

  test('double Unlock click starts exactly one activation attempt', async () => {
    let resolveActivation: ((value: ReturnType<typeof activeResult>) => void) | undefined
    const pending = new Promise<ReturnType<typeof activeResult>>((resolve) => {
      resolveActivation = resolve
    })
    const wallet = createWallet(null, true)
    wallet.activateStoredWalletForX402.mockImplementation(() => pending)
    renderRoute(wallet)
    const input = await screen.findByLabelText('Wallet password')
    fireEvent.change(input, { target: { value: 'correct-password' } })
    const button = screen.getByRole('button', { name: 'Unlock existing wallet' })

    fireEvent.click(button)
    fireEvent.click(button)
    expect(wallet.activateStoredWalletForX402).toHaveBeenCalledTimes(1)
    wallet.state.account = ACCOUNT
    await act(async () => { resolveActivation?.(activeResult()); await Promise.resolve() })
    expect(await screen.findByRole('heading', { name: 'Wallet confirmation required' })).toBeTruthy()
  })

  test('stale activation result after unmount is ignored and cannot create signing state', async () => {
    let resolveActivation: ((value: ReturnType<typeof activeResult>) => void) | undefined
    const pending = new Promise<ReturnType<typeof activeResult>>((resolve) => {
      resolveActivation = resolve
    })
    const wallet = createWallet(null, true)
    wallet.activateStoredWalletForX402.mockImplementation(() => pending)
    const rendered = renderRoute(wallet)
    await enterPasswordAndUnlock('correct-password')
    const accountReadsBeforeUnmount = wallet.getX402ActiveAccount.mock.calls.length

    rendered.unmount()
    wallet.state.account = ACCOUNT
    await act(async () => { resolveActivation?.(activeResult()); await Promise.resolve() })

    expect(wallet.getX402ActiveAccount).toHaveBeenCalledTimes(accountReadsBeforeUnmount)
    expect(wallet.signX402AuthorizationMessage).not.toHaveBeenCalled()
  })

  test('password appears only in the activation argument and never in transport, logs, storage, proof or callback', async () => {
    const secret = 'H3B_PASSWORD_SENTINEL_7ef20d'
    const wallet = createWallet(null, true)
    const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) => (
      vi.spyOn(console, method as 'log').mockImplementation(() => undefined)
    ))
    const localSet = vi.spyOn(Storage.prototype, 'setItem')
    const historySpy = vi.spyOn(window.history, 'replaceState')
    renderRoute(wallet)
    await enterPasswordAndUnlock(secret)
    fireEvent.click(await screen.findByRole('button', { name: 'Sign authorization proof' }))
    await screen.findByRole('heading', { name: 'Authorization proof signed' })

    const callback = screen.getByRole('link', { name: 'Return to x402eCash' }).getAttribute('href') ?? ''
    const proof = new URL(callback).hash.match(/&proof=([A-Za-z0-9_-]+)$/u)?.[1] ?? ''
    const decodedProof = new TextDecoder().decode(decodeCanonicalBase64Url(proof))
    expect(wallet.activateStoredWalletForX402).toHaveBeenCalledWith(secret)
    expect(window.location.href).not.toContain(secret)
    expect(callback).not.toContain(secret)
    expect(decodedProof).not.toContain(secret)
    expect(JSON.stringify(requestFixture())).not.toContain(secret)
    expect(JSON.stringify(historySpy.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(localSet.mock.calls)).not.toContain(secret)
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret)
  })

  test('late signer result after expiry is cancelled and cannot produce a callback proof', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32))
    let now = NOW
    let resolveSignature: ((value: { signature: string; publicKey: string }) => void) | undefined
    const pending = new Promise<{ signature: string; publicKey: string }>((resolve) => {
      resolveSignature = resolve
    })
    const request = { ...requestFixture(), expiresAt: NOW + 2 }
    const wallet = createWallet()
    wallet.signX402AuthorizationMessage.mockImplementation(() => pending)
    renderRoute(wallet, routeFor(request), () => now)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: 'Sign authorization proof' }))

    now = NOW + 2
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    await act(async () => {
      resolveSignature?.({ signature: 'opaque-tonalli-message-signature', publicKey: PUBLIC_KEY })
      await Promise.resolve()
    })

    expect(screen.getByRole('heading', { name: 'Authorization request expired' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Authorization proof signed' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Return to x402eCash' })).toBeNull()
  })

  test('route source contains no persistence, wallet creation, WalletConnect, transaction, UTXO or broadcast invocation', () => {
    const source = readFileSync('src/routes/X402AuthorizeRequest.tsx', 'utf8')
    expect(source).not.toMatch(/\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/u)
    expect(source).not.toMatch(/\b(?:createNewWallet|restoreFromMnemonic|WalletConnect|selectUtxos|TxBuilder|broadcastTx|fetch)\s*\(/u)
    expect(source).not.toMatch(/\b(?:signTransaction|createTransaction|sendPaymentSignature)\s*\(/u)
    expect(source).not.toMatch(/\b(?:BroadcastChannel|analytics)\b/u)
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
