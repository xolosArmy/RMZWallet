import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useTrustedX402Client } from '../integrations/x402/useTrustedX402Client'
import type { TonalliX402AuthorizationDryRunStatus } from '../integrations/x402/TonalliX402AuthorizationDryRunOrchestrator'
import {
  X402_STAGING_ALLOWLIST,
  X402_STAGING_MAX_PAYMENT_SATS
} from '../integrations/x402/x402StagingFeature'
import type { X402StagingResponse } from '../integrations/x402/X402StagingResponse'
import { runX402StagingAuthorization } from '../integrations/x402/runX402StagingAuthorization'

export type X402StagingStatus =
  | 'request-started'
  | 'http-402-received'
  | 'approval-requested'
  | 'approval-accepted'
  | 'authorization-signed'
  | 'server-verification-successful'

const STATUS_LABELS: Record<X402StagingStatus, string> = {
  'request-started': 'request started',
  'http-402-received': 'HTTP 402 received',
  'approval-requested': 'approval requested',
  'approval-accepted': 'approval accepted',
  'authorization-signed': 'authorization signed',
  'server-verification-successful': 'server verification successful'
}

const toDisplayStatus = (
  status: TonalliX402AuthorizationDryRunStatus
): X402StagingStatus | null => {
  if (status === 'approval-requested') return 'approval-requested'
  if (status === 'approval-accepted') return 'approval-accepted'
  if (status === 'authorization-signature-returned') return 'authorization-signed'
  return null
}

export default function X402Staging() {
  const [statuses, setStatuses] = useState<X402StagingStatus[]>([])
  const [result, setResult] = useState<X402StagingResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [running, setRunning] = useState(false)
  const mounted = useRef(true)
  const activeRequest = useRef<AbortController | null>(null)

  const recordStatus = useCallback((status: X402StagingStatus) => {
    if (!mounted.current) return
    setStatuses((current) => current.includes(status) ? current : [...current, status])
  }, [])

  const clientOptions = useMemo(() => ({
    allowlist: X402_STAGING_ALLOWLIST,
    maxPaymentSats: X402_STAGING_MAX_PAYMENT_SATS,
    onPaymentRequired: () => recordStatus('http-402-received'),
    onStatus: (status: TonalliX402AuthorizationDryRunStatus) => {
      const displayStatus = toDisplayStatus(status)
      if (displayStatus !== null) recordStatus(displayStatus)
    }
  }), [recordStatus])
  const client = useTrustedX402Client(clientOptions)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      activeRequest.current?.abort()
      activeRequest.current = null
      setStatuses([])
      setResult(null)
      setFailed(false)
      setRunning(false)
    }
  }, [])

  const runTest = async () => {
    if (running) return
    setStatuses([])
    setResult(null)
    setFailed(false)
    setRunning(true)
    recordStatus('request-started')

    if (client === null) {
      setFailed(true)
      setRunning(false)
      return
    }

    const controller = new AbortController()
    activeRequest.current = controller
    try {
      const boundedResult = await runX402StagingAuthorization(client, controller.signal)
      if (!mounted.current) return
      setResult(boundedResult)
      recordStatus('server-verification-successful')
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      if (mounted.current) {
        activeRequest.current = null
        setRunning(false)
      }
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">x402-XEC trusted staging</p>
          <h1 className="section-title">Authorization-only staging test</h1>
        </div>
      </header>

      <div className="card">
        <button
          className="cta primary"
          type="button"
          disabled={running}
          onClick={runTest}
        >
          Test real staging authorization
        </button>

        <div style={{ display: 'grid', gap: 8, marginTop: 18 }}>
          {statuses.map((status) => (
            <div key={status} className="muted">✓ {STATUS_LABELS[status]}</div>
          ))}
        </div>

        {result && (
          <X402StagingResultView result={result} />
        )}
        {failed && (
          <div className="error" style={{ marginTop: 18 }}>
            Authorization test stopped safely.
          </div>
        )}
      </div>

      <Link className="cta ghost" to="/">Back to Dashboard</Link>
    </div>
  )
}

export function X402StagingResultView({ result }: { result: X402StagingResponse }) {
  return (
    <dl className="success" style={{ marginTop: 18 }}>
      <dt>notice</dt><dd>{result.notice}</dd>
      <dt>authorizationOnly</dt><dd>{String(result.authorizationOnly)}</dd>
      <dt>broadcasted</dt><dd>{String(result.broadcasted)}</dd>
      <dt>payer</dt><dd>{result.payer}</dd>
    </dl>
  )
}
