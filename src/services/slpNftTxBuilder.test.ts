import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Address, Script, Tx, TxBuilder, getStackArray, toHex } from 'ecash-lib'
import type { ScriptUtxo } from 'chronik-client'
import { XEC_DUST_SATS } from '../config/xecFees'
import { XOLOSARMY_NFT_PARENT_TOKEN_ID } from '../config/nfts'
import { NFT_COLLECTION_TRUST_REGISTRY } from '../domain/nftCollections'
import {
  NFT_PARENT_MINT_BATON_VOUT,
  SLP_NFT1_GROUP,
  XOLOSARMY_MINT_PASS_ADMIN_ADDRESS,
  findSlpNft1GroupMintBaton,
  mintSlpNft1GroupPasses,
  selectNftChildMintPass,
  snapshotNftChildMintPass,
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
  protocol?: 'SLP' | 'ALP'
  tokenTypeName?: string
  atoms?: bigint
  isMintBaton?: boolean
  isCoinbase?: boolean
}): ScriptUtxo => ({
  outpoint: { txid: params.txid, outIdx: params.outIdx },
  sats: params.sats ?? BigInt(XEC_DUST_SATS),
  isCoinbase: params.isCoinbase ?? false,
  token: params.tokenId
    ? {
        tokenId: params.tokenId,
        tokenType: {
          protocol: params.protocol ?? 'SLP',
          type:
            params.tokenTypeName ??
            (params.tokenType === SLP_NFT1_GROUP
              ? 'SLP_TOKEN_TYPE_NFT1_GROUP'
              : params.tokenType === 65
                ? 'SLP_TOKEN_TYPE_NFT1_CHILD'
                : 'SLP_TOKEN_TYPE_FUNGIBLE'),
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

describe('NFT Child collection Mint Pass selection', () => {
  const officialParent = NFT_COLLECTION_TRUST_REGISTRY.official.parentTokenId as string
  const communityParent = NFT_COLLECTION_TRUST_REGISTRY.community.parentTokenId as string
  const officialPass = utxo({
    txid: TXID_A,
    outIdx: 1,
    tokenId: officialParent,
    tokenType: SLP_NFT1_GROUP,
    atoms: 1n
  })
  const communityPass = utxo({
    txid: TXID_B,
    outIdx: 1,
    tokenId: communityParent,
    tokenType: SLP_NFT1_GROUP,
    atoms: 1n
  })

  it('selects only the canonical Group atom for the explicit collection', () => {
    assert.equal(selectNftChildMintPass([communityPass, officialPass], 'official')?.utxo, officialPass)
    assert.equal(selectNftChildMintPass([officialPass, communityPass], 'community')?.utxo, communityPass)
  })

  it('freezes the exact canonical Parent and outpoint selected before secret access', () => {
    const selection = selectNftChildMintPass([communityPass], 'community')
    assert.ok(selection)

    const snapshot = snapshotNftChildMintPass(selection)
    assert.deepEqual(snapshot, {
      kind: 'exact',
      parentTokenId: communityParent,
      outpoint: { txid: TXID_B, outIdx: 1 }
    })
    assert.equal(Object.isFrozen(snapshot), true)
    assert.equal(Object.isFrozen(snapshot.outpoint), true)
  })

  it('never falls back across Official and Community', () => {
    assert.equal(selectNftChildMintPass([officialPass], 'community'), null)
    assert.equal(selectNftChildMintPass([communityPass], 'official'), null)
  })

  it('selects a canonical multi-atom Group only for the existing fanout path', () => {
    const communityFanout = utxo({
      txid: TXID_C,
      outIdx: 1,
      tokenId: communityParent,
      tokenType: SLP_NFT1_GROUP,
      atoms: 3n
    })

    const selection = selectNftChildMintPass([communityFanout], 'community')
    assert.equal(selection?.kind, 'fanout')
    assert.equal(selection?.parentTokenId, communityParent)
  })

  it('rejects baton, Child, fungible, ALP, coinbase and malformed candidates', () => {
    const rejected = [
      utxo({
        txid: TXID_A,
        outIdx: 2,
        tokenId: communityParent,
        tokenType: SLP_NFT1_GROUP,
        atoms: 1n,
        isMintBaton: true
      }),
      utxo({ txid: TXID_A, outIdx: 3, tokenId: communityParent, tokenType: 65, atoms: 1n }),
      utxo({ txid: TXID_A, outIdx: 4, tokenId: communityParent, tokenType: 1, atoms: 1n }),
      utxo({
        txid: TXID_A,
        outIdx: 5,
        tokenId: communityParent,
        tokenType: SLP_NFT1_GROUP,
        protocol: 'ALP',
        tokenTypeName: 'ALP_TOKEN_TYPE_STANDARD',
        atoms: 1n
      }),
      utxo({
        txid: TXID_A,
        outIdx: 6,
        tokenId: communityParent,
        tokenType: SLP_NFT1_GROUP,
        atoms: 1n,
        isCoinbase: true
      }),
      { ...communityPass, outpoint: { txid: 'not-a-txid', outIdx: 0 } } as ScriptUtxo,
      { ...communityPass, token: { ...communityPass.token, atoms: '1' } } as unknown as ScriptUtxo,
      null as unknown as ScriptUtxo
    ]

    assert.equal(selectNftChildMintPass(rejected, 'community'), null)
  })

  it('contains hostile token getters and rejects arbitrary runtime collection injection', () => {
    const hostile = { ...communityPass } as ScriptUtxo
    Object.defineProperty(hostile, 'token', {
      get() {
        throw new Error('hostile token getter')
      }
    })

    assert.equal(selectNftChildMintPass([hostile], 'community'), null)
    assert.throws(
      () => selectNftChildMintPass([communityPass], 'attacker' as 'community'),
      /Colección NFT no registrada/
    )
  })
})
