import type { FormEvent } from 'react'
import { useState } from 'react'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'

function RevealSeed() {
  const { unlockEncryptedWallet, getMnemonic } = useWallet()
  const [pin, setPin] = useState('')
  const [mnemonic, setMnemonic] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)

  const handleReveal = async (event: FormEvent) => {
    event.preventDefault()
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
        throw new Error('No pudimos recuperar la seed. Intenta reimportar tu cartera.')
      }
      setMnemonic(phrase)
    } catch (err) {
      setError((err as Error).message)
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
          <div className="actions">
            <button className="cta primary" type="submit" disabled={unlocking}>
              {unlocking ? 'Desbloqueando...' : 'Revelar frase'}
            </button>
          </div>
        </form>

        {mnemonic && (
          <>
            <div className="seed-box">{mnemonic}</div>
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
