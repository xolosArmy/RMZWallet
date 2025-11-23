import type { FormEvent } from 'react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWallet } from '../context/WalletContext'

function Onboarding() {
  const navigate = useNavigate()
  const { createNewWallet, loadExistingWallet, backupVerified, getMnemonic, loading, error } = useWallet()
  const [passwordNew, setPasswordNew] = useState('')
  const [passwordExisting, setPasswordExisting] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    if (passwordNew.length < 6) {
      setLocalError('Usa al menos 6 caracteres para el password/PIN local.')
      return
    }

    try {
      const mnemonic = await createNewWallet()
      navigate('/backup', { state: { password: passwordNew, mnemonic } })
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

  const handleExisting = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    if (passwordExisting.length < 6) {
      setLocalError('El password/PIN debe tener al menos 6 caracteres.')
      return
    }

    try {
      await loadExistingWallet(passwordExisting)
      if (backupVerified) {
        navigate('/')
        return
      }
      const mnemonic = getMnemonic()
      if (!mnemonic) {
        throw new Error('No se pudo recuperar la seed para el respaldo.')
      }
      navigate('/backup', { state: { password: passwordExisting, mnemonic } })
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="subtitle">Bienvenido a xolosArmy Wallet</p>
          <h1 className="title">$RMZ en tu propio dispositivo</h1>
        </div>
      </header>

      <div className="grid">
        <form className="card" onSubmit={handleCreate}>
          <h2>Crear billetera nueva</h2>
          <p className="muted">La seed se genera localmente y nunca sale de tu dispositivo.</p>
          <label htmlFor="new-password">Password/PIN local</label>
          <input
            id="new-password"
            type="password"
            placeholder="Mínimo 6 caracteres"
            value={passwordNew}
            onChange={(e) => setPasswordNew(e.target.value)}
          />
          <div className="actions">
            <button className="cta" type="submit" disabled={loading}>
              Generar seed
            </button>
          </div>
        </form>

        <form className="card" onSubmit={handleExisting}>
          <h2>Usar billetera guardada</h2>
          <p className="muted">Ingresa el password/PIN con el que cifraste la seed.</p>
          <label htmlFor="existing-password">Password/PIN</label>
          <input
            id="existing-password"
            type="password"
            placeholder="Tu password local"
            value={passwordExisting}
            onChange={(e) => setPasswordExisting(e.target.value)}
          />
          <div className="actions">
            <button className="cta secondary" type="submit" disabled={loading}>
              Desbloquear
            </button>
          </div>
        </form>
      </div>

      {(localError || error) && <div className="error">{localError || error}</div>}
    </div>
  )
}

export default Onboarding
