import type { FormEvent, ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { useResumePendingTonalliRequest } from '../hooks/useResumePendingTonalliRequest'
import { validateLocalPassword, validateSeedPhraseWordCount } from './onboardingValidation'
import {
  DERIVATION_PROFILE_IDS,
  getDerivationProfile
} from '../services/derivationProfiles'
import type { DerivationProfileId } from '../services/derivationProfiles'
import type { DerivationDiscovery } from '../services/dualDerivationDiscovery'
import { QuickStartUnavailableError } from '../services/quickStartStorage'
import { readTonalliIntent } from '../services/tonalliIntent'
import { setPendingBackupPassword } from '../services/backupSession'

const formatSatsAsXec = (sats: bigint) =>
  `${sats / 100n}.${(sats % 100n).toString().padStart(2, '0')}`

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
  return (
    <OnboardingShell className="onboarding-selector-page">
      <section className="onboarding-selector" aria-labelledby="onboarding-title">
        <div className="onboarding-intro">
          <p className="eyebrow">Bienvenido a Tonalli</p>
          <h1 id="onboarding-title" className="hero-title">
            Tus llaves. Tu dinero. Tu Tonalli.
          </h1>
          <p className="lead">
            Crea tu Tonalli en un paso y empieza a usarla. Tus llaves permanecen en tu dispositivo.
          </p>
          <p className="onboarding-claim">Verifica. Autocustodia. Libérate.</p>
        </div>

        <div className="onboarding-hero-actions">
          <Link className="cta primary onboarding-primary-cta" to="/onboarding/create">
            Crear mi Tonalli
          </Link>
          <Link className="cta outline onboarding-secondary-cta" to="/onboarding/existing">
            Ya tengo una wallet
          </Link>
        </div>

        <p className="security-note">
          Tonalli Wallet no custodia tus fondos. Verifica el sitio antes de ingresar información sensible.
        </p>
      </section>
    </OnboardingShell>
  )
}

export function ExistingWallet() {
  const actions = [
    {
      eyebrow: 'Wallet local',
      title: 'Desbloquear wallet',
      description: 'Abre la wallet cifrada que ya existe en este dispositivo.',
      to: '/onboarding/unlock',
      variant: 'primary'
    },
    {
      eyebrow: 'Recuperar acceso',
      title: 'Restaurar wallet',
      description: 'Restaura acceso con tu frase de recuperación.',
      to: '/onboarding/import',
      variant: 'outline'
    },
    {
      eyebrow: 'Modo lectura',
      title: 'Modo lectura',
      description: 'Consulta la información disponible sin introducir una frase de recuperación.',
      to: '/onboarding/read-only',
      variant: 'ghost'
    },
    {
      eyebrow: 'Opciones avanzadas',
      title: 'Crear con PIN y respaldo inmediato',
      description: 'Flujo clásico: genera la wallet, muestra la frase y cifra con un PIN local.',
      to: '/onboarding/create-backed',
      variant: 'outline'
    }
  ]

  return (
    <OnboardingShell className="onboarding-selector-page">
      <section className="onboarding-selector" aria-labelledby="existing-wallet-title">
        <BackToOnboarding />
        <div className="onboarding-intro">
          <p className="eyebrow">Acceso existente</p>
          <h1 id="existing-wallet-title" className="hero-title">Ya tengo una wallet</h1>
          <p className="lead">Desbloquea, restaura o explora sin crear una Tonalli nueva.</p>
        </div>
        <div className="onboarding-action-list" aria-label="Acciones de wallet existente">
          {actions.map((action) => (
            <Link key={action.to} className="onboarding-action-card" to={action.to}>
              <span className="card-kicker">{action.eyebrow}</span>
              <span className="onboarding-action-title">{action.title}</span>
              <span className="muted">{action.description}</span>
              <span className={`cta ${action.variant}`}>Continuar</span>
            </Link>
          ))}
        </div>
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

function DerivationProfileChoice({
  detection,
  loading,
  onChoose
}: {
  detection: DerivationDiscovery
  loading: boolean
  onChoose(profileId: DerivationProfileId): void
}) {
  if (detection.kind !== 'choice-required') return null
  return (
    <div className="card" role="group" aria-label="Elegir perfil de derivación">
      <h2>Actividad encontrada en varios perfiles</h2>
      <p className="muted">
        Encontramos actividad en varios engines asociados a esta seed. Elige cuál quieres abrir.
        Tonalli no combinará sus UTXOs.
      </p>
      {DERIVATION_PROFILE_IDS.filter(
        profileId => detection.profiles[profileId].hasActivity
      ).map(profileId => {
        const profile = getDerivationProfile(profileId)
        const activity = detection.profiles[profileId]
        return (
          <div key={profileId} className="card">
            <strong>{profile.label} ({profile.coinType})</strong>
            <p className="muted">
              {formatSatsAsXec(activity.xecSats)} XEC · {activity.tokenUtxoCount} token UTXOs ·{' '}
              {activity.activeAddressCount} direcciones con actividad
            </p>
            <button
              className="cta outline"
              type="button"
              disabled={loading}
              onClick={() => onChoose(profileId)}
            >
              Abrir {profile.label}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function resumeAfterQuickStart(navigate: ReturnType<typeof useNavigate>) {
  void readTonalliIntent()
  navigate('/', { replace: true })
}

export function CreateWallet() {
  const navigate = useNavigate()
  const {
    startQuickStartWallet,
    loading,
    error,
    initialized,
    quickStartBootstrap
  } = useWallet()
  const [localError, setLocalError] = useState<string | null>(null)
  const [needsPinFallback, setNeedsPinFallback] = useState(false)

  const bootstrapPending = quickStartBootstrap === 'pending'
  const recoveryFailed = quickStartBootstrap === 'failed'
  const createBlocked = bootstrapPending || recoveryFailed || initialized

  useEffect(() => {
    if (initialized) resumeAfterQuickStart(navigate)
  }, [initialized, navigate])

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    if (createBlocked && !initialized) {
      setLocalError(
        recoveryFailed
          ? 'Hay una Tonalli en este dispositivo que no se pudo recuperar. No se creará otra wallet.'
          : 'Espera a que Tonalli termine de preparar este dispositivo.'
      )
      return
    }
    try {
      await startQuickStartWallet()
      resumeAfterQuickStart(navigate)
    } catch (err) {
      if (err instanceof QuickStartUnavailableError) {
        setNeedsPinFallback(true)
        setLocalError('Este navegador no puede guardar una Tonalli temporal de forma segura. Usa un PIN local.')
        return
      }
      setLocalError((err as Error).message)
    }
  }

  return (
    <OnboardingShell>
      <section className="onboarding-flow" aria-labelledby="create-wallet-title">
        <BackToOnboarding />
        <form className="card onboarding-form" onSubmit={handleCreate}>
          <p className="card-kicker">Nueva Tonalli</p>
          <h1 id="create-wallet-title" className="section-title">Crear mi Tonalli</h1>
          <p className="muted">
            Generamos tu wallet en este dispositivo. Puedes empezar a usarla ahora y protegerla cuando quieras.
          </p>
          <p className="warning">Tonalli Wallet no custodia ni puede recuperar tu frase de recuperación.</p>
          {bootstrapPending && <p className="muted">Preparando este dispositivo…</p>}
          {recoveryFailed && (
            <div className="error" role="alert">
              Hay una Tonalli guardada aquí que no se pudo recuperar. No se creará otra wallet.
            </div>
          )}
          <div className="actions">
            <button
              className="cta primary"
              type="submit"
              disabled={loading || createBlocked}
              data-testid="create-tonalli"
            >
              {loading ? 'Creando...' : bootstrapPending ? 'Preparando...' : 'Crear mi Tonalli'}
            </button>
          </div>
          {needsPinFallback && (
            <Link className="cta outline" to="/onboarding/create-backed">
              Continuar con PIN local
            </Link>
          )}
          <RouteError message={localError || error} />
        </form>
      </section>
    </OnboardingShell>
  )
}

export function CreateBackedWallet() {
  const navigate = useNavigate()
  const { createNewWallet, loading, error, initialized, quickStartBootstrap } = useWallet()
  const [passwordNew, setPasswordNew] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)

  const bootstrapPending = quickStartBootstrap === 'pending'
  const recoveryFailed = quickStartBootstrap === 'failed'
  const existingQuickStart = quickStartBootstrap === 'recovered'
  const createBlocked = bootstrapPending || recoveryFailed || existingQuickStart || initialized

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    if (createBlocked) {
      setLocalError(
        recoveryFailed
          ? 'Hay una Tonalli en este dispositivo que no se pudo recuperar. No se creará otra wallet.'
          : bootstrapPending
            ? 'Espera a que Tonalli termine de preparar este dispositivo.'
            : 'Ya hay una Tonalli en este dispositivo. No se creará otra wallet.'
      )
      return
    }
    const validationError = validateLocalPassword(passwordNew, 'Usa al menos 6 caracteres para el password/PIN local.')
    if (validationError) {
      setLocalError(validationError)
      return
    }

    try {
      await createNewWallet()
      setPendingBackupPassword(passwordNew)
      navigate('/backup')
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

  return (
    <OnboardingShell>
      <section className="onboarding-flow" aria-labelledby="create-backed-wallet-title">
        <BackToOnboarding />
        <form className="card onboarding-form" onSubmit={handleCreate}>
          <p className="card-kicker">Opciones avanzadas</p>
          <h1 id="create-backed-wallet-title" className="section-title">Crear con PIN y respaldo inmediato</h1>
          <p className="muted">La frase de recuperación se genera localmente y nunca sale de tu dispositivo.</p>
          <p className="warning">Tonalli Wallet no custodia ni puede recuperar tu frase de recuperación.</p>
          {bootstrapPending && <p className="muted">Preparando este dispositivo…</p>}
          {recoveryFailed && (
            <div className="error" role="alert">
              Hay una Tonalli guardada aquí que no se pudo recuperar. No se creará otra wallet.
            </div>
          )}
          {(initialized || existingQuickStart) && !recoveryFailed && (
            <div className="error" role="alert">
              Ya hay una Tonalli en este dispositivo. No se creará otra wallet.
            </div>
          )}
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
            <button
              className="cta primary"
              type="submit"
              disabled={loading || createBlocked}
              data-testid="create-backed-tonalli"
            >
              {loading ? 'Creando...' : bootstrapPending ? 'Preparando...' : 'Generar wallet'}
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
  const [profileChoice, setProfileChoice] = useState<DerivationDiscovery | null>(null)

  const finishLoadedWallet = () => {
    if (backupVerified) {
      navigate('/')
      return
    }
    if (!getMnemonic()) {
      throw new Error('No se pudo recuperar la seed para el respaldo.')
    }
    navigate('/backup')
  }

  const continueWithProfile = async (profileId: DerivationProfileId) => {
    try {
      setLocalError(null)
      const result = await loadExistingWallet(passwordExisting, profileId)
      if (result.status !== 'loaded') {
        throw new Error('No se pudo fijar el perfil de derivación elegido.')
      }
      finishLoadedWallet()
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

  const handleExisting = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    const validationError = validateLocalPassword(passwordExisting, 'El password/PIN debe tener al menos 6 caracteres.')
    if (validationError) {
      setLocalError(validationError)
      return
    }

    try {
      const result = await loadExistingWallet(passwordExisting)
      if (result.status === 'choice-required' && result.detection) {
        setProfileChoice(result.detection)
        return
      }
      finishLoadedWallet()
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
          {profileChoice && (
            <DerivationProfileChoice
              detection={profileChoice}
              loading={loading}
              onChoose={(profileId) => void continueWithProfile(profileId)}
            />
          )}
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
  const [profileChoice, setProfileChoice] = useState<DerivationDiscovery | null>(null)

  const continueWithProfile = async (profileId: DerivationProfileId) => {
    try {
      setLocalError(null)
      const phrase = seedPhrase.trim()
      const result = await restoreWallet(phrase, profileId)
      if (result.status !== 'restored') {
        throw new Error('No se pudo fijar el perfil de derivación elegido.')
      }
      setPendingBackupPassword(passwordImport)
      navigate('/backup', { state: { restoreNotice: result.notice } })
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

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
      const result = await restoreWallet(phrase)
      if (result.status === 'choice-required') {
        setProfileChoice(result.detection)
        return
      }
      setPendingBackupPassword(passwordImport)
      navigate('/backup', { state: { restoreNotice: result.notice } })
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
          <h1 id="import-wallet-title" className="section-title">Restaurar wallet existente</h1>
          <p className="muted">
            Introduce tu frase de 12 o 24 palabras únicamente dentro de Tonalli Wallet y verifica que estás usando el
            dominio oficial.
          </p>
          <p className="warning">Nunca compartas tu frase de recuperación con soporte, terceros o sitios externos.</p>
          {profileChoice && (
            <DerivationProfileChoice
              detection={profileChoice}
              loading={loading}
              onChoose={(profileId) => void continueWithProfile(profileId)}
            />
          )}
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
              Restaurar wallet
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
