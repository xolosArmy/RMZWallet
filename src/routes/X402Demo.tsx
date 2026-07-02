import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTonalliX402ApprovalHandler } from '../context/useTonalliX402ApprovalHandler'
import { TonalliBrowserWalletAdapter, type TonalliX402Wallet } from '../integrations/x402/TonalliBrowserWalletAdapter'
import { TonalliX402AuthorizationDryRunOrchestrator } from '../integrations/x402/TonalliX402AuthorizationDryRunOrchestrator'
import { createX402DemoClient, createX402DemoMockAdapter, X402_DEMO_PATH, type X402DemoResponse, type X402DemoStep } from '../integrations/x402/X402DemoClient'
import { xolosWalletService } from '../services/XolosWalletService'
import TopBar from '../components/TopBar'

const STEP_LABELS: Record<X402DemoStep, string> = {
  'request-received-402': 'Request received HTTP 402',
  'approval-requested': 'Approval requested',
  'approval-accepted': 'Approval accepted',
  'approval-rejected': 'Approval rejected',
  'approval-cancelled': 'Approval cancelled',
  'authorization-signature-returned': 'Authorization signature returned',
  'payment-signature-attached': 'PAYMENT-SIGNATURE attached',
  'mocked-protected-resource-returned': 'Mocked protected resource returned'
}

export default function X402Demo() {
  const requestApproval = useTonalliX402ApprovalHandler()
  const [steps, setSteps] = useState<X402DemoStep[]>([])
  const [result, setResult] = useState<X402DemoResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const mounted = useRef(true)

  const recordStep = useCallback((step: X402DemoStep) => {
    if (!mounted.current) return
    setSteps((current) => current.includes(step) ? current : [...current, step])
  }, [])

  const client = useMemo(() => {
    const walletAdapter = new TonalliBrowserWalletAdapter({
      walletService: xolosWalletService as TonalliX402Wallet,
      approvalHandler: requestApproval
    })
    const orchestrator = new TonalliX402AuthorizationDryRunOrchestrator({
      walletAdapter,
      onStatus: recordStep
    })
    const mock = createX402DemoMockAdapter(recordStep)
    return createX402DemoClient(orchestrator, mock.adapter)
  }, [recordStep, requestApproval])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      setSteps([])
      setResult(null)
      setError(null)
    }
  }, [])

  const runDemo = async () => {
    setSteps([])
    setResult(null)
    setError(null)
    setRunning(true)
    try {
      const demoResponse = await client.get<X402DemoResponse>(X402_DEMO_PATH)
      if (mounted.current) setResult(demoResponse.data)
    } catch {
      if (mounted.current) setError('Authorization dry run stopped safely.')
    } finally {
      if (mounted.current) setRunning(false)
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">x402-XEC authorization demo</p>
          <h1 className="section-title">DRY RUN ONLY</h1>
          <p className="muted">
            Local mocked HTTP 402 flow. No transaction created, no funds moved,
            no Chronik request, and no broadcast performed.
          </p>
        </div>
      </header>

      <div className="card">
        <button className="cta primary" type="button" disabled={running} onClick={runDemo}>
          {running ? 'Waiting for approval…' : 'Test 402 Authorization'}
        </button>
        <div style={{ display: 'grid', gap: 8, marginTop: 18 }}>
          {steps.map((step) => <div key={step} className="muted">✓ {STEP_LABELS[step]}</div>)}
        </div>
        {result && (
          <div className="success" style={{ marginTop: 18 }}>
            Mock response 200 · {result.notice} · broadcasted: false
          </div>
        )}
        {error && <div className="error" style={{ marginTop: 18 }}>{error}</div>}
      </div>

      <div className="card">
        <strong>Safety boundary</strong>
        <p className="muted">
          Authorization message only. The demo transaction outpoint is an all-zero placeholder,
          not a real funding transaction.
        </p>
        <p className="muted">
          No transaction created · no funds moved · no Chronik request · no broadcast performed.
        </p>
      </div>

      <Link className="cta ghost" to="/">Back to Dashboard</Link>
    </div>
  )
}
