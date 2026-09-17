import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import SensitiveSeedPhrase from '../components/SensitiveSeedPhrase'
import { useWallet } from '../context/useWallet'
import TopBar from '../components/TopBar'
import { validateLocalPassword } from './onboardingValidation'
import { takePendingBackupPassword } from '../services/backupSession'
import { WALLET_CAPABILITY } from '../domain/walletCapabilities'

interface BackupLocationState {
  restoreNotice?: string
}

function BackupSeed() {
  const navigate = useNavigate()
  const { state } = useLocation() as { state?: BackupLocationState }
  const { completeProgressiveBackup, getMnemonic, hasCapability } = useWallet()
  const [answers, setAnswers] = useState({ w3: '', w7: '', w11: '' })
  const [password, setPassword] = useState(() => takePendingBackupPassword() ?? '')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const mnemonic = typeof getMnemonic === 'function' && (hasCapability?.(WALLET_CAPABILITY.BACKUP_WALLET) ?? true)
    ? getMnemonic()
    : null
  const words = useMemo(() => (mnemonic ? mnemonic.split(' ') : []), [mnemonic])

  useEffect(() => {
    if (!mnemonic) {
      navigate('/onboarding')
    }
  }, [mnemonic, navigate])

  const checkAnswers = async (e: FormEvent) => {
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

    const passwordError = validateLocalPassword(password, 'Usa al menos 6 caracteres para el password/PIN local.')
    if (passwordError) {
      setError(passwordError)
      return
    }

    try {
      setSaving(true)
      await completeProgressiveBackup(password)
      setSuccess('Seed respaldada. Puedes usar la billetera.')
      navigate('/')
    } catch {
      setError('No pudimos cifrar y verificar el respaldo en este dispositivo. Tu Tonalli temporal se conserva.')
    } finally {
      setSaving(false)
    }
  }

  if (!mnemonic) {
    return null
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Protege tu Tonalli</p>
          <h1 className="section-title">Guarda tu frase de recuperación</h1>
          <p className="muted">Escríbela fuera de línea. Tonalli Wallet no puede recuperarla por ti.</p>
        </div>
      </header>

      <div className="card">
        {state?.restoreNotice && <p className="success">{state.restoreNotice}</p>}
        <p className="muted">
          Estas 12 palabras viven en la wallet de este dispositivo. Nunca se copian a la URL ni al historial.
        </p>
        <SensitiveSeedPhrase key={mnemonic} mnemonic={mnemonic} />
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
        <label htmlFor="backup-password">Password/PIN local</label>
        <input
          id="backup-password"
          type="password"
          autoComplete="new-password"
          placeholder="Mínimo 6 caracteres"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="actions">
          <button className="cta" type="submit" disabled={saving}>
            {saving ? 'Cifrando y verificando...' : 'Marcar respaldo como listo'}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {success && <div className="success">{success}</div>}
      </form>
    </div>
  )
}

export default BackupSeed
