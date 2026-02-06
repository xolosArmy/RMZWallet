import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Html5Qrcode } from 'html5-qrcode'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import ApproveSessionModal, { type ProposalLike } from '../components/walletconnect/ApproveSessionModal'
import { wcWallet } from '../lib/walletconnect/WcWallet'

const normalizeWcUri = (value: string) => value.replace(/\s+/g, '').trim()
const isValidWcUri = (value: string) => value.trim().toLowerCase().startsWith('wc:')

type Tab = 'scan' | 'paste'

function WalletConnect() {
  const { address } = useWallet()
  const [tab, setTab] = useState<Tab>('scan')
  const [uri, setUri] = useState<string>('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [isPairing, setIsPairing] = useState(false)
  const [wcState, setWcState] = useState(() => wcWallet.getState())
  const [pendingProposal, setPendingProposal] = useState<ProposalLike | null>(null)
  const scannerRef = useRef<Html5Qrcode | null>(null)

  const projectId = useMemo(() => import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined, [])

  useEffect(() => {
    const unsub = wcWallet.subscribe(setWcState)
    return () => {
      unsub()
    }
  }, [])

  useEffect(() => {
    const unsub = wcWallet.onSessionProposal((proposal) => {
      console.log('[WC] session_proposal received', proposal)
      setPendingProposal(proposal)
      setError(null)
      setStatus(null)
      setSuccess(null)
    })
    return () => {
      unsub()
    }
  }, [])

  useEffect(() => {
    if (!projectId) {
      setError('Falta VITE_WALLETCONNECT_PROJECT_ID en el entorno.')
      return
    }
    wcWallet.init(projectId).catch((err) => {
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
          const text = decodedText.trim()
          if (!text) return
          setUri(normalizeWcUri(text))
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

  const refreshSessions = () => {
    const sessions = wcWallet.getActiveSessions()
    setWcState((prev) => ({ ...prev, sessions: Object.values(sessions) }))
  }

  const handlePair = async () => {
    setError(null)
    setStatus(null)
    setSuccess(null)

    const trimmed = normalizeWcUri(uri)
    if (trimmed !== uri) {
      setUri(trimmed)
    }

    if (!isValidWcUri(trimmed)) {
      setError('El URI de WalletConnect debe iniciar con "wc:".')
      return
    }

    try {
      setIsPairing(true)
      await wcWallet.pair(trimmed)
      setSuccess('Pairing iniciado ✓')
    } catch (err) {
      setError((err as Error).message || 'No se pudo emparejar el URI.')
    } finally {
      setIsPairing(false)
    }
  }

  const handlePaste = async () => {
    if (!navigator.clipboard?.readText) return
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      setUri(normalizeWcUri(text))
      setError(null)
      setSuccess(null)
    } catch {
      // ignore clipboard failures
    }
  }

  const handleDisconnect = async (topic: string) => {
    setError(null)
    setStatus(null)
    setSuccess(null)
    try {
      await wcWallet.disconnectSession(topic)
      setStatus('Sesión desconectada.')
    } catch (err) {
      setError((err as Error).message || 'No se pudo desconectar la sesión.')
    }
  }

  const handleRejectProposal = async () => {
    if (!pendingProposal) return
    setError(null)
    setStatus(null)
    setSuccess(null)

    try {
      await wcWallet.rejectSession(pendingProposal.id, { code: 5000, message: 'User rejected' })
      refreshSessions()
      setPendingProposal(null)
      setStatus('Ritual cancelado')
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
              onChange={(e) => setUri(e.target.value)}
              placeholder="wc:..."
            />
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="cta ghost" type="button" onClick={handlePaste}>
                Pegar
              </button>
              <button
                className="cta primary"
                type="button"
                onClick={handlePair}
                disabled={!wcState.initialized || isPairing}
              >
                {isPairing ? 'Conectando…' : 'Conectar'}
              </button>
            </div>
          </div>
        )}

        <div className="wc-panel">
          <label htmlFor="wc-uri-inline">URI detectado</label>
          <textarea
            id="wc-uri-inline"
            rows={2}
            value={uri}
            onChange={(e) => setUri(e.target.value)}
            placeholder="wc:..."
          />
          <div className="actions" style={{ marginTop: 12 }}>
            <button
              className="cta primary"
              type="button"
              onClick={handlePair}
              disabled={!wcState.initialized || isPairing}
            >
              {isPairing ? 'Conectando…' : 'Conectar'}
            </button>
            <span className="pill pill-ghost">{address ? `Activo: ${address}` : 'Sin dirección activa'}</span>
          </div>
        </div>

        {(error || success || status || wcState.lastError) && (
          <div className="muted" style={{ marginTop: 12 }}>
            {error || success || status || wcState.lastError}
          </div>
        )}
      </div>

      <div className="card">
        <p className="card-kicker">Sesiones conectadas</p>
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
        }}
        onRejected={handleRejectProposal}
        onClose={() => setPendingProposal(null)}
      />
    </div>
  )
}

export default WalletConnect
