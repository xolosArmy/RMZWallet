import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { xolosWalletService } from '../services/XolosWalletService'

const PENDING_KEY = 'tonalli_pending_req_v1'
const MAX_TS_SKEW_SEC = 300

const CONNECT_REQUEST_NOW_SEC = Math.floor(Date.now() / 1000)

const redirectHash = (returnUrl: string, params: Record<string, string>) => {
  const url = new URL(returnUrl)
  url.hash = new URLSearchParams(params).toString()
  window.location.href = url.toString()
}

function ConnectRequest() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { initialized, backupVerified } = useWallet()
  const [actionError, setActionError] = useState<string | null>(null)

  const getParam = (key: string) => (searchParams.get(key) ?? '').trim()
  const app = getParam('app')
  const returnUrl = getParam('returnUrl')
  const origin = getParam('origin')
  const requestId = getParam('requestId')
  const nonce = getParam('nonce')
  const ts = getParam('ts')

  const validationError = (() => {
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
    try {
      const parsedUrl = new URL(returnUrl)
      if (parsedUrl.origin !== origin) {
        return 'Solicitud inválida: origin no coincide con returnUrl.'
      }
    } catch {
      return 'Solicitud inválida: returnUrl no válido.'
    }
    return null
  })()

  useEffect(() => {
    if (validationError) return
    if (!initialized || !backupVerified) {
      localStorage.setItem(PENDING_KEY, window.location.search)
      navigate('/onboarding', { replace: true })
    }
  }, [backupVerified, initialized, navigate, validationError])

  const handleReject = () => {
    if (validationError) return
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
    const address = xolosWalletService.getAddress()
    const pubkey = xolosWalletService.getPublicKeyHex()
    if (!address || !pubkey) {
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
      `address=${address}`,
      `pubkey=${pubkey}`
    ].join('\n')

    try {
      const signature = await xolosWalletService.signMessage(challenge)
      redirectHash(returnUrl, {
        status: 'ok',
        wallet: 'tonalli',
        chain: 'ecash',
        requestId,
        nonce,
        ts,
        origin,
        address,
        pubkey,
        signature
      })
    } catch (err) {
      const message = (err as Error).message
      if (message === 'WALLET_LOCKED') {
        setActionError('Wallet locked. Unlock to approve.')
        return
      }
      setActionError(message || 'No se pudo firmar la solicitud.')
    }
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
