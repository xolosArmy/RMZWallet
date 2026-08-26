import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useLocation } from 'react-router-dom'
import TopBar from '../components/TopBar'
import {
  createRejectedH3BCallbackUrl,
  createSignedH3BCallbackUrl,
  createTonalliH3BAuthorizationSession,
  type TonalliH3BAuthorizationSession,
  type TonalliH3BRejectedResult,
  type TonalliH3BSignedResult,
  type TonalliH3BWalletAccount,
  type TonalliH3BWalletPort
} from '../integrations/x402/h3b/TonalliH3BAuthorizationProof'
import {
  parseTonalliH3BRequest,
  type TonalliH3BRequest
} from '../integrations/x402/h3b/TonalliH3BContract'
import {
  X402StoredWalletActivationError,
  isCanonicalX402WalletAccount,
  xolosWalletService,
  type X402StoredWalletActivationResult
} from '../services/XolosWalletService'

type ViewIdentity = Readonly<{
  generation: number
  transportKey: string
}>

type RequestView = ViewIdentity & Readonly<{
  request: TonalliH3BRequest
}>

type UnlockView = RequestView & Readonly<{
  status: 'unlock-required' | 'unlocking'
  unlockFailed: boolean
}>

type ReadyView = ViewIdentity & Readonly<{
  status: 'ready' | 'signing'
  session: TonalliH3BAuthorizationSession
}>

type TerminalView = ViewIdentity & (
  | Readonly<{
    status: 'rejected'
    result: TonalliH3BRejectedResult
    callbackUrl: string
  }>
  | Readonly<{
    status: 'signed'
    result: TonalliH3BSignedResult
    callbackUrl: string
  }>
)

type FailureReason =
  | 'invalid-request'
  | 'url-cleanup-failed'
  | 'wallet-unavailable'
  | 'activation-failed'
  | 'profile-choice-required'

type ViewState =
  | Readonly<{
    status: 'loading'
    transportKey: string
  }>
  | UnlockView
  | ReadyView
  | TerminalView
  | Readonly<{
    status: 'expired'
    transportKey: string
  }>
  | Readonly<{
    status: 'failed'
    transportKey: string
    reason: FailureReason
  }>

type X402AuthorizeWalletPort = TonalliH3BWalletPort & Readonly<{
  hasEncryptedWalletOnDevice(): boolean
  activateStoredWalletForX402(password: string): Promise<X402StoredWalletActivationResult>
}>

const definitionValueStyle = Object.freeze({ margin: 0, minWidth: 0 })

const readNowSeconds = (nowSeconds?: () => number): number => (
  nowSeconds?.() ?? Math.floor(Date.now() / 1000)
)

const isExpired = (request: TonalliH3BRequest, nowSeconds?: () => number): boolean => {
  const now = readNowSeconds(nowSeconds)
  return !Number.isSafeInteger(now) || now >= request.expiresAt
}

const isValidActiveAccount = (
  account: TonalliH3BWalletAccount | null
): account is TonalliH3BWalletAccount => isCanonicalX402WalletAccount(account)

export type X402AuthorizeRequestProps = Readonly<{
  wallet?: X402AuthorizeWalletPort
  nowSeconds?: () => number
}>

export default function X402AuthorizeRequest({
  wallet = xolosWalletService,
  nowSeconds
}: X402AuthorizeRequestProps) {
  const location = useLocation()
  const transportKey = JSON.stringify([location.pathname, location.search, location.hash])
  const [view, setView] = useState<ViewState>({ status: 'loading', transportKey })
  const [password, setPassword] = useState('')
  const actionLocked = useRef(false)
  const activeGeneration = useRef(0)
  const activeSession = useRef<TonalliH3BAuthorizationSession | null>(null)

  useEffect(() => {
    let active = true
    let expiryTimer: number | undefined
    const generation = activeGeneration.current + 1
    activeGeneration.current = generation
    actionLocked.current = false
    activeSession.current?.cancel()
    activeSession.current = null
    setPassword('')

    const fail = (reason: FailureReason) => {
      if (!active || activeGeneration.current !== generation) return
      actionLocked.current = true
      activeGeneration.current += 1
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer)
      activeSession.current?.cancel()
      activeSession.current = null
      setPassword('')
      setView({ status: 'failed', transportKey, reason })
    }

    const expire = () => {
      if (!active || activeGeneration.current !== generation) return
      actionLocked.current = true
      activeGeneration.current += 1
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer)
      activeSession.current?.cancel()
      activeSession.current = null
      setPassword('')
      setView({ status: 'expired', transportKey })
    }

    const prepare = async () => {
      let request: TonalliH3BRequest
      try {
        request = parseTonalliH3BRequest({
          hash: location.hash,
          search: location.search,
          nowSeconds: readNowSeconds(nowSeconds)
        })
      } catch {
        fail('invalid-request')
        return
      }

      try {
        window.history.replaceState(window.history.state, '', location.pathname)
        if (window.location.hash !== '' || window.location.search !== '') {
          throw new Error('H3B_URL_CLEANUP_FAILED')
        }
      } catch {
        fail('url-cleanup-failed')
        return
      }

      if (!active || activeGeneration.current !== generation) return
      const now = readNowSeconds(nowSeconds)
      if (!Number.isSafeInteger(now) || now >= request.expiresAt) {
        expire()
        return
      }
      expiryTimer = window.setTimeout(expire, (request.expiresAt - now) * 1000)

      let account: TonalliH3BWalletAccount | null
      try {
        account = wallet.getX402ActiveAccount()
      } catch {
        fail('wallet-unavailable')
        return
      }

      if (account !== null && !isValidActiveAccount(account)) {
        fail('wallet-unavailable')
        return
      }

      if (account === null) {
        let encryptedWalletExists = false
        try {
          encryptedWalletExists = wallet.hasEncryptedWalletOnDevice()
        } catch {
          fail('wallet-unavailable')
          return
        }
        if (!encryptedWalletExists) {
          fail('wallet-unavailable')
          return
        }
        setView({
          status: 'unlock-required',
          request,
          generation,
          transportKey,
          unlockFailed: false
        })
        return
      }

      try {
        const session = await createTonalliH3BAuthorizationSession(request, wallet, { nowSeconds })
        if (!active || activeGeneration.current !== generation) {
          session.cancel()
          return
        }
        if (
          !isValidActiveAccount(session.account) ||
          session.account.address !== account.address ||
          session.account.publicKey !== account.publicKey
        ) {
          session.cancel()
          fail('wallet-unavailable')
          return
        }
        activeSession.current = session
        setView({ status: 'ready', session, generation, transportKey })
      } catch {
        if (!active || activeGeneration.current !== generation) return
        if (isExpired(request, nowSeconds)) expire()
        else fail('wallet-unavailable')
      }
    }

    void prepare()
    return () => {
      active = false
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer)
      if (activeGeneration.current === generation) activeGeneration.current += 1
      actionLocked.current = true
      activeSession.current?.cancel()
      activeSession.current = null
    }
  }, [location.hash, location.pathname, location.search, nowSeconds, transportKey, wallet])

  const expire = (generation: number, currentTransportKey: string) => {
    if (generation !== activeGeneration.current) return
    actionLocked.current = true
    activeGeneration.current += 1
    activeSession.current?.cancel()
    activeSession.current = null
    setPassword('')
    setView({ status: 'expired', transportKey: currentTransportKey })
  }

  const fail = (
    generation: number,
    currentTransportKey: string,
    reason: FailureReason
  ) => {
    if (generation !== activeGeneration.current) return
    actionLocked.current = true
    activeGeneration.current += 1
    activeSession.current?.cancel()
    activeSession.current = null
    setPassword('')
    setView({ status: 'failed', transportKey: currentTransportKey, reason })
  }

  const unlock = async (unlockView: UnlockView) => {
    if (
      actionLocked.current ||
      unlockView.status !== 'unlock-required' ||
      unlockView.generation !== activeGeneration.current ||
      password.length === 0
    ) return

    if (isExpired(unlockView.request, nowSeconds)) {
      expire(unlockView.generation, unlockView.transportKey)
      return
    }

    const submittedPassword = password
    actionLocked.current = true
    setPassword('')
    setView({ ...unlockView, status: 'unlocking', unlockFailed: false })

    let activationCompleted = false
    try {
      const result = await wallet.activateStoredWalletForX402(submittedPassword)
      if (unlockView.generation !== activeGeneration.current) return

      if (isExpired(unlockView.request, nowSeconds)) {
        expire(unlockView.generation, unlockView.transportKey)
        return
      }

      if (result.status === 'choice-required') {
        fail(
          unlockView.generation,
          unlockView.transportKey,
          'profile-choice-required'
        )
        return
      }

      let account: TonalliH3BWalletAccount | null
      try {
        account = wallet.getX402ActiveAccount()
      } catch {
        fail(unlockView.generation, unlockView.transportKey, 'activation-failed')
        return
      }
      if (
        !isValidActiveAccount(account) ||
        account.address !== result.account.address ||
        account.publicKey !== result.account.publicKey
      ) {
        fail(unlockView.generation, unlockView.transportKey, 'activation-failed')
        return
      }
      activationCompleted = true

      if (isExpired(unlockView.request, nowSeconds)) {
        expire(unlockView.generation, unlockView.transportKey)
        return
      }

      const session = await createTonalliH3BAuthorizationSession(
        unlockView.request,
        wallet,
        { nowSeconds }
      )
      if (unlockView.generation !== activeGeneration.current) {
        session.cancel()
        return
      }
      if (
        !isValidActiveAccount(session.account) ||
        session.account.address !== account.address ||
        session.account.publicKey !== account.publicKey
      ) {
        session.cancel()
        fail(unlockView.generation, unlockView.transportKey, 'activation-failed')
        return
      }
      activeSession.current = session
      actionLocked.current = false
      setView({
        status: 'ready',
        session,
        generation: unlockView.generation,
        transportKey: unlockView.transportKey
      })
    } catch (error) {
      if (unlockView.generation !== activeGeneration.current) return
      if (isExpired(unlockView.request, nowSeconds)) {
        expire(unlockView.generation, unlockView.transportKey)
        return
      }
      if (
        !activationCompleted &&
        error instanceof X402StoredWalletActivationError &&
        error.reason === 'unlock-failed'
      ) {
        actionLocked.current = false
        setView({ ...unlockView, status: 'unlock-required', unlockFailed: true })
        return
      }
      fail(unlockView.generation, unlockView.transportKey, 'activation-failed')
    }
  }

  const reject = (ready: ReadyView) => {
    if (
      actionLocked.current ||
      ready.status !== 'ready' ||
      ready.generation !== activeGeneration.current
    ) return
    if (isExpired(ready.session.request, nowSeconds)) {
      expire(ready.generation, ready.transportKey)
      return
    }
    actionLocked.current = true
    try {
      const result = ready.session.reject()
      const callbackUrl = createRejectedH3BCallbackUrl(ready.session.request)
      activeGeneration.current += 1
      activeSession.current = null
      setView({
        status: 'rejected',
        generation: ready.generation,
        transportKey: ready.transportKey,
        result,
        callbackUrl
      })
    } catch {
      fail(ready.generation, ready.transportKey, 'activation-failed')
    }
  }

  const sign = async (ready: ReadyView) => {
    if (
      actionLocked.current ||
      ready.status !== 'ready' ||
      ready.generation !== activeGeneration.current
    ) return
    actionLocked.current = true
    setView({ ...ready, status: 'signing' })
    try {
      const result = await ready.session.sign()
      if (ready.generation !== activeGeneration.current) return
      const callbackUrl = createSignedH3BCallbackUrl(ready.session.request, result.proof)
      activeGeneration.current += 1
      activeSession.current = null
      setView({
        status: 'signed',
        generation: ready.generation,
        transportKey: ready.transportKey,
        result,
        callbackUrl
      })
    } catch {
      if (ready.generation !== activeGeneration.current) return
      if (isExpired(ready.session.request, nowSeconds)) {
        expire(ready.generation, ready.transportKey)
      } else {
        fail(ready.generation, ready.transportKey, 'activation-failed')
      }
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header section-header--stacked">
        <p className="eyebrow">x402eCash WebMCP Challenge</p>
        <h1 className="section-title">Gate H3B — Tonalli Authorization Proof</h1>
        <p className="muted">
          Tonalli validates a short-lived H3A-approved request and asks for a second,
          explicit wallet confirmation.
        </p>
      </header>

      {(view.transportKey !== transportKey || view.status === 'loading') && (
        <section className="card" aria-live="polite">
          <p>Validating the authorization request and active wallet account…</p>
        </section>
      )}

      {view.status === 'failed' && view.transportKey === transportKey && (
        <StoppedCard reason={view.reason} />
      )}

      {view.status === 'expired' && view.transportKey === transportKey && (
        <section className="card" aria-labelledby="h3b-expired-title">
          <h2 id="h3b-expired-title">Authorization request expired</h2>
          <p className="error" role="alert">
            This request expired. Start a completely fresh authorization request from x402eCash.
            Nothing was signed and no payment was performed.
          </p>
        </section>
      )}

      {(view.status === 'unlock-required' || view.status === 'unlocking') &&
        view.transportKey === transportKey && (
          <UnlockCard
            view={view}
            password={password}
            onPasswordChange={setPassword}
            onSubmit={(event) => {
              event.preventDefault()
              void unlock(view)
            }}
          />
        )}

      {(view.status === 'ready' || view.status === 'signing') && view.transportKey === transportKey && (
        <AuthorizationCard
          view={view}
          onReject={() => reject(view)}
          onSign={() => void sign(view)}
        />
      )}

      {(view.status === 'rejected' || view.status === 'signed') && view.transportKey === transportKey && (
        <TerminalResult view={view} />
      )}
    </div>
  )
}

function StoppedCard({ reason }: Readonly<{ reason: FailureReason }>) {
  const detail = reason === 'profile-choice-required'
    ? 'Wallet activation requires profile selection. Open Tonalli normally, complete wallet activation, then start a fresh authorization request.'
    : reason === 'url-cleanup-failed'
      ? 'The request could not be removed safely from this tab\'s URL.'
      : 'The request is invalid, expired, no longer active, or the wallet is unavailable.'

  return (
    <section className="card" aria-labelledby="h3b-stopped-title">
      <h2 id="h3b-stopped-title">Authorization stopped safely</h2>
      <p className="error" role="alert">
        {detail} Authorization did not complete and no valid proof was produced.
        No payment was performed.
      </p>
    </section>
  )
}

function UnlockCard({
  view,
  password,
  onPasswordChange,
  onSubmit
}: Readonly<{
  view: UnlockView
  password: string
  onPasswordChange(value: string): void
  onSubmit(event: FormEvent<HTMLFormElement>): void
}>) {
  const busy = view.status === 'unlocking'
  return (
    <form className="card" aria-labelledby="h3b-unlock-title" onSubmit={onSubmit}>
      <p className="card-kicker">EXISTING WALLET</p>
      <h2 id="h3b-unlock-title">Unlock Tonalli Wallet to continue</h2>
      <p className="muted">
        This unlocks the existing wallet in this tab. It does not make a payment or sign yet.
        A second explicit confirmation will still be required.
      </p>
      <label htmlFor="h3b-wallet-password">Wallet password</label>
      <input
        id="h3b-wallet-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => onPasswordChange(event.target.value)}
        disabled={busy}
        required
      />
      {view.unlockFailed && (
        <p className="error" role="alert">
          The wallet could not be unlocked. Check the password and try again while this request is valid.
        </p>
      )}
      <div className="actions">
        <button className="cta primary" type="submit" disabled={busy || password.length === 0}>
          {busy ? 'Unlocking Tonalli Wallet…' : 'Unlock existing wallet'}
        </button>
      </div>
    </form>
  )
}

function AuthorizationCard({
  view,
  onReject,
  onSign
}: Readonly<{
  view: ReadyView
  onReject(): void
  onSign(): void
}>) {
  const acceptance = view.session.request.paymentRequired.accepts[0]
  const busy = view.status === 'signing'
  return (
    <section className="card highlight" aria-labelledby="h3b-confirm-title" aria-describedby="h3b-boundary">
      <p className="card-kicker">AUTHORIZATION DRY RUN</p>
      <h2 id="h3b-confirm-title">Wallet confirmation required</h2>
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 0.35fr) minmax(0, 1fr)', gap: '8px 16px' }}>
        <dt>Requesting app</dt><dd style={definitionValueStyle}>x402eCash</dd>
        <dt>Origin</dt><dd className="address-box" style={definitionValueStyle}>{view.session.request.sourceOrigin}</dd>
        <dt>Resource</dt><dd className="address-box" style={definitionValueStyle}>{view.session.request.paymentRequired.resource.url}</dd>
        <dt>Amount</dt><dd style={definitionValueStyle}>{acceptance.extra.displayAmount}</dd>
        <dt>Atomic amount</dt><dd style={definitionValueStyle}>{acceptance.amount}</dd>
        <dt>Network</dt><dd style={definitionValueStyle}>{acceptance.network}</dd>
        <dt>Asset</dt><dd style={definitionValueStyle}>{acceptance.asset}</dd>
        <dt>Destination</dt><dd className="address-box" style={definitionValueStyle}>{acceptance.payTo}</dd>
        <dt>H3A approval</dt><dd style={definitionValueStyle}>Approved</dd>
        <dt>Mode</dt><dd style={definitionValueStyle}>AUTHORIZATION DRY RUN</dd>
      </dl>
      <p id="h3b-boundary" className="warning">
        This signs an authorization proof only.<br />
        No payment.<br />
        No transaction.<br />
        No PAYMENT-SIGNATURE.<br />
        No resource unlock.
      </p>
      <div className="actions">
        <button className="cta outline" type="button" disabled={busy} onClick={onReject}>
          Reject
        </button>
        <button className="cta primary" type="button" disabled={busy} onClick={onSign}>
          {busy ? 'Signing authorization proof…' : 'Sign authorization proof'}
        </button>
      </div>
    </section>
  )
}

function TerminalResult({ view }: Readonly<{ view: TerminalView }>) {
  const signed = view.status === 'signed'
  return (
    <section className="card" aria-labelledby="h3b-result-title">
      <h2 id="h3b-result-title">
        {signed ? 'Authorization proof signed' : 'Authorization request rejected'}
      </h2>
      <p className={signed ? 'success' : 'info'} role="status">
        {signed
          ? 'Tonalli signed the authorization-only message. No transaction was created or broadcast, and no payment was performed.'
          : 'The wallet user rejected the request. Nothing was signed and no payment was performed.'}
      </p>
      <dl>
        <dt>Challenge</dt><dd className="address-box" style={definitionValueStyle}>{view.result.challengeId}</dd>
        <dt>Signed</dt><dd style={definitionValueStyle}>{String(view.result.signed)}</dd>
        <dt>Payment performed</dt><dd style={definitionValueStyle}>{String(view.result.payment.performed)}</dd>
      </dl>
      <div className="actions">
        <a className="cta primary" href={view.callbackUrl}>Return to x402eCash</a>
      </div>
    </section>
  )
}
