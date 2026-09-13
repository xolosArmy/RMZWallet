/**
 * @file productionWalletAdapters.ts
 *
 * Real production Gate 2B / Gate C2 adapters constructed from RMZWallet services.
 * No permissive empty or throwing placeholder defaults.
 *
 * This module MUST NOT create, return, or export a Wallet signatory, signing
 * provider, or any function capable of yielding one.
 */

import { Script, toHex } from 'ecash-lib'
import { DurableWalletApprovalLedger } from './durableWalletApprovalLedger'
import type { WalletApprovalLedger } from '../../features/agentWalletApprovalReceiver/types'
import type {
  AgentWalletExecutionEngineConfig,
  ExecutionUtxoInput,
  WalletUtxoProvider
} from '../../features/agentWalletExecution/types'
import { getChronik } from '../../services/ChronikClient'
import { xolosWalletService } from '../../services/XolosWalletService'
import { isImmatureCoinbaseUtxo } from '../../services/coinbaseMaturity'

export interface ProductionWalletRuntime {
  readonly approvalLedger: WalletApprovalLedger
  readonly sessionVerifier: AgentWalletExecutionEngineConfig['sessionVerifier']
  readonly utxoProvider: WalletUtxoProvider
  readonly ledgerStorage: Storage
}

export interface ProductionChronikUtxoLike {
  readonly outpoint: { readonly txid: string; readonly outIdx: number }
  readonly sats: number | bigint | string
  readonly token?: unknown
  readonly isCoinbase?: boolean
  readonly blockHeight?: number
}

export function selectSpendableXecUtxosForExecution(
  utxos: readonly ProductionChronikUtxoLike[],
  lockingScriptHex: string,
  tipHeight: number | undefined
): ExecutionUtxoInput[] {
  return utxos
    .filter(utxo => !utxo.token)
    .filter(utxo => !isImmatureCoinbaseUtxo(utxo, tipHeight))
    .map(utxo => ({
      txid: String(utxo.outpoint.txid),
      outIdx: Number(utxo.outpoint.outIdx),
      sats: BigInt(utxo.sats),
      lockingScriptHex
    }))
}

export async function resolveCanonicalTipHeight(
  blockchainInfo: () => Promise<{ tipHeight?: number }>
): Promise<number | undefined> {
  try {
    const info = await blockchainInfo()
    return typeof info?.tipHeight === 'number' ? info.tipHeight : undefined
  } catch {
    return undefined
  }
}

function createProductionSessionVerifier(): AgentWalletExecutionEngineConfig['sessionVerifier'] {
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

function createProductionUtxoProvider(): WalletUtxoProvider {
  return {
    async getSpendableUtxos(address: string) {
      const scriptHex = toHex(Script.fromAddress(address).bytecode)
      const result = await getChronik().address(address).utxos()
      const hasCoinbase = result.utxos.some(utxo => Boolean(utxo.isCoinbase))
      let tipHeight: number | undefined
      if (hasCoinbase) {
        tipHeight = await resolveCanonicalTipHeight(() => getChronik().blockchainInfo())
      }
      return selectSpendableXecUtxosForExecution(result.utxos, scriptHex, tipHeight)
    }
  }
}

/**
 * Construct the shared production Wallet runtime.
 * Returns null when required durable dependencies cannot be constructed (fail closed).
 *
 * NEVER returns a signatory, signing provider, walletUIHost, controller,
 * private settlement storage, or raw-tx accessor.
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
      ledgerStorage: storage
    }
  } catch {
    return null
  }
}
