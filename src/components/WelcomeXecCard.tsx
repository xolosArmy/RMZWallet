import { useCallback, useEffect, useRef, useState } from 'react'
import { WALLET_CAPABILITY } from '../domain/walletCapabilities'
import { useWallet } from '../context/useWallet'
import {
  isWelcomeFaucetConfigured,
  isWelcomeQuickStartCompatible,
  WELCOME_RATE_LIMIT_FALLBACK_MS
} from '../services/welcomeFaucet'
import type { WelcomeClaimResponse, WelcomeFaucetConfig } from '../services/welcomeFaucet'
import {
  loadWelcomeClaimSurface,
  nextWelcomeClaimAction,
  reconcileWelcomeClaim,
  requestWelcomeClaim
} from '../services/welcomeClaim'

export const WELCOME_RECONCILE_INTERVAL_MS = 1500
export const WELCOME_RECONCILE_MAX_ATTEMPTS = 5

type AddressClaim = { address: string; response: WelcomeClaimResponse }
type AddressMessage = { address: string; text: string }

function formatAmount(config: WelcomeFaucetConfig | null): string {
  const xec = config?.starterPack.xec
  if (!xec) return 'XEC de bienvenida'
  return `${xec} XEC`
}

export default function WelcomeXecCard() {
  const { address, hasCapability, refreshBalances } = useWallet()
  const [config, setConfig] = useState<WelcomeFaucetConfig | null>(null)
  const [addressClaim, setAddressClaim] = useState<AddressClaim | null>(null)
  const [busyAddress, setBusyAddress] = useState<string | null>(null)
  const [manualBusyAddress, setManualBusyAddress] = useState<string | null>(null)
  const [pollExhaustedAddress, setPollExhaustedAddress] = useState<string | null>(null)
  const [rateLimitManualReadyClaim, setRateLimitManualReadyClaim] = useState<AddressClaim | null>(null)
  const [rateLimitReconcilingAddress, setRateLimitReconcilingAddress] = useState<string | null>(null)
  const [addressError, setAddressError] = useState<AddressMessage | null>(null)
  const postInFlight = useRef<string | null>(null)
  const manualController = useRef<AbortController | null>(null)
  const rateLimitAutoController = useRef<AbortController | null>(null)
  const terminalRefreshAddress = useRef<string | null>(null)
  const mounted = useRef(false)
  const refreshBalancesRef = useRef(refreshBalances)

  const allowed = hasCapability?.(WALLET_CAPABILITY.WELCOME_XEC_CLAIM) === true
  const configured = isWelcomeFaucetConfigured()
  const compatible = config === null || isWelcomeQuickStartCompatible(config)
  const claim = addressClaim?.address === address ? addressClaim.response : null
  const error = addressError?.address === address ? addressError.text : null
  const busy = busyAddress === address
  const manualBusy = manualBusyAddress === address
  const pollExhausted = pollExhaustedAddress === address
  const rateLimitManualReady = rateLimitManualReadyClaim !== null && rateLimitManualReadyClaim === addressClaim
  const rateLimitReconciling = rateLimitReconcilingAddress === address
  const scope = useRef({ address, allowed, configured, compatible })
  scope.current = { address, allowed, configured, compatible }
  refreshBalancesRef.current = refreshBalances

  const isCurrent = useCallback((requestedAddress: string, signal?: AbortSignal) => (
    mounted.current && !signal?.aborted
    && scope.current.address === requestedAddress
    && scope.current.allowed && scope.current.configured && scope.current.compatible
  ), [])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    terminalRefreshAddress.current = null
    setPollExhaustedAddress(null)
    setRateLimitManualReadyClaim(null)
    setRateLimitReconcilingAddress(null)
  }, [address])

  useEffect(() => {
    if (!allowed || !address || !configured || !compatible) return
    const controller = new AbortController()
    void loadWelcomeClaimSurface(address, controller.signal).then(surface => {
      if (!isCurrent(address, controller.signal)) return
      setConfig(surface.config)
      setAddressClaim(previous => {
        // A slow initial GET cannot erase a later pending claim or rate-limit cooldown.
        if (previous?.address === address
          && (previous.response.status === 'pending_review' || previous.response.status === 'rate_limited')
          && surface.status.status !== 'completed' && surface.status.status !== 'already_claimed') return previous
        return { address, response: surface.status }
      })
    }).catch(() => {
      if (isCurrent(address, controller.signal)) {
        setAddressError({ address, text: 'No pudimos consultar el regalo de bienvenida.' })
      }
    })
    return () => controller.abort()
  }, [address, allowed, configured, compatible, isCurrent])

  const applyTerminalStatus = useCallback((requestedAddress: string, result: WelcomeClaimResponse) => {
    setAddressClaim({ address: requestedAddress, response: result })
    setAddressError(null)
    if (terminalRefreshAddress.current !== requestedAddress) {
      terminalRefreshAddress.current = requestedAddress
      void refreshBalancesRef.current().catch(() => undefined)
    }
  }, [])

  const applyPendingReconciledStatus = useCallback((requestedAddress: string, result: WelcomeClaimResponse, signal: AbortSignal) => {
    if (!isCurrent(requestedAddress, signal)) return
    if (result.address && result.address !== requestedAddress) {
      setAddressError({ address: requestedAddress, text: 'No pudimos confirmar el estado todavía.' })
      return
    }
    if (result.status === 'completed' || result.status === 'already_claimed') {
      applyTerminalStatus(requestedAddress, result)
      return
    }
    if (result.status === 'pending_review') {
      setAddressClaim({ address: requestedAddress, response: result })
      setAddressError(null)
      return
    }
    // A non-terminal/ambiguous GET never re-enables the POST after pending_review.
    setAddressError({ address: requestedAddress, text: 'No pudimos confirmar el estado todavía.' })
  }, [isCurrent, applyTerminalStatus])

  const applyRateLimitReconciledStatus = useCallback((requestedAddress: string, result: WelcomeClaimResponse, signal: AbortSignal) => {
    if (!isCurrent(requestedAddress, signal)) return
    if (result.address && result.address !== requestedAddress) {
      setAddressError({ address: requestedAddress, text: 'No pudimos confirmar el estado todavía.' })
      return
    }
    if (result.status === 'completed' || result.status === 'already_claimed') {
      applyTerminalStatus(requestedAddress, result)
      return
    }
    if (result.status === 'available' || result.status === 'retryable' || result.status === 'pending_review') {
      setAddressClaim({ address: requestedAddress, response: result })
      setAddressError(null)
      return
    }
    if (result.status === 'rate_limited') {
      setAddressClaim({ address: requestedAddress, response: result })
      setAddressError({ address: requestedAddress, text: 'Demasiados intentos. Intenta más tarde.' })
      return
    }
    // An error/unknown status is not evidence that another POST is safe.
    setAddressError({ address: requestedAddress, text: 'No pudimos confirmar el estado todavía.' })
  }, [isCurrent, applyTerminalStatus])

  useEffect(() => {
    if (!address || !allowed || !configured || !compatible || claim?.status !== 'pending_review' || pollExhausted) return
    const requestedAddress = address
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0

    const reconcile = async () => {
      if (!isCurrent(requestedAddress, controller.signal)) return
      attempts += 1
      try {
        const result = await reconcileWelcomeClaim(requestedAddress, controller.signal)
        if (!isCurrent(requestedAddress, controller.signal)) return
        applyPendingReconciledStatus(requestedAddress, result, controller.signal)
        if ((!result.address || result.address === requestedAddress)
          && (result.status === 'completed' || result.status === 'already_claimed')) {
          controller.abort()
          return
        }
      } catch {
        if (!isCurrent(requestedAddress, controller.signal)) return
        setAddressError({ address: requestedAddress, text: 'No pudimos actualizar el estado todavía.' })
      }
      if (!isCurrent(requestedAddress, controller.signal)) return
      if (attempts >= WELCOME_RECONCILE_MAX_ATTEMPTS) {
        setPollExhaustedAddress(requestedAddress)
        controller.abort()
        return
      }
      timer = setTimeout(() => void reconcile(), WELCOME_RECONCILE_INTERVAL_MS)
    }

    timer = setTimeout(() => void reconcile(), WELCOME_RECONCILE_INTERVAL_MS)
    return () => {
      controller.abort()
      if (timer !== null) clearTimeout(timer)
    }
  }, [address, allowed, configured, compatible, claim?.status, pollExhausted, isCurrent, applyPendingReconciledStatus])

  useEffect(() => {
    if (!address || !allowed || !configured || !compatible || !addressClaim || claim?.status !== 'rate_limited') return
    const requestedAddress = address
    const cooldownClaim = addressClaim
    const controller = new AbortController()
    const suppliedDelay = claim.retryAfterMs
    const cooldownMs = typeof suppliedDelay === 'number' && Number.isFinite(suppliedDelay) && suppliedDelay >= 0
      ? Math.min(suppliedDelay, 2_147_483_647)
      : WELCOME_RATE_LIMIT_FALLBACK_MS
    setRateLimitManualReadyClaim(null)
    const timer = setTimeout(() => {
      if (!isCurrent(requestedAddress, controller.signal)) return
      setRateLimitManualReadyClaim(cooldownClaim)
      rateLimitAutoController.current = controller
      setRateLimitReconcilingAddress(requestedAddress)
      void reconcileWelcomeClaim(requestedAddress, controller.signal).then(result => {
        applyRateLimitReconciledStatus(requestedAddress, result, controller.signal)
      }).catch(() => {
        if (isCurrent(requestedAddress, controller.signal)) {
          setAddressError({ address: requestedAddress, text: 'No pudimos actualizar el estado todavía.' })
        }
      }).finally(() => {
        if (rateLimitAutoController.current === controller) rateLimitAutoController.current = null
        if (isCurrent(requestedAddress, controller.signal)) setRateLimitReconcilingAddress(null)
      })
    }, cooldownMs)
    return () => {
      controller.abort()
      clearTimeout(timer)
      if (rateLimitAutoController.current === controller) rateLimitAutoController.current = null
    }
  }, [address, allowed, configured, compatible, addressClaim, claim?.status, claim?.retryAfterMs, isCurrent, applyRateLimitReconciledStatus])

  useEffect(() => () => {
    manualController.current?.abort()
    manualController.current = null
  }, [address, allowed, configured, compatible, claim?.status])

  const handleClaim = async () => {
    if (!address || !allowed || !compatible || postInFlight.current === address) return
    if (nextWelcomeClaimAction(claim?.status) !== 'claim') return
    const requestedAddress = address
    postInFlight.current = requestedAddress
    setBusyAddress(requestedAddress)
    setAddressError(null)
    try {
      const result = await requestWelcomeClaim(requestedAddress, claim?.status)
      if (!isCurrent(requestedAddress)) return
      setAddressClaim({ address: requestedAddress, response: result })
      if (result.status === 'completed' || result.status === 'already_claimed') {
        if (terminalRefreshAddress.current !== requestedAddress) {
          terminalRefreshAddress.current = requestedAddress
          await refreshBalancesRef.current().catch(() => undefined)
        }
      }
      if (result.status === 'pending_review') {
        setAddressError({ address: requestedAddress, text: result.message || 'Tu reclamo está en revisión. No enviaremos otra transferencia.' })
      }
      if (result.status === 'rate_limited') {
        setAddressError({ address: requestedAddress, text: 'Demasiados intentos. Intenta más tarde.' })
      }
      if (result.status === 'error') {
        setAddressError({ address: requestedAddress, text: result.error || 'No se pudo completar el reclamo.' })
      }
    } catch (err) {
      if (isCurrent(requestedAddress)) {
        setAddressError({ address: requestedAddress, text: (err as Error).message || 'No se pudo completar el reclamo.' })
      }
    } finally {
      if (postInFlight.current === requestedAddress) postInFlight.current = null
      if (isCurrent(requestedAddress)) setBusyAddress(null)
    }
  }

  const handleManualReconciliation = async () => {
    if (!address || !allowed || !configured || !compatible || manualController.current) return
    const pendingReconciliation = claim?.status === 'pending_review' && pollExhausted
    const rateLimitReconciliation = claim?.status === 'rate_limited' && rateLimitManualReady && !rateLimitAutoController.current
    if (!pendingReconciliation && !rateLimitReconciliation) return
    const requestedAddress = address
    const controller = new AbortController()
    manualController.current = controller
    setManualBusyAddress(requestedAddress)
    try {
      const result = await reconcileWelcomeClaim(requestedAddress, controller.signal)
      if (pendingReconciliation) applyPendingReconciledStatus(requestedAddress, result, controller.signal)
      else applyRateLimitReconciledStatus(requestedAddress, result, controller.signal)
    } catch {
      if (isCurrent(requestedAddress, controller.signal)) {
        setAddressError({ address: requestedAddress, text: 'No pudimos actualizar el estado todavía.' })
      }
    } finally {
      if (manualController.current === controller) manualController.current = null
      if (isCurrent(requestedAddress, controller.signal)) setManualBusyAddress(null)
    }
  }

  if (!allowed || !configured || !address) return null
  if (!compatible) return null

  const amountLabel = formatAmount(config)
  const completed = claim?.status === 'completed' || claim?.status === 'already_claimed'
  const pending = claim?.status === 'pending_review'
  const rateLimited = claim?.status === 'rate_limited'

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
      {((pending && pollExhausted) || rateLimited) && (
        <div className="actions">
          <button className="cta outline" type="button" onClick={() => void handleManualReconciliation()}
            disabled={manualBusy || (rateLimited && (!rateLimitManualReady || rateLimitReconciling))}>
            {manualBusy ? 'Actualizando...' : 'Actualizar estado'}
          </button>
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
    </section>
  )
}
