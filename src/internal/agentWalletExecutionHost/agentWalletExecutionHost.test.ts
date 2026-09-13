/**
 * @file agentWalletExecutionHost.test.ts
 *
 * TESTS FOR TRUSTED WALLET UI EXECUTION HOST BOOTSTRAP (Gate C2)
 */

import { describe, expect, it, vi } from 'vitest'
import './trustedWalletExecutionRuntime'
import * as HostBarrel from './index'
import * as PublicBarrel from '../../features/agentWalletExecution'
import type { WalletExecutionComposition } from './types'
import type {
  AgentWalletExecutionEngineConfig,
  WalletExecutionTrustedOptions
} from '../../features/agentWalletExecution/types'
import { MockStorage, TestExecutionLockCoordinator } from '../../features/agentWalletExecution/testUtils'
import { DurableTransactionalExecutionLedger } from '../../features/agentWalletExecution/ledger'

const createWalletExecutionComposition = (
  config: AgentWalletExecutionEngineConfig,
  trusted?: WalletExecutionTrustedOptions
): WalletExecutionComposition => {
  const factory = (globalThis as Record<symbol, unknown>)[
    Symbol.for('rmzwallet.testOnly.createWalletExecutionComposition')
  ]
  if (typeof factory !== 'function') {
    throw new Error('Test-only composition factory is not registered.')
  }
  return (factory as typeof createWalletExecutionComposition)(config, trusted)
}

describe('Trusted Wallet UI Execution Host (src/internal/agentWalletExecutionHost)', () => {
  it('does not export createWalletExecutionComposition from the host barrel or public barrel', () => {
    expect((HostBarrel as { createWalletExecutionComposition?: unknown }).createWalletExecutionComposition)
      .toBeUndefined()
    expect((PublicBarrel as { createWalletExecutionComposition?: unknown }).createWalletExecutionComposition)
      .toBeUndefined()
    expect((PublicBarrel as { WalletExecutionComposition?: unknown }).WalletExecutionComposition).toBeUndefined()
    expect((PublicBarrel as { WalletExecutionUIHost?: unknown }).WalletExecutionUIHost).toBeUndefined()
    expect((PublicBarrel as { WalletLocalConfirmationController?: unknown }).WalletLocalConfirmationController)
      .toBeUndefined()
  })

  it('delivers local confirmation controller exclusively to walletUIHost listener', async () => {
    const storage = new MockStorage()
    const lockCoordinator = new TestExecutionLockCoordinator()
    const executionLedger = new DurableTransactionalExecutionLedger({ storage, lockCoordinator })

    const dummyConfig: AgentWalletExecutionEngineConfig = {
      approvalLedger: {
        get: vi.fn(),
        getByApprovalId: vi.fn()
      },
      executionLedger,
      sessionVerifier: {
        verifyActiveSession: vi.fn().mockResolvedValue({
          authenticated: true,
          activeAddress: 'ecash:qpumqqygwcnt999fz3gp5nxjy66ckg6esvxaqmtclv'
        })
      },
      utxoProvider: {
        getSpendableUtxos: vi.fn().mockResolvedValue([])
      },
      signatoryProvider: {
        getSignatory: vi.fn()
      },
      storage,
      lockCoordinator
    }

    const composition = createWalletExecutionComposition(dummyConfig)

    expect((composition.publicEngine as { walletUIHost?: unknown }).walletUIHost).toBeUndefined()
    expect((composition.publicEngine as { getActiveController?: unknown }).getActiveController).toBeUndefined()
    expect((composition.publicEngine as { confirm?: unknown }).confirm).toBeUndefined()
    expect((composition.publicEngine as { sign?: unknown }).sign).toBeUndefined()
    expect((composition.publicEngine as { dispose?: unknown }).dispose).toBeUndefined()

    expect(typeof composition.walletUIHost.onSessionPrepared).toBe('function')
    expect(typeof composition.walletUIHost.getActiveController).toBe('function')
    expect(composition.walletUIHost.getActiveController()).toBeUndefined()
    expect(typeof composition.dispose).toBe('function')
  })
})
