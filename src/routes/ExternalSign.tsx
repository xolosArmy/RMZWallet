import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { ExternalSignApprovalCapabilityV1 } from '../features/externalSign/approval'
import { getCurrentBrowserCapabilities } from '../features/externalSign/browser'
import { calculateExternalSignContentHash, type ExternalSignContentHash } from '../features/externalSign/contentHash'
import { EXTERNAL_SIGN_CONFIG, EXTERNAL_SIGN_P0_ENABLED } from '../features/externalSign/config'
import {
  EXTERNAL_SIGN_REQUEST_STORAGE_KEY,
  EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY,
  ExternalSignError,
  parseExternalSignRequestParam,
  storePendingExternalSignRequest,
  takePendingExternalSignRequest,
  type ExternalSignWireRequestV1,
  type OriginContextV1
} from '../features/externalSign/contract'
import { acquireExternalSignLock, type ExternalSignLockLease } from '../features/externalSign/lock'
import {
  assertExternalSignOriginAllowed,
  authenticateExternalSignOrigin,
  declaredOriginContext,
  deliverExternalSignResponse
} from '../features/externalSign/origin'
import { IndexedDbExternalSignReplayStore } from '../features/externalSign/replayStore'
import { buildExternalSignReview, xecFromSats, type ExternalSignPrevoutProvider, type ExternalSignTxReviewV1 } from '../features/externalSign/review'
import { finalizeApprovedExternalSign, terminateExternalSignRequest } from '../features/externalSign/session'
import type { ExternalSignResponseV1 } from '../features/externalSign/signOnly'
import { getChronik } from '../services/ChronikClient'
import { xolosWalletService } from '../services/XolosWalletService'

const ONBOARDING_RETURN_TO = '/external-sign'

type PreparedRequest = Readonly<{
  origin: OriginContextV1
  review: ExternalSignTxReviewV1
  contentHash: ExternalSignContentHash
}>

const errorMessage = (error: unknown): string => {
  const code = error instanceof ExternalSignError ? error.code : 'EXTERNAL_SIGN_FAILED'
  const messages: Record<string, string> = {
    ORIGIN_NOT_AUTHENTICATED: 'El origen está declarado, no verificado. Esta solicitud no puede firmarse.',
    ORIGIN_NOT_ALLOWED: 'El origen autenticado no está autorizado por la política local.',
    EXTERNAL_SIGN_BUSY_OR_LOCK_UNAVAILABLE: 'Hay otra solicitud activa o el navegador no puede garantizar exclusión mutua.',
    REQUEST_REPLAYED: 'Esta solicitud ya fue consumida o cerrada.',
    FEE_OUT_OF_POLICY: 'El fee no cumple simultáneamente los límites absoluto y por byte.',
    INPUT_NOT_OWNED: 'Uno o más inputs no pertenecen a la wallet activa.',
    TOKEN_OR_UNINTERPRETABLE_DATA: 'La transacción contiene tokens o datos que P0 no puede presentar íntegramente.',
    UNSUPPORTED_OUTPUT_SCRIPT: 'La transacción contiene un output distinto de P2PKH.',
    LEGACY_BROADCAST_FORBIDDEN: 'Las solicitudes con broadcast están prohibidas en P0.',
    MODE_FORBIDDEN: 'P0 acepta exclusivamente la modalidad signOnly.'
  }
  return messages[code] ?? `Solicitud bloqueada: ${code}`
}

const readOnlyChronikProvider = (): ExternalSignPrevoutProvider => {
  const chronik = getChronik()
  return Object.freeze({
    tx: (txid: string) => chronik.tx(txid),
    validateRawTx: (rawTx: string) => chronik.validateRawTx(rawTx)
  })
}

export function ExternalSignDisabled() {
  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">TONALLI_SIGN_REQUEST</p>
          <h1 className="section-title">Firma externa deshabilitada</h1>
          <p className="muted">La ruta permanece cerrada por política de seguridad.</p>
        </div>
      </header>
      <section className="card">
        <div className="error">EXTERNAL_SIGN_DISABLED</div>
        <p className="muted">No se firmó ni se transmitió ninguna transacción.</p>
      </section>
    </div>
  )
}

function ExternalSign() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { address, initialized } = useWallet()
  const [request, setRequest] = useState<ExternalSignWireRequestV1 | null>(null)
  const [origin, setOrigin] = useState<OriginContextV1 | null>(null)
  const [prepared, setPrepared] = useState<PreparedRequest | null>(null)
  const [result, setResult] = useState<ExternalSignResponseV1 | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [remainingMs, setRemainingMs] = useState(0)
  const loadHandledRef = useRef(false)
  const onboardingHandledRef = useRef(false)
  const capabilityRef = useRef<ExternalSignApprovalCapabilityV1 | null>(null)
  const providerRef = useRef<ExternalSignPrevoutProvider | null>(null)
  const replayStoreRef = useRef<IndexedDbExternalSignReplayStore | null>(null)
  const leaseRef = useRef<ExternalSignLockLease | null>(null)
  const channelRef = useRef<BroadcastChannel | null>(null)

  const walletReady = initialized && Boolean(address)
  const totalSentSats = useMemo(() => prepared?.review.outputs
    .filter(output => output.classification === 'recipient')
    .reduce((total, output) => total + BigInt(output.sats), 0n)
    .toString(10) ?? '0', [prepared])

  useEffect(() => {
    if (loadHandledRef.current || !EXTERNAL_SIGN_P0_ENABLED) return
    loadHandledRef.current = true
    try {
      const fromQuery = searchParams.get('request')
      const parsed = fromQuery
        ? parseExternalSignRequestParam(fromQuery)
        : takePendingExternalSignRequest(sessionStorage)
      if (!parsed) throw new ExternalSignError('REQUEST_NOT_FOUND')
      setRequest(parsed)
      setOrigin(declaredOriginContext(parsed))
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [searchParams])

  useEffect(() => {
    if (!request || walletReady || onboardingHandledRef.current) return
    onboardingHandledRef.current = true
    storePendingExternalSignRequest(sessionStorage, request)
    sessionStorage.setItem(EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY, ONBOARDING_RETURN_TO)
    navigate(`/onboarding?returnTo=${encodeURIComponent(ONBOARDING_RETURN_TO)}`, { replace: true })
  }, [navigate, request, walletReady])

  useEffect(() => {
    if (!request || !walletReady || !address || prepared || result || error) return
    let cancelled = false

    void (async () => {
      try {
        const capabilities = getCurrentBrowserCapabilities()
        if (!capabilities.supported) {
          throw new ExternalSignError('UNSUPPORTED_BROWSER', capabilities.missing.join(', '))
        }
        const replayStore = new IndexedDbExternalSignReplayStore(indexedDB)
        replayStoreRef.current = replayStore
        await replayStore.purgeExpired(Date.now())
        if (await replayStore.has(request.requestId)) throw new ExternalSignError('REQUEST_REPLAYED')
        const lease = await acquireExternalSignLock(navigator.locks)
        if (cancelled) {
          lease.release()
          return
        }
        leaseRef.current = lease
        const channel = new BroadcastChannel('tonalli-external-sign-v1')
        channelRef.current = channel
        channel.postMessage({ type: 'active', requestId: request.requestId })

        const trustedOrigin = await authenticateExternalSignOrigin(request, crypto, window)
        if (cancelled) return
        setOrigin(trustedOrigin)
        assertExternalSignOriginAllowed(trustedOrigin, EXTERNAL_SIGN_CONFIG.allowedOrigins)

        const provider = readOnlyChronikProvider()
        providerRef.current = provider
        const review = await buildExternalSignReview(request, address, provider)
        const contentHash = await calculateExternalSignContentHash(request, trustedOrigin, review)
        if (cancelled) return
        setPrepared(Object.freeze({ origin: trustedOrigin, review, contentHash }))
        setRemainingMs(Math.max(0, request.expiresAt - Date.now()))
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught))
      }
    })()

    return () => {
      cancelled = true
      capabilityRef.current?.invalidate()
      capabilityRef.current = null
      channelRef.current?.close()
      channelRef.current = null
      leaseRef.current?.release()
      leaseRef.current = null
    }
  }, [address, error, prepared, request, result, walletReady])

  useEffect(() => {
    if (!request || !prepared || result) return
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, request.expiresAt - Date.now())
      setRemainingMs(remaining)
      if (remaining === 0) {
        window.clearInterval(timer)
        capabilityRef.current?.invalidate()
        capabilityRef.current = null
        setPrepared(null)
        setError('Solicitud bloqueada: REQUEST_EXPIRED')
        const replayStore = replayStoreRef.current
        if (replayStore) void terminateExternalSignRequest(request, replayStore, 'expired').catch(() => undefined)
      }
    }, 250)
    return () => window.clearInterval(timer)
  }, [prepared, request, result])

  useEffect(() => {
    const invalidate = () => capabilityRef.current?.invalidate()
    window.addEventListener('beforeunload', invalidate)
    return () => window.removeEventListener('beforeunload', invalidate)
  }, [])

  const releaseSession = () => {
    capabilityRef.current = null
    providerRef.current = null
    channelRef.current?.close()
    channelRef.current = null
    leaseRef.current?.release()
    leaseRef.current = null
    sessionStorage.removeItem(EXTERNAL_SIGN_REQUEST_STORAGE_KEY)
    sessionStorage.removeItem(EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY)
  }

  const reject = async () => {
    if (!request || !replayStoreRef.current) return
    capabilityRef.current?.invalidate()
    setProcessing(true)
    try {
      await terminateExternalSignRequest(request, replayStoreRef.current, 'rejected', Date.now(), prepared?.contentHash ?? null)
      channelRef.current?.postMessage({ type: 'rejected', requestId: request.requestId })
      setPrepared(null)
      setError('Solicitud rechazada. No se firmó ni se transmitió ninguna transacción.')
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setProcessing(false)
      releaseSession()
    }
  }

  const approveAndSign = async () => {
    if (!request || !prepared || !providerRef.current || !replayStoreRef.current || !address || processing) return
    setProcessing(true)
    setError(null)
    const capability = new ExternalSignApprovalCapabilityV1(
      request.requestId,
      prepared.contentHash,
      request.expiresAt,
      Date.now()
    )
    capabilityRef.current = capability
    try {
      const provider = providerRef.current
      const signed = await finalizeApprovedExternalSign(
        request,
        prepared.origin,
        prepared.review,
        prepared.contentHash,
        capability,
        {
          reviewAgain: () => buildExternalSignReview(request, address, provider),
          replayStore: replayStoreRef.current,
          signer: { getSignatory: () => xolosWalletService.getSignatory() }
        }
      )
      setResult(signed)
      setPrepared(null)
      channelRef.current?.postMessage({ type: 'signed', requestId: request.requestId })
      deliverExternalSignResponse(signed, prepared.origin, window.opener)
    } catch (caught) {
      capability.invalidate()
      setError(errorMessage(caught))
    } finally {
      setProcessing(false)
      releaseSession()
    }
  }

  if (!EXTERNAL_SIGN_P0_ENABLED) return <ExternalSignDisabled />

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">TONALLI_SIGN_REQUEST_V1</p>
          <h1 className="section-title">Revisar firma externa</h1>
          <p className="muted">Solo se firmará. Tonalli Wallet no transmitirá esta transacción.</p>
        </div>
      </header>

      <section className="card">
        {request && (
          <>
            <h2>Solicitud</h2>
            <p><strong>Red:</strong> {request.chainId}</p>
            <p><strong>Modalidad:</strong> {request.mode}</p>
            <p><strong>Solicitante:</strong> {request.requester.displayName}</p>
            <p><strong>Confianza del origen:</strong> {origin?.status ?? 'unknown'}</p>
            <p><strong>Origen declarado:</strong> {origin?.declaredOrigin ?? 'Ninguno'} (declarado, no verificado)</p>
            <p><strong>Origen autenticado:</strong> {origin?.authenticatedOrigin ?? 'Ninguno'}</p>
            <p style={{ wordBreak: 'break-all' }}><strong>requestId:</strong> {request.requestId}</p>
            {request.intentId && <p style={{ wordBreak: 'break-all' }}><strong>intentId:</strong> {request.intentId}</p>}
            <p><strong>Expiración:</strong> {new Date(request.expiresAt).toISOString()} ({Math.ceil(remainingMs / 1000)} s)</p>
          </>
        )}

        {prepared && (
          <>
            <h2>Inputs ({prepared.review.inputs.length})</h2>
            {prepared.review.inputs.map(input => (
              <div className="card" key={`${input.txid}:${input.vout}`}>
                <p style={{ wordBreak: 'break-all' }}><strong>Outpoint:</strong> {input.txid}:{input.vout}</p>
                <p><strong>Cantidad:</strong> {input.sats} sats ({xecFromSats(input.sats)})</p>
                <p style={{ wordBreak: 'break-all' }}><strong>Script P2PKH:</strong> {input.outputScript}</p>
                <p><strong>Propiedad:</strong> wallet activa verificada</p>
              </div>
            ))}

            <h2>Outputs ({prepared.review.outputs.length})</h2>
            {prepared.review.outputs.map(output => (
              <div className="card" key={output.index}>
                <p><strong>Output {output.index}:</strong> {output.classification === 'change' ? 'Cambio' : 'Destinatario'}</p>
                <p style={{ wordBreak: 'break-all' }}><strong>Dirección:</strong> {output.address}</p>
                <p><strong>Cantidad:</strong> {output.sats} sats ({xecFromSats(output.sats)})</p>
                <p style={{ wordBreak: 'break-all' }}><strong>Script P2PKH:</strong> {output.outputScript}</p>
              </div>
            ))}

            <h2>Resumen exacto</h2>
            <p><strong>Total enviado:</strong> {totalSentSats} sats ({xecFromSats(totalSentSats)})</p>
            <p><strong>Total inputs:</strong> {prepared.review.inputTotalSats} sats</p>
            <p><strong>Total outputs:</strong> {prepared.review.outputTotalSats} sats</p>
            <p><strong>Fee:</strong> {prepared.review.feeSats} sats ({xecFromSats(prepared.review.feeSats)})</p>
            <p><strong>Fee rate:</strong> {prepared.review.feeRateSatsPerByte} sat/byte</p>
            <p><strong>Tamaño:</strong> {prepared.review.serializedSizeBytes} bytes</p>
            <p><strong>Tokens:</strong> ninguno</p>
            <p><strong>OP_RETURN:</strong> ninguno</p>
            <p style={{ wordBreak: 'break-all' }}><strong>contentHash:</strong> {prepared.contentHash}</p>
            <div className="error">Advertencia: únicamente se firmará. No se transmitirá a la red.</div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
              <button type="button" className="secondary" onClick={() => void reject()} disabled={processing}>Rechazar</button>
              <button type="button" onClick={() => void approveAndSign()} disabled={processing || remainingMs === 0}>
                {processing ? 'Revalidando...' : 'Aprobar y firmar'}
              </button>
            </div>
          </>
        )}

        {!prepared && !result && !error && <div className="muted">Validando solicitud y preparando vista previa...</div>}
        {error && <div className="error">{error}</div>}
        {result && (
          <div className="success">
            <p>Firma completada. La transacción no fue transmitida.</p>
            <p style={{ wordBreak: 'break-all' }}><strong>contentHash:</strong> {result.contentHash}</p>
            <label htmlFor="signed-tx">signedTxHex</label>
            <textarea id="signed-tx" rows={4} value={result.signedTxHex} readOnly />
          </div>
        )}
      </section>
    </div>
  )
}

export default ExternalSign
