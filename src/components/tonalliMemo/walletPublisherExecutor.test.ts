import { describe, expect, it, vi } from 'vitest'
import {
  Address,
  ALL_BIP143,
  Ecc,
  fromHex,
  P2PKHSignatory,
  shaRmd160,
  Tx
} from 'ecash-lib'
import type { ScriptUtxo } from 'chronik-client'
import {
  ChronikNetworkTransport,
  WalletPublisherExecutor,
  WalletSigner,
  createWalletPublisherExecutor
} from './walletPublisherExecutor'

const ecc = new Ecc()
const testSk = fromHex('11'.repeat(32))
const testPk = ecc.derivePubkey(testSk)
const testAddress = Address.p2pkh(shaRmd160(testPk)).toString()
const testSignatory = P2PKHSignatory(testSk, testPk, ALL_BIP143)
const testUtxos: ScriptUtxo[] = [
  {
    outpoint: {
      txid: '22'.repeat(32),
      outIdx: 0
    },
    blockHeight: 800000,
    sats: 100000n,
    isCoinbase: false,
    isFinal: true
  }
]

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
    it('builds real eCash transaction with OP_RETURN payload and serializes rawTxBytes to hex', async () => {
      const signer = new WalletSigner({
        address: testAddress,
        signatory: testSignatory,
        utxos: testUtxos
      })
      expect(signer.address).toBe(testAddress)

      const result = await signer.sign({ message: 'tonalli test memo' })
      expect(typeof result.rawTxBytes).toBe('string')
      expect(result.rawTxBytes).toMatch(/^[0-9a-fA-F]+$/)
      expect(result.rawTxHex).toBe(result.rawTxBytes)
      expect(result.signatureHex).toBe(result.rawTxBytes)

      // Deserialize and verify structure using ecash-lib
      const deserialized = Tx.deser(fromHex(result.rawTxBytes))
      expect(deserialized.outputs.length).toBe(2)
      expect(deserialized.outputs[0].sats).toBe(0n)
      // Output 0 must be TM1 OP_RETURN (starts with 0x6a)
      expect(deserialized.outputs[0].script.toHex()).toMatch(/^6a/)
      // Output 1 is change to sender address with deducted fee
      expect(deserialized.outputs[1].sats).toBeGreaterThan(0n)
      expect(deserialized.outputs[1].sats).toBeLessThan(100000n)
      expect(result.txid).toBe(deserialized.txid())
    })

    it('throws INSUFFICIENT_FUNDS when spendable UTXOs are empty', async () => {
      const signer = new WalletSigner({
        address: testAddress,
        signatory: testSignatory,
        utxos: []
      })
      await expect(signer.sign({ message: 'test' })).rejects.toThrow(/INSUFFICIENT_FUNDS/)
    })

    it('uses custom signing delegate if provided', async () => {
      const customSign = vi.fn().mockResolvedValue({
        signedArtifact: { custom: true },
        signatureHex: 'deadbeef',
        rawTxBytes: 'deadbeef',
        rawTxHex: 'deadbeef',
        txid: 'custom-txid-123'
      })
      const signer = new WalletSigner({ signCandidate: customSign })

      const result = await signer.sign({ input: 'data' })
      expect(result.signatureHex).toBe('deadbeef')
      expect(result.rawTxBytes).toBe('deadbeef')
      expect(result.txid).toBe('custom-txid-123')
      expect(customSign).toHaveBeenCalledWith({ input: 'data' }, undefined)
    })
  })

  describe('WalletPublisherExecutor workflow', () => {
    it('executes full 4-phase publish pipeline with custom transport and signer', async () => {
      const mockChronik = {
        broadcastTx: vi.fn().mockResolvedValue({ txid: 'tx-broadcasted-success' })
      }
      const transport = new ChronikNetworkTransport({ chronik: mockChronik as never })
      const signer = new WalletSigner({
        address: testAddress,
        signatory: testSignatory,
        utxos: testUtxos
      })

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
        testAddress
      )
      expect(evidence).toEqual({ verified: true, evidenceToken: 'token-abc' })
      expect(mockVerificationPort.verifyAliasOwnership).toHaveBeenCalledWith(
        { alias: 'alice.xec', expectedOwnerAddress: testAddress },
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
      expect(signedReview).toHaveProperty('rawTxBytes')
      expect(typeof (signedReview as { rawTxBytes: string }).rawTxBytes).toBe('string')
      expect((signedReview as { rawTxBytes: string }).rawTxBytes).toMatch(/^[0-9a-fA-F]+$/)

      // Verify that rawTxBytes deserializes to valid eCash transaction with OP_RETURN
      const deserTx = Tx.deser(fromHex((signedReview as { rawTxBytes: string }).rawTxBytes))
      expect(deserTx.outputs[0].sats).toBe(0n)
      expect(deserTx.outputs[0].script.toHex()).toBe(
        (preparedReview as { preview: { scriptHex: string } }).preview.scriptHex
      )
      expect((signedReview as { txid: string }).txid).toBe(deserTx.txid())

      // 4. Broadcast and finalize
      const dispatchResult = await executor.broadcastAndFinalize(preparedReview, signedReview)
      expect(dispatchResult.txid).toBe('tx-broadcasted-success')
      expect(mockRecoveryStore.commitDispatchIntent).toHaveBeenCalled()
      expect(mockRecoveryStore.commitTransportAcknowledgement).toHaveBeenCalled()
      expect(mockChronik.broadcastTx).toHaveBeenCalledWith(
        fromHex((signedReview as { rawTxBytes: string }).rawTxBytes)
      )
    })
  })
})
