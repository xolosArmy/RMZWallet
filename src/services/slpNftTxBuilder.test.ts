import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Address, Script, Tx, TxBuilder, getStackArray, toHex } from 'ecash-lib'
import type { ScriptUtxo } from 'chronik-client'
import { XEC_DUST_SATS } from '../config/xecFees'
import { XOLOSARMY_NFT_PARENT_TOKEN_ID } from '../config/nfts'
import {
  NFT_PARENT_MINT_BATON_VOUT,
  SLP_NFT1_GROUP,
  XOLOSARMY_MINT_PASS_ADMIN_ADDRESS,
  findSlpNft1GroupMintBaton,
  mintSlpNft1GroupPasses,
  validateMintPassQuantity
} from './slpNftTxBuilder'

const OTHER_TOKEN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TXID_A = '1111111111111111111111111111111111111111111111111111111111111111'
const TXID_B = '2222222222222222222222222222222222222222222222222222222222222222'
const TXID_C = '3333333333333333333333333333333333333333333333333333333333333333'
const OTHER_VALID_ADDRESS = Address.p2pkh('0000000000000000000000000000000000000000').cash().toString()

const p2pkhScript = (address = XOLOSARMY_MINT_PASS_ADMIN_ADDRESS) =>
  Script.fromAddress(Address.parse(address).cash().toString())

const utxo = (params: {
  txid: string
  outIdx: number
  sats?: bigint
  tokenId?: string
  tokenType?: number
  atoms?: bigint
  isMintBaton?: boolean
}): ScriptUtxo => ({
  outpoint: { txid: params.txid, outIdx: params.outIdx },
  sats: params.sats ?? BigInt(XEC_DUST_SATS),
  isCoinbase: false,
  token: params.tokenId
    ? {
        tokenId: params.tokenId,
        tokenType: {
          protocol: 'SLP',
          type: params.tokenType === SLP_NFT1_GROUP ? 'SLP_TOKEN_TYPE_NFT1_GROUP' : 'SLP_TOKEN_TYPE_FUNGIBLE',
          number: params.tokenType ?? SLP_NFT1_GROUP
        },
        atoms: params.atoms ?? 0n,
        isMintBaton: params.isMintBaton ?? false
      }
    : undefined
}) as ScriptUtxo

const makeChronik = (utxos: ScriptUtxo[]) => {
  let broadcastCount = 0
  return {
    chronik: {
      address: () => ({
        utxos: async () => ({ utxos })
      }),
      broadcastTx: async () => {
        broadcastCount += 1
        return { txid: 'broadcasted' }
      }
    },
    get broadcastCount() {
      return broadcastCount
    }
  }
}

describe('Mint Pass SLP NFT1 Group baton handling', () => {
  it('encuentra solo el mint baton correcto y excluye parent tokens normales y otros tokens', () => {
    const baton = utxo({
      txid: TXID_A,
      outIdx: 2,
      tokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
      tokenType: SLP_NFT1_GROUP,
      isMintBaton: true
    })
    const normalParent = utxo({
      txid: TXID_B,
      outIdx: 1,
      tokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
      tokenType: SLP_NFT1_GROUP,
      atoms: 10n
    })
    const otherToken = utxo({
      txid: TXID_C,
      outIdx: 1,
      tokenId: OTHER_TOKEN_ID,
      tokenType: SLP_NFT1_GROUP,
      isMintBaton: true
    })

    assert.equal(findSlpNft1GroupMintBaton([normalParent, otherToken, baton], XOLOSARMY_NFT_PARENT_TOKEN_ID), baton)
  })

  it('rechaza quantity 0, negativa, decimal o mayor que el limite', () => {
    for (const badQty of ['0', '-1', '1.5', '101', 0, -1, 1.2, 101, 0n, 101n]) {
      assert.throws(() => validateMintPassQuantity(badQty), /entero entre 1 y 100/)
    }
    assert.equal(validateMintPassQuantity('100'), 100n)
  })

  it('rechaza una wallet que no controla la direccion propietaria del baton', async () => {
    const { chronik } = makeChronik([])
    const wallet = {
      getSignatory: () => ({
        address: OTHER_VALID_ADDRESS,
        publicKeyHex: '',
        publicKey: new Uint8Array(),
        signatory: () => p2pkhScript()
      }),
      signTxBuilder: (builder: TxBuilder) => builder.sign()
    }

    await assert.rejects(
      mintSlpNft1GroupPasses({
        wallet,
        address: XOLOSARMY_MINT_PASS_ADMIN_ADDRESS,
        parentTokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
        quantity: 1,
        mintDestinationAddress: XOLOSARMY_MINT_PASS_ADMIN_ADDRESS,
        batonDestinationAddress: XOLOSARMY_MINT_PASS_ADMIN_ADDRESS,
        chronik,
        broadcast: false
      }),
      /no controla/
    )
  })

  it('genera un SLP MINT type 129, conserva el baton en vout 2 y no transmite durante dry-run', async () => {
    const baton = utxo({
      txid: TXID_A,
      outIdx: 2,
      tokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
      tokenType: SLP_NFT1_GROUP,
      isMintBaton: true
    })
    const normalParent = utxo({
      txid: TXID_B,
      outIdx: 1,
      tokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
      tokenType: SLP_NFT1_GROUP,
      atoms: 99n
    })
    const feeUtxo = utxo({ txid: TXID_C, outIdx: 0, sats: 10_000n })
    const { chronik, broadcastCount } = makeChronik([normalParent, baton, feeUtxo])
    let spentOutpoints: string[] = []

    const wallet = {
      getSignatory: () => ({
        address: XOLOSARMY_MINT_PASS_ADMIN_ADDRESS,
        publicKeyHex: '',
        publicKey: new Uint8Array(),
        signatory: () => p2pkhScript()
      }),
      signTxBuilder: (builder: TxBuilder) => {
        spentOutpoints = builder.inputs.map(({ input }) => `${input.prevOut.txid}:${input.prevOut.outIdx}`)
        const outputs = builder.outputs.map((output) =>
          output instanceof Script ? { sats: 1000n, script: output } : output
        )
        return new Tx({ inputs: builder.inputs.map(({ input }) => input), outputs })
      }
    }

    const result = await mintSlpNft1GroupPasses({
      wallet,
      address: XOLOSARMY_MINT_PASS_ADMIN_ADDRESS,
      parentTokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
      quantity: 7,
      mintDestinationAddress: XOLOSARMY_MINT_PASS_ADMIN_ADDRESS,
      batonDestinationAddress: XOLOSARMY_MINT_PASS_ADMIN_ADDRESS,
      chronik,
      broadcast: false
    })

    const tx = Tx.fromHex(result.rawTxHex)
    const stack = getStackArray(toHex(tx.outputs[0].script.bytecode))

    assert.deepEqual(spentOutpoints, [`${TXID_A}:2`, `${TXID_C}:0`])
    assert.equal(stack[0], '534c5000')
    assert.equal(stack[1], '81')
    assert.equal(Buffer.from(stack[2], 'hex').toString('ascii'), 'MINT')
    assert.equal(stack[3], XOLOSARMY_NFT_PARENT_TOKEN_ID)
    assert.equal(stack[4], '02')
    assert.equal(BigInt(`0x${stack[5]}`), 7n)
    assert.equal(result.expectedBatonVout, NFT_PARENT_MINT_BATON_VOUT)
    assert.equal(result.expectedBatonOutpoint, `${result.txid}:2`)
    assert.equal(result.outputCount >= 3, true)
    assert.equal(broadcastCount, 0)
  })
})
