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
import {
  PENDING_IDENTITY_STATE,
  QuickStartUnavailableError,
  isWebLocksSupported,
  type PendingIdentityState
} from '../services/quickStartStorage'
import { readTonalliIntent } from '../services/tonalliIntent'
import { setPendingBackupPassword } from '../services/backupSession'

const formatSatsAsXec = (sats: bigint) =>
  `${sats / 100n}.${(sats % 100n).toString().padStart(2, '0')}`

const pendingIdentityBlockingMessage = (state: PendingIdentityState) => {
  if (state === PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING) {
    return 'Encontramos datos de una creación anterior que no pueden leerse correctamente.'
  }
  if (state === PENDING_IDENTITY_STATE.STORAGE_UNAVAILABLE) {
    return 'El almacenamiento local no está disponible para verificar el estado de la billetera.'
  }
  if (state === PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING) {
    return 'Encontramos una creación anterior incompleta que esta versión no puede recuperar automáticamente.'
  }
  return 'Tienes una creación de Tonalli pendiente de respaldo. Continúa con el respaldo para protegerla.'
}

const pendingIdentityActionLabel = (state: PendingIdentityState) => {
  if (state === PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING) {
    return 'Resolver datos de creación dañados'
  }
  if (state === PENDING_IDENTITY_STATE.STORAGE_UNAVAILABLE) {
    return 'Reintentar almacenamiento'
  }
  if (state === PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING) {
    return 'Resolver creación incompleta'
  }
  return 'Continuar respaldo'
}

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
  const {
    pendingIdentityState,
    hasPendingIdentity,
    resumePendingIdentity,
    abandonPendingIdentity,
    loading
  } = useWallet()
  const navigate = useNavigate()
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [abandoning, setAbandoning] = useState(false)
  const recoverablePending = pendingIdentityState === PENDING_IDENTITY_STATE.RECOVERABLE_PENDING
  const legacyPending = pendingIdentityState === PENDING_IDENTITY_STATE.LEGACY_UNRECOVERABLE_PENDING
  const corruptPending = pendingIdentityState === PENDING_IDENTITY_STATE.CORRUPT_OR_UNKNOWN_PENDING
  const storageUnavailable = pendingIdentityState === PENDING_IDENTITY_STATE.STORAGE_UNAVAILABLE

  const handleResume = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!pin) {
      setError('Ingresa el PIN o contraseña con el que iniciaste la creación.')
      return
    }
    setResuming(true)
    try {
      const result = await resumePendingIdentity(pin)
      if (result?.reconciled) {
        navigate('/')
      } else {
        navigate('/backup')
      }
    } catch (err) {
      setError((err as Error).message || 'No se pudo recuperar la creación pendiente.')
    } finally {
      setResuming(false)
    }
  }

  const handleAbandon = async () => {
    setAbandoning(true)
    setError(null)
    try {
      await abandonPendingIdentity()
      setConfirmAbandon(false)
      setPin('')
    } catch (err) {
      setError((err as Error).message || 'No se pudo descartar la creación incompleta.')
    } finally {
      setAbandoning(false)
    }
  }

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

        {hasPendingIdentity ? (
          <div
            className="card pending-identity-card"
            data-testid="pending-identity-recovery-card"
            style={{ maxWidth: '480px', margin: '1.5rem auto', textAlign: 'left' }}
          >
            <p className="card-kicker" style={{ color: 'var(--color-warning, #f59e0b)', fontWeight: 'bold' }}>
              Creación pendiente detectada
            </p>
            {corruptPending ? (
              <>
                <h2 style={{ fontSize: '1.25rem', margin: '0.5rem 0' }}>Datos de creación dañados detectados</h2>
                <p className="muted" style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>
                  Encontramos datos de una creación anterior que no pueden leerse correctamente.
                </p>
                <p className="muted" style={{ fontSize: '0.9rem', marginBottom: '1rem' }}>
                  Tonalli no creará otra identidad automáticamente porque la información dañada podría corresponder a una wallet que ya recibió fondos.
                </p>
              </>
            ) : recoverablePending ? (
              <>
                <h2 style={{ fontSize: '1.25rem', margin: '0.5rem 0' }}>Tienes una creación de Tonalli pendiente</h2>
                <p className="muted" style={{ fontSize: '0.9rem', marginBottom: '1rem' }}>
                  Existe una identidad creada o importada pendiente de verificar su respaldo. Ingresa tu PIN local para continuar el respaldo de forma segura.
                </p>
                <form onSubmit={handleResume}>
                  <div className="field" style={{ marginBottom: '1rem' }}>
                    <label htmlFor="pending-pin" style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem' }}>
                      PIN o contraseña local:
                    </label>
                    <input
                      id="pending-pin"
                      type="password"
                      className="input"
                      data-testid="pending-pin-input"
                      value={pin}
                      onChange={(e) => setPin(e.target.value)}
                      placeholder="Tu PIN local"
                      disabled={resuming || loading}
                      autoComplete="current-password"
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div className="actions" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <button
                      type="submit"
                      className="cta primary"
                      data-testid="resume-pending-backup-btn"
                      disabled={resuming || loading || !pin}
                    >
                      {resuming ? 'Verificando...' : 'Continuar respaldo'}
                    </button>
                  </div>
                </form>
              </>
            ) : legacyPending ? (
              <p className="muted" style={{ fontSize: '0.9rem', marginBottom: '1rem' }}>
                Encontramos una creación anterior incompleta que esta versión no puede recuperar automáticamente.
              </p>
            ) : storageUnavailable ? (
              <p className="muted" style={{ fontSize: '0.9rem', marginBottom: '1rem' }}>
                El almacenamiento local no está disponible para verificar el estado de la billetera.
              </p>
            ) : null}
            {error && (
              <div className="error" role="alert" data-testid="pending-identity-error" style={{ marginTop: '0.75rem' }}>
                {error}
              </div>
            )}
            {!storageUnavailable && (
              <div style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid var(--border-color, #333)' }}>
                {!confirmAbandon ? (
                  <button
                    type="button"
                    className="cta ghost"
                    style={{ fontSize: '0.8rem', color: 'var(--text-muted, #888)' }}
                    onClick={() => setConfirmAbandon(true)}
                    data-testid="request-abandon-pending-btn"
                    disabled={resuming || loading || abandoning}
                  >
                    {corruptPending
                      ? 'Descartar datos de creación dañados y empezar de nuevo'
                      : legacyPending
                      ? 'Descartar creación incompleta y empezar de nuevo'
                      : 'Descartar creación pendiente…'}
                  </button>
                ) : (
                  <div className="warning" style={{ fontSize: '0.85rem' }} data-testid="abandon-warning-box">
                    <p style={{ margin: '0 0 0.5rem 0', color: 'var(--color-danger, #ef4444)' }}>
                      {corruptPending
                        ? 'Si esta creación anterior correspondía a una dirección que recibió fondos y no conservas su frase de recuperación, descartarla puede hacer que esos fondos sean inaccesibles permanentemente.'
                        : 'La dirección creada anteriormente pudo haber recibido fondos. Si no conservas su frase de recuperación, descartarla puede hacer que esos fondos sean inaccesibles permanentemente.'}
                    </p>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        type="button"
                        className="cta danger"
                        onClick={() => void handleAbandon()}
                        data-testid="confirm-abandon-pending-btn"
                        style={{ fontSize: '0.8rem' }}
                        disabled={abandoning || loading}
                      >
                        {abandoning ? 'Descartando…' : 'Sí, descartar definitivamente'}
                      </button>
                      <button
                        type="button"
                        className="cta ghost"
                        onClick={() => setConfirmAbandon(false)}
                        data-testid="cancel-abandon-pending-btn"
                        style={{ fontSize: '0.8rem' }}
                        disabled={abandoning || loading}
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="onboarding-hero-actions">
            <Link className="cta primary onboarding-primary-cta" to="/onboarding/create">
              Crear mi Tonalli
            </Link>
            <Link className="cta outline onboarding-secondary-cta" to="/onboarding/existing">
              Ya tengo una wallet
            </Link>
          </div>
        )}

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
    quickStartBootstrap,
    hasBackedWalletOnDevice,
    pendingIdentityState,
    hasPendingIdentity
  } = useWallet()
  const [localError, setLocalError] = useState<string | null>(null)
  const [needsPinFallback, setNeedsPinFallback] = useState(false)
  const webLocksSupported = isWebLocksSupported()

  const bootstrapPending = quickStartBootstrap === 'pending'
  const recoveryFailed = quickStartBootstrap === 'failed'
  const backedWalletExists = hasBackedWalletOnDevice && !initialized
  const createBlocked =
    !webLocksSupported ||
    bootstrapPending ||
    recoveryFailed ||
    initialized ||
    backedWalletExists ||
    hasPendingIdentity

  useEffect(() => {
    if (initialized) resumeAfterQuickStart(navigate)
  }, [initialized, navigate])

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    if (!webLocksSupported) {
      setLocalError('Tu navegador no cuenta con soporte de Web Locks. Actualiza tu navegador para usar Tonalli de forma segura.')
      return
    }
    if (createBlocked && !initialized) {
      setLocalError(
        hasPendingIdentity
          ? pendingIdentityBlockingMessage(pendingIdentityState)
          : recoveryFailed
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
        if (!webLocksSupported) {
          setLocalError('Tu navegador no cuenta con soporte de Web Locks. Actualiza tu navegador para usar Tonalli de forma segura.')
          return
        }
        setNeedsPinFallback(true)
        setLocalError('Este navegador no puede guardar una Tonalli temporal de forma segura. Usa un PIN local.')
        return
      }
      if ((err as Error).message === 'BACKED_WALLET_EXISTS') {
        setLocalError('Ya hay una wallet cifrada en este dispositivo. Desbloquéala para continuar.')
        return
      }
      if ((err as Error).message === 'PENDING_IDENTITY_EXISTS') {
        setLocalError('Hay otra operación de creación de wallet pendiente en otra pestaña.')
        return
      }
      if ((err as Error).message === 'CORRUPT_OR_UNKNOWN_PENDING') {
        setLocalError('Encontramos datos de una creación anterior que no pueden leerse correctamente.')
        return
      }
      if ((err as Error).message === 'STORAGE_UNAVAILABLE') {
        setLocalError('El almacenamiento local no está disponible para verificar el estado de la billetera.')
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
          {!webLocksSupported && (
            <div className="error" role="alert" data-testid="unsupported-browser-state">
              Tu navegador no cuenta con soporte de Web Locks para coordinar operaciones de forma segura entre pestañas. Actualiza tu navegador para usar Tonalli de forma segura.
            </div>
          )}
          {hasPendingIdentity && (
            <div className="warning" role="alert" data-testid="pending-identity-alert">
              {pendingIdentityBlockingMessage(pendingIdentityState)}
              <div style={{ marginTop: '0.75rem' }}>
                <Link className="cta outline" to="/onboarding">
                  {pendingIdentityActionLabel(pendingIdentityState)}
                </Link>
              </div>
            </div>
          )}
          {bootstrapPending && <p className="muted">Preparando este dispositivo…</p>}
          {recoveryFailed && (
            <div className="error" role="alert">
              Hay una Tonalli guardada aquí que no se pudo recuperar. No se creará otra wallet.
            </div>
          )}
          {backedWalletExists && !recoveryFailed && (
            <div className="error" role="alert">
              Ya hay una wallet cifrada en este dispositivo. Desbloquéala para continuar.
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
          {backedWalletExists && (
            <Link className="cta outline" to="/onboarding/unlock" data-testid="unlock-existing-wallet">
              Desbloquear wallet
            </Link>
          )}
          {needsPinFallback && webLocksSupported && !backedWalletExists && (
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
  const {
    createNewWallet,
    loading,
    error,
    initialized,
    quickStartBootstrap,
    pendingIdentityState,
    hasPendingIdentity
  } = useWallet()
  const [passwordNew, setPasswordNew] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const webLocksSupported = isWebLocksSupported()

  const bootstrapPending = quickStartBootstrap === 'pending'
  const recoveryFailed = quickStartBootstrap === 'failed'
  const existingQuickStart = quickStartBootstrap === 'recovered'
  const createBlocked =
    !webLocksSupported ||
    bootstrapPending ||
    recoveryFailed ||
    existingQuickStart ||
    initialized ||
    hasPendingIdentity

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    if (!webLocksSupported) {
      setLocalError('Tu navegador no cuenta con soporte de Web Locks. Actualiza tu navegador para usar Tonalli de forma segura.')
      return
    }
    if (createBlocked) {
      setLocalError(
        hasPendingIdentity
          ? pendingIdentityBlockingMessage(pendingIdentityState)
          : recoveryFailed
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
      await createNewWallet(passwordNew)
      setPendingBackupPassword(passwordNew)
      navigate('/backup')
    } catch (err) {
      if ((err as Error).message === 'PENDING_IDENTITY_EXISTS') {
        setLocalError('Hay otra operación de creación de wallet pendiente en otra pestaña.')
        return
      }
      if ((err as Error).message === 'CORRUPT_OR_UNKNOWN_PENDING') {
        setLocalError('Encontramos datos de una creación anterior que no pueden leerse correctamente.')
        return
      }
      if ((err as Error).message === 'STORAGE_UNAVAILABLE') {
        setLocalError('El almacenamiento local no está disponible para verificar el estado de la billetera.')
        return
      }
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
          {!webLocksSupported && (
            <div className="error" role="alert" data-testid="unsupported-browser-state">
              Tu navegador no cuenta con soporte de Web Locks para coordinar operaciones de forma segura entre pestañas. Actualiza tu navegador para usar Tonalli de forma segura.
            </div>
          )}
          {hasPendingIdentity && (
            <div className="warning" role="alert" data-testid="pending-identity-alert">
              {pendingIdentityBlockingMessage(pendingIdentityState)}
              <div style={{ marginTop: '0.75rem' }}>
                <Link className="cta outline" to="/onboarding">
                  {pendingIdentityActionLabel(pendingIdentityState)}
                </Link>
              </div>
            </div>
          )}
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
  const {
    restoreWallet,
    loading,
    error,
    initialized,
    quickStartBootstrap,
    pendingIdentityState,
    hasPendingIdentity
  } = useWallet()
  const [seedPhrase, setSeedPhrase] = useState('')
  const [passwordImport, setPasswordImport] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [profileChoice, setProfileChoice] = useState<DerivationDiscovery | null>(null)

  const webLocksSupported = isWebLocksSupported()
  const bootstrapPending = quickStartBootstrap === 'pending'
  const recoveryFailed = quickStartBootstrap === 'failed'
  const existingQuickStart = quickStartBootstrap === 'recovered'
  const importBlocked =
    !webLocksSupported ||
    bootstrapPending ||
    recoveryFailed ||
    existingQuickStart ||
    initialized ||
    hasPendingIdentity

  const continueWithProfile = async (profileId: DerivationProfileId) => {
    try {
      setLocalError(null)
      if (!webLocksSupported) {
        setLocalError('Tu navegador no cuenta con soporte de Web Locks. Actualiza tu navegador para usar Tonalli de forma segura.')
        return
      }
      if (importBlocked) {
        setLocalError(
          hasPendingIdentity
            ? pendingIdentityBlockingMessage(pendingIdentityState)
            : recoveryFailed
              ? 'Hay una Tonalli en este dispositivo que no se pudo recuperar. No se restaurará otra wallet.'
              : bootstrapPending
                ? 'Espera a que Tonalli termine de preparar este dispositivo.'
                : 'Ya hay una Tonalli en este dispositivo. No se restaurará otra wallet.'
        )
        return
      }
      const phrase = seedPhrase.trim()
      const result = await restoreWallet(phrase, profileId, passwordImport)
      if (result.status !== 'restored') {
        throw new Error('No se pudo fijar el perfil de derivación elegido.')
      }
      setPendingBackupPassword(passwordImport)
      navigate('/backup', { state: { restoreNotice: result.notice } })
    } catch (err) {
      if ((err as Error).message === 'PENDING_IDENTITY_EXISTS') {
        setLocalError('Hay otra operación de creación o restauración de wallet pendiente en otra pestaña.')
        return
      }
      if ((err as Error).message === 'CORRUPT_OR_UNKNOWN_PENDING') {
        setLocalError('Encontramos datos de una creación anterior que no pueden leerse correctamente.')
        return
      }
      if ((err as Error).message === 'STORAGE_UNAVAILABLE') {
        setLocalError('El almacenamiento local no está disponible para verificar el estado de la billetera.')
        return
      }
      setLocalError((err as Error).message)
    }
  }

  const handleImport = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    if (!webLocksSupported) {
      setLocalError('Tu navegador no cuenta con soporte de Web Locks. Actualiza tu navegador para usar Tonalli de forma segura.')
      return
    }
    if (importBlocked) {
      setLocalError(
        hasPendingIdentity
          ? pendingIdentityBlockingMessage(pendingIdentityState)
          : recoveryFailed
            ? 'Hay una Tonalli en este dispositivo que no se pudo recuperar. No se restaurará otra wallet.'
            : bootstrapPending
              ? 'Espera a que Tonalli termine de preparar este dispositivo.'
              : 'Ya hay una Tonalli en este dispositivo. No se restaurará otra wallet.'
      )
      return
    }
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
      const result = await restoreWallet(phrase, undefined, passwordImport)
      if (result.status === 'choice-required') {
        setProfileChoice(result.detection)
        return
      }
      setPendingBackupPassword(passwordImport)
      navigate('/backup', { state: { restoreNotice: result.notice } })
    } catch (err) {
      if ((err as Error).message === 'PENDING_IDENTITY_EXISTS') {
        setLocalError('Hay otra operación de creación o restauración de wallet pendiente en otra pestaña.')
        return
      }
      if ((err as Error).message === 'CORRUPT_OR_UNKNOWN_PENDING') {
        setLocalError('Encontramos datos de una creación anterior que no pueden leerse correctamente.')
        return
      }
      if ((err as Error).message === 'STORAGE_UNAVAILABLE') {
        setLocalError('El almacenamiento local no está disponible para verificar el estado de la billetera.')
        return
      }
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
          {!webLocksSupported && (
            <div className="error" role="alert" data-testid="unsupported-browser-state">
              Tu navegador no cuenta con soporte de Web Locks para coordinar operaciones de forma segura entre pestañas. Actualiza tu navegador para usar Tonalli de forma segura.
            </div>
          )}
          {hasPendingIdentity && (
            <div className="warning" role="alert" data-testid="pending-identity-alert">
              {pendingIdentityBlockingMessage(pendingIdentityState)}
              <div style={{ marginTop: '0.75rem' }}>
                <Link className="cta outline" to="/onboarding">
                  {pendingIdentityActionLabel(pendingIdentityState)}
                </Link>
              </div>
            </div>
          )}
          {bootstrapPending && <p className="muted">Preparando este dispositivo…</p>}
          {recoveryFailed && (
            <div className="error" role="alert">
              Hay una Tonalli guardada aquí que no se pudo recuperar. No se restaurará otra wallet.
            </div>
          )}
          {(initialized || existingQuickStart) && !recoveryFailed && (
            <div className="error" role="alert">
              Ya hay una Tonalli en este dispositivo. No se restaurará otra wallet.
            </div>
          )}
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
            <button
              className="cta primary"
              type="submit"
              disabled={loading || importBlocked}
              data-testid="import-tonalli"
            >
              {loading ? 'Restaurando...' : bootstrapPending ? 'Preparando...' : 'Restaurar wallet'}
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
