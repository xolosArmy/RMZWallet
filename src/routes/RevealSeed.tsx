import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import TopBar from '../components/TopBar'
import SensitiveSeedPhrase from '../components/SensitiveSeedPhrase'
import { useWallet } from '../context/useWallet'

const MAX_FAILED_ATTEMPTS = 3
const LOCKOUT_MS = 30_000

function RevealSeed() {
  const { unlockEncryptedWallet, getMnemonic } = useWallet()
  const [pin, setPin] = useState('')
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [failedAttempts, setFailedAttempts] = useState(0)
  const [lockoutDeadline, setLockoutDeadline] = useState<number | null>(null)
  const [clock, setClock] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (lockoutDeadline !== null) {
        setClock(Date.now())
      }
    }, 250)
    return () => window.clearInterval(interval)
  }, [lockoutDeadline])

  const lockoutRemainingMs = lockoutDeadline === null ? 0 : Math.max(0, lockoutDeadline - clock)
  const isLocked = lockoutRemainingMs > 0
  const lockoutSeconds = Math.ceil(lockoutRemainingMs / 1000)

  const lockoutMessage = useMemo(() => {
    if (!isLocked) return null
    return `Demasiados intentos fallidos. Intenta otra vez en ${lockoutSeconds}s.`
  }, [isLocked, lockoutSeconds])

  const handleReveal = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setCopyStatus(null)
    setMnemonic(null)

    if (isLocked) {
      setError(lockoutMessage)
      return
    }

    if (pin.length < 6) {
      setError('El PIN debe tener al menos 6 caracteres.')
      return
    }

    try {
      setUnlocking(true)
      await unlockEncryptedWallet(pin)
      const phrase = getMnemonic()
      if (!phrase) {
        throw new Error('No pudimos recuperar la seed. Intenta reimportar tu cartera.')
      }
      setFailedAttempts(0)
      setLockoutDeadline(null)
      setMnemonic(phrase)
    } catch (err) {
      const nextFailures = failedAttempts + 1
      setFailedAttempts(nextFailures)
      if (nextFailures >= MAX_FAILED_ATTEMPTS) {
        setLockoutDeadline(Date.now() + LOCKOUT_MS)
        setFailedAttempts(0)
        setError(`Demasiados intentos fallidos. Formulario congelado por ${LOCKOUT_MS / 1000}s.`)
      } else {
        setError((err as Error).message)
      }
    } finally {
      setUnlocking(false)
    }
  }

  const handleCopy = async () => {
    if (!mnemonic) return
    try {
      await navigator.clipboard.writeText(mnemonic)
      setCopyStatus('Frase copiada en el portapapeles.')
    } catch {
      setError('No se pudo copiar la frase. Copia manualmente.')
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Seguridad local</p>
          <h1 className="section-title">Frase semilla</h1>
          <p className="muted">Estas son tus 12/24 palabras. No las compartas con nadie; dan control total sobre tus fondos.</p>
        </div>
      </header>

      <div className="card reveal-card">
        <div className="warning">Advertencia: revelar tu seed es riesgoso si hay alguien mirando.</div>
        <p className="muted">
          Tu seed vive cifrada y nunca sale del dispositivo. Usa tu PIN local para desbloquearla solo cuando estés en
          un lugar seguro.
        </p>

        <form className="reveal-form" onSubmit={handleReveal}>
          <label htmlFor="pin">Ingresa tu PIN</label>
          <input
            id="pin"
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="PIN local"
            disabled={unlocking || isLocked}
          />
          <div className="actions">
            <button className="cta primary" type="submit" disabled={unlocking || isLocked}>
              {unlocking ? 'Desbloqueando...' : isLocked ? 'Formulario congelado' : 'Revelar frase'}
            </button>
          </div>
        </form>

        {mnemonic && (
          <>
            <SensitiveSeedPhrase key={mnemonic} mnemonic={mnemonic} />
            <p className="muted">Guarda esta frase fuera de línea. Es la llave para recuperar tu wallet.</p>
            <div className="actions">
              <button className="cta outline" type="button" onClick={handleCopy}>
                Copiar frase
              </button>
            </div>
            {copyStatus && <div className="success">{copyStatus}</div>}
          </>
        )}

        {lockoutMessage && isLocked && <div className="error">{lockoutMessage}</div>}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  )
}

export default RevealSeed
