import type { FormEvent } from 'react'
import { useState } from 'react'
import AliasResolutionStatus from '../components/AliasResolutionStatus'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { useAliasResolution } from '../hooks/useAliasResolution'
import type { FirmaSendPreview } from '../services/firmaAlphaSend'
import { formatTokenAmount } from '../utils/tokenFormat'

const formatXecFromSats = (sats: bigint) => {
  const whole = sats / 100n
  const fraction = (sats % 100n).toString().padStart(2, '0')
  return `${whole}.${fraction}`
}

function SendFirma() {
  const {
    prepareFirmaSend,
    sendFirma,
    initialized,
    backupVerified,
    loading,
    error
  } = useWallet()
  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState('')
  const [preview, setPreview] = useState<FirmaSendPreview | null>(null)
  const [txid, setTxid] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const aliasResolution = useAliasResolution(destination)

  const canPreview =
    initialized &&
    backupVerified &&
    !loading &&
    amount.trim().length > 0 &&
    aliasResolution.status === 'confirmed' &&
    Boolean(aliasResolution.resolvedAddress)

  const clearPreparedState = () => {
    setPreview(null)
    setTxid(null)
    setLocalError(null)
  }

  const handlePrepare = async (event: FormEvent) => {
    event.preventDefault()
    setLocalError(null)
    setTxid(null)

    if (!initialized || !backupVerified) {
      setLocalError('Debes completar el onboarding y el respaldo de tu frase semilla antes de enviar FIRMA.')
      return
    }
    const destinationAddress = aliasResolution.resolvedAddress
    if (aliasResolution.status !== 'confirmed' || !destinationAddress) {
      setLocalError(aliasResolution.errorMessage || 'El destinatario debe resolverse y confirmarse antes del preview.')
      return
    }
    if (!amount.trim()) {
      setLocalError('Ingresa un monto FIRMA mayor a cero.')
      return
    }

    try {
      setPreview(await prepareFirmaSend(destinationAddress, amount))
    } catch (err) {
      setPreview(null)
      setLocalError((err as Error).message)
    }
  }

  const handleConfirm = async () => {
    if (!preview) return
    setLocalError(null)
    setTxid(null)
    try {
      const result = await sendFirma(preview)
      setTxid(result)
      setPreview(null)
      setAmount('')
    } catch (err) {
      setPreview(null)
      setLocalError((err as Error).message)
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Enviar</p>
          <h1 className="section-title">Enviar Firma Alpha</h1>
          <p className="muted">
            Transfiere FIRMA como token ALP directamente desde tu wallet. Verifica destino, monto y comisión antes de firmar.
          </p>
        </div>
      </header>

      {!backupVerified && (
        <div className="error">
          Debes completar el onboarding y el respaldo de tu frase semilla antes de enviar FIRMA.
        </div>
      )}

      <form className="card" onSubmit={handlePrepare}>
        <label htmlFor="firma-destination">Destino (ecash:... o alias .xec)</label>
        <input
          id="firma-destination"
          value={destination}
          onChange={(event) => {
            setDestination(event.target.value)
            clearPreparedState()
          }}
          placeholder="ecash:... o xolosarmy.xec"
        />
        <AliasResolutionStatus resolution={aliasResolution} />

        <label htmlFor="firma-amount">Monto FIRMA</label>
        <input
          id="firma-amount"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value)
            clearPreparedState()
          }}
          placeholder="Ej. 0.0100"
          aria-describedby="firma-amount-help"
        />
        <p className="muted" id="firma-amount-help">Máximo 4 decimales.</p>

        <div className="actions">
          <button className="cta primary" type="submit" disabled={!canPreview}>
            Preparar / Previsualizar
          </button>
        </div>

        {preview && (
          <section className="send-preview" aria-label="Previsualización del envío FIRMA">
            <h2>Revisa antes de firmar</h2>
            <div className="send-preview__row">
              <span>Enviar</span>
              <span>{formatTokenAmount(preview.amountAtoms, 4)} FIRMA</span>
            </div>
            <div className="send-preview__row">
              <span>Destino</span>
              <span className="address-box">{preview.destination}</span>
            </div>
            <div className="send-preview__row">
              <span>Saldo actual</span>
              <span>{formatTokenAmount(preview.balanceBeforeAtoms, 4)} FIRMA</span>
            </div>
            <div className="send-preview__row">
              <span>Saldo después</span>
              <span>{formatTokenAmount(preview.balanceAfterAtoms, 4)} FIRMA</span>
            </div>
            {preview.firmaChangeAtoms > 0n && (
              <div className="send-preview__row">
                <span>Cambio FIRMA</span>
                <span>{formatTokenAmount(preview.firmaChangeAtoms, 4)} FIRMA</span>
              </div>
            )}
            <div className="send-preview__row">
              <span>Comisión estimada</span>
              <span>{formatXecFromSats(preview.networkFeeSats)} XEC</span>
            </div>
            <p className="muted">Inputs seleccionados: {preview.inputOutpoints.length}</p>
            <div className="actions">
              <button className="cta primary" type="button" onClick={handleConfirm} disabled={loading}>
                Confirmar, firmar localmente y transmitir
              </button>
            </div>
          </section>
        )}

        {(localError || error) && <div className="error">{localError || error}</div>}
        {txid && (
          <div className="success">
            <p className="success-title">FIRMA enviada correctamente</p>
            <p className="success-hash">
              TXID:
              <a
                href={`https://explorer.e.cash/tx/${txid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="success-link"
              >
                {txid}
              </a>
            </p>
          </div>
        )}
      </form>
    </div>
  )
}

export default SendFirma
