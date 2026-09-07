import { useId, useMemo } from 'react'
import {
  MAX_TM1_SCRIPT_BYTES,
  TM1_DEFAULT_WALLET_MAX_EVENT_DATA_BYTES,
  TM1_PROTOCOL_MAX_EVENT_DATA_BYTES,
  TM1_PROTOCOL_OVERHEAD_BYTES
} from './types'

export interface MemoEditorProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
  maxBytes?: number
  protocolMaxBytes?: number
  id?: string
  showOverheadDetails?: boolean
}

export function MemoEditor({
  value,
  onChange,
  disabled = false,
  placeholder = 'Escribe tu mensaje oficial Tonalli Memo aquí...',
  maxBytes = TM1_DEFAULT_WALLET_MAX_EVENT_DATA_BYTES,
  protocolMaxBytes = TM1_PROTOCOL_MAX_EVENT_DATA_BYTES,
  id: customId,
  showOverheadDetails = true
}: MemoEditorProps) {
  const generatedId = useId()
  const textareaId = customId || `memo-editor-${generatedId}`
  const counterId = `memo-counter-${textareaId}`
  const overheadId = `memo-overhead-${textareaId}`

  // Real-time byte calculation via TextEncoder
  const currentBytes = useMemo(() => {
    return new TextEncoder().encode(value).length
  }, [value])

  const remainingBytes = maxBytes - currentBytes
  const isOverLimit = currentBytes > maxBytes
  const isNearLimit = currentBytes >= maxBytes * 0.85 && !isOverLimit

  const percentUsed = Math.min(100, Math.round((currentBytes / maxBytes) * 100))

  return (
    <div className="memo-editor">
      <div className="memo-editor__header">
        <label htmlFor={textareaId} className="field-label">
          Mensaje de Tonalli Memo
        </label>
        <div
          id={counterId}
          className={`byte-counter ${
            isOverLimit ? 'byte-counter--error' : isNearLimit ? 'byte-counter--warning' : ''
          }`}
          aria-live="polite"
          data-testid="memo-byte-counter"
        >
          <span className="byte-counter__current">{currentBytes}</span>
          <span className="byte-counter__divider">/</span>
          <span className="byte-counter__max">{maxBytes} bytes UTF-8</span>
          <span className="byte-counter__badge">
            {isOverLimit
              ? `Excedido por ${currentBytes - maxBytes} B`
              : `${remainingBytes} B restantes`}
          </span>
        </div>
      </div>

      <div className="memo-editor__input-wrapper">
        <textarea
          id={textareaId}
          className={`input memo-editor__textarea ${isOverLimit ? 'input--error' : ''}`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder={placeholder}
          rows={3}
          aria-describedby={`${counterId} ${showOverheadDetails ? overheadId : ''}`.trim()}
          aria-invalid={isOverLimit}
        />
        <div
          className="memo-editor__progress-bar"
          role="progressbar"
          aria-valuenow={currentBytes}
          aria-valuemin={0}
          aria-valuemax={maxBytes}
          style={{ width: `${percentUsed}%` }}
          data-status={isOverLimit ? 'error' : isNearLimit ? 'warning' : 'ok'}
        />
      </div>

      {isOverLimit && (
        <p className="tx-meta error-text" role="alert">
          El mensaje excede el límite del borrador ({currentBytes}/{maxBytes} bytes). Por favor reduce el texto.
        </p>
      )}

      {showOverheadDetails && (
        <div id={overheadId} className="memo-editor__overhead card subtle" data-testid="memo-overhead-breakdown">
          <p className="memo-field-label">Límite estricto OP_RETURN eCash</p>
          <div className="memo-overhead-grid">
            <div>
              <span className="muted">Máximo OP_RETURN:</span>
              <strong>{MAX_TM1_SCRIPT_BYTES} bytes</strong>
            </div>
            <div>
              <span className="muted">Overhead protocolo TM1:</span>
              <strong>-{TM1_PROTOCOL_OVERHEAD_BYTES} bytes</strong>
            </div>
            <div>
              <span className="muted">Capacidad útil wire:</span>
              <strong>{protocolMaxBytes} bytes</strong>
            </div>
            <div>
              <span className="muted">Borrador de billetera:</span>
              <strong>{maxBytes} bytes</strong>
            </div>
          </div>
          <p className="tx-meta muted">
            Descontando el marcador OP_RETURN (0x6a), identificador LOKAD &apos;TMM\0&apos; (5B),
            prefijo OP_PUSHDATA1 (2B), y cabecera de versión, evento e índice de autor (3B).
          </p>
        </div>
      )}
    </div>
  )
}
export default MemoEditor
