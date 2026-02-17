import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Html5Qrcode } from 'html5-qrcode'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import ApproveSessionModal, { type ProposalLike } from '../components/walletconnect/ApproveSessionModal'
import { wcWallet } from '../lib/walletconnect/WcWallet'
import {
  canPairWalletConnectUri,
  hasWhitespace,
  INVALID_WC_URI_ERROR,
  isChronikWsError,
  sanitizeWcUri
} from '../lib/walletconnect/wcUri'

type Tab = 'scan' | 'paste'

function WalletConnect() {
  const { address } = useWallet()
  const [tab, setTab] = useState<Tab>('scan')
  const [uri, setUri] = useState<string>('')
  const [wcReady, setWcReady] = useState(false)
  const [pendingPairUri, setPendingPairUri] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('idle')
  const [error, setError] = useState<string | null>(null)
  const [uriError, setUriError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isPairing, setIsPairing] = useState(false)
  const [wcState, setWcState] = useState(() => wcWallet.getState())
  const [pendingProposal, setPendingProposal] = useState<ProposalLike | null>(null)
  const scannerRef = useRef<Html5Qrcode | null>(null)

  const projectId = useMemo(
    () =>
      (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ??
      (import.meta.env.VITE_WC_PROJECT_ID as string | undefined),
    []
  )
  const effectiveUri = useMemo(() => (pendingPairUri ?? uri).trim(), [pendingPairUri, uri])
  const isValidUri = useMemo(() => canPairWalletConnectUri(effectiveUri), [effectiveUri])
  const canConnect = useMemo(() => !isPairing && isValidUri, [isPairing, isValidUri])
  const visibleError = useMemo(() => (error && !isChronikWsError(error) ? error : null), [error])
  const visibleWalletConnectError = useMemo(
    () => (wcState.lastError && !isChronikWsError(wcState.lastError) ? wcState.lastError : null),
    [wcState.lastError]
  )
  const connectionStatusLabel = useMemo(() => {
    if (visibleError || visibleWalletConnectError) return 'Error'
    if (wcState.sessions.length > 0 || status === 'session_active') return 'Sesión activa'
    if (status === 'paired') return 'Sesión creada'
    if (status === 'proposal_received') return 'Proposal recibido'
    if (status === 'paired_waiting_proposal') return 'Pair ok, esperando proposal...'
    if (status === 'initializing') return 'Inicializando WalletConnect...'
    if (status === 'pairing' || isPairing) return 'Pairing...'
    return 'Listo para conectar'
  }, [isPairing, status, visibleError, visibleWalletConnectError, wcState.sessions.length])
  const statusDetail = useMemo(() => {
    if (!status) return null
    if (
      ['idle', 'initializing', 'pairing', 'paired', 'paired_waiting_proposal', 'proposal_received', 'session_active'].includes(
        status
      )
    ) {
      return null
    }
    return status
  }, [status])
  const chronikNotice = useMemo(() => {
    const wcError = wcState.lastError ?? ''
    const localError = error ?? ''
    if (isChronikWsError(wcError) || isChronikWsError(localError)) {
      return 'WS offline, usando fallback HTTP'
    }
    return null
  }, [error, wcState.lastError])

  useEffect(() => {
    const unsub = wcWallet.subscribe(setWcState)
    return () => {
      unsub()
    }
  }, [])

  useEffect(() => {
    if (!projectId) {
      setError('Falta WalletConnect Project ID (VITE_WALLETCONNECT_PROJECT_ID o VITE_WC_PROJECT_ID).')
      return
    }
    setWcReady(false)
    wcWallet
      .init(projectId)
      .then(() => {
        setWcReady(true)
        setStatus('idle')
        setError(null)
      })
      .catch((err) => {
        setError((err as Error).message || 'No se pudo iniciar WalletConnect.')
      })
  }, [projectId])

  useEffect(() => {
    if (tab !== 'scan') return

    const qr = new Html5Qrcode('wc-qr-reader')
    scannerRef.current = qr
    setStatus('Activando cámara... apunta al QR de la dApp.')
    setError(null)

    qr
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: 240 },
        async (decodedText) => {
          const text = sanitizeWcUri(decodedText)
          if (!text) return
          setUri(text)
          setUriError(canPairWalletConnectUri(text) ? null : INVALID_WC_URI_ERROR)
          setStatus('QR capturado. Listo para emparejar.')
          try {
            await qr.stop()
          } catch {
            // ignore
          }
        },
        () => {
          // ignore intermittent scan errors
        }
      )
      .catch((err) => {
        const message = (err as Error).message || 'No se pudo iniciar la cámara.'
        setError('No se pudo acceder a la cámara. Revisa permisos del navegador.')
        setStatus(message)
      })

    return () => {
      const scanner = scannerRef.current
      if (!scanner) return
      ;(async () => {
        try {
          await scanner.stop()
          try {
            await scanner.clear()
          } catch {
            // ignore
          }
        } catch {
          // ignore
        }
      })()
    }
  }, [tab])

  const refreshSessions = useCallback(() => {
    const sessions = wcWallet.getActiveSessions()
    setWcState((prev) => ({ ...prev, sessions: Object.values(sessions) }))
  }, [])

  useEffect(() => {
    const onSessionProposal = (proposal: unknown) => {
      const proposalLike = proposal as ProposalLike
      const requiredNamespaces = proposalLike.params?.requiredNamespaces
      const optionalNamespaces = proposalLike.params?.optionalNamespaces
      console.log('[wc] session_proposal received', {
        id: proposalLike.id,
        requiredNamespaces,
        optionalNamespaces
      })
      setPendingProposal(proposal as ProposalLike)
      setError(null)
      setStatus('proposal_received')
      setSuccess(null)
    }

    const unsubscribeProposal = wcWallet.onSessionProposal(onSessionProposal)

    return () => {
      unsubscribeProposal()
    }
  }, [])

  useEffect(() => {
    if (wcState.sessions.length > 0) {
      setStatus('session_active')
    }
  }, [wcState.sessions.length])

  useEffect(() => {
    if (!wcReady || !pendingPairUri || isPairing) return

    ;(async () => {
      try {
        const cleaned = sanitizeWcUri(pendingPairUri)
        if (!canPairWalletConnectUri(cleaned)) {
          setUriError(INVALID_WC_URI_ERROR)
          setPendingPairUri(null)
          setStatus('idle')
          return
        }

        console.log('[wc] auto-pair queued URI', pendingPairUri)
        setIsPairing(true)
        setStatus('pairing')
        setUriError(null)
        await wcWallet.pair(cleaned)
        console.log('[wc] pair() ok')
        setPendingPairUri(null)
        setStatus('paired')
        setSuccess('Sesión WalletConnect creada.')
        setError(null)
      } catch (err) {
        const message = (err as Error).message || 'No se pudo emparejar el URI en cola.'
        setError(`Auto-pair falló: ${message}`)
        setStatus('idle')
      } finally {
        setIsPairing(false)
      }
    })()
  }, [isPairing, pendingPairUri, wcReady])

  const handlePair = async () => {
    setError(null)
    setStatus('idle')
    setSuccess(null)

    const cleaned = sanitizeWcUri(effectiveUri)
    if (cleaned !== effectiveUri) {
      if (pendingPairUri) {
        setPendingPairUri(cleaned)
      } else {
        setUri(cleaned)
      }
    }
    const hasUriWhitespace = hasWhitespace(cleaned)
    if (import.meta.env.DEV) {
      console.info('[WalletConnect] pair click', {
        hasPendingPairUri: Boolean(pendingPairUri),
        effectiveUriLength: effectiveUri.length,
        cleanedUriLength: cleaned.length,
        hasWhitespace: hasUriWhitespace
      })
    }
    console.log('[wc] connect clicked', { wcReady, uriLen: cleaned.length })

    if (!canPairWalletConnectUri(cleaned)) {
      setUriError(INVALID_WC_URI_ERROR)
      return
    }

    if (!wcReady) {
      setPendingPairUri(cleaned)
      setUriError(null)
      setStatus('initializing')
      return
    }

    try {
      setIsPairing(true)
      setUriError(null)
      setStatus('pairing')
      const t0 = Date.now()
      console.log('[wc] calling pair()', { t0 })
      await Promise.race([
        wcWallet.pair(cleaned),
        new Promise((_, rej) => setTimeout(() => rej(new Error('pair() timeout after 15s')), 15000))
      ])
      console.log('[wc] pair() resolved', { ms: Date.now() - t0 })
      setStatus('paired_waiting_proposal')
      setSuccess('Pairing iniciado ✓')
    } catch (err) {
      console.error('[wc] pair() failed', err)
      const maybeError = err as { message?: string }
      setError(`WalletConnect pair failed: ${maybeError?.message ?? String(err)}`)
      setStatus('idle')
    } finally {
      setIsPairing(false)
    }
  }

  const handlePaste = async () => {
    if (!navigator.clipboard?.readText) return
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      const cleaned = sanitizeWcUri(text)
      setUri(cleaned)
      setUriError(canPairWalletConnectUri(cleaned) ? null : INVALID_WC_URI_ERROR)
      setError(null)
      setSuccess(null)
    } catch {
      // ignore clipboard failures
    }
  }

  const handleDisconnect = async (topic: string) => {
    setError(null)
    setStatus('idle')
    setSuccess(null)
    try {
      await wcWallet.disconnectSession(topic)
      setStatus('idle')
    } catch (err) {
      setError((err as Error).message || 'No se pudo desconectar la sesión.')
    }
  }

  const handleRejectProposal = async () => {
    if (!pendingProposal) return
    setError(null)
    setStatus('idle')
    setSuccess(null)

    try {
      await wcWallet.rejectSession(pendingProposal.id, { code: 5000, message: 'User rejected' })
      refreshSessions()
      setPendingProposal(null)
      setStatus('idle')
    } catch (err) {
      setError((err as Error).message || 'No se pudo rechazar el vínculo.')
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">WalletConnect</p>
          <h1 className="section-title">Conectar dApps</h1>
          <p className="muted">Empareja RMZWallet con xolo-legend u otras dApps eCash compatibles.</p>
        </div>
        <div className="actions">
          <Link className="cta ghost" to="/settings">
            Ajustes
          </Link>
        </div>
      </header>

      <div className="card">
        <div className="wc-tabs">
          <button
            type="button"
            className={`wc-tab ${tab === 'scan' ? 'active' : ''}`}
            onClick={() => setTab('scan')}
          >
            Scan QR
          </button>
          <button
            type="button"
            className={`wc-tab ${tab === 'paste' ? 'active' : ''}`}
            onClick={() => setTab('paste')}
          >
            Paste URI
          </button>
        </div>

        {tab === 'scan' && (
          <div className="wc-panel">
            <p className="muted">Apunta al QR generado por la dApp. El URI aparecerá abajo.</p>
            <div className="wc-qr-shell">
              <div id="wc-qr-reader" style={{ width: '100%', height: 280 }} />
            </div>
          </div>
        )}

        {tab === 'paste' && (
          <div className="wc-panel">
            <p className="card-kicker">Pegar URI (wc:)</p>
            <label htmlFor="wc-uri">URI de WalletConnect</label>
            <textarea
              id="wc-uri"
              rows={3}
              value={uri}
              onChange={(e) => {
                const cleaned = sanitizeWcUri(e.target.value)
                setUri(cleaned)
                setUriError(cleaned.length > 0 && !canPairWalletConnectUri(cleaned) ? INVALID_WC_URI_ERROR : null)
              }}
              placeholder="wc:..."
            />
            {uriError && <p className="error">{uriError}</p>}
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="cta ghost" type="button" onClick={handlePaste}>
                Pegar
              </button>
              <button
                className="cta primary"
                type="button"
                onClick={handlePair}
                disabled={!canConnect}
              >
                {isPairing ? 'Conectando…' : !wcReady && isValidUri ? 'Conectar (inicializando...)' : 'Conectar'}
              </button>
            </div>
            <p className="muted">{connectionStatusLabel}</p>
          </div>
        )}

        <div className="wc-panel">
          <label htmlFor="wc-uri-inline">URI detectado</label>
          <textarea
            id="wc-uri-inline"
            rows={2}
            value={uri}
            onChange={(e) => {
              const cleaned = sanitizeWcUri(e.target.value)
              setUri(cleaned)
              setUriError(cleaned.length > 0 && !canPairWalletConnectUri(cleaned) ? INVALID_WC_URI_ERROR : null)
            }}
            placeholder="wc:..."
          />
          {uriError && <p className="error">{uriError}</p>}
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="cta primary"
              type="button"
              onClick={handlePair}
              disabled={!canConnect}
            >
              {isPairing ? 'Conectando…' : !wcReady && isValidUri ? 'Conectar (inicializando...)' : 'Conectar'}
            </button>
            <span className="pill pill-ghost">{address ? `Activo: ${address}` : 'Sin dirección activa'}</span>
          </div>
          <p className="muted">{connectionStatusLabel}</p>
        </div>

        {chronikNotice && (
          <p className="muted" style={{ marginTop: 12 }}>
            {chronikNotice}
          </p>
        )}
        {(visibleError || success || statusDetail || visibleWalletConnectError) && (
          <div className="muted" style={{ marginTop: 12 }}>
            {visibleError || success || statusDetail || visibleWalletConnectError}
          </div>
        )}
      </div>

      <div className="card">
        <p className="card-kicker">{wcState.sessions.length > 0 ? 'Sesiones conectadas' : 'Sesiones'}</p>
        {wcState.sessions.length === 0 && <p className="muted">No hay sesiones activas.</p>}
        {wcState.sessions.map((session) => (
          <div key={session.topic} className="wc-session">
            <div>
              <p className="subtitle">{session.peer?.metadata?.name || 'dApp'}</p>
              <p className="muted">{session.peer?.metadata?.url || 'Sin URL'}</p>
              <p className="muted">Topic: {session.topic}</p>
            </div>
            <div className="actions">
              <button className="cta outline" type="button" onClick={() => handleDisconnect(session.topic)}>
                Disconnect
              </button>
            </div>
          </div>
        ))}
      </div>

      <ApproveSessionModal
        open={Boolean(pendingProposal)}
        proposal={pendingProposal}
        activeAddress={address}
        onApproved={() => {
          refreshSessions()
          if (typeof window !== 'undefined') {
            window.setTimeout(() => refreshSessions(), 250)
          }
        }}
        onRejected={handleRejectProposal}
        onClose={() => setPendingProposal(null)}
      />
    </div>
  )
}

export default WalletConnect
