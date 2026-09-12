/**
 * @file index.ts (src/internal/agentWalletExecutionHost/index.ts)
 *
 * TRUSTED WALLET UI EXECUTION HOST BOOTSTRAP (Gate C2)
 *
 * Architectural Boundary:
 * - Strictly internal to the RMZWallet application shell.
 * - Imports engine internals to construct the dual composition:
 *     1. publicEngine: Exposed to Agents/protocols (lacks confirm, sign, execute, controller access).
 *     2. walletUIHost: Confined to trusted Wallet UI modal to receive local confirmation authority.
 * - Public agentWalletExecution barrel NEVER exports this module or its capabilities.
 */

export { createWalletExecutionComposition } from '../../features/agentWalletExecution/engine'
export type {
  WalletLocalConfirmationController,
  WalletExecutionUIHost,
  WalletExecutionComposition
} from './types'
