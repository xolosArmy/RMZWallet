/**
 * @file index.ts (src/internal/settlementStore/index.ts)
 *
 * Gate C2 settlement persistence constants and threat-model documentation.
 *
 * C2 SHALL NOT export a raw-transaction writer or reader.
 * The write-once persist path is closure-private to the trusted Wallet bootstrap
 * (trustedWalletExecutionRuntime.tsx). Trusted retrieval belongs to Gate C3.
 *
 * This module exports only storage/lock names so tests can inspect the durable
 * payload. It does NOT export:
 *   storeInternalSignedTransaction
 *   writeSignedTransaction
 *   putSettlementArtifact
 *   replaceSettlementArtifact
 *   getInternalSignedTransaction
 *   or any factory that yields a writer.
 *
 * Threat Model & Residual Risk Disclaimer:
 * - Persistence uses Web Storage (localStorage by default) for durability across reloads.
 * - localStorage provides persistence but NOT same-origin/XSS isolation.
 * - Same-origin arbitrary JavaScript/XSS can access browser storage.
 * - C2 claims API/module boundary isolation, not process, enclave, or cryptographic
 *   storage isolation.
 * - Do not claim that localStorage itself creates a security partition.
 * - Cross-tab lost updates for the private persist path are prevented by
 *   navigator.locks.request on DEFAULT_SETTLEMENT_STORE_LOCK_NAME.
 * - No in-memory lock fallback. Web Locks absence fails closed.
 *
 * Canonical lock ordering (see ledger.ts):
 *   per-execution review lock
 *   → per-execution signing lock
 *   → short global ledger lock
 *   → settlement-store lock when needed
 * Never wait for a review or signing lock while holding the ledger or settlement lock.
 * Never acquire signing lock then attempt review lock.
 */

export const DEFAULT_INTERNAL_SETTLEMENT_STORAGE_KEY = 'rmzwallet_internal_settlement_v2'
export const DEFAULT_SETTLEMENT_STORE_LOCK_NAME = 'rmzwallet:internal-settlement:lock:v2'
