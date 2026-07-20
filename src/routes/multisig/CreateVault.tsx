import type { FormEvent } from 'react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import TopBar from '../../components/TopBar'
import { ecashMultisigService } from '../../services/EcashMultisigService'
import { xolosWalletService } from '../../services/XolosWalletService'

const splitPubkeys = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)

function CreateVault() {
  const navigate = useNavigate()
  const [label, setLabel] = useState('')
  const [m, setM] = useState(2)
  const [pubkeys, setPubkeys] = useState('')
  const [error, setError] = useState<string | null>(null)

  const addCurrentPubkey = () => {
    const currentPubkey = xolosWalletService.getPublicKeyHex()
    if (!currentPubkey) {
      setError('La wallet debe estar desbloqueada para leer tu public key.')
      return
    }
    const current = splitPubkeys(pubkeys)
    if (!current.map((item) => item.toLowerCase()).includes(currentPubkey.toLowerCase())) {
      current.push(currentPubkey)
    }
    setPubkeys(current.join('\n'))
    setError(null)
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      ecashMultisigService.createVault({
        label,
        m,
        pubkeysHex: splitPubkeys(pubkeys)
      })
      navigate('/multisig')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Nueva bóveda</p>
          <h1 className="section-title">Crear multifirma eCash</h1>
          <p className="muted">Multifirma experimental. Usa primero montos pequeños.</p>
        </div>
      </header>

      <div className="error">
        1 dispositivo = 1 firmante. No importes varias semillas en el mismo dispositivo.
      </div>

      <form className="card" onSubmit={handleSubmit}>
        <label htmlFor="vault-label">Etiqueta</label>
        <input
          id="vault-label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Tesoreria 2-de-3"
        />

        <label htmlFor="vault-m">Firmas requeridas</label>
        <input
          id="vault-m"
          type="number"
          min={1}
          step={1}
          value={m}
          onChange={(event) => setM(Number(event.target.value))}
        />

        <label htmlFor="vault-pubkeys">Public keys de firmantes</label>
        <textarea
          id="vault-pubkeys"
          value={pubkeys}
          onChange={(event) => setPubkeys(event.target.value)}
          rows={8}
          placeholder="Una public key hex por linea"
        />

        <div className="actions">
          <button className="cta outline" type="button" onClick={addCurrentPubkey}>
            Agregar mi public key
          </button>
          <button className="cta primary" type="submit">
            Crear boveda
          </button>
          <Link className="cta outline" to="/multisig">
            Cancelar
          </Link>
        </div>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  )
}

export default CreateVault
