import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import {
  TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES,
  Tm1Draft02EncodingError,
  encodeTm1Draft02Post
} from '../integrations/tonalliMemo/tm1Draft02'
import {
  TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX
} from '../integrations/tonalliMemo/tm1Draft02Plan'
import {
  prepareTm1Draft02Review,
  type Tm1Draft02ReviewSnapshot
} from '../integrations/tonalliMemo/prepareTm1Draft02Review'

function MemoDraftPreview() {
  const { initialized, address } = useWallet()
  const [eventData, setEventData] = useState('')
  const [reviewSnapshot, setReviewSnapshot] = useState<Tm1Draft02ReviewSnapshot | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const reviewRequestId = useRef(0)

  const result = useMemo(() => {
    try {
      return {
        preview: encodeTm1Draft02Post({
          eventData,
          authorInputIndex: TM1_DRAFT_02_STANDARD_AUTHOR_INPUT_INDEX
        }),
        error: null
      }
    } catch (error) {
      return {
        preview: null,
        error: error instanceof Tm1Draft02EncodingError ? error.message : 'No se pudo generar la vista previa TM1.'
      }
    }
  }, [eventData])

  useEffect(() => {
    reviewRequestId.current += 1
    setReviewSnapshot(null)
    setReviewError(null)
    setReviewLoading(false)
  }, [address, eventData])

  useEffect(() => () => {
    reviewRequestId.current += 1
  }, [])

  const eventDataByteLength = new TextEncoder().encode(eventData).length

  const calculateEstimatedPlan = async () => {
    if (!result.preview || !initialized) return

    const requestId = reviewRequestId.current + 1
    reviewRequestId.current = requestId
    setReviewLoading(true)
    setReviewError(null)
    setReviewSnapshot(null)

    try {
      const snapshot = await prepareTm1Draft02Review({ eventData })
      if (reviewRequestId.current === requestId) {
        setReviewSnapshot(snapshot)
      }
    } catch (error) {
      if (reviewRequestId.current === requestId) {
        setReviewError(error instanceof Error ? error.message : 'No se pudo calcular el plan TM1 estimado.')
      }
    } finally {
      if (reviewRequestId.current === requestId) {
        setReviewLoading(false)
      }
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Tonalli Memo</p>
          <h1 className="section-title">Vista previa TM1 Draft 0.2</h1>
          <p className="muted">
            Revisa el mensaje y calcula un plan estimado sin acceder a llaves, firmar, transmitir ni publicar.
          </p>
        </div>
        <div className="quick-actions" aria-label="Acciones de vista previa TM1">
          <Link className="cta outline" to="/memo">Volver al feed</Link>
        </div>
      </header>

      <div className="info" role="note">
        TM1 sigue siendo Draft 0.2. Esta pantalla consulta UTXOs para estimar el fondeo, pero no construye una transacción firmada ni autoriza emisiones en mainnet.
      </div>

      <section className="card" aria-labelledby="tm1-preview-form-title">
        <h2 id="tm1-preview-form-title">Datos del borrador</h2>

        <label className="field">
          <span>Mensaje exacto</span>
          <textarea
            value={eventData}
            onChange={(event) => setEventData(event.target.value)}
            rows={6}
            placeholder="Escribe el mensaje sin normalización automática"
          />
        </label>
        <p className="muted tx-meta">
          {eventDataByteLength}/{TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES} bytes UTF-8. Los espacios y saltos de línea se conservan.
        </p>

        <div className="field">
          <span>Índice del input autor</span>
          <p>0</p>
          <p className="muted tx-meta">
            Política de Tonalli Wallet para publicaciones ordinarias autofinanciadas.
          </p>
        </div>

        <div className="field">
          <span>Dirección activa</span>
          <p className="tx-address">{address ?? 'Billetera no inicializada'}</p>
        </div>

        <button
          className="cta"
          type="button"
          onClick={() => void calculateEstimatedPlan()}
          disabled={!initialized || !result.preview || reviewLoading}
        >
          {reviewLoading ? 'Calculando plan estimado…' : 'Calcular plan estimado'}
        </button>
      </section>

      {result.error && (
        <div className="error" role="alert">
          <p className="success-title">Borrador no codificable</p>
          <p className="tx-meta">{result.error}</p>
        </div>
      )}

      {reviewError && (
        <div className="error" role="alert">
          <p className="success-title">Plan estimado no disponible</p>
          <p className="tx-meta">{reviewError}</p>
        </div>
      )}

      {result.preview && (
        <section className="card" aria-labelledby="tm1-preview-result-title">
          <h2 id="tm1-preview-result-title">Resultado auditable del encoder</h2>
          <div className="memo-field-grid">
            <div>
              <span className="memo-field-label">Protocolo</span>
              <p>TM1 Draft 0.2</p>
            </div>
            <div>
              <span className="memo-field-label">LOKAD ID</span>
              <p className="tx-address">{result.preview.lokadIdHex}</p>
            </div>
            <div>
              <span className="memo-field-label">Versión</span>
              <p>0x{result.preview.version.toString(16).padStart(2, '0')}</p>
            </div>
            <div>
              <span className="memo-field-label">Evento</span>
              <p>POST (0x{result.preview.eventType.toString(16).padStart(2, '0')})</p>
            </div>
            <div>
              <span className="memo-field-label">Input autor</span>
              <p>{result.preview.authorInputIndex}</p>
            </div>
            <div>
              <span className="memo-field-label">Bytes del mensaje</span>
              <p>{result.preview.eventDataByteLength}</p>
            </div>
            <div>
              <span className="memo-field-label">Bytes del envelope</span>
              <p>{result.preview.envelopeByteLength}</p>
            </div>
            <div>
              <span className="memo-field-label">Bytes del script</span>
              <p>{result.preview.scriptByteLength}</p>
            </div>
          </div>

          <div className="field">
            <span>Envelope hexadecimal</span>
            <code className="tx-address" style={{ display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {result.preview.envelopeHex}
            </code>
          </div>

          <div className="field">
            <span>Script OP_RETURN hexadecimal</span>
            <code className="tx-address" style={{ display: 'block', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {result.preview.scriptHex}
            </code>
          </div>
        </section>
      )}

      {reviewSnapshot && (
        <section className="card" aria-labelledby="tm1-review-snapshot-title">
          <h2 id="tm1-review-snapshot-title">Snapshot estimado de fondeo</h2>
          <p className="muted">
            Esta revisión es informativa. La comisión y el tamaño se estiman antes de existir una transacción firmada.
          </p>

          <div className="memo-field-grid">
            <div>
              <span className="memo-field-label">Dirección autora</span>
              <p className="tx-address">{reviewSnapshot.address}</p>
            </div>
            <div>
              <span className="memo-field-label">Hash160 del autor</span>
              <p className="tx-address">{reviewSnapshot.authorPublicKeyHashHex}</p>
            </div>
            <div>
              <span className="memo-field-label">Input autor</span>
              <p>{reviewSnapshot.authorInputIndex}</p>
            </div>
            <div>
              <span className="memo-field-label">Inputs seleccionados</span>
              <p>{reviewSnapshot.selectedInputs.length}</p>
            </div>
            <div>
              <span className="memo-field-label">Comisión de red estimada</span>
              <p>{reviewSnapshot.estimatedFeeSats.toString()} sats ({reviewSnapshot.estimatedFeeXec} XEC)</p>
            </div>
            <div>
              <span className="memo-field-label">Cambio estimado</span>
              <p>{reviewSnapshot.estimatedChangeSats.toString()} sats</p>
            </div>
            <div>
              <span className="memo-field-label">Tamaño estimado</span>
              <p>{reviewSnapshot.estimatedSizeBytes} bytes</p>
            </div>
            <div>
              <span className="memo-field-label">Suposición por input firmado</span>
              <p>{reviewSnapshot.signedInputSizeAssumptionBytes} bytes P2PKH</p>
            </div>
          </div>

          <div className="field">
            <span>Mensaje exacto revisado</span>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reviewSnapshot.message}</pre>
          </div>

          <div className="field">
            <span>Inputs estimados</span>
            <ol>
              {reviewSnapshot.selectedInputs.map((input) => (
                <li key={`${input.txid}:${input.outIdx}`} className="tx-meta">
                  {input.role === 'author' ? 'Autor' : 'Fondeo'} · {input.txid}:{input.outIdx} · {input.sats.toString()} sats
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
    </div>
  )
}

export default MemoDraftPreview
