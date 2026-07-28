import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { fetchTonalliMemoFeed } from '../integrations/tonalliMemo/client'
import { abbreviateTxid, formatTonalliMemoTimestamp } from '../integrations/tonalliMemo/format'
import type { TonalliMemoFeedItem } from '../integrations/tonalliMemo/types'

type FeedState =
  | { status: 'loading'; items: TonalliMemoFeedItem[] }
  | { status: 'success'; items: TonalliMemoFeedItem[] }
  | { status: 'error'; items: TonalliMemoFeedItem[]; message: string }

const FEED_LIMIT = 25

function MemoFeed() {
  const [state, setState] = useState<FeedState>({ status: 'loading', items: [] })
  const [requestId, setRequestId] = useState(0)

  const retry = useCallback(() => {
    setState((current) => ({ status: 'loading', items: current.items }))
    setRequestId((value) => value + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let active = true

    fetchTonalliMemoFeed(FEED_LIMIT, controller.signal)
      .then((feed) => {
        if (!active || controller.signal.aborted) return
        setState({ status: 'success', items: feed.items })
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return
        setState({
          status: 'error',
          items: [],
          message: error instanceof Error ? error.message : 'No se pudo cargar Tonalli Memo.'
        })
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [requestId])

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Tonalli Memo</p>
          <h1 className="section-title">Feed oficial verificado</h1>
          <p className="muted">Mensajes oficiales de Tonalli Memo validados por la politica publica del registro.</p>
        </div>
        <div className="quick-actions" aria-label="Acciones del feed Memo">
          <button className="cta outline" type="button" onClick={retry} disabled={state.status === 'loading'}>
            Reintentar
          </button>
        </div>
      </header>

      {state.status === 'loading' && (
        <div className="info" role="status">
          Cargando Tonalli Memo...
        </div>
      )}

      {state.status === 'error' && (
        <div className="error" role="alert">
          <p className="success-title">No se pudo cargar Tonalli Memo</p>
          <p className="tx-meta">{state.message}</p>
          <button className="cta outline small" type="button" onClick={retry}>
            Reintentar
          </button>
        </div>
      )}

      {state.status === 'success' && state.items.length === 0 && (
        <div className="card">
          <p className="muted">No hay mensajes oficiales verificados por ahora.</p>
        </div>
      )}

      {state.items.length > 0 && (
        <div className="tx-list" aria-label="Mensajes Tonalli Memo verificados">
          {state.items.map((item) => (
            <article className="tx-item memo-feed-item" key={item.txid}>
              <div className="memo-feed-item__header">
                <div>
                  <h2>{item.profileAlias || 'Perfil oficial'}</h2>
                  <p className="muted tx-meta">{item.profileCode || 'Codigo no disponible'}</p>
                </div>
                <span className="pill">{item.status}</span>
              </div>
              <div className="memo-field-grid">
                <div>
                  <span className="memo-field-label">Evento</span>
                  <p>{item.eventType || 'No disponible'}</p>
                </div>
                <div>
                  <span className="memo-field-label">Cadena</span>
                  <p>{item.chainStatus || 'No disponible'}</p>
                </div>
                <div>
                  <span className="memo-field-label">Altura</span>
                  <p>{item.blockHeight === null ? 'No disponible' : item.blockHeight}</p>
                </div>
                <div>
                  <span className="memo-field-label">Fecha</span>
                  <p>{formatTonalliMemoTimestamp(item.timestamp)}</p>
                </div>
              </div>
              <p className="tx-message memo-payload">{item.payload || '(sin payload)'}</p>
              <Link className="tx-address memo-tx-link" to={`/memo/tx/${item.txid}`} title={item.txid}>
                {abbreviateTxid(item.txid)}
              </Link>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}

export default MemoFeed
