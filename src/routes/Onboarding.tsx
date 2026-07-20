import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useWallet } from '../context/useWallet'
import TopBar from '../components/TopBar'
import BrandLogo from '../components/BrandLogo'
import { EXTERNAL_SIGN_REQUEST_STORAGE_KEY, EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY } from '../utils/externalSign'
import { resolvePendingConnectTarget, TONALLI_PENDING_REQUEST_KEY } from '../utils/tonalliConnect'

function Onboarding() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
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
    const pendingExternalSign = sessionStorage.getItem(EXTERNAL_SIGN_REQUEST_STORAGE_KEY)
    if (pendingExternalSign) {
      resumeHandledRef.current = true
      const requestedReturnTo = (searchParams.get('returnTo') ?? '').trim()
      const storedReturnTo = sessionStorage.getItem(EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY) ?? ''
      const returnTo = storedReturnTo || requestedReturnTo || '/external-sign'
      sessionStorage.removeItem(EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY)
      navigate(returnTo, { replace: true })
      return
    }
    const pendingConnect = localStorage.getItem(TONALLI_PENDING_REQUEST_KEY)
    if (!pendingConnect) return
    resumeHandledRef.current = true
    localStorage.removeItem(TONALLI_PENDING_REQUEST_KEY)
    navigate(resolvePendingConnectTarget(pendingConnect), { replace: true })
  }, [backupVerified, initialized, navigate, searchParams])

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
          <p className="eyebrow">Bienvenido a Tonalli Wallet</p>
          <h1 className="hero-title">Tus llaves. Tu dinero. Tu Tonalli.</h1>
          <p className="lead">
            Controla eCash (XEC), eToken Xolos RMZ, NFTs e identidad on-chain desde una wallet abierta y no custodial.
            Tus llaves permanecen en tu dispositivo.
          </p>
          <div className="hero-actions">
            <a className="cta primary" href="#crear">
              Crear nueva wallet
            </a>
            <a className="cta outline" href="#importar">
              Desbloquear wallet
            </a>
            <a className="cta outline" href="#restaurar">
              Importar desde seed
            </a>
            <a className="cta ghost" href="#lectura">
              Explorar en modo lectura
            </a>
          </div>
        </div>

        <div className="hero-card">
          <div className="logo-plate">
            <BrandLogo variant="primary" size={210} />
          </div>
          <div className="hero-badge">Verifica. Autocustodia. Libérate.</div>
          <p className="hero-note">
            La frase de recuperación y las llaves permanecen en tu dispositivo. Tonalli Wallet no custodia tus fondos.
          </p>
          <div className="hero-stats">
            <span className="pill">eCash (XEC)</span>
            <span className="pill pill-ghost">eToken Xolos RMZ integrado</span>
          </div>
        </div>
      </section>

      <div className="grid onboarding-grid">
        <form id="crear" className="card" onSubmit={handleCreate}>
          <p className="card-kicker">Nueva wallet</p>
          <h2>Crear wallet nueva</h2>
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
          <h2>Importar desde seed</h2>
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
              Importar wallet
            </button>
          </div>
        </form>

        <div id="lectura" className="card highlight">
          <p className="card-kicker">Modo lectura</p>
          <h2>Explorar en modo lectura</h2>
          <p className="muted">
            Puedes entrar en modo solo lectura para revisar tu dirección, eToken Xolos RMZ y eCash (XEC) sin exponer tu seed.
          </p>
          <div className="actions">
            <Link className="cta ghost" to="/">
              Abrir panel
            </Link>
          </div>
        </div>
      </div>

      {(localError || error) && <div className="error">{localError || error}</div>}
    </div>
  )
}

export default Onboarding
