/**
 * @file engine.ts
 *
 * CANONICAL AGENT-FACING WALLET EXECUTION ENGINE ENTRY (Gate C2)
 *
 * createWalletExecutionComposition is NOT exported from this module.
 * The trusted composition factory is file-local to the Wallet bootstrap:
 * src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.tsx
 *
 * This module exposes createAgentWalletExecutionEngine, which returns
 * DisposableAgentWalletExecutionEngine (prepareExecution, getExecutionStatus, settle, dispose).
 * The returned factory handle may dispose ONLY its own composition and lifecycle retries.
 * It never returns walletUIHost, controller, private settlement storage, settlement mutators,
 * Chronik, lock coordinator, raw tx, or signing authority.
 *
 * TrustedWalletExecutionProvider exposes the canonical AgentWalletExecutionEngine
 * WITHOUT dispose() through the React Agent-facing context.
 *
 * Settlement persistence uses trusted?.privateSettlementStorage only inside the
 * unexported test factory. Production bootstrap instantiates private settlement
 * storage in a file-local closure and NEVER accepts it from callers.
 * config.storage is NEVER used for raw signed transactions.
 */

export { createAgentWalletExecutionEngine } from '../../internal/agentWalletExecutionHost/trustedWalletExecutionRuntime'
export type { DisposableAgentWalletExecutionEngine } from './types'

