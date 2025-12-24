import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/WalletContext'
import { getChronik } from '../services/ChronikClient'
import {
  TONALLI_SERVICE_FEE_XEC,
  XEC_SATS_PER_XEC,
  XEC_TONALLI_TREASURY_ADDRESS
} from '../config/xecFees'

function SendXEC() {
  const { sendXEC, estimateXecSend, initialized, backupVerified, loading, error, balance } = useWallet()
  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState<number>(0)
  const [txid, setTxid] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [estimatedFeeSats, setEstimatedFeeSats] = useState<number | null>(null)
  const [estimatedTotalSats, setEstimatedTotalSats] = useState<number | null>(null)

  const amountInSats = Math.round(amount * XEC_SATS_PER_XEC)
  const formatXecFromSats = (sats: number) => (sats / XEC_SATS_PER_XEC).toFixed(2)
  const formatXecValue = (xec: number) => xec.toFixed(2)
  const shortenedCommission = `${XEC_TONALLI_TREASURY_ADDRESS.slice(0, 12)}...${XEC_TONALLI_TREASURY_ADDRESS.slice(-6)}`

  useEffect(() => {
    let cancelled = false
    if (!initialized || !backupVerified || !amount || amount <= 0) {
      setEstimatedFeeSats(null)
      setEstimatedTotalSats(null)
      return
    }

    estimateXecSend(amount)
      .then((quote) => {
        if (cancelled) return
        setEstimatedFeeSats(quote.networkFeeSats)
        setEstimatedTotalSats(quote.totalCostSats)
      })
      .catch(() => {
        if (cancelled) return
        setEstimatedFeeSats(null)
        setEstimatedTotalSats(null)
      })

    return () => {
      cancelled = true
    }
  }, [amount, backupVerified, estimateXecSend, initialized])

  useEffect(() => {
    if (!txid) return
    const chronik = getChronik()
    const ws = chronik.ws({
      onMessage: (msg) => {
        if (msg instanceof Error) {
          console.error(msg)
          return
        }
        if (msg.type === 'Tx' && msg.msgType === 'TX_CONFIRMED' && msg.txid === txid) {
          setConfirmed(true)
          ws.close()
        }
      },
      onError: (err) => {
        console.error(err)
      }
    })
    ws.subscribeToTxid(txid)

    return () => {
      ws.close()
    }
  }, [txid])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setLocalError(null)
    setTxid(null)
    setConfirmed(false)

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

    if (!balance) {
      setLocalError('No pudimos cargar tu saldo de XEC. Intenta de nuevo.')
      return
    }

    let totalToCheck = estimatedTotalSats
    if (!totalToCheck) {
      try {
        const quote = await estimateXecSend(amount)
        totalToCheck = quote.totalCostSats
        setEstimatedFeeSats(quote.networkFeeSats)
        setEstimatedTotalSats(quote.totalCostSats)
      } catch (err) {
        setLocalError((err as Error).message)
        return
      }
    }

    if (totalToCheck > balance.xec) {
      setLocalError(
        `Saldo insuficiente. Se requieren ${formatXecFromSats(totalToCheck)} XEC incluyendo tarifa de red y servicio.`
      )
      return
    }

    try {
      const tx = await sendXEC(destination.trim(), amount)
      setTxid(tx)
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Enviar</p>
          <h1 className="section-title">XEC hacia otra dirección</h1>
          <p className="muted">Envía eCash con tarifa de red y servicio Tonalli.</p>
        </div>
      </header>

      {!backupVerified && (
        <div className="error">
          Debes completar el onboarding y el respaldo de tu frase semilla antes de poder enviar XEC.
        </div>
      )}

      <form className="card" onSubmit={handleSubmit}>
        <label htmlFor="destination">Destino (ecash:...)</label>
        <input
          id="destination"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          placeholder="ecash:..."
        />

        <label htmlFor="amount">Monto XEC</label>
        <input
          id="amount"
          type="number"
          min={0}
          step={0.01}
          value={amount}
          onChange={(event) => setAmount(Number(event.target.value))}
          placeholder="Ej. 10.00"
        />

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
            Enviar XEC
          </button>
        </div>

        {(localError || error) && <div className="error">{localError || error}</div>}
        {txid && (
          <div className="success">
            Transacción enviada: <span className="address-box">{txid}</span>
          </div>
        )}
        {confirmed && <div className="success">Transacción confirmada on-chain.</div>}
      </form>
    </div>
  )
}

export default SendXEC
