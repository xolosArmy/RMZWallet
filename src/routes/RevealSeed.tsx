import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import SensitiveSeedPhrase from '../components/SensitiveSeedPhrase'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'

const MAX_FAILED_ATTEMPTS = 3
const LOCKOUT_DURATION_MS = 30_000

function RevealSeed() {
  const { unlockEncryptedWallet, getMnemonic } = useWallet()
  const [pin, setPin] = useState('')
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [failedAttempts, setFailedAttempts] = useState(0)
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null)
  const [lockoutRemainingSeconds, setLockoutRemainingSeconds] = useState(0)

  useEffect(() => {
    if (!lockoutUntil) {
      setLockoutRemainingSeconds(0)
      return
    }

    const syncCountdown = () => {
      const remainingMs = lockoutUntil - Date.now()
      if (remainingMs <= 0) {
        setLockoutUntil(null)
        setFailedAttempts(0)
        setLockoutRemainingSeconds(0)
        return
      }

      setLockoutRemainingSeconds(Math.ceil(remainingMs / 1000))
    }

    syncCountdown()
    const intervalId = window.setInterval(syncCountdown, 250)

    return () => window.clearInterval(intervalId)
  }, [lockoutUntil])

  const isLockedOut = useMemo(() => Boolean(lockoutUntil && lockoutRemainingSeconds > 0), [lockoutRemainingSeconds, lockoutUntil])

  const handleReveal = async (event: FormEvent) => {
    event.preventDefault()

    if (isLockedOut) {
      setError(`Demasiados intentos. Intenta de nuevo en ${lockoutRemainingSeconds} segundos.`)
      return
    }

    setError(null)
    setCopyStatus(null)
    setMnemonic(null)

    if (pin.length < 6) {
      setError('El PIN debe tener al menos 6 caracteres.')
      return
    }

    try {
      setUnlocking(true)
      await unlockEncryptedWallet(pin)
      const phrase = getMnemonic()
      if (!phrase) {
        setError('No pudimos recuperar la seed. Intenta reimportar tu cartera.')
        return
      }
      setFailedAttempts(0)
      setLockoutUntil(null)
      setMnemonic(phrase)
    } catch (err) {
      const message = (err as Error).message
      const nextFailedAttempts = failedAttempts + 1
      setFailedAttempts(nextFailedAttempts)

      if (nextFailedAttempts >= MAX_FAILED_ATTEMPTS) {
        setLockoutUntil(Date.now() + LOCKOUT_DURATION_MS)
        setError(`Demasiados intentos. Intenta de nuevo en ${Math.ceil(LOCKOUT_DURATION_MS / 1000)} segundos.`)
      } else {
        setError(message)
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
    } catch (err) {
      setError('No se pudo copiar la frase. Copia manualmente.')
      console.error(err)
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Seguridad local</p>
          <h1 className="section-title">Frase semilla</h1>
          <p className="muted">Estas son tus 12/24 palabras. No las compartas con nadie.</p>
        </div>
      </header>

      <div className="card reveal-card">
        <div className="warning">⚠️ Revelar tu seed es riesgoso si hay alguien mirando.</div>
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
          />
          {isLockedOut && (
            <div className="error">Demasiados intentos. Intenta de nuevo en {lockoutRemainingSeconds} segundos.</div>
          )}
          <div className="actions">
            <button className="cta primary" type="submit" disabled={unlocking || isLockedOut}>
              {unlocking ? 'Desbloqueando...' : isLockedOut ? `Bloqueado (${lockoutRemainingSeconds}s)` : 'Revelar frase'}
            </button>
          </div>
        </form>

        {mnemonic && (
          <>
            <SensitiveSeedPhrase mnemonic={mnemonic} />
            <p className="muted">Guarda esta frase en un lugar seguro. Es la clave de tu templo.</p>
            <div className="actions">
              <button className="cta outline" type="button" onClick={handleCopy}>
                Copiar frase
              </button>
            </div>
            {copyStatus && <div className="success">{copyStatus}</div>}
          </>
        )}

        {error && <div className="error">{error}</div>}
      </div>
    </div>
  )
}

export default RevealSeed
