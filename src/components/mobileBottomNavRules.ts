import {
  hiddenWalletNavigationPaths,
  isWalletNavigationActive,
  isWalletNavigationHidden
} from './walletNavigation'
import type { WalletNavigationItemId } from './walletNavigation'

export const hiddenMobileBottomNavPaths = hiddenWalletNavigationPaths

export function isMobileBottomNavHidden(pathname: string) {
  return isWalletNavigationHidden(pathname)
}

export function isMobileBottomNavActive(item: WalletNavigationItemId, pathname: string) {
  return isWalletNavigationActive(item, pathname)
}
