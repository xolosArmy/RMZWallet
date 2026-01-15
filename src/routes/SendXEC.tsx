import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useWallet } from '../context/useWallet'
import TopBar from '../components/TopBar'
import { TONALLI_SERVICE_FEE_XEC, XEC_SATS_PER_XEC, XEC_TONALLI_TREASURY_ADDRESS } from '../config/xecFees'

const MAX_OP_RETURN_BYTES = 221
const MAX_PREFILL_CHARS = 140

const sanitizeOpReturnMessage = (value: string) => {
  let sanitized = ''
  let byteCount = 0

  for (const char of value) {
    const code = char.charCodeAt(0)
    if (code < 0x20 || code > 0x7e) {
      continue
    }
    if (byteCount >= MAX_OP_RETURN_BYTES) {
      break
    }
    sanitized += char
    byteCount += 1
  }

  return sanitized
}

const sanitizePrefillMessage = (value: string) => {
  const sanitized = sanitizeOpReturnMessage(value)
  return sanitized.slice(0, MAX_PREFILL_CHARS)
}

function SendXEC() {
  const location = useLocation()
  const { sendXEC, estimateXecSend, initialized, backupVerified, loading, error, balance } = useWallet()
  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState<number>(0)
  const [message, setMessage] = useState('')
  const [txid, setTxid] = useState<string | null>(null)
  const [replyToTxid, setReplyToTxid] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [estimatedFeeSats, setEstimatedFeeSats] = useState<number | null>(null)
  const [estimatedTotalSats, setEstimatedTotalSats] = useState<number | null>(null)

  const amountInSats = Math.round(amount * XEC_SATS_PER_XEC)
  const formatXecFromSats = (sats: number) => (sats / XEC_SATS_PER_XEC).toFixed(2)
  const formatXecValue = (xec: number) => xec.toFixed(2)
  const shortenedCommission = `${XEC_TONALLI_TREASURY_ADDRESS.slice(0, 12)}...${XEC_TONALLI_TREASURY_ADDRESS.slice(-6)}`

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const to = params.get('to')
    const msg = params.get('msg')
    const replyTo = params.get('replyTo')
    setDestination(to ? to.trim() : '')
    setMessage(msg ? sanitizePrefillMessage(msg) : '')
    setReplyToTxid(replyTo ? replyTo.trim() : null)
  }, [location.search])

  useEffect(() => {
    let cancelled = false
    const runEstimate = async () => {
      if (!initialized || !backupVerified || !amountInSats || amountInSats <= 0) {
        if (!cancelled) {
          setEstimatedFeeSats(null)
          setEstimatedTotalSats(null)
        }
        return
      }

      try {
        const quote = await estimateXecSend(amountInSats, message)
        if (cancelled) return
        setEstimatedFeeSats(quote.networkFeeSats)
        setEstimatedTotalSats(quote.totalCostSats)
      } catch {
        if (cancelled) return
        setEstimatedFeeSats(null)
        setEstimatedTotalSats(null)
      }
    }

    void runEstimate()

    return () => {
      cancelled = true
    }
  }, [amountInSats, backupVerified, estimateXecSend, initialized, message])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    setTxid(null)

    if (!initialized || !backupVerified) {
      setLocalError('Debes completar el onboarding y el respaldo de tu frase semilla antes de poder enviar XEC.')
      return
    }

    if (!destination.startsWith('ecash:')) {
      setLocalError('La dirección debe ser una dirección eCash (prefijo ecash:).')
      return
    }

    if (!amount || amount <= 0) {
      setLocalError('Ingresa un monto válido mayor a cero.')
      return
    }

    if (amountInSats <= 0) {
      setLocalError('El monto en XEC es demasiado pequeño.')
      return
    }

    if (!balance) {
      setLocalError('No pudimos cargar tu saldo de XEC. Intenta de nuevo.')
      return
    }

    let totalToCheck = estimatedTotalSats
    if (!totalToCheck) {
      try {
        const quote = await estimateXecSend(amountInSats, message)
        totalToCheck = quote.totalCostSats
        setEstimatedFeeSats(quote.networkFeeSats)
        setEstimatedTotalSats(quote.totalCostSats)
      } catch (err) {
        setLocalError((err as Error).message)
        return
      }
    }

    const totalToCheckBig = BigInt(Math.round(totalToCheck))
    if (totalToCheckBig > balance.xec) {
      setLocalError(
        `Saldo insuficiente. Se requieren ${formatXecFromSats(totalToCheck)} XEC incluyendo tarifa de red y servicio.`
      )
      return
    }

    try {
      const tx = await sendXEC(destination.trim(), amountInSats, message)
      setTxid(tx)
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

  const handleMessageChange = (value: string) => {
    setMessage(sanitizeOpReturnMessage(value))
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Enviar</p>
          <h1 className="section-title">XEC hacia otra dirección</h1>
          <p className="muted">Mueve XEC con confianza sobre la red eCash.</p>
        </div>
      </header>

      {!backupVerified && (
        <div className="error">
          Debes completar el onboarding y el respaldo de tu frase semilla antes de poder enviar XEC.
        </div>
      )}

      <form className="card" onSubmit={handleSubmit}>
        {replyToTxid && (
          <div className="muted">
            Respondiendo a: <span className="address-box">{replyToTxid}</span>
          </div>
        )}
        <label htmlFor="destination">Destino (ecash:...)</label>
        <input
          id="destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="ecash:..."
        />

        <label htmlFor="amount">Monto XEC</label>
        <input
          id="amount"
          type="number"
          min={0}
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          placeholder="Ej. 10"
        />

        <label htmlFor="opreturn-message">Mensaje público OP_RETURN</label>
        <textarea
          id="opreturn-message"
          value={message}
          onChange={(e) => handleMessageChange(e.target.value)}
          placeholder="(opcional) Mensaje público OP_RETURN"
          rows={3}
        />
        <p className="muted">Este mensaje será público y quedará grabado en la blockchain de eCash.</p>

        <div className="fee-breakdown">
          <div>
            <span>Monto a enviar</span>
            <strong>{amountInSats > 0 ? `${formatXecFromSats(amountInSats)} XEC` : '—'}</strong>
          </div>
          <div>
            <span>Tarifa de red (dinámica)</span>
            <strong>{estimatedFeeSats !== null ? `${formatXecFromSats(estimatedFeeSats)} XEC` : '—'}</strong>
          </div>
          <div>
            <span>Tarifa de servicio Tonalli (fija)</span>
            <strong>{formatXecValue(TONALLI_SERVICE_FEE_XEC)} XEC</strong>
          </div>
          <div className="muted">
            Tesorería Tonalli: <span className="address-box">{shortenedCommission}</span>
          </div>
          <div className="total-line">
            <span>Total a deducir</span>
            <strong>{estimatedTotalSats !== null ? `${formatXecFromSats(estimatedTotalSats)} XEC` : '—'}</strong>
          </div>
          <p className="muted note">
            La tarifa de red se calcula en tiempo real y la tarifa Tonalli es fija. Se enviarán salidas a destinatario y
            tesorería Tonalli.
          </p>
        </div>

        <div className="actions">
          <button className="cta" type="submit" disabled={!initialized || !backupVerified || loading}>
            Enviar
          </button>
        </div>

        {(localError || error) && <div className="error">{localError || error}</div>}
        {txid && (
          <div className="success">
            Transacción enviada: <span className="address-box">{txid}</span>
          </div>
        )}
      </form>
    </div>
  )
}

export default SendXEC
