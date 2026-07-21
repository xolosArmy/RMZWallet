const sendPaths = new Set(['/send-menu', '/send', '/send-xec', '/send-nft'])
const morePaths = new Set([
  '/more',
  '/dex',
  '/register-alias',
  '/multisig',
  '/walletconnect',
  '/scan',
  '/settings',
  '/reveal-seed',
  '/x402-demo',
  '/x402-staging'
])

export const hiddenMobileBottomNavPaths = [
  '/onboarding',
  '/backup',
  '/external-sign',
  '/connect',
  '/connect/sign-message'
] as const

export function isMobileBottomNavHidden(pathname: string) {
  return (
    pathname === '/backup' ||
    pathname === '/external-sign' ||
    pathname === '/connect' ||
    pathname === '/connect/sign-message' ||
    pathname === '/onboarding' ||
    pathname.startsWith('/onboarding/')
  )
}

export function isMobileBottomNavActive(item: 'home' | 'send' | 'receive' | 'nfts' | 'more', pathname: string) {
  if (item === 'home') return pathname === '/'
  if (item === 'send') return sendPaths.has(pathname)
  if (item === 'receive') return pathname === '/receive'
  if (item === 'nfts') return pathname === '/nfts'
  return morePaths.has(pathname) || pathname.startsWith('/multisig/')
}
