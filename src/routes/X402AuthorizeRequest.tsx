import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import TopBar from '../components/TopBar'
import {
  createRejectedH3BCallbackUrl,
  createSignedH3BCallbackUrl,
  createTonalliH3BAuthorizationSession,
  type TonalliH3BAuthorizationSession,
  type TonalliH3BRejectedResult,
  type TonalliH3BSignedResult,
  type TonalliH3BWalletPort
} from '../integrations/x402/h3b/TonalliH3BAuthorizationProof'
import { parseTonalliH3BRequest } from '../integrations/x402/h3b/TonalliH3BContract'
import { xolosWalletService } from '../services/XolosWalletService'

type ReadyView = Readonly<{
  status: 'ready' | 'signing'
  session: TonalliH3BAuthorizationSession
  generation: number
  transportKey: string
}>

type TerminalView =
  | Readonly<{
    status: 'rejected'
    session: TonalliH3BAuthorizationSession
    generation: number
    transportKey: string
    result: TonalliH3BRejectedResult
    callbackUrl: string
  }>
  | Readonly<{
    status: 'signed'
    session: TonalliH3BAuthorizationSession
    generation: number
    transportKey: string
    result: TonalliH3BSignedResult
    callbackUrl: string
  }>

type ViewState = Readonly<{
  status: 'loading' | 'error'
  transportKey: string
}> | ReadyView | TerminalView
const definitionValueStyle = Object.freeze({ margin: 0, minWidth: 0 })

export type X402AuthorizeRequestProps = Readonly<{
  wallet?: TonalliH3BWalletPort
  nowSeconds?: () => number
}>

export default function X402AuthorizeRequest({
  wallet = xolosWalletService,
  nowSeconds
}: X402AuthorizeRequestProps) {
  const location = useLocation()
  const transportKey = JSON.stringify([location.pathname, location.search, location.hash])
  const [view, setView] = useState<ViewState>({ status: 'loading', transportKey })
  const actionLocked = useRef(false)
  const activeGeneration = useRef(0)

  useEffect(() => {
    let active = true
    let session: TonalliH3BAuthorizationSession | null = null
    const generation = activeGeneration.current + 1
    activeGeneration.current = generation
    actionLocked.current = false

    const prepare = async () => {
      try {
        const request = parseTonalliH3BRequest({
          hash: location.hash,
          search: location.search,
          nowSeconds: nowSeconds?.()
        })
        session = await createTonalliH3BAuthorizationSession(request, wallet, { nowSeconds })
        if (!active) {
          session.cancel()
          return
        }

        setView({ status: 'ready', session, generation, transportKey })
        window.history.replaceState(
          window.history.state,
          '',
          location.pathname
        )
      } catch {
        session?.cancel()
        if (active) {
          actionLocked.current = true
          setView({ status: 'error', transportKey })
        }
      }
    }

    void prepare()
    return () => {
      active = false
      if (activeGeneration.current === generation) activeGeneration.current += 1
      actionLocked.current = true
      session?.cancel()
    }
  }, [location.hash, location.pathname, location.search, nowSeconds, transportKey, wallet])

  const reject = (ready: ReadyView) => {
    if (
      actionLocked.current ||
      ready.status !== 'ready' ||
      ready.generation !== activeGeneration.current
    ) return
    actionLocked.current = true
    try {
      const result = ready.session.reject()
      setView({
        status: 'rejected',
        session: ready.session,
        generation: ready.generation,
        transportKey: ready.transportKey,
        result,
        callbackUrl: createRejectedH3BCallbackUrl(ready.session.request)
      })
    } catch {
      setView({ status: 'error', transportKey: ready.transportKey })
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
      setView({
        status: 'signed',
        session: ready.session,
        generation: ready.generation,
        transportKey: ready.transportKey,
        result,
        callbackUrl: createSignedH3BCallbackUrl(ready.session.request, result.proof)
      })
    } catch {
      if (ready.generation === activeGeneration.current) {
        setView({ status: 'error', transportKey: ready.transportKey })
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

      {view.status === 'error' && view.transportKey === transportKey && (
        <section className="card" aria-labelledby="h3b-stopped-title">
          <h2 id="h3b-stopped-title">Authorization stopped safely</h2>
          <p className="error" role="alert">
            The request is invalid, expired, no longer active, or the wallet is unavailable.
            Authorization did not complete and no valid proof was produced. No payment was performed.
          </p>
        </section>
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
        This signs an authorization proof only. It does not sign a transaction, spend XEC,
        send PAYMENT-SIGNATURE, or unlock the resource.
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
