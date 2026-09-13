/**
 * @file TrustedWalletExecutionProvider.tsx
 *
 * Re-export of the trusted Wallet bootstrap. Composition construction is
 * file-local inside trustedWalletExecutionRuntime.tsx and is NOT exported.
 */

export {
  TrustedWalletExecutionProvider,
  resetTrustedExecutionShellForTests
} from './trustedWalletExecutionRuntime'
export type { TrustedWalletExecutionProviderProps } from './trustedWalletExecutionRuntime'
