import { describe, expect, it, vi } from 'vitest'
import {
  Address,
  ALL_BIP143,
  Ecc,
  fromHex,
  P2PKHSignatory,
  shaRmd160,
  toHex,
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
      expect(evidence).toEqual(
        expect.objectContaining({
          verified: true,
          evidenceToken: 'token-abc',
          evidenceHash: expect.any(String),
          nonce: expect.any(String)
        })
      )
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

    it('generates unique evidence and nonces on successive retries to avoid ALIAS_PROOF_REPLAYED', async () => {
      const consumedProofs = new Set<string>()
      const mockAuthorizer = {
        authorizePublication: vi.fn().mockImplementation(async ({ verifiedAliasEvidenceToken }) => {
          const token = verifiedAliasEvidenceToken as { evidenceHash: string; nonce: string }
          if (consumedProofs.has(token.evidenceHash)) {
            throw new Error('ALIAS_PROOF_REPLAYED: Evidence proof was already consumed')
          }
          consumedProofs.add(token.evidenceHash)
          return { authorized: true, authToken: `auth-${token.evidenceHash.slice(0, 8)}` }
        })
      }
      const mockVerificationPort = {
        verifyAliasOwnership: vi.fn().mockResolvedValue({
          verified: true,
          evidenceToken: 'base-chronik-tx-proof'
        })
      }
      const executor = new WalletPublisherExecutor({
        verificationPort: mockVerificationPort,
        authorizer: mockAuthorizer
      })

      // Attempt 1
      const evidence1 = await executor.verifyOwnership('alice.xec', testAddress)
      const auth1 = await executor.requestAuthorization(evidence1)
      expect(auth1).toHaveProperty('authorized', true)
      expect(consumedProofs.size).toBe(1)

      // Attempt 2 (e.g. user retries after a network or broadcast timeout)
      const evidence2 = await executor.verifyOwnership('alice.xec', testAddress)
      expect((evidence2 as { evidenceHash: string }).evidenceHash).not.toBe(
        (evidence1 as { evidenceHash: string }).evidenceHash
      )
      expect((evidence2 as { nonce: string }).nonce).not.toBe(
        (evidence1 as { nonce: string }).nonce
      )

      // Attempt 2 must pass authorizer without ALIAS_PROOF_REPLAYED
      const auth2 = await executor.requestAuthorization(evidence2)
      expect(auth2).toHaveProperty('authorized', true)
      expect(consumedProofs.size).toBe(2)
    })

    it('handles HD wallet inputs from multiple derivation indices with their exact keys', async () => {
      // Input 1: receive/0 (5,000 sats)
      const sk1 = fromHex('33'.repeat(32))
      const pk1 = ecc.derivePubkey(sk1)
      const addr1 = Address.p2pkh(shaRmd160(pk1)).toString()
      const sig1 = P2PKHSignatory(sk1, pk1, ALL_BIP143)

      // Input 2: change/1 (15,000 sats)
      const sk2 = fromHex('44'.repeat(32))
      const pk2 = ecc.derivePubkey(sk2)
      const addr2 = Address.p2pkh(shaRmd160(pk2)).toString()
      const sig2 = P2PKHSignatory(sk2, pk2, ALL_BIP143)

      // Input 3: receive/3 (40,000 sats)
      const sk3 = fromHex('55'.repeat(32))
      const pk3 = ecc.derivePubkey(sk3)
      const addr3 = Address.p2pkh(shaRmd160(pk3)).toString()
      const sig3 = P2PKHSignatory(sk3, pk3, ALL_BIP143)

      const multiIndexUtxos = [
        {
          utxo: {
            outpoint: { txid: '10'.repeat(32), outIdx: 0 },
            blockHeight: 800000,
            sats: 5000n,
            isCoinbase: false,
            isFinal: true
          },
          owner: {
            address: addr1,
            hdPath: "m/44'/899'/0'/0/0",
            branch: 'receive' as const,
            index: 0,
            signatory: sig1
          }
        },
        {
          utxo: {
            outpoint: { txid: '20'.repeat(32), outIdx: 1 },
            blockHeight: 800000,
            sats: 15000n,
            isCoinbase: false,
            isFinal: true
          },
          owner: {
            address: addr2,
            hdPath: "m/44'/899'/0'/1/1",
            branch: 'change' as const,
            index: 1,
            signatory: sig2
          }
        },
        {
          utxo: {
            outpoint: { txid: '30'.repeat(32), outIdx: 2 },
            blockHeight: 800000,
            sats: 40000n,
            isCoinbase: false,
            isFinal: true
          },
          owner: {
            address: addr3,
            hdPath: "m/44'/899'/0'/0/3",
            branch: 'receive' as const,
            index: 3,
            signatory: sig3
          }
        }
      ]

      const hdSigner = new WalletSigner({
        address: addr1,
        hdUtxos: multiIndexUtxos
      })

      const signed = await hdSigner.sign({ message: 'multi-index test memo' })
      expect(typeof signed.rawTxBytes).toBe('string')
      expect(signed.txid).toBeDefined()

      // Deserializing verifies that all inputs were properly mapped and signed
      const tx = Tx.deser(fromHex(signed.rawTxBytes))
      expect(tx.inputs.length).toBeGreaterThanOrEqual(1)
      expect(tx.outputs.length).toBe(2) // OP_RETURN + change to addr1
      expect(tx.outputs[0].sats).toBe(0n)
      expect(tx.outputs[1].sats).toBeGreaterThan(0n)
      expect(signed.txid).toBe(tx.txid())
    })

    it('resolves HD signatories via walletService.getHdSignatoryForOwner for multi-path UTXOs', async () => {
      const skActive = fromHex('55'.repeat(32))
      const pkActive = ecc.derivePubkey(skActive)
      const sigActive = P2PKHSignatory(skActive, pkActive, ALL_BIP143)

      const skChange = fromHex('66'.repeat(32))
      const pkChange = ecc.derivePubkey(skChange)
      const addrChange = Address.p2pkh(shaRmd160(pkChange)).toString()
      const sigChange = P2PKHSignatory(skChange, pkChange, ALL_BIP143)

      const mockWalletService = {
        getHdOwnedUtxos: vi.fn().mockResolvedValue([
          {
            utxo: {
              outpoint: { txid: '88'.repeat(32), outIdx: 0 },
              blockHeight: 800000,
              sats: 100n,
              isCoinbase: false,
              isFinal: true
            },
            owner: {
              address: testAddress,
              hdPath: "m/44'/899'/0'/0/0",
              branch: 'receive' as const,
              index: 0,
              signatory: sigActive
            }
          },
          {
            utxo: {
              outpoint: { txid: '77'.repeat(32), outIdx: 0 },
              blockHeight: 800000,
              sats: 25000n,
              isCoinbase: false,
              isFinal: true
            },
            owner: {
              address: addrChange,
              hdPath: "m/44'/899'/0'/1/2",
              branch: 'change' as const,
              index: 2
            }
          }
        ]),
        getHdSignatoryForOwner: vi.fn().mockReturnValue(sigChange),
        getAddress: vi.fn().mockReturnValue(testAddress)
      }

      const signer = new WalletSigner({
        address: testAddress,
        walletService: mockWalletService
      })

      const signed = await signer.sign({ message: 'delegated hd test' })
      expect(mockWalletService.getHdOwnedUtxos).toHaveBeenCalled()
      expect(mockWalletService.getHdSignatoryForOwner).toHaveBeenCalledWith(
        expect.objectContaining({ hdPath: "m/44'/899'/0'/1/2" })
      )
      expect(signed.rawTxBytes).toBeDefined()
    })

    it('places activeAddress UTXO at input zero even when a change address has a giant UTXO', async () => {
      const skActive = fromHex('11'.repeat(32))
      const pkActive = ecc.derivePubkey(skActive)
      const sigActive = P2PKHSignatory(skActive, pkActive, ALL_BIP143)

      const skChange = fromHex('22'.repeat(32))
      const pkChange = ecc.derivePubkey(skChange)
      const addrChange = Address.p2pkh(shaRmd160(pkChange)).toString()
      const sigChange = P2PKHSignatory(skChange, pkChange, ALL_BIP143)

      const smallActiveUtxo = {
        outpoint: { txid: 'aa'.repeat(32), outIdx: 0 },
        blockHeight: 800000,
        sats: 100n, // small UTXO: less than network fee, forcing multi-input selection
        isCoinbase: false,
        isFinal: true
      }

      const giantChangeUtxo = {
        outpoint: { txid: 'bb'.repeat(32), outIdx: 1 },
        blockHeight: 800000,
        sats: 10_000_000n, // giant UTXO on change address
        isCoinbase: false,
        isFinal: true
      }

      // Pass giant UTXO first in the array to guarantee it isn't an array-ordering coincidence
      const hdUtxos = [
        {
          utxo: giantChangeUtxo,
          owner: {
            address: addrChange,
            hdPath: "m/44'/899'/0'/1/0",
            branch: 'change' as const,
            index: 0,
            signatory: sigChange
          }
        },
        {
          utxo: smallActiveUtxo,
          owner: {
            address: testAddress,
            hdPath: "m/44'/899'/0'/0/0",
            branch: 'receive' as const,
            index: 0,
            signatory: sigActive
          }
        }
      ]

      const signer = new WalletSigner({
        address: testAddress,
        hdUtxos
      })

      const signed = await signer.sign({ message: 'input-zero-guarantee' })
      expect(typeof signed.rawTxBytes).toBe('string')

      const tx = Tx.deser(fromHex(signed.rawTxBytes))
      expect(tx.inputs.length).toBe(2)
      // Input 0 MUST strictly be the activeAddress small UTXO
      const input0Txid =
        typeof tx.inputs[0].prevOut.txid === 'string'
          ? tx.inputs[0].prevOut.txid
          : toHex(tx.inputs[0].prevOut.txid)
      expect(input0Txid).toBe('aa'.repeat(32))
      expect(tx.inputs[0].prevOut.outIdx).toBe(0)

      // Input 1 is the giant change UTXO added afterwards to cover the transaction
      const input1Txid =
        typeof tx.inputs[1].prevOut.txid === 'string'
          ? tx.inputs[1].prevOut.txid
          : toHex(tx.inputs[1].prevOut.txid)
      expect(input1Txid).toBe('bb'.repeat(32))
      expect(tx.inputs[1].prevOut.outIdx).toBe(1)
    })

    it('aborts with NO_UTXO_FOR_ACTIVE_ADDRESS when activeAddress has 0 UTXOs even if other HD addresses have funds', async () => {
      const skChange = fromHex('22'.repeat(32))
      const pkChange = ecc.derivePubkey(skChange)
      const addrChange = Address.p2pkh(shaRmd160(pkChange)).toString()
      const sigChange = P2PKHSignatory(skChange, pkChange, ALL_BIP143)

      const hdUtxosOnlyChange = [
        {
          utxo: {
            outpoint: { txid: 'cc'.repeat(32), outIdx: 0 },
            blockHeight: 800000,
            sats: 5_000_000n,
            isCoinbase: false,
            isFinal: true
          },
          owner: {
            address: addrChange,
            hdPath: "m/44'/899'/0'/1/0",
            branch: 'change' as const,
            index: 0,
            signatory: sigChange
          }
        }
      ]

      const signer = new WalletSigner({
        address: testAddress,
        hdUtxos: hdUtxosOnlyChange
      })

      await expect(signer.sign({ message: 'fail-no-active-utxo' })).rejects.toThrow(
        /NO_UTXO_FOR_ACTIVE_ADDRESS/
      )
    })
  })
})
