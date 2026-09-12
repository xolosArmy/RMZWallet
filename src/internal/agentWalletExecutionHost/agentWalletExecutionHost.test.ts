/**
 * @file agentWalletExecutionHost.test.ts
 *
 * TESTS FOR TRUSTED WALLET UI EXECUTION HOST BOOTSTRAP (Gate C2)
 */

import { describe, expect, it, vi } from 'vitest'
import { createWalletExecutionComposition } from './index'
import * as PublicBarrel from '../../features/agentWalletExecution'
import { MockStorage, TestExecutionLockCoordinator } from '../../features/agentWalletExecution/testUtils'
import { DurableTransactionalExecutionLedger } from '../../features/agentWalletExecution/ledger'

describe('Trusted Wallet UI Execution Host (src/internal/agentWalletExecutionHost)', () => {
  it('confirms createWalletExecutionComposition is available from internal host but NOT from public barrel', () => {
    expect(typeof createWalletExecutionComposition).toBe('function')
    expect((PublicBarrel as any).createWalletExecutionComposition).toBeUndefined()
    expect((PublicBarrel as any).WalletExecutionComposition).toBeUndefined()
    expect((PublicBarrel as any).WalletExecutionUIHost).toBeUndefined()
    expect((PublicBarrel as any).WalletLocalConfirmationController).toBeUndefined()
  })

  it('delivers local confirmation controller exclusively to walletUIHost listener', async () => {
    const storage = new MockStorage()
    const lockCoordinator = new TestExecutionLockCoordinator()
    const executionLedger = new DurableTransactionalExecutionLedger({ storage, lockCoordinator })

    const dummyConfig: any = {
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
      storage
    }

    const composition = createWalletExecutionComposition(dummyConfig)

    // Public engine has NO controller accessors or confirm/sign methods
    expect((composition.publicEngine as any).walletUIHost).toBeUndefined()
    expect((composition.publicEngine as any).getActiveController).toBeUndefined()
    expect((composition.publicEngine as any).confirm).toBeUndefined()
    expect((composition.publicEngine as any).sign).toBeUndefined()

    // Host provides onSessionPrepared and getActiveController
    expect(typeof composition.walletUIHost.onSessionPrepared).toBe('function')
    expect(typeof composition.walletUIHost.getActiveController).toBe('function')
    expect(composition.walletUIHost.getActiveController()).toBeUndefined()
  })
})
