/**
 * @file index.ts (src/internal/agentWalletExecutionHost/index.ts)
 *
 * TRUSTED WALLET UI EXECUTION HOST BOOTSTRAP (Gate C2)
 *
 * Architectural Boundary:
 * - Strictly internal to the RMZWallet application shell.
 * - createWalletExecutionComposition is NOT exported from this barrel,
 *   engine.ts, or any generic internal barrel.
 * - Agent/public code receives ONLY publicEngine via TrustedWalletExecutionContext.
 */

export type {
  WalletLocalConfirmationController,
  WalletExecutionUIHost,
  WalletExecutionComposition
} from './types'
export {
  TrustedWalletExecutionProvider,
  resetTrustedExecutionShellForTests
} from './TrustedWalletExecutionProvider'
export type { TrustedWalletExecutionProviderProps } from './TrustedWalletExecutionProvider'
export {
  TrustedWalletExecutionContext,
  useTrustedWalletExecution
} from './TrustedWalletExecutionContext'
export type { TrustedWalletExecutionContextValue } from './TrustedWalletExecutionContext'
export { TrustedGate2bToC2Bridge } from './TrustedGate2bToC2Bridge'
export { createProductionWalletRuntime } from './productionWalletAdapters'
export type { ProductionWalletRuntime } from './productionWalletAdapters'
export { DurableWalletApprovalLedger } from './durableWalletApprovalLedger'
