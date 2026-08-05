import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import TopBar from '../components/TopBar'
import {
  TM1_DRAFT_02_WALLET_MAX_EVENT_DATA_BYTES,
  Tm1Draft02EncodingError,
  encodeTm1Draft02Post
} from '../integrations/tonalliMemo/tm1Draft02'

function MemoDraftPreview() {
  const [eventData, setEventData] = useState('')
  const [authorInputIndex, setAuthorInputIndex] = useState('0')

  const result = useMemo(() => {
    try {
      const parsedIndex = Number(authorInputIndex)
      return {
        preview: encodeTm1Draft02Post({ eventData, authorInputIndex: parsedIndex }),
        error: null
      }
    } catch (error) {
      return {
        preview: null,
        error: error instanceof Tm1Draft02EncodingError ? error.message : 'No se pudo generar la vista previa TM1.'
      }
    }
  }, [authorInputIndex, eventData])

  const eventDataByteLength = new TextEncoder().encode(eventData).length

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Tonalli Memo</p>
          <h1 className="section-title">Vista previa TM1 Draft 0.2</h1>
          <p className="muted">
            Construye y revisa el script OP_RETURN sin usar llaves, UTXO, firma, broadcast ni fondos reales.
          </p>
        </div>
        <div className="quick-actions" aria-label="Acciones de vista previa TM1">
          <Link className="cta outline" to="/memo">Volver al feed</Link>
        </div>
      </header>

      <div className="info" role="note">
        TM1 sigue siendo Draft 0.2. Esta pantalla no publica ni autoriza transacciones de producción.
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

        <label className="field">
          <span>Índice del input autor</span>
          <input
            type="number"
            min="0"
            max="255"
            step="1"
            value={authorInputIndex}
            onChange={(event) => setAuthorInputIndex(event.target.value)}
          />
        </label>
      </section>

      {result.error && (
        <div className="error" role="alert">
          <p className="success-title">Borrador no codificable</p>
          <p className="tx-meta">{result.error}</p>
        </div>
      )}

      {result.preview && (
        <section className="card" aria-labelledby="tm1-preview-result-title">
          <h2 id="tm1-preview-result-title">Resultado auditable</h2>
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
    </div>
  )
}

export default MemoDraftPreview
