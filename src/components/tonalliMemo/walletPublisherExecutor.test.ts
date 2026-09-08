import { describe, expect, it, vi } from 'vitest'
import {
  ChronikNetworkTransport,
  WalletPublisherExecutor,
  WalletSigner,
  createWalletPublisherExecutor
} from './walletPublisherExecutor'

describe('walletPublisherExecutor components', () => {
  describe('ChronikNetworkTransport', () => {
    it('broadcasts raw transaction to chronik and returns txid', async () => {
      const mockChronik = {
        broadcastTx: vi.fn().mockResolvedValue({ txid: 'mock-txid-12345' })
      }
      const transport = new ChronikNetworkTransport({ chronik: mockChronik as never })

      const result = await transport.broadcast(new Uint8Array([0x01, 0x02, 0x03]))
      expect(result.txid).toBe('mock-txid-12345')
      expect(mockChronik.broadcastTx).toHaveBeenCalledWith(new Uint8Array([0x01, 0x02, 0x03]))
    })

    it('rejects when signal is already aborted', async () => {
      const mockChronik = {
        broadcastTx: vi.fn()
      }
      const transport = new ChronikNetworkTransport({ chronik: mockChronik as never })

      const controller = new AbortController()
      controller.abort()

      await expect(transport.broadcast(new Uint8Array([0x01]), controller.signal)).rejects.toThrow(
        'OPERATION_ABORTED'
      )
      expect(mockChronik.broadcastTx).not.toHaveBeenCalled()
    })
  })

  describe('WalletSigner', () => {
    it('signs candidate review and returns default signature when no custom signer provided', async () => {
      const signer = new WalletSigner({ address: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq' })
      expect(signer.address).toBe('ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq')

      const result = await signer.sign({ message: 'test' })
      expect(result.signedArtifact).toEqual({ message: 'test' })
      expect(result.signatureHex).toBe('00'.repeat(64))
    })

    it('uses custom signing delegate if provided', async () => {
      const customSign = vi.fn().mockResolvedValue({
        signedArtifact: { custom: true },
        signatureHex: 'deadbeef'
      })
      const signer = new WalletSigner({ signCandidate: customSign })

      const result = await signer.sign({ input: 'data' })
      expect(result.signatureHex).toBe('deadbeef')
      expect(customSign).toHaveBeenCalledWith({ input: 'data' }, undefined)
    })
  })

  describe('WalletPublisherExecutor workflow', () => {
    it('executes full 4-phase publish pipeline with custom transport and signer', async () => {
      const mockChronik = {
        broadcastTx: vi.fn().mockResolvedValue({ txid: 'tx-broadcasted-success' })
      }
      const transport = new ChronikNetworkTransport({ chronik: mockChronik as never })
      const signer = new WalletSigner({ address: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq' })

      const mockVerificationPort = {
        verifyAliasOwnership: vi.fn().mockResolvedValue({
          verified: true,
          evidenceToken: 'token-abc'
        })
      }
      const mockAuthorizer = {
        authorizePublication: vi.fn().mockResolvedValue({
          authorized: true,
          authToken: 'auth-123'
        })
      }
      const mockRecoveryStore = {
        load: vi.fn(),
        listRecoverable: vi.fn(),
        create: vi.fn(),
        commitExecutionEvidence: vi.fn(),
        commitDispatchIntent: vi.fn().mockResolvedValue({}),
        commitTransportAcknowledgement: vi.fn().mockResolvedValue({}),
        commitRecoveryTransition: vi.fn(),
        claimOwnership: vi.fn()
      }

      const executor = new WalletPublisherExecutor({
        transport,
        signer,
        verificationPort: mockVerificationPort,
        authorizer: mockAuthorizer,
        recoveryStore: mockRecoveryStore as never
      })

      // Also verify createWalletPublisherExecutor helper creates an instance
      const factoryCreated = createWalletPublisherExecutor({ transport, signer })
      expect(factoryCreated).toBeInstanceOf(WalletPublisherExecutor)

      // 1. Verify ownership
      const evidence = await executor.verifyOwnership(
        'alice.xec',
        'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq'
      )
      expect(evidence).toEqual({ verified: true, evidenceToken: 'token-abc' })
      expect(mockVerificationPort.verifyAliasOwnership).toHaveBeenCalledWith(
        { alias: 'alice.xec', expectedOwnerAddress: 'ecash:qp63uahgrxged4z5jswyt5dn5v3lzsem6cacy2kzvq' },
        undefined
      )

      // 2. Request authorization
      const auth = await executor.requestAuthorization(evidence)
      expect(auth).toEqual({ authorized: true, authToken: 'auth-123' })
      expect(mockAuthorizer.authorizePublication).toHaveBeenCalledWith(
        { verifiedAliasEvidenceToken: evidence },
        undefined
      )

      // 3. Prepare and sign
      const { preparedReview, signedReview } = await executor.prepareAndSign(auth, 'Test Memo')
      expect(preparedReview).toHaveProperty('preparedId')
      expect(signedReview).toHaveProperty('preparedId')
      expect(signedReview).toHaveProperty('signature')

      // 4. Broadcast and finalize
      const dispatchResult = await executor.broadcastAndFinalize(preparedReview, signedReview)
      expect(dispatchResult.txid).toBe('tx-broadcasted-success')
      expect(mockRecoveryStore.commitDispatchIntent).toHaveBeenCalled()
      expect(mockRecoveryStore.commitTransportAcknowledgement).toHaveBeenCalled()
      expect(mockChronik.broadcastTx).toHaveBeenCalled()
    })
  })
})
