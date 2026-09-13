/**
 * @file productionWalletAdapters.ts
 *
 * Real production Gate 2B / Gate C2 adapters constructed from RMZWallet services.
 * No permissive empty or throwing placeholder defaults.
 */

import { Script, toHex } from 'ecash-lib'
import { DurableWalletApprovalLedger } from './durableWalletApprovalLedger'
import type { WalletApprovalLedger } from '../../features/agentWalletApprovalReceiver/types'
import type {
  AgentWalletExecutionEngineConfig,
  WalletSignatoryProvider,
  WalletUtxoProvider
} from '../../features/agentWalletExecution/types'
import { WalletExecutionError } from '../../features/agentWalletExecution/errors'
import { getChronik } from '../../services/ChronikClient'
import { xolosWalletService } from '../../services/XolosWalletService'

export interface ProductionWalletRuntime {
  readonly approvalLedger: WalletApprovalLedger
  readonly sessionVerifier: AgentWalletExecutionEngineConfig['sessionVerifier']
  readonly utxoProvider: WalletUtxoProvider
  readonly signatoryProvider: WalletSignatoryProvider
  readonly ledgerStorage: Storage
  readonly trustedSettlementStorage: Storage
}

export function createProductionSessionVerifier(): AgentWalletExecutionEngineConfig['sessionVerifier'] {
  return {
    async verifyActiveSession() {
      const activeAddress = xolosWalletService.getAddress()
      if (!activeAddress) {
        return { authenticated: false, error: 'Wallet is locked or no active address found.' }
      }
      return { authenticated: true, activeAddress }
    }
  }
}

export function createProductionUtxoProvider(): WalletUtxoProvider {
  return {
    async getSpendableUtxos(address: string) {
      const scriptHex = toHex(Script.fromAddress(address).bytecode)
      const result = await getChronik().address(address).utxos()
      return result.utxos
        .filter(utxo => !utxo.token)
        .map(utxo => ({
          txid: String(utxo.outpoint.txid),
          outIdx: Number(utxo.outpoint.outIdx),
          sats: BigInt(utxo.sats),
          lockingScriptHex: scriptHex
        }))
    }
  }
}

export function createProductionSignatoryProvider(): WalletSignatoryProvider {
  return {
    async getSignatory(address: string) {
      const activeAddress = xolosWalletService.getAddress()
      if (!activeAddress) {
        throw new WalletExecutionError(
          'SESSION_REVALIDATION_FAILED',
          'Wallet is locked; production signatory refuses to mint a placeholder.'
        )
      }
      if (activeAddress !== address) {
        throw new WalletExecutionError(
          'SESSION_ADDRESS_MISMATCH',
          `Active wallet address "${activeAddress}" does not match requested signatory address "${address}".`
        )
      }
      return xolosWalletService.getSignatory()
    }
  }
}

/**
 * Construct the shared production Wallet runtime.
 * Returns null when required durable dependencies cannot be constructed (fail closed).
 */
export function createProductionWalletRuntime(): ProductionWalletRuntime | null {
  const storage = typeof localStorage !== 'undefined' ? localStorage : undefined
  if (!storage) {
    return null
  }
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    return null
  }
  try {
    const approvalLedger = new DurableWalletApprovalLedger({ storage })
    return {
      approvalLedger,
      sessionVerifier: createProductionSessionVerifier(),
      utxoProvider: createProductionUtxoProvider(),
      signatoryProvider: createProductionSignatoryProvider(),
      ledgerStorage: storage,
      trustedSettlementStorage: storage
    }
  } catch {
    return null
  }
}
