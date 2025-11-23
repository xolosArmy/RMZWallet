import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useWallet } from '../context/WalletContext'

interface BackupState {
  password: string
  mnemonic: string
}

function BackupSeed() {
  const navigate = useNavigate()
  const { state } = useLocation() as { state?: BackupState }
  const { encryptAndStore, setBackupVerified } = useWallet()
  const [answers, setAnswers] = useState({ w3: '', w7: '', w11: '' })
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const backupState = state
  const words = useMemo(() => (backupState?.mnemonic ? backupState.mnemonic.split(' ') : []), [backupState])

  useEffect(() => {
    if (!backupState?.mnemonic || !backupState?.password) {
      navigate('/onboarding')
    }
  }, [backupState, navigate])

  const checkAnswers = (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)

    const valid =
      words[2]?.toLowerCase() === answers.w3.trim().toLowerCase() &&
      words[6]?.toLowerCase() === answers.w7.trim().toLowerCase() &&
      words[10]?.toLowerCase() === answers.w11.trim().toLowerCase()

    if (!valid) {
      setError('Las palabras no coinciden. Inténtalo de nuevo.')
      return
    }

    // Guardamos la seed cifrada en localStorage; solo vive en texto plano en memoria durante este flujo.
    if (!backupState?.password) {
      setError('Falta el password de cifrado. Regresa al onboarding.')
      return
    }

    encryptAndStore(backupState.password)
    setBackupVerified?.(true)
    setSuccess('Seed respaldada. Puedes usar la billetera.')
    navigate('/')
  }

  if (!backupState?.mnemonic || !backupState?.password) {
    return null
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="subtitle">Respalda tu seed</p>
          <h1 className="title">Sin seed, no hay $RMZ</h1>
        </div>
      </header>

      <div className="card">
        <p className="muted">
          Escribe estas 12 palabras en orden. La seed solo vive en tu memoria y se cifra con tu password local.
          En producción se debe usar PBKDF2/scrypt con salt e iteraciones altas para derivar claves.
        </p>
        <div className="address-box">{backupState.mnemonic}</div>
      </div>

      <form className="card" onSubmit={checkAnswers}>
        <h2>Verificación rápida</h2>
        <p className="muted">Ingresa las palabras #3, #7 y #11 para confirmar el respaldo.</p>
        <label htmlFor="w3">Palabra #3</label>
        <input
          id="w3"
          value={answers.w3}
          onChange={(e) => setAnswers((prev) => ({ ...prev, w3: e.target.value }))}
        />
        <label htmlFor="w7">Palabra #7</label>
        <input
          id="w7"
          value={answers.w7}
          onChange={(e) => setAnswers((prev) => ({ ...prev, w7: e.target.value }))}
        />
        <label htmlFor="w11">Palabra #11</label>
        <input
          id="w11"
          value={answers.w11}
          onChange={(e) => setAnswers((prev) => ({ ...prev, w11: e.target.value }))}
        />
        <div className="actions">
          <button className="cta" type="submit">
            Marcar respaldo como listo
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {success && <div className="success">{success}</div>}
      </form>
    </div>
  )
}

export default BackupSeed
