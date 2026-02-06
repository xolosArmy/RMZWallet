import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useWallet } from '../context/useWallet'
import TopBar from '../components/TopBar'

function Onboarding() {
  const navigate = useNavigate()
  const { createNewWallet, loadExistingWallet, restoreWallet, backupVerified, initialized, getMnemonic, loading, error } =
    useWallet()
  const [passwordNew, setPasswordNew] = useState('')
  const [passwordExisting, setPasswordExisting] = useState('')
  const [seedPhrase, setSeedPhrase] = useState('')
  const [passwordImport, setPasswordImport] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const resumeHandledRef = useRef(false)

  useEffect(() => {
    if (resumeHandledRef.current) return
    if (!initialized || !backupVerified) return
    const pendingSearch = localStorage.getItem('tonalli_pending_req_v1')
    if (!pendingSearch) return
    resumeHandledRef.current = true
    localStorage.removeItem('tonalli_pending_req_v1')
    navigate(`/connect${pendingSearch}`, { replace: true })
  }, [backupVerified, initialized, navigate])

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

  const handleImport = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    if (passwordImport.length < 6) {
      setLocalError('El password/PIN debe tener al menos 6 caracteres.')
      return
    }

    const phrase = seedPhrase.trim()
    const wordsCount = phrase.split(' ').length
    if (wordsCount !== 12 && wordsCount !== 24) {
      setLocalError('La frase seed debe contener 12 o 24 palabras.')
      return
    }

    try {
      await restoreWallet(phrase)
      navigate('/backup', { state: { password: passwordImport, mnemonic: phrase } })
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

  return (
    <div className="page">
      <TopBar />

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Bienvenido a RMZWallet</p>
          <h1 className="hero-title">Tu templo seguro para XEC y el eToken RMZ</h1>
          <p className="lead">
            Configura tu cartera para ver saldos y mover XEC con seguridad. Explora tus tokens, NFTs y el ecosistema
            XolosArmy desde una sola interfaz.
          </p>
          <div className="hero-actions">
            <a className="cta primary" href="#crear">
              Crear nueva cartera RMZWallet
            </a>
            <a className="cta outline" href="#importar">
              Conectar cartera existente
            </a>
            <a className="cta outline" href="#restaurar">
              Importar cartera desde seed
            </a>
            <a className="cta ghost" href="#lectura">
              Ver saldos de tokens y NFTs
            </a>
          </div>
        </div>

        <div className="hero-card">
          <p className="muted">Cyber-aztec · XolosArmy Network</p>
          <div className="hero-badge">Guardianía digital</div>
          <p className="hero-note">
            La seed y el cifrado viven solo en tu dispositivo. Usa un password local que recuerdes y respalda tu frase
            de 12 palabras.
          </p>
          <div className="hero-stats">
            <span className="pill">RMZ listo para eCash (XEC)</span>
            <span className="pill pill-ghost">Modo lectura disponible</span>
          </div>
        </div>
      </section>

      <div className="grid onboarding-grid">
        <form id="crear" className="card" onSubmit={handleCreate}>
          <p className="card-kicker">Nuevo templo</p>
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
            <button className="cta primary" type="submit" disabled={loading}>
              Generar seed
            </button>
          </div>
        </form>

        <form id="importar" className="card" onSubmit={handleExisting}>
          <p className="card-kicker">Conectar</p>
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
            <button className="cta outline" type="submit" disabled={loading}>
              Desbloquear
            </button>
          </div>
        </form>

        <form id="restaurar" className="card" onSubmit={handleImport}>
          <p className="card-kicker">Importar</p>
          <h2>Importar cartera desde seed</h2>
          <p className="muted">
            Pega tu frase de 12 o 24 palabras para restaurar tu cartera. Nota: la seed nunca sale de tu dispositivo.
          </p>
          <label htmlFor="seed-phrase">Frase seed</label>
          <textarea
            id="seed-phrase"
            rows={3}
            placeholder="Ingrese aquí las 12 o 24 palabras"
            value={seedPhrase}
            onChange={(e) => setSeedPhrase(e.target.value)}
          />
          <label htmlFor="import-password">Nuevo Password/PIN local</label>
          <input
            id="import-password"
            type="password"
            placeholder="Mínimo 6 caracteres"
            value={passwordImport}
            onChange={(e) => setPasswordImport(e.target.value)}
          />
          <div className="actions">
            <button className="cta outline" type="submit" disabled={loading}>
              Importar cartera
            </button>
          </div>
        </form>

        <div id="lectura" className="card highlight">
          <p className="card-kicker">Modo lectura</p>
          <h2>Ver saldos de tokens y NFTs</h2>
          <p className="muted">
            Puedes entrar en modo solo lectura para revisar tu dirección, saldo RMZ y gas en XEC sin exponer tu seed.
          </p>
          <div className="actions">
            <Link className="cta ghost" to="/">
              Abrir vista de saldos
            </Link>
          </div>
        </div>
      </div>

      {(localError || error) && <div className="error">{localError || error}</div>}
    </div>
  )
}

export default Onboarding
