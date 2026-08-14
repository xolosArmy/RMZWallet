import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, test, vi } from 'vitest'
import App from '../App'
import AppNavigationLayout from '../components/AppNavigationLayout'
import DesktopNavigation from '../components/DesktopNavigation'
import MobileBottomNav from '../components/MobileBottomNav'
import { isMobileBottomNavActive, isMobileBottomNavHidden } from '../components/mobileBottomNavRules'
import { isWalletNavigationActive, walletNavigationItems } from '../components/walletNavigation'
import Dashboard from './Dashboard'
import More from './More'
import SendMenu from './SendMenu'

const walletState = vi.hoisted(() => ({ initialized: true, firmaFormatted: '0.0000' }))

vi.mock('../components/TopBar', () => ({ default: () => <div>Top bar</div> }))

vi.mock('../context/useWallet', () => ({
  useWallet: () => ({
    address: 'ecash:qptestaddress',
    balance: {
      rmzFormatted: '42',
      rmzAtoms: 42n,
      rmzDecimals: 0,
      xecFormatted: '1200',
      xec: 120000n,
      tokenUtxoSats: 546n,
      tokenUtxoXecFormatted: '5.46',
      firmaAtoms: 0n,
      firmaFormatted: walletState.firmaFormatted,
      firmaDecimals: 4
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
    expect(html).toContain('Memo')
    expect(html).toContain('Recibir')
    expect(html).toContain('Más')
  })

  test('active destination mapping covers send and more routes', () => {
    expect(isMobileBottomNavActive('home', '/')).toBe(true)
    expect(isMobileBottomNavActive('home', '/send')).toBe(false)
    expect(isMobileBottomNavActive('send', '/send-menu')).toBe(true)
    expect(isMobileBottomNavActive('send', '/send')).toBe(true)
    expect(isMobileBottomNavActive('send', '/send-xec')).toBe(true)
    expect(isMobileBottomNavActive('send', '/send-firma')).toBe(true)
    expect(isMobileBottomNavActive('send', '/send-nft')).toBe(true)
    expect(isMobileBottomNavActive('memo', '/memo')).toBe(true)
    expect(isMobileBottomNavActive('memo', '/memo/tx/' + 'a'.repeat(64))).toBe(true)
    expect(isMobileBottomNavActive('more', '/dex')).toBe(true)
    expect(isMobileBottomNavActive('more', '/multisig')).toBe(true)
    expect(isMobileBottomNavActive('more', '/multisig/create')).toBe(true)
    expect(isMobileBottomNavActive('more', '/settings')).toBe(true)
  })

  test('mobile navigation continues to use the shared five destinations', () => {
    const html = renderAt('/', <MobileBottomNav />)

    for (const item of walletNavigationItems) {
      expect(html).toContain(`href="${item.to}"`)
      expect(html).toContain(item.label)
    }
  })

  test('shared configuration preserves mobile active route behavior', () => {
    const items = ['home', 'send', 'memo', 'receive', 'more'] as const
    const paths = ['/', '/send-menu', '/send', '/send-xec', '/send-firma', '/send-nft', '/memo', '/memo/tx/' + 'a'.repeat(64), '/receive', '/nfts', '/more', '/dex', '/multisig/create', '/settings']

    for (const item of items) {
      for (const path of paths) {
        expect(isMobileBottomNavActive(item, path), `${item} ${path}`).toBe(isWalletNavigationActive(item, path))
      }
    }
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

  test('layout hides navigation for Tonalli Connect routes', () => {
    expect(isMobileBottomNavHidden('/connect')).toBe(true)
    expect(isMobileBottomNavHidden('/connect/sign-message')).toBe(true)

    expect(renderLayout('/connect')).not.toContain('Navegación principal')
    expect(renderLayout('/connect/sign-message')).not.toContain('Navegación principal')
  })

  test('DesktopNavigation shows five destinations with expected links', () => {
    const html = renderAt('/', <DesktopNavigation />)

    expect(html).toContain('aria-label="Navegación principal de escritorio"')
    expect(html).toContain('href="/"')
    expect(html).toContain('href="/send-menu"')
    expect(html).toContain('href="/memo"')
    expect(html).toContain('href="/receive"')
    expect(html).toContain('href="/more"')
    expect(html).toContain('Inicio')
    expect(html).toContain('Enviar')
    expect(html).toContain('Memo')
    expect(html).toContain('Recibir')
    expect(html).toContain('Más')
  })

  test('DesktopNavigation marks Inicio active only on root', () => {
    const html = renderAt('/', <DesktopNavigation />)
    const sendHtml = renderAt('/send', <DesktopNavigation />)

    expect(html).toContain('desktop-navigation__item is-active" aria-current="page" href="/"')
    expect(sendHtml).not.toContain('desktop-navigation__item is-active" aria-current="page" href="/"')
  })

  test.each(['/send', '/send-xec', '/send-firma', '/send-nft'])('DesktopNavigation marks Enviar active on %s', (path) => {
    const html = renderAt(path, <DesktopNavigation />)

    expect(html).toContain('desktop-navigation__item is-active" aria-current="page" href="/send-menu"')
    expect(html).toContain('desktop-navigation__item is-active')
  })

  test.each(['/dex', '/multisig', '/multisig/create', '/settings', '/scan'])('DesktopNavigation marks Más active on %s', (path) => {
    const html = renderAt(path, <DesktopNavigation />)

    expect(html).toContain('desktop-navigation__item is-active" aria-current="page" href="/more"')
    expect(html).toContain('desktop-navigation__item is-active')
  })

  test('DesktopNavigation marks Memo and Recibir active', () => {
    expect(renderAt('/memo', <DesktopNavigation />)).toContain('desktop-navigation__item is-active" aria-current="page" href="/memo"')
    expect(renderAt('/memo/tx/' + 'a'.repeat(64), <DesktopNavigation />)).toContain('desktop-navigation__item is-active" aria-current="page" href="/memo"')
    expect(renderAt('/receive', <DesktopNavigation />)).toContain('desktop-navigation__item is-active" aria-current="page" href="/receive"')
  })

  test('DesktopNavigation hides on sensitive routes and uninitialized wallets', () => {
    expect(renderAt('/onboarding', <DesktopNavigation />)).not.toContain('Navegación principal de escritorio')
    expect(renderAt('/onboarding/create', <DesktopNavigation />)).not.toContain('Navegación principal de escritorio')
    expect(renderAt('/backup', <DesktopNavigation />)).not.toContain('Navegación principal de escritorio')
    expect(renderAt('/external-sign', <DesktopNavigation />)).not.toContain('Navegación principal de escritorio')
    expect(renderAt('/connect', <DesktopNavigation />)).not.toContain('Navegación principal de escritorio')
    expect(renderAt('/connect/sign-message', <DesktopNavigation />)).not.toContain('Navegación principal de escritorio')

    walletState.initialized = false
    expect(renderAt('/', <DesktopNavigation />)).not.toContain('Navegación principal de escritorio')
    walletState.initialized = true
  })

  test('/send-menu preserves RMZ priority and contains the five transfer options', () => {
    const html = renderAt('/send-menu', <SendMenu />)

    expect(html).toContain('Operaciones')
    expect(html).toContain('¿Qué deseas enviar?')
    expect(html).toContain('Enviar Xolos RMZ')
    expect(html).toContain('href="/send"')
    expect(html).toContain('Enviar eCash XEC')
    expect(html).toContain('href="/send-xec"')
    expect(html).toContain('Enviar Firma Alpha')
    expect(html).toContain('href="/send-firma"')
    expect(html).toContain('Enviar NFT')
    expect(html).toContain('href="/send-nft"')
    expect(html).toContain('Escanear código QR')
    expect(html).toContain('href="/scan"')
    expect(html.indexOf('Enviar Xolos RMZ')).toBeLessThan(html.indexOf('Enviar eCash XEC'))
    expect(html.indexOf('Enviar eCash XEC')).toBeLessThan(html.indexOf('Enviar Firma Alpha'))
    expect(html.indexOf('Enviar Firma Alpha')).toBeLessThan(html.indexOf('Enviar NFT'))
  })

  test('/more contains expected categories and keeps x402 behind feature flags', () => {
    const html = renderAt('/more', <More />)

    expect(html).toContain('Ecosistema')
    expect(html).toContain('Conectividad')
    expect(html).toContain('Seguridad')
    expect(html).toContain('DEX / Agora')
    expect(html).toContain('NFTs')
    expect(html).toContain('href="/nfts"')
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
    walletState.firmaFormatted = '0.0000'
    const html = renderAt('/', <Dashboard />)

    expect(html).toContain('Acciones rápidas')
    expect(html).toContain('href="/send-menu"')
    expect(html).toContain('href="/receive"')
    expect(html).toContain('href="/scan"')
    expect(html).toContain('eToken Xolos RMZ')
    expect(html).toContain('XEC libre para comisiones')
    expect(html).toContain('Sats asociados a token UTXOs: 546 sats (5.46 XEC)')
    expect(html).toContain('Activos compatibles')
    expect(html).toContain('Firma Alpha')
    expect(html).toContain('0.0000 FIRMA')
    expect(html).toContain('href="/send-firma"')
    expect(html).toContain('href="/dex?mode=firma"')
    expect(html.indexOf('eToken Xolos RMZ')).toBeLessThan(html.indexOf('Activos compatibles'))
    expect(html).toContain('Dirección eCash')
    expect(html).toContain('Historial reciente')
    expect(html).not.toContain('href="/dex"')
    expect(html).not.toContain('href="/register-alias"')
    expect(html).not.toContain('href="/walletconnect"')
    expect(html).not.toContain('Ver frase seed')
    expect(html).not.toContain('Ver frase de recuperación')
    expect(html).not.toContain('Test 402 Authorization')
  })

  test('dashboard renders the existing non-zero FIRMA formatted balance without promoting it over RMZ', () => {
    walletState.initialized = true
    walletState.firmaFormatted = '12.3456'
    const html = renderAt('/', <Dashboard />)

    expect(html).toContain('12.3456 FIRMA')
    expect(html.indexOf('eToken Xolos RMZ')).toBeLessThan(html.indexOf('Activos compatibles'))
    expect(html.indexOf('XEC libre para comisiones')).toBeLessThan(html.indexOf('Activos compatibles'))
    walletState.firmaFormatted = '0.0000'
  })

  test('existing routes remain mounted through App', () => {
    walletState.initialized = true
    const paths = [
      '/',
      '/send-menu',
      '/send',
      '/send-xec',
      '/send-firma',
      '/send-nft',
      '/memo',
      '/memo/tx/' + 'a'.repeat(64),
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
