/**
 * @file index.ts (src/internal/settlementStore/index.ts)
 *
 * CANONICAL WALLET-INTERNAL SETTLEMENT STORE (Gate C2 -> C3 Bridge)
 *
 * Scope & Security Model:
 * - Module-private persistence holding raw signed transactions for Gate C3 settlement.
 * - Confined exclusively to trusted Wallet application bootstrap and settlement flows.
 * - NEVER exported from features/agentWalletExecution or its public barrel index.ts.
 * - Deep imports into features/agentWalletExecution cannot discover or invoke this store.
 *
 * Threat Model & Residual Risk Disclaimer:
 * - In a browser client environment sharing the same Web origin, all scripts executing within
 *   the origin have technical access to window.localStorage.
 * - This module provides strict API and module-boundary isolation (preventing Agent-level,
 *   library-level, and accidental consumption of raw signed transaction bytes).
 * - Cryptographic or process-level isolation is NOT claimed: an attacker with arbitrary same-origin
 *   script execution (XSS) retains read access to raw Web Storage strings.
 */

export const DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY = 'rmzwallet_internal_settlement_v2'

const inMemoryFallbackStore = new Map<string, string>()

/**
 * Stores a raw signed transaction hex payload within the private settlement store.
 * Strictly internal to Wallet signing execution pipeline.
 */
export async function storeInternalSignedTransaction(
  executionId: string,
  rawSignedTxHex: string,
  storage?: Storage
): Promise<void> {
  const targetStorage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!targetStorage) {
    inMemoryFallbackStore.set(executionId, rawSignedTxHex)
    return
  }
  try {
    const raw = targetStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
    const store: Record<string, string> = raw ? JSON.parse(raw) : {}
    store[executionId] = rawSignedTxHex
    targetStorage.setItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY, JSON.stringify(store))
  } catch (err) {
    throw new Error(
      `Failed to store settlement transaction: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

/**
 * Retrieves a raw signed transaction hex payload for Gate C3 settlement.
 * Strictly internal to Wallet settlement bootstrap.
 */
export async function getInternalSignedTransaction(
  executionId: string,
  storage?: Storage
): Promise<string | undefined> {
  const targetStorage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!targetStorage) {
    return inMemoryFallbackStore.get(executionId)
  }
  try {
    const raw = targetStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
    if (!raw) return undefined
    const store = JSON.parse(raw) as Record<string, string>
    return store[executionId]
  } catch {
    return undefined
  }
}

/**
 * Clears the internal settlement store. Strictly for test cleanup and wallet reset.
 */
export async function clearInternalSettlementStore(storage?: Storage): Promise<void> {
  inMemoryFallbackStore.clear()
  const targetStorage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  targetStorage?.removeItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
}
