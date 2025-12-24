import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/WalletContext'
import { getChronik } from '../services/ChronikClient'
import { XEC_COMMISSION_ADDRESS, XEC_COMMISSION_SATS, XEC_FIXED_FEE_SATS } from '../config/xecFees'

function SendXEC() {
  const { sendXEC, initialized, backupVerified, loading, error, balance } = useWallet()
  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState<number>(0)
  const [txid, setTxid] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const amountInSats = Math.round(amount * 100)
  const totalInSats = amountInSats + XEC_FIXED_FEE_SATS + XEC_COMMISSION_SATS
  const formatXec = (sats: number) => (sats / 100).toFixed(2)
  const shortenedCommission = `${XEC_COMMISSION_ADDRESS.slice(0, 12)}...${XEC_COMMISSION_ADDRESS.slice(-6)}`

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

    if (totalInSats > balance.xec) {
      setLocalError(
        `Saldo insuficiente. Se requieren ${formatXec(totalInSats)} XEC incluyendo tarifa fija y comisión.`
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
          <p className="muted">Envía eCash con tarifa fija y comisión RMZArmy.</p>
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
            <strong>{amountInSats > 0 ? `${formatXec(amountInSats)} XEC` : '—'}</strong>
          </div>
          <div>
            <span>Tarifa de transacción (fija)</span>
            <strong>{formatXec(XEC_FIXED_FEE_SATS)} XEC</strong>
          </div>
          <div>
            <span>Comisión RMZArmy</span>
            <strong>{formatXec(XEC_COMMISSION_SATS)} XEC</strong>
          </div>
          <div className="muted">
            Dirección de comisión: <span className="address-box">{shortenedCommission}</span>
          </div>
          <div className="total-line">
            <span>Total a deducir</span>
            <strong>{amountInSats > 0 ? `${formatXec(totalInSats)} XEC` : '—'}</strong>
          </div>
          <p className="muted note">
            La comisión es fija y no se puede modificar. Se enviarán dos salidas: destinatario y comisión.
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
