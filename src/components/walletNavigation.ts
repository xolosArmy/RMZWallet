export type WalletNavigationItemId = 'home' | 'send' | 'memo' | 'receive' | 'more'

export type WalletNavigationItem = {
  id: WalletNavigationItemId
  label: string
  to: string
}

const sendPaths = new Set(['/send-menu', '/send', '/send-xec', '/send-nft'])
const morePaths = new Set([
  '/more',
  '/dex',
  '/nfts',
  '/register-alias',
  '/multisig',
  '/walletconnect',
  '/scan',
  '/settings',
  '/reveal-seed',
  '/x402-demo',
  '/x402-staging'
])

export const walletNavigationItems: WalletNavigationItem[] = [
  { id: 'home', label: 'Inicio', to: '/' },
  { id: 'send', label: 'Enviar', to: '/send-menu' },
  { id: 'memo', label: 'Memo', to: '/memo' },
  { id: 'receive', label: 'Recibir', to: '/receive' },
  { id: 'more', label: 'Más', to: '/more' }
]

export const hiddenWalletNavigationPaths = [
  '/onboarding',
  '/backup',
  '/external-sign',
  '/connect',
  '/connect/sign-message'
] as const

export function isWalletNavigationHidden(pathname: string) {
  return (
    pathname === '/backup' ||
    pathname === '/external-sign' ||
    pathname === '/connect' ||
    pathname === '/connect/sign-message' ||
    pathname === '/onboarding' ||
    pathname.startsWith('/onboarding/')
  )
}

export function isWalletNavigationActive(item: WalletNavigationItemId, pathname: string) {
  if (item === 'home') return pathname === '/'
  if (item === 'send') return sendPaths.has(pathname)
  if (item === 'memo') return pathname === '/memo' || pathname.startsWith('/memo/tx/')
  if (item === 'receive') return pathname === '/receive'
  return morePaths.has(pathname) || pathname.startsWith('/multisig/')
}

export function shouldShowWalletNavigation(initialized: boolean, pathname: string) {
  return initialized && !isWalletNavigationHidden(pathname)
}
