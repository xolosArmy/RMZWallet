import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, test, vi } from 'vitest'
import App from '../App'
import AppNavigationLayout from '../components/AppNavigationLayout'
import MobileBottomNav from '../components/MobileBottomNav'
import { isMobileBottomNavActive, isMobileBottomNavHidden } from '../components/mobileBottomNavRules'
import Dashboard from './Dashboard'
import More from './More'
import SendMenu from './SendMenu'

const walletState = vi.hoisted(() => ({ initialized: true }))

vi.mock('../components/TopBar', () => ({ default: () => <div>Top bar</div> }))

vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    address: 'ecash:qptestaddress',
    balance: {
      rmzFormatted: '42',
      xecFormatted: '1200',
      xec: 120000n
    },
    initialized: walletState.initialized,
    refreshBalances: vi.fn(),
    rescanWallet: vi.fn(),
    loading: false,
    error: null
  })
}))

function renderAt(path: string, ui: ReactNode) {
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>)
}

function renderLayout(path: string, initialized = true) {
  walletState.initialized = initialized
  return renderAt(path, (
    <AppNavigationLayout>
      <div>Contenido</div>
    </AppNavigationLayout>
  ))
}

describe('Tonalli mobile navigation v3', () => {
  test('MobileBottomNav shows five visible destinations', () => {
    const html = renderAt('/', <MobileBottomNav />)

    expect(html).toContain('aria-label="Navegación principal"')
    expect(html).toContain('Inicio')
    expect(html).toContain('Enviar')
    expect(html).toContain('Recibir')
    expect(html).toContain('NFTs')
    expect(html).toContain('Más')
  })

  test('active destination mapping covers send and more routes', () => {
    expect(isMobileBottomNavActive('home', '/')).toBe(true)
    expect(isMobileBottomNavActive('home', '/send')).toBe(false)
    expect(isMobileBottomNavActive('send', '/send-menu')).toBe(true)
    expect(isMobileBottomNavActive('send', '/send')).toBe(true)
    expect(isMobileBottomNavActive('send', '/send-xec')).toBe(true)
    expect(isMobileBottomNavActive('send', '/send-nft')).toBe(true)
    expect(isMobileBottomNavActive('more', '/dex')).toBe(true)
    expect(isMobileBottomNavActive('more', '/multisig')).toBe(true)
    expect(isMobileBottomNavActive('more', '/multisig/create')).toBe(true)
    expect(isMobileBottomNavActive('more', '/settings')).toBe(true)
  })

  test('active state includes aria-current and a non-color class', () => {
    const html = renderAt('/send-xec', <MobileBottomNav />)

    expect(html).toContain('href="/send-menu"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('mobile-bottom-nav__item is-active')
  })

  test('layout hides navigation for onboarding, backup, external signing and uninitialized wallets', () => {
    expect(isMobileBottomNavHidden('/onboarding')).toBe(true)
    expect(isMobileBottomNavHidden('/onboarding/create')).toBe(true)
    expect(isMobileBottomNavHidden('/backup')).toBe(true)
    expect(isMobileBottomNavHidden('/external-sign')).toBe(true)

    expect(renderLayout('/onboarding')).not.toContain('Navegación principal')
    expect(renderLayout('/backup')).not.toContain('Navegación principal')
    expect(renderLayout('/external-sign')).not.toContain('Navegación principal')
    expect(renderLayout('/', false)).not.toContain('Navegación principal')
    expect(renderLayout('/')).toContain('Navegación principal')
  })

  test('/send-menu contains the four transfer options', () => {
    const html = renderAt('/send-menu', <SendMenu />)

    expect(html).toContain('Operaciones')
    expect(html).toContain('¿Qué deseas enviar?')
    expect(html).toContain('Enviar Xolos RMZ')
    expect(html).toContain('href="/send"')
    expect(html).toContain('Enviar eCash XEC')
    expect(html).toContain('href="/send-xec"')
    expect(html).toContain('Enviar NFT')
    expect(html).toContain('href="/send-nft"')
    expect(html).toContain('Escanear código QR')
    expect(html).toContain('href="/scan"')
  })

  test('/more contains expected categories and keeps x402 behind feature flags', () => {
    const html = renderAt('/more', <More />)

    expect(html).toContain('Ecosistema')
    expect(html).toContain('Conectividad')
    expect(html).toContain('Seguridad')
    expect(html).toContain('DEX / Agora')
    expect(html).toContain('Alias .xec')
    expect(html).toContain('Multifirma eCash')
    expect(html).toContain('WalletConnect')
    expect(html).toContain('Escanear QR')
    expect(html).toContain('Configuración')
    expect(html).toContain('Ver frase de recuperación')
    expect(html).toContain('Acceso sensible. Nunca compartas tu frase con soporte, sitios web o terceros.')
    expect(html).not.toContain('Test 402 Authorization')
    expect(html).not.toContain('Test real staging authorization')
  })

  test('dashboard no longer exposes the full tool list as primary actions', () => {
    walletState.initialized = true
    const html = renderAt('/', <Dashboard />)

    expect(html).toContain('Acciones rápidas')
    expect(html).toContain('href="/send-menu"')
    expect(html).toContain('href="/receive"')
    expect(html).toContain('href="/scan"')
    expect(html).toContain('eToken Xolos RMZ')
    expect(html).toContain('eCash (XEC) para comisiones')
    expect(html).toContain('Dirección eCash')
    expect(html).toContain('Historial reciente')
    expect(html).not.toContain('href="/dex"')
    expect(html).not.toContain('href="/register-alias"')
    expect(html).not.toContain('href="/walletconnect"')
    expect(html).not.toContain('Ver frase seed')
    expect(html).not.toContain('Ver frase de recuperación')
    expect(html).not.toContain('Test 402 Authorization')
  })

  test('existing routes remain mounted through App', () => {
    walletState.initialized = true
    const paths = [
      '/',
      '/send-menu',
      '/send',
      '/send-xec',
      '/send-nft',
      '/receive',
      '/nfts',
      '/more',
      '/dex',
      '/register-alias',
      '/multisig',
      '/walletconnect',
      '/scan',
      '/settings',
      '/reveal-seed',
      '/backup',
      '/external-sign',
      '/connect',
      '/connect/sign-message',
      '/onboarding'
    ]

    for (const path of paths) {
      const html = renderAt(path, (
        <Routes>
          <Route path="*" element={<App />} />
        </Routes>
      ))
      expect(html.length, path).toBeGreaterThan(0)
    }
  })
})
