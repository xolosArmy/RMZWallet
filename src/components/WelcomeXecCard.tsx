import { useCallback, useEffect, useRef, useState } from 'react'
import { WALLET_CAPABILITY } from '../domain/walletCapabilities'
import { useWallet } from '../context/useWallet'
import {
  isWelcomeFaucetConfigured,
  isWelcomeQuickStartCompatible
} from '../services/welcomeFaucet'
import type { WelcomeClaimResponse, WelcomeFaucetConfig } from '../services/welcomeFaucet'
import {
  loadWelcomeClaimSurface,
  nextWelcomeClaimAction,
  requestWelcomeClaim
} from '../services/welcomeClaim'

function formatAmount(config: WelcomeFaucetConfig | null): string {
  const xec = config?.starterPack.xec
  if (!xec) return 'XEC de bienvenida'
  return `${xec} XEC`
}

export default function WelcomeXecCard() {
  const { address, hasCapability, refreshBalances } = useWallet()
  const [config, setConfig] = useState<WelcomeFaucetConfig | null>(null)
  const [claim, setClaim] = useState<WelcomeClaimResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const allowed = hasCapability?.(WALLET_CAPABILITY.WELCOME_XEC_CLAIM) === true
  const configured = isWelcomeFaucetConfigured()

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!address || !configured) return
    const surface = await loadWelcomeClaimSurface(address, signal)
    setConfig(surface.config)
    setClaim(surface.status)
  }, [address, configured])

  useEffect(() => {
    if (!allowed || !address || !configured) return
    const controller = new AbortController()
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted) {
        setError('No pudimos consultar el regalo de bienvenida.')
      }
    })
    return () => controller.abort()
  }, [address, allowed, configured, load])

  const handleClaim = async () => {
    if (!address || inFlight.current) return
    if (nextWelcomeClaimAction(claim?.status) !== 'claim') return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await requestWelcomeClaim(address, claim?.status)
      setClaim(result)
      if (result.status === 'completed' || result.status === 'already_claimed') {
        await refreshBalances().catch(() => undefined)
      }
      if (result.status === 'pending_review') {
        setError(result.message || 'Tu reclamo está en revisión. No enviaremos otra transferencia.')
      }
      if (result.status === 'rate_limited') {
        setError('Demasiados intentos. Intenta más tarde.')
      }
      if (result.status === 'error') {
        setError(result.error || 'No se pudo completar el reclamo.')
      }
    } catch (err) {
      setError((err as Error).message || 'No se pudo completar el reclamo.')
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  if (!allowed || !configured || !address) return null
  if (config && !isWelcomeQuickStartCompatible(config)) {
    return null
  }

  const amountLabel = formatAmount(config)
  const completed = claim?.status === 'completed' || claim?.status === 'already_claimed'
  const pending = claim?.status === 'pending_review'

  return (
    <section className="card welcome-xec-card" aria-labelledby="welcome-xec-title">
      <p className="eyebrow">Bienvenida</p>
      <h2 id="welcome-xec-title" className="section-title">
        {completed ? 'Ya recibiste tus primeros XEC' : `Recibe tus primeros ${amountLabel}`}
      </h2>
      <p className="muted">
        Tonalli usa tu wallet internamente. No tienes que copiar ninguna dirección.
      </p>
      {completed ? (
        <p className="success">
          {claim?.dryRun ? 'Simulación completada.' : 'XEC recibido.'}
          {claim?.txid ? ` Referencia lista en tu saldo.` : ''}
        </p>
      ) : (
        <div className="actions">
          <button
            className="cta primary"
            type="button"
            onClick={() => void handleClaim()}
            disabled={busy || pending || nextWelcomeClaimAction(claim?.status) !== 'claim'}
          >
            {busy ? 'Recibiendo...' : pending ? 'En revisión' : 'Recibir XEC'}
          </button>
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
    </section>
  )
}
