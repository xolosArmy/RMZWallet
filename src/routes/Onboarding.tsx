import type { FormEvent, ReactNode } from 'react'
import { useState } from 'react'
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
      title: 'Restaurar wallet existente',
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
          <p className="muted">Compatible con eCash / Cashtab · BIP44 1899</p>
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
  const [profileChoice, setProfileChoice] = useState<DerivationDiscovery | null>(null)

  const finishLoadedWallet = () => {
    if (backupVerified) {
      navigate('/')
      return
    }
    const mnemonic = getMnemonic()
    if (!mnemonic) {
      throw new Error('No se pudo recuperar la seed para el respaldo.')
    }
    navigate('/backup', { state: { password: passwordExisting, mnemonic } })
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
      navigate('/backup', {
        state: {
          password: passwordImport,
          mnemonic: phrase,
          restoreNotice: result.notice
        }
      })
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
      navigate('/backup', {
        state: {
          password: passwordImport,
          mnemonic: phrase,
          restoreNotice: result.notice
        }
      })
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
