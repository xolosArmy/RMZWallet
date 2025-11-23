import type { FormEvent } from 'react'
import { useState } from 'react'
import { useWallet } from '../context/WalletContext'

function SendRMZ() {
  const { sendRMZ, initialized, backupVerified, loading, error } = useWallet()
  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState<number>(0)
  const [txid, setTxid] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    setTxid(null)

    if (!initialized || !backupVerified) {
      setLocalError('Debes completar el onboarding y el respaldo de tu frase semilla antes de poder enviar RMZ.')
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

    try {
      const tx = await sendRMZ(destination.trim(), amount)
      setTxid(tx)
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="subtitle">Enviar</p>
          <h1 className="title">RMZ hacia otra dirección</h1>
        </div>
      </header>

      {!backupVerified && (
        <div className="error">
          Debes completar el onboarding y el respaldo de tu frase semilla antes de poder enviar RMZ.
        </div>
      )}

      <form className="card" onSubmit={handleSubmit}>
        <label htmlFor="destination">Destino (ecash:...)</label>
        <input
          id="destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="ecash:..."
        />

        <label htmlFor="amount">Monto RMZ</label>
        <input
          id="amount"
          type="number"
          min={0}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          placeholder="Ej. 10"
        />

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

export default SendRMZ
