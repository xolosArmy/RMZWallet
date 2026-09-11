import { useMemo, useState } from 'react'
import {
  encodeTm1Draft02Post,
  TM1_DRAFT_02_PROTOCOL_MAX_EVENT_DATA_BYTES,
  type Tm1Draft02PostPreview
} from '../../integrations/tonalliMemo/tm1Draft02'

export interface CanonicalPayloadPreviewProps {
  message: string
  authorInputIndex?: number
  preview?: Tm1Draft02PostPreview | null
  error?: string | null
}

export function CanonicalPayloadPreview({
  message,
  authorInputIndex = 0,
  preview: externalPreview,
  error: externalError
}: CanonicalPayloadPreviewProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null)

  // Compute preview if not supplied externally
  const computed = useMemo(() => {
    if (externalPreview !== undefined) {
      return { preview: externalPreview, error: externalError ?? null }
    }
    const trimmed = message.trim()
    if (!trimmed) {
      return { preview: null, error: null }
    }
    try {
      const p = encodeTm1Draft02Post({
        eventData: message,
        authorInputIndex,
        maxEventDataBytes: TM1_DRAFT_02_PROTOCOL_MAX_EVENT_DATA_BYTES
      })
      return { preview: p, error: null }
    } catch (err) {
      return {
        preview: null,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }, [message, authorInputIndex, externalPreview, externalError])

  const preview = computed.preview
  const error = computed.error

  const copyToClipboard = (text: string, fieldName: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        setCopiedField(fieldName)
        setTimeout(() => setCopiedField(null), 2000)
      }).catch(() => {
        // clipboard write failed silently
      })
    }
  }

  return (
    <div className="card canonical-preview" data-testid="canonical-preview">
      <div className="canonical-preview__header">
        <p className="eyebrow">Auditoría Criptográfica Wire</p>
        <h3 className="section-title">Vista Previa Payload Canónico TM1</h3>
        <p className="muted tx-meta">
          Payload binario exacto que será firmado por la clave de titularidad y difundido a la red eCash.
        </p>
      </div>

      {!preview && !error && (
        <div className="canonical-preview__placeholder card subtle" data-testid="preview-empty-state">
          <p className="muted">
            Ingresa un mensaje en el editor para previsualizar la estructura canónica y los bytes hexadecimales de OP_RETURN.
          </p>
        </div>
      )}

      {error && (
        <div className="error tx-meta" role="alert" data-testid="preview-error-state">
          <p className="tx-meta error-text">
            <strong>Error de codificación canónica:</strong> {error}
          </p>
        </div>
      )}

      {preview && (
        <div className="canonical-preview__content" data-testid="preview-active-content">
          <div className="memo-field-grid">
            <div>
              <span className="memo-field-label">Protocolo / Borrador</span>
              <p className="monospace">
                <strong>{preview.protocol}</strong> (Draft {preview.draft})
              </p>
            </div>
            <div>
              <span className="memo-field-label">LOKAD ID</span>
              <p className="monospace">
                <code>0x{preview.lokadIdHex}</code> (TMM\0)
              </p>
            </div>
            <div>
              <span className="memo-field-label">Versión</span>
              <p className="monospace">
                <code>0x{preview.version.toString(16).padStart(2, '0')}</code> ({preview.version})
              </p>
            </div>
            <div>
              <span className="memo-field-label">Tipo de Evento</span>
              <p className="monospace">
                <code>0x{preview.eventType.toString(16).padStart(2, '0')}</code> (POST)
              </p>
            </div>
            <div>
              <span className="memo-field-label">Índice Autor</span>
              <p className="monospace">
                <code>input[{preview.authorInputIndex}]</code>
              </p>
            </div>
            <div>
              <span className="memo-field-label">Longitudes (Bytes)</span>
              <p className="monospace">
                Payload: {preview.eventDataByteLength}B | Env: {preview.envelopeByteLength}B | Script: {preview.scriptByteLength}B
              </p>
            </div>
          </div>

          <div className="canonical-preview__hex-blocks">
            <div className="hex-block">
              <div className="hex-block__header">
                <span className="memo-field-label">Envelope Hex Canónico ({preview.envelopeByteLength} bytes)</span>
                <button
                  type="button"
                  className="cta outline small"
                  onClick={() => copyToClipboard(preview.envelopeHex, 'envelope')}
                  data-testid="copy-envelope-hex-button"
                >
                  {copiedField === 'envelope' ? '¡Copiado!' : 'Copiar'}
                </button>
              </div>
              <pre className="code-box monospace" data-testid="envelope-hex">
                {preview.envelopeHex}
              </pre>
            </div>

            <div className="hex-block">
              <div className="hex-block__header">
                <span className="memo-field-label">Script OP_RETURN Hex Completo ({preview.scriptByteLength} bytes)</span>
                <button
                  type="button"
                  className="cta outline small"
                  onClick={() => copyToClipboard(preview.scriptHex, 'script')}
                  data-testid="copy-script-hex-button"
                >
                  {copiedField === 'script' ? '¡Copiado!' : 'Copiar'}
                </button>
              </div>
              <pre className="code-box monospace" data-testid="script-hex">
                {preview.scriptHex}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default CanonicalPayloadPreview
