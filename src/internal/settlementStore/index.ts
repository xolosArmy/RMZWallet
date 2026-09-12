/**
 * @file index.ts (src/internal/settlementStore/index.ts)
 *
 * CANONICAL WALLET-INTERNAL SETTLEMENT STORE (Gate C2 write-only persistence)
 *
 * Gate C2 scope:
 * - C2 MAY persist a verified raw signed transaction under an opaque executionId.
 * - C2 returns ONLY SignedExecutionHandle.
 * - C2 SHALL HAVE NO raw-transaction retrieval API.
 * - Trusted retrieval is Gate C3 work. This module is write-only for Gate C2.
 *
 * Threat Model & Residual Risk Disclaimer:
 * - Persistence uses Web Storage (localStorage by default) for durability across reloads.
 * - localStorage provides persistence but NOT same-origin/XSS isolation.
 * - Cryptographic or process-level isolation is NOT claimed: an attacker with arbitrary
 *   same-origin script execution (XSS) retains read access to raw Web Storage strings.
 * - Cross-tab lost updates are prevented by the same production security model as the
 *   execution ledger: navigator.locks.request exclusive lock. No in-memory lock fallback.
 * - If Web Locks are unavailable, persistence fails closed.
 */

import { WalletExecutionError } from '../../features/agentWalletExecution/errors'
import {
  WebLocksExecutionCoordinator,
  type ExecutionLockCoordinator
} from '../../features/agentWalletExecution/ledger'

export const DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY = 'rmzwallet_internal_settlement_v2'
export const DEFAULT_SETTLEMENT_STORE_LOCK_NAME = 'rmzwallet:internal-settlement:lock:v2'

export interface SettlementStoreWriteOptions {
  readonly storage?: Storage
  readonly lockCoordinator?: ExecutionLockCoordinator
}

function resolveStorage(storage?: Storage): Storage {
  const targetStorage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!targetStorage) {
    throw new WalletExecutionError(
      'STORAGE_UNAVAILABLE',
      'No durable settlement storage available. Raw signed transactions cannot be persisted.'
    )
  }
  return targetStorage
}

function resolveCoordinator(lockCoordinator?: ExecutionLockCoordinator): ExecutionLockCoordinator {
  return lockCoordinator ?? new WebLocksExecutionCoordinator()
}

function readStoreObject(targetStorage: Storage): Record<string, string> {
  const raw = targetStorage.getItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
  if (!raw) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new WalletExecutionError(
      'STORAGE_MUTATION_FAILED',
      `Failed to parse settlement store payload: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WalletExecutionError(
      'STORAGE_MUTATION_FAILED',
      'Settlement store payload is not a JSON object.'
    )
  }
  return parsed as Record<string, string>
}

/**
 * Stores a verified raw signed transaction hex payload.
 * Write-only. No corresponding C2 retrieval function exists.
 *
 * Cross-tab exclusive lock is mandatory. There is no automatic in-memory lock fallback.
 */
export async function storeInternalSignedTransaction(
  executionId: string,
  rawSignedTxHex: string,
  storageOrOptions?: Storage | SettlementStoreWriteOptions,
  lockCoordinatorArg?: ExecutionLockCoordinator
): Promise<void> {
  const options: SettlementStoreWriteOptions =
    storageOrOptions !== undefined &&
    typeof storageOrOptions === 'object' &&
    !('getItem' in storageOrOptions)
      ? storageOrOptions
      : {
          storage: storageOrOptions as Storage | undefined,
          lockCoordinator: lockCoordinatorArg
        }

  const targetStorage = resolveStorage(options.storage)
  const coordinator = resolveCoordinator(options.lockCoordinator)

  await coordinator.requestExclusive(DEFAULT_SETTLEMENT_STORE_LOCK_NAME, async () => {
    const store = readStoreObject(targetStorage)
    store[executionId] = rawSignedTxHex
    try {
      targetStorage.setItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY, JSON.stringify(store))
    } catch (err) {
      throw new WalletExecutionError(
        'STORAGE_MUTATION_FAILED',
        `Failed to store settlement transaction: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  })
}

/**
 * Clears the internal settlement store. Strictly for test cleanup and wallet reset.
 * This is not a raw-transaction retrieval API.
 */
export async function clearInternalSettlementStore(
  storage?: Storage,
  lockCoordinator?: ExecutionLockCoordinator
): Promise<void> {
  const targetStorage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined)
  if (!targetStorage) {
    return
  }
  const coordinator = resolveCoordinator(lockCoordinator)
  await coordinator.requestExclusive(DEFAULT_SETTLEMENT_STORE_LOCK_NAME, async () => {
    targetStorage.removeItem(DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY)
  })
}
