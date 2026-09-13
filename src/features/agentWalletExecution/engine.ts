/**
 * @file engine.ts
 *
 * CANONICAL AGENT-FACING WALLET EXECUTION ENGINE ENTRY (Gate C2)
 *
 * createWalletExecutionComposition is NOT exported from this module.
 * The trusted composition factory is file-local to the Wallet bootstrap:
 * src/internal/agentWalletExecutionHost/trustedWalletExecutionRuntime.ts
 *
 * This module exposes ONLY createAgentWalletExecutionEngine, which returns
 * AgentWalletExecutionEngine (prepare/status). It never returns walletUIHost,
 * controller, dispose, or private settlement storage.
 *
 * Settlement persistence uses trusted?.privateSettlementStorage and NEVER
 * config.storage. Raw signed transactions are write-once inside the trusted
 * bootstrap closure.
 */

export { createAgentWalletExecutionEngine } from '../../internal/agentWalletExecutionHost/trustedWalletExecutionRuntime'
