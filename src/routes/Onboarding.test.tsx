import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, test } from 'vitest'
import { WalletContext } from '../context/walletContext'
import {
  CreateBackedWallet,
  CreateWallet,
  ExistingWallet,
  ImportWallet,
  OnboardingHome,
  ReadOnlyWallet,
  UnlockWallet,
} from './Onboarding'
import { validateLocalPassword, validateSeedPhraseWordCount } from './onboardingValidation'
import { walletContextFixture } from '../test/walletContextFixture'

const walletValue = walletContextFixture()

function renderRoute(ui: ReactNode) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WalletContext.Provider value={walletValue}>{ui}</WalletContext.Provider>
    </MemoryRouter>
  )
}

describe('Tonalli onboarding routes', () => {
  test('new user sees one primary action and a secondary existing-wallet path', () => {
    const html = renderRoute(<OnboardingHome />)

    expect(html).toContain('Tus llaves. Tu dinero. Tu Tonalli.')
    expect(html).toContain('Crear mi Tonalli')
    expect(html).toContain('Ya tengo una wallet')
    expect(html).toContain('href="/onboarding/create"')
    expect(html).toContain('href="/onboarding/existing"')
    expect(html).not.toContain('href="/onboarding/unlock"')
    expect(html).not.toContain('href="/onboarding/import"')
    expect(html).not.toContain('href="/onboarding/read-only"')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('BIP44')
    expect(html).not.toContain('UTXO')
  })

  test('secondary existing-wallet hub keeps unlock, restore, read-only and advanced', () => {
    const html = renderRoute(<ExistingWallet />)

    expect(html).toContain('Desbloquear wallet')
    expect(html).toContain('Restaurar wallet')
    expect(html).toContain('Modo lectura')
    expect(html).toContain('Opciones avanzadas')
    expect(html).toContain('href="/onboarding/unlock"')
    expect(html).toContain('href="/onboarding/import"')
    expect(html).toContain('href="/onboarding/read-only"')
    expect(html).toContain('href="/onboarding/create-backed"')
  })

  test('/onboarding/create is the passwordless Quick Start happy path', () => {
    const html = renderRoute(<CreateWallet />)

    expect(html).toContain('Crear mi Tonalli')
    expect(html).toContain('data-testid="create-tonalli"')
    expect(html).not.toContain('id="new-password"')
    expect(html).not.toContain('Generar seed')
    expect(html).not.toContain('BIP44')
    expect(html).not.toContain('id="seed-phrase"')
    expect(html).toContain('href="/onboarding"')
  })

  test('/onboarding/create-backed preserves the PIN create form', () => {
    const html = renderRoute(<CreateBackedWallet />)

    expect(html).toContain('Crear con PIN y respaldo inmediato')
    expect(html).toContain('id="new-password"')
    expect(html).toContain('autoComplete="new-password"')
    expect(html).not.toContain('id="existing-password"')
    expect(html).not.toContain('id="seed-phrase"')
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

    expect(html).toContain('Restaurar wallet existente')
    expect(html).toContain('id="seed-phrase"')
    expect(html).toContain('autoCapitalize="off"')
    expect(html).toContain('autoComplete="off"')
    expect(html).toContain('autoCorrect="off"')
    expect(html).toContain('spellCheck="false"')
    expect(html).toContain('Restaurar wallet')
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
