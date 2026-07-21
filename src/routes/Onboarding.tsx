import type { FormEvent, ReactNode } from 'react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { useResumePendingTonalliRequest } from '../hooks/useResumePendingTonalliRequest'
import { validateLocalPassword, validateSeedPhraseWordCount } from './onboardingValidation'

function OnboardingShell({ children, className = '' }: { children: ReactNode; className?: string }) {
  const { backupVerified, initialized } = useWallet()
  useResumePendingTonalliRequest({ backupVerified, initialized })

  return (
    <div className={`page onboarding-page ${className}`.trim()}>
      <TopBar />
      {children}
    </div>
  )
}

export function OnboardingHome() {
  const actions = [
    {
      eyebrow: 'Nueva wallet',
      title: 'Crear nueva wallet',
      description: 'Genera una frase de recuperación local para empezar con autocustodia.',
      to: '/onboarding/create',
      variant: 'primary'
    },
    {
      eyebrow: 'Wallet local',
      title: 'Desbloquear wallet',
      description: 'Abre la wallet cifrada que ya existe en este dispositivo.',
      to: '/onboarding/unlock',
      variant: 'outline'
    },
    {
      eyebrow: 'Recuperar acceso',
      title: 'Importar desde seed',
      description: 'Restaura acceso con una frase de 12 o 24 palabras.',
      to: '/onboarding/import',
      variant: 'outline'
    },
    {
      eyebrow: 'Modo lectura',
      title: 'Explorar en modo lectura',
      description: 'Consulta la información disponible sin introducir una frase de recuperación.',
      to: '/onboarding/read-only',
      variant: 'ghost'
    }
  ]

  return (
    <OnboardingShell className="onboarding-selector-page">
      <section className="onboarding-selector" aria-labelledby="onboarding-title">
        <div className="onboarding-intro">
          <p className="eyebrow">Bienvenido a Tonalli Wallet</p>
          <h1 id="onboarding-title" className="hero-title">
            Tus llaves. Tu dinero. Tu Tonalli.
          </h1>
          <p className="lead">
            Controla eCash (XEC), eToken Xolos RMZ, NFTs e identidad on-chain desde una wallet abierta y no custodial.
            Tus llaves permanecen en tu dispositivo.
          </p>
          <p className="onboarding-claim">Verifica. Autocustodia. Libérate.</p>
        </div>

        <div className="onboarding-action-list" aria-label="Acciones de onboarding">
          {actions.map((action) => (
            <Link key={action.to} className="onboarding-action-card" to={action.to}>
              <span className="card-kicker">{action.eyebrow}</span>
              <span className="onboarding-action-title">{action.title}</span>
              <span className="muted">{action.description}</span>
              <span className={`cta ${action.variant}`}>Continuar</span>
            </Link>
          ))}
        </div>

        <p className="security-note">
          Tonalli Wallet no custodia tus fondos. Verifica el sitio antes de ingresar información sensible.
        </p>
      </section>
    </OnboardingShell>
  )
}

function BackToOnboarding() {
  return (
    <Link className="cta ghost back-link" to="/onboarding">
      Volver
    </Link>
  )
}

function RouteError({ message }: { message?: string | null }) {
  if (!message) return null
  return (
    <div className="error" role="alert" aria-live="polite">
      {message}
    </div>
  )
}

export function CreateWallet() {
  const navigate = useNavigate()
  const { createNewWallet, loading, error } = useWallet()
  const [passwordNew, setPasswordNew] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    const validationError = validateLocalPassword(passwordNew, 'Usa al menos 6 caracteres para el password/PIN local.')
    if (validationError) {
      setLocalError(validationError)
      return
    }

    try {
      const mnemonic = await createNewWallet()
      navigate('/backup', { state: { password: passwordNew, mnemonic } })
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

  return (
    <OnboardingShell>
      <section className="onboarding-flow" aria-labelledby="create-wallet-title">
        <BackToOnboarding />
        <form className="card onboarding-form" onSubmit={handleCreate}>
          <p className="card-kicker">Nueva wallet</p>
          <h1 id="create-wallet-title" className="section-title">Crear wallet nueva</h1>
          <p className="muted">La frase de recuperación se genera localmente y nunca sale de tu dispositivo.</p>
          <p className="warning">Tonalli Wallet no custodia ni puede recuperar tu frase de recuperación.</p>
          <label htmlFor="new-password">Password/PIN local</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            placeholder="Mínimo 6 caracteres"
            value={passwordNew}
            onChange={(e) => setPasswordNew(e.target.value)}
          />
          <div className="actions">
            <button className="cta primary" type="submit" disabled={loading}>
              Generar seed
            </button>
          </div>
          <RouteError message={localError || error} />
        </form>
      </section>
    </OnboardingShell>
  )
}

export function UnlockWallet() {
  const navigate = useNavigate()
  const { loadExistingWallet, backupVerified, getMnemonic, loading, error } = useWallet()
  const [passwordExisting, setPasswordExisting] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const handleExisting = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    const validationError = validateLocalPassword(passwordExisting, 'El password/PIN debe tener al menos 6 caracteres.')
    if (validationError) {
      setLocalError(validationError)
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
    <OnboardingShell>
      <section className="onboarding-flow" aria-labelledby="unlock-wallet-title">
        <BackToOnboarding />
        <form className="card onboarding-form" onSubmit={handleExisting}>
          <p className="card-kicker">Wallet local</p>
          <h1 id="unlock-wallet-title" className="section-title">Desbloquear wallet</h1>
          <p className="muted">Ingresa el password o PIN con el que cifraste la wallet en este dispositivo.</p>
          <label htmlFor="existing-password">Password/PIN</label>
          <input
            id="existing-password"
            type="password"
            autoComplete="current-password"
            placeholder="Tu password local"
            value={passwordExisting}
            onChange={(e) => setPasswordExisting(e.target.value)}
          />
          <div className="actions">
            <button className="cta primary" type="submit" disabled={loading}>
              Desbloquear
            </button>
          </div>
          <RouteError message={localError || error} />
        </form>
      </section>
    </OnboardingShell>
  )
}

export function ImportWallet() {
  const navigate = useNavigate()
  const { restoreWallet, loading, error } = useWallet()
  const [seedPhrase, setSeedPhrase] = useState('')
  const [passwordImport, setPasswordImport] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const handleImport = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    const passwordError = validateLocalPassword(passwordImport, 'El password/PIN debe tener al menos 6 caracteres.')
    if (passwordError) {
      setLocalError(passwordError)
      return
    }

    const phrase = seedPhrase.trim()
    const seedError = validateSeedPhraseWordCount(phrase)
    if (seedError) {
      setLocalError(seedError)
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
    <OnboardingShell>
      <section className="onboarding-flow" aria-labelledby="import-wallet-title">
        <BackToOnboarding />
        <form className="card onboarding-form" onSubmit={handleImport}>
          <p className="card-kicker">Recuperar acceso</p>
          <h1 id="import-wallet-title" className="section-title">Importar desde seed</h1>
          <p className="muted">
            Introduce tu frase de 12 o 24 palabras únicamente dentro de Tonalli Wallet y verifica que estás usando el
            dominio oficial.
          </p>
          <p className="warning">Nunca compartas tu frase de recuperación con soporte, terceros o sitios externos.</p>
          <label htmlFor="seed-phrase">Frase seed</label>
          <textarea
            id="seed-phrase"
            rows={4}
            placeholder="Ingrese aquí las 12 o 24 palabras"
            value={seedPhrase}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            onChange={(e) => setSeedPhrase(e.target.value)}
          />
          <label htmlFor="import-password">Nuevo Password/PIN local</label>
          <input
            id="import-password"
            type="password"
            autoComplete="new-password"
            placeholder="Mínimo 6 caracteres"
            value={passwordImport}
            onChange={(e) => setPasswordImport(e.target.value)}
          />
          <div className="actions">
            <button className="cta primary" type="submit" disabled={loading}>
              Importar wallet
            </button>
          </div>
          <RouteError message={localError || error} />
        </form>
      </section>
    </OnboardingShell>
  )
}

export function ReadOnlyWallet() {
  return (
    <OnboardingShell>
      <section className="onboarding-flow" aria-labelledby="read-only-wallet-title">
        <BackToOnboarding />
        <div className="card onboarding-form read-only-panel">
          <p className="card-kicker">Modo lectura</p>
          <h1 id="read-only-wallet-title" className="section-title">Explorar en modo lectura</h1>
          <p className="muted">Consulta la información disponible sin introducir una frase de recuperación.</p>
          <div className="actions">
            <Link className="cta primary" to="/">
              Abrir panel
            </Link>
          </div>
        </div>
      </section>
    </OnboardingShell>
  )
}

export default OnboardingHome
