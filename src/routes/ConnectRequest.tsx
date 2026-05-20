import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { xolosWalletService } from '../services/XolosWalletService'
import { storePendingConnectRequest } from '../utils/tonalliConnect'

const MAX_TS_SKEW_SEC = 300

const CONNECT_ALLOWED_DOMAINS = (
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_CONNECT_ALLOWED_DOMAINS ??
    (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_WC_ALLOWED_DOMAINS ??
    (typeof process !== 'undefined'
      ? process.env?.VITE_CONNECT_ALLOWED_DOMAINS ?? process.env?.VITE_WC_ALLOWED_DOMAINS
      : undefined)) as string | undefined
)
  ?.split(',')
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean)

const CONNECT_REQUEST_NOW_SEC = Math.floor(Date.now() / 1000)

const redirectHash = (returnUrl: string, params: Record<string, string>) => {
  const url = new URL(returnUrl)
  url.hash = new URLSearchParams(params).toString()
  window.location.href = url.toString()
}

function ConnectRequest() {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { initialized, backupVerified } = useWallet()
  const [actionError, setActionError] = useState<string | null>(null)

  const isSignMessageRoute = location.pathname === '/connect/sign-message'
  const getParam = (key: string) => (searchParams.get(key) ?? '').trim()
  const getRawParam = (key: string) => searchParams.get(key) ?? ''

  const app = getParam('app')
  const returnUrl = getParam('returnUrl')
  const origin = getParam('origin')
  const requestId = getParam('requestId')
  const nonce = getParam('nonce')
  const ts = getParam('ts')
  const challengeId = getParam('challengeId')
  const message = getRawParam('message')
  const domain = getParam('domain')
  const purpose = getParam('purpose')
  const walletAddress = xolosWalletService.getAddress()
  const walletPubkey = xolosWalletService.getPublicKeyHex()

  const parsedReturnUrl = useMemo(() => {
    if (!returnUrl) return null
    try {
      return new URL(returnUrl)
    } catch {
      return null
    }
  }, [returnUrl])

  const requestOriginHost = parsedReturnUrl?.hostname.toLowerCase() ?? null
  const isAllowedRequester = requestOriginHost ? Boolean(CONNECT_ALLOWED_DOMAINS?.includes(requestOriginHost)) : false

  const signMessageValidation = useMemo(() => {
    if (!returnUrl) {
      return 'Missing return URL.'
    }

    if (!parsedReturnUrl) {
      return 'Missing return URL.'
    }

    if (!challengeId || message.length === 0) {
      return 'Invalid Tonalli Connect signing request.'
    }

    return null
  }, [challengeId, message, parsedReturnUrl, returnUrl])

  const connectValidation = (() => {
    if (!returnUrl || !origin || !requestId || !nonce || !ts) {
      return 'Solicitud inválida: faltan parámetros requeridos.'
    }
    const tsNumber = Number(ts)
    if (!Number.isFinite(tsNumber)) {
      return 'Solicitud inválida: timestamp no válido.'
    }
    if (Math.abs(CONNECT_REQUEST_NOW_SEC - tsNumber) > MAX_TS_SKEW_SEC) {
      return 'Solicitud inválida: timestamp fuera de tiempo.'
    }
    if (!parsedReturnUrl) {
      return 'Solicitud inválida: returnUrl no válido.'
    }
    if (parsedReturnUrl.origin !== origin) {
      return 'Bloqueada por seguridad: el origin no coincide exactamente con returnUrl.'
    }
    return null
  })()

  const validationError = isSignMessageRoute ? signMessageValidation : connectValidation
  const unknownOriginWarning = !validationError && requestOriginHost && !isAllowedRequester
  const connectSecurityTone = unknownOriginWarning ? 'roja' : 'verde'

  useEffect(() => {
    if (validationError) return
    if (!initialized || !backupVerified) {
      storePendingConnectRequest({
        path: isSignMessageRoute ? '/connect/sign-message' : '/connect',
        search: window.location.search
      })
      navigate('/onboarding', { replace: true })
    }
  }, [backupVerified, initialized, isSignMessageRoute, navigate, validationError])

  const handleReject = () => {
    if (validationError) return

    if (isSignMessageRoute) {
      redirectHash(returnUrl, {
        status: 'error',
        reason: 'USER_CANCELLED',
        challengeId
      })
      return
    }

    redirectHash(returnUrl, {
      status: 'error',
      requestId,
      code: 'USER_REJECTED',
      message: 'User rejected'
    })
  }

  const handleApprove = async () => {
    if (validationError) return
    setActionError(null)

    try {
      if (isSignMessageRoute) {
        if (!walletAddress || !walletPubkey) {
          throw new Error('WALLET_LOCKED')
        }

        // Tonalli signs only the exact challenge message received from the Gateway.
        // The Gateway verifies the signature, public key, address, nonce/challengeId, and expiration.
        // Tonalli never exposes private keys during this flow.
        const signature = await xolosWalletService.signMessage(message)
        redirectHash(returnUrl, {
          status: 'ok',
          wallet: 'tonalli',
          chain: 'ecash',
          address: walletAddress,
          pubkey: walletPubkey,
          signature,
          challengeId
        })
        return
      }

      if (!walletAddress || !walletPubkey) {
        setActionError('No pudimos leer tu billetera para firmar.')
        return
      }

      const challenge = [
        'TONALLI_AUTH',
        `app=${app}`,
        'action=connect',
        `origin=${origin}`,
        `requestId=${requestId}`,
        `nonce=${nonce}`,
        `ts=${ts}`,
        'chain=ecash',
        `address=${walletAddress}`,
        `pubkey=${walletPubkey}`
      ].join('\n')

      const signature = await xolosWalletService.signMessage(challenge)
      redirectHash(returnUrl, {
        status: 'ok',
        wallet: 'tonalli',
        chain: 'ecash',
        requestId,
        nonce,
        ts,
        origin,
        address: walletAddress,
        pubkey: walletPubkey,
        signature
      })
    } catch (err) {
      const errorMessage = (err as Error).message
      if (errorMessage === 'WALLET_LOCKED') {
        if (isSignMessageRoute) {
          redirectHash(returnUrl, {
            status: 'error',
            reason: 'WALLET_LOCKED',
            challengeId
          })
          return
        }
        setActionError('Wallet locked. Unlock to approve.')
        return
      }

      if (isSignMessageRoute) {
        if (import.meta.env.DEV) {
          console.error('[Tonalli Connect sign-message] signing failed', err)
        }
        redirectHash(returnUrl, {
          status: 'error',
          reason: 'SIGNING_FAILED',
          challengeId
        })
        return
      }

      setActionError(errorMessage || 'No se pudo firmar la solicitud.')
    }
  }

  if (isSignMessageRoute) {
    return (
      <div className="page">
        <TopBar />
        <header className="section-header">
          <div>
            <p className="eyebrow">Tonalli Connect</p>
            <h1 className="section-title">Sign Mining Gateway Challenge</h1>
            <p className="muted">eCash México Mining Gateway is requesting a Tonalli Wallet signature.</p>
          </div>
        </header>

        {validationError && <div className="error">{validationError}</div>}
        {actionError && <div className="error">{actionError}</div>}

        {!validationError && unknownOriginWarning && (
          <div
            style={{
              borderRadius: 18,
              border: '2px solid rgba(251, 191, 36, 0.8)',
              background: 'linear-gradient(180deg, rgba(120, 53, 15, 0.3), rgba(68, 30, 5, 0.45))',
              color: '#fde68a',
              padding: 18,
              marginBottom: 16,
              display: 'grid',
              gap: 8
            }}
          >
            <strong>Origen desconocido - Posible phishing</strong>
            <span>
              El callback apunta a <code>{requestOriginHost}</code>, que no está en <code>VITE_CONNECT_ALLOWED_DOMAINS</code>.
            </span>
            <span>Firma bajo tu propio riesgo.</span>
          </div>
        )}

        {!validationError && (
          <div className="card">
            <p className="muted">
              Only sign this message if you trust the requesting application and the domain matches what you expected.
            </p>
            <div className="stack" style={{ display: 'grid', gap: 12 }}>
              <div>
                <strong>domain</strong>
                <p className="muted">{domain || 'N/D'}</p>
              </div>
              <div>
                <strong>purpose</strong>
                <p className="muted">{purpose || 'N/D'}</p>
              </div>
              <div>
                <strong>challengeId</strong>
                <p className="muted" style={{ wordBreak: 'break-all' }}>
                  {challengeId}
                </p>
              </div>
              <div>
                <strong>wallet address</strong>
                <p className="muted" style={{ wordBreak: 'break-all' }}>
                  {walletAddress || 'N/D'}
                </p>
              </div>
              <div>
                <strong>message</strong>
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    margin: 0,
                    padding: 12,
                    borderRadius: 12,
                    background: 'rgba(255,255,255,0.04)'
                  }}
                >
                  {message}
                </pre>
              </div>
            </div>
            <div className="actions">
              <button className="cta outline" type="button" onClick={handleReject}>
                Cancel
              </button>
              <button className="cta primary" type="button" onClick={handleApprove}>
                Sign Message
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Tonalli Connect</p>
          <h1 className="section-title">Solicitud de conexión</h1>
          <p className="muted">App: {app || 'Desconocida'}</p>
          <p className="muted">Origen: {origin || 'N/D'}</p>
        </div>
      </header>

      {validationError && <div className="error">{validationError}</div>}
      {actionError && <div className="error">{actionError}</div>}

      {!validationError && requestOriginHost && (
        <div
          style={{
            borderRadius: 18,
            border: unknownOriginWarning
              ? '2px solid rgba(251, 191, 36, 0.8)'
              : '1px solid rgba(34, 197, 94, 0.55)',
            background: unknownOriginWarning
              ? 'linear-gradient(180deg, rgba(120, 53, 15, 0.3), rgba(68, 30, 5, 0.45))'
              : 'rgba(20, 83, 45, 0.28)',
            color: unknownOriginWarning ? '#fde68a' : '#bbf7d0',
            padding: 18,
            marginBottom: 16,
            display: 'grid',
            gap: 8
          }}
        >
          <strong>
            {unknownOriginWarning ? 'Origen Desconocido - Posible Phishing' : 'Origen permitido por RMZWallet'}
          </strong>
          <span>
            Host solicitante: <code>{requestOriginHost}</code>
          </span>
          <span>
            Origen declarado: <code>{origin}</code>
          </span>
          <span>
            Estado: {connectSecurityTone === 'roja' ? 'no verificado en allowlist' : 'verificado en allowlist'}
          </span>
          {unknownOriginWarning && <span>Autoriza solo si reconoces esta app y esperabas este callback.</span>}
        </div>
      )}

      {!validationError && (
        <div className="card">
          <p className="muted">
            Esta app solicita acceso a tu dirección y firma un challenge para verificar tu conexión.
          </p>
          <div className="actions">
            <button className="cta outline" type="button" onClick={handleReject}>
              Rechazar
            </button>
            <button className="cta primary" type="button" onClick={handleApprove}>
              Autorizar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default ConnectRequest
