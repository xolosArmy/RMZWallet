import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { fetchTonalliMemoTx } from '../integrations/tonalliMemo/client'
import { formatTonalliMemoTimestamp } from '../integrations/tonalliMemo/format'
import { isValidTonalliMemoTxid } from '../integrations/tonalliMemo/guards'
import type { TonalliMemoTxDetail, TonalliMemoVerification } from '../integrations/tonalliMemo/types'

type DetailState =
  | { status: 'loading'; detail: TonalliMemoTxDetail | null }
  | { status: 'success'; detail: TonalliMemoTxDetail }
  | { status: 'error'; detail: null; message: string }

function VerificationFields({ verification }: { verification: TonalliMemoVerification | null }) {
  if (verification === null) {
    return (
      <div className="card">
        <h2>Verificacion</h2>
        <p className="muted">La API devolvio verification: null para esta transaccion.</p>
      </div>
    )
  }

  return (
    <div className="card">
      <h2>Verificacion</h2>
      <div className="memo-field-grid">
        <div>
          <span className="memo-field-label">Estado</span>
          <p>{verification.status}</p>
        </div>
        <div>
          <span className="memo-field-label">Perfil</span>
          <p>{verification.profileAlias || 'No disponible'}</p>
        </div>
        <div>
          <span className="memo-field-label">Codigo</span>
          <p>{verification.profileCode || 'No disponible'}</p>
        </div>
        <div>
          <span className="memo-field-label">Evento</span>
          <p>{verification.eventType || 'No disponible'}</p>
        </div>
        <div>
          <span className="memo-field-label">Cadena</span>
          <p>{verification.chainStatus || 'No disponible'}</p>
        </div>
        <div>
          <span className="memo-field-label">Altura</span>
          <p>{verification.blockHeight === null ? 'No disponible' : verification.blockHeight}</p>
        </div>
        <div>
          <span className="memo-field-label">Fecha</span>
          <p>{formatTonalliMemoTimestamp(verification.timestamp)}</p>
        </div>
      </div>
      <p className="tx-message memo-payload">{verification.payload || '(sin payload)'}</p>
    </div>
  )
}

function MemoTx() {
  const { txid = '' } = useParams()
  const validTxid = useMemo(() => isValidTonalliMemoTxid(txid), [txid])
  const [state, setState] = useState<DetailState>({ status: 'loading', detail: null })
  const [requestId, setRequestId] = useState(0)

  const retry = useCallback(() => {
    if (validTxid) {
      setState((current) => ({ status: 'loading', detail: current.detail }))
      setRequestId((value) => value + 1)
    }
  }, [validTxid])

  useEffect(() => {
    if (!validTxid) return

    const controller = new AbortController()
    let active = true

    fetchTonalliMemoTx(txid, controller.signal)
      .then((detail) => {
        if (!active || controller.signal.aborted) return
        setState({ status: 'success', detail })
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return
        setState({
          status: 'error',
          detail: null,
          message: error instanceof Error ? error.message : 'No se pudo cargar la transaccion Memo.'
        })
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [requestId, txid, validTxid])

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Tonalli Memo</p>
          <h1 className="section-title">Detalle de transaccion</h1>
          <p className="muted">Tonalli Wallet displays Tonalli Memo registry-policy verification over normalized Chronik transaction data. It does not independently verify eCash consensus or transaction signatures.</p>
        </div>
        <div className="quick-actions" aria-label="Acciones de detalle Memo">
          <Link className="cta outline" to="/memo">
            Feed
          </Link>
          <button className="cta outline" type="button" onClick={retry} disabled={!validTxid || state.status === 'loading'}>
            Reintentar
          </button>
        </div>
      </header>

      {!validTxid && (
        <div className="error" role="alert">
          TXID invalido. Debe tener 64 caracteres hexadecimales en minusculas.
        </div>
      )}

      {validTxid && state.status === 'loading' && (
        <div className="info" role="status">
          Cargando transaccion Tonalli Memo...
        </div>
      )}

      {validTxid && state.status === 'error' && (
        <div className="error" role="alert">
          <p className="success-title">No se pudo cargar la transaccion Memo</p>
          <p className="tx-meta">{state.message}</p>
          <button className="cta outline small" type="button" onClick={retry}>
            Reintentar
          </button>
        </div>
      )}

      {state.status === 'success' && (
        <>
          <div className="card">
            <h2>Transaccion</h2>
            <p className="muted">TXID completo</p>
            <div className="address-box">{state.detail.txid}</div>
            <div className="memo-field-grid">
              <div>
                <span className="memo-field-label">Estado</span>
                <p>{state.detail.transaction.status}</p>
              </div>
              <div>
                <span className="memo-field-label">Perfil</span>
                <p>{state.detail.transaction.profileAlias || 'No disponible'}</p>
              </div>
              <div>
                <span className="memo-field-label">Codigo</span>
                <p>{state.detail.transaction.profileCode || 'No disponible'}</p>
              </div>
              <div>
                <span className="memo-field-label">Evento</span>
                <p>{state.detail.transaction.eventType || 'No disponible'}</p>
              </div>
              <div>
                <span className="memo-field-label">Cadena</span>
                <p>{state.detail.transaction.chainStatus || 'No disponible'}</p>
              </div>
              <div>
                <span className="memo-field-label">Altura</span>
                <p>{state.detail.transaction.blockHeight === null ? 'No disponible' : state.detail.transaction.blockHeight}</p>
              </div>
              <div>
                <span className="memo-field-label">Fecha</span>
                <p>{formatTonalliMemoTimestamp(state.detail.transaction.timestamp)}</p>
              </div>
            </div>
            <p className="tx-message memo-payload">{state.detail.transaction.payload || '(sin payload)'}</p>
          </div>
          <VerificationFields verification={state.detail.verification} />
        </>
      )}
    </div>
  )
}

export default MemoTx
