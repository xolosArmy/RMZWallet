import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, test, vi } from 'vitest'
import { WalletContext, type WalletContextValue } from '../context/walletContext'
import {
  CreateWallet,
  ImportWallet,
  OnboardingHome,
  ReadOnlyWallet,
  UnlockWallet,
} from './Onboarding'
import { validateLocalPassword, validateSeedPhraseWordCount } from './onboardingValidation'

const walletValue: WalletContextValue = {
  address: null,
  balance: null,
  loading: false,
  error: null,
  initialized: false,
  backupVerified: false,
  createNewWallet: vi.fn(),
  restoreWallet: vi.fn(),
  loadExistingWallet: vi.fn(),
  encryptAndStore: vi.fn(),
  refreshBalances: vi.fn(),
  rescanWallet: vi.fn(),
  sendRMZ: vi.fn(),
  sendXEC: vi.fn(),
  estimateAliasRegistration: vi.fn(),
  reserveAliasRegistrationUtxos: vi.fn(),
  buildAliasRegistrationRawTx: vi.fn(),
  registerAliasOnChain: vi.fn(),
  estimateXecSend: vi.fn(),
  getMnemonic: vi.fn(),
  unlockEncryptedWallet: vi.fn()
}

function renderRoute(ui: ReactNode) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WalletContext.Provider value={walletValue}>{ui}</WalletContext.Provider>
    </MemoryRouter>
  )
}

describe('Tonalli onboarding routes', () => {
  test('/onboarding shows the four actions and no forms', () => {
    const html = renderRoute(<OnboardingHome />)

    expect(html).toContain('Tus llaves. Tu dinero. Tu Tonalli.')
    expect(html).toContain('Crear nueva wallet')
    expect(html).toContain('Desbloquear wallet')
    expect(html).toContain('Importar desde seed')
    expect(html).toContain('Explorar en modo lectura')
    expect(html).toContain('href="/onboarding/create"')
    expect(html).toContain('href="/onboarding/unlock"')
    expect(html).toContain('href="/onboarding/import"')
    expect(html).toContain('href="/onboarding/read-only"')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('id="new-password"')
    expect(html).not.toContain('id="existing-password"')
    expect(html).not.toContain('id="seed-phrase"')
  })

  test('/onboarding/create shows only the create form', () => {
    const html = renderRoute(<CreateWallet />)

    expect(html).toContain('Crear wallet nueva')
    expect(html).toContain('Generar seed')
    expect(html).toContain('id="new-password"')
    expect(html).toContain('autoComplete="new-password"')
    expect(html).toContain('href="/onboarding"')
    expect(html).not.toContain('id="existing-password"')
    expect(html).not.toContain('id="seed-phrase"')
    expect(html).not.toContain('Importar wallet')
  })

  test('/onboarding/unlock shows only the unlock form', () => {
    const html = renderRoute(<UnlockWallet />)

    expect(html).toContain('Desbloquear wallet')
    expect(html).toContain('id="existing-password"')
    expect(html).toContain('autoComplete="current-password"')
    expect(html).toContain('href="/onboarding"')
    expect(html).not.toContain('Conectar')
    expect(html).not.toContain('id="new-password"')
    expect(html).not.toContain('id="seed-phrase"')
    expect(html).not.toContain('Generar seed')
  })

  test('/onboarding/import shows only the seed form', () => {
    const html = renderRoute(<ImportWallet />)

    expect(html).toContain('Importar desde seed')
    expect(html).toContain('id="seed-phrase"')
    expect(html).toContain('autoCapitalize="off"')
    expect(html).toContain('autoComplete="off"')
    expect(html).toContain('autoCorrect="off"')
    expect(html).toContain('spellCheck="false"')
    expect(html).toContain('Importar wallet')
    expect(html).toContain('id="import-password"')
    expect(html).toContain('autoComplete="new-password"')
    expect(html).toContain('href="/onboarding"')
    expect(html).not.toContain('id="new-password"')
    expect(html).not.toContain('id="existing-password"')
  })

  test('/onboarding/read-only shows only read-only explanation', () => {
    const html = renderRoute(<ReadOnlyWallet />)

    expect(html).toContain('Explorar en modo lectura')
    expect(html).toContain('Consulta la información disponible sin introducir una frase de recuperación.')
    expect(html).toContain('Abrir panel')
    expect(html).toContain('href="/"')
    expect(html).toContain('href="/onboarding"')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('frase de 12 o 24 palabras')
  })

  test('current password and seed validations are preserved', () => {
    expect(validateLocalPassword('12345', 'mínimo')).toBe('mínimo')
    expect(validateLocalPassword('123456', 'mínimo')).toBeNull()
    expect(validateSeedPhraseWordCount('uno dos tres')).toBe('La frase seed debe contener 12 o 24 palabras.')
    expect(validateSeedPhraseWordCount(Array.from({ length: 12 }, (_, index) => `word${index}`).join(' '))).toBeNull()
    expect(validateSeedPhraseWordCount(Array.from({ length: 24 }, (_, index) => `word${index}`).join(' '))).toBeNull()
  })
})
