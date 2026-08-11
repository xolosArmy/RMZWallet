import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptUtxo, TokenInfo } from 'chronik-client'
import { DUMMY_KEYPAIR } from 'ecash-agora'
import {
  ALL_BIP143,
  Address,
  P2PKHSignatory,
  parseAlp,
  parseEmppScript,
  shaRmd160
} from 'ecash-lib'
import { FIRMA_ALPHA } from '../config/firmaAlpha'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import { TOKEN_DUST_SATS } from '../dex/agoraPhase1'
import { parseTokenAmount } from '../utils/tokenFormat'
import { getChronik } from './ChronikClient'
import { xolosWalletService } from './XolosWalletService'
import { buildFirmaSendPlan } from './firmaAlphaSend'

const walletAddress = Address.p2pkh(shaRmd160(DUMMY_KEYPAIR.pk)).toString()
const destinationPk = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x55)])
const destinationAddress = Address.p2pkh(shaRmd160(destinationPk)).toString()

const canonicalTokenInfo = (): TokenInfo => ({
  tokenId: FIRMA_ALPHA.tokenId,
  tokenType: {
    protocol: 'ALP',
    type: 'ALP_TOKEN_TYPE_STANDARD',
    number: 0
  },
  genesisInfo: {
    tokenTicker: FIRMA_ALPHA.ticker,
    tokenName: FIRMA_ALPHA.onChainName,
    url: 'firmaprotocol.com',
    decimals: FIRMA_ALPHA.decimals,
    data: '',
    authPubkey: FIRMA_ALPHA.genesisAuthPubkeyHex
  }
} as TokenInfo)

const xecUtxo = (marker: string, sats: bigint): ScriptUtxo => ({
  outpoint: { txid: marker.repeat(64), outIdx: 0 },
  blockHeight: 1,
  isCoinbase: false,
  sats,
  isFinal: true
} as ScriptUtxo)

const tokenUtxo = (params: {
  marker: string
  atoms: bigint
  tokenId?: string
  protocol?: 'ALP' | 'SLP'
  tokenType?: number
  isMintBaton?: boolean
}): ScriptUtxo => ({
  ...xecUtxo(params.marker, TOKEN_DUST_SATS),
  token: {
    tokenId: params.tokenId ?? FIRMA_ALPHA.tokenId,
    tokenType: {
      protocol: params.protocol ?? 'ALP',
      type: 'ALP_TOKEN_TYPE_STANDARD',
      number: params.tokenType ?? 0
    },
    atoms: params.atoms,
    isMintBaton: params.isMintBaton ?? false
  }
} as ScriptUtxo)

describe('Firma Alpha ALP SEND plan', () => {
  it('selects only canonical FIRMA, preserves token change and funds the fee with pure XEC', () => {
    const canonical = tokenUtxo({ marker: 'a', atoms: 250n })
    const rmz = tokenUtxo({ marker: 'b', atoms: 999n, tokenId: RMZ_ETOKEN_ID })
    const fakeFirma = tokenUtxo({ marker: 'c', atoms: 999n, tokenId: 'c'.repeat(64) })
    const nft = tokenUtxo({ marker: 'd', atoms: 1n, tokenId: 'd'.repeat(64), protocol: 'SLP', tokenType: 65 })
    const mintBaton = tokenUtxo({ marker: 'e', atoms: 0n, isMintBaton: true })
    const pureXec = xecUtxo('f', 20_000n)

    const plan = buildFirmaSendPlan({
      walletAddress,
      destination: destinationAddress,
      amountAtoms: 100n,
      utxos: [rmz, fakeFirma, nft, mintBaton, canonical, pureXec]
    })

    expect(plan.preview.tokenId).toBe(FIRMA_ALPHA.tokenId)
    expect(plan.preview.tokenInputOutpoints).toEqual([`${canonical.outpoint.txid}:0`])
    expect(plan.preview.xecInputOutpoints).toEqual([`${pureXec.outpoint.txid}:0`])
    expect(plan.preview.firmaChangeAtoms).toBe(150n)
    expect(plan.preview.balanceBeforeAtoms).toBe(250n)
    expect(plan.preview.balanceAfterAtoms).toBe(150n)
    expect(plan.preview.networkFeeSats).toBeGreaterThan(0n)
    expect(pureXec.sats).toBeGreaterThan(plan.preview.networkFeeSats)
    expect(plan.preview.inputOutpoints).not.toContain(`${rmz.outpoint.txid}:0`)
    expect(plan.preview.inputOutpoints).not.toContain(`${fakeFirma.outpoint.txid}:0`)
    expect(plan.preview.inputOutpoints).not.toContain(`${nft.outpoint.txid}:0`)
    expect(plan.preview.inputOutpoints).not.toContain(`${mintBaton.outpoint.txid}:0`)

    const opReturn = plan.outputs[0]
    if ('bytecode' in opReturn) throw new Error('Expected fixed ALP OP_RETURN output')
    const pushes = parseEmppScript(opReturn.script)
    expect(pushes).toHaveLength(1)
    expect(parseAlp(pushes?.[0] as Uint8Array)).toEqual({
      txType: 'SEND',
      tokenType: 0,
      tokenId: FIRMA_ALPHA.tokenId,
      sendAtomsArray: [100n, 150n]
    })
  })

  it('creates a full acceptance send with no FIRMA change output', () => {
    const plan = buildFirmaSendPlan({
      walletAddress,
      destination: destinationAddress,
      amountAtoms: 100n,
      utxos: [tokenUtxo({ marker: '1', atoms: 100n }), xecUtxo('2', 20_000n)]
    })

    expect(plan.preview.firmaChangeAtoms).toBe(0n)
    expect(plan.preview.balanceAfterAtoms).toBe(0n)
    const opReturn = plan.outputs[0]
    if ('bytecode' in opReturn) throw new Error('Expected fixed ALP OP_RETURN output')
    const parsed = parseAlp(parseEmppScript(opReturn.script)?.[0] as Uint8Array)
    expect(parsed).toMatchObject({ txType: 'SEND', sendAtomsArray: [100n] })
  })

  it('rejects zero, insufficient FIRMA and missing pure-XEC fee fuel', () => {
    const firma = tokenUtxo({ marker: '3', atoms: 100n })
    expect(() => buildFirmaSendPlan({
      walletAddress,
      destination: destinationAddress,
      amountAtoms: 0n,
      utxos: [firma, xecUtxo('4', 20_000n)]
    })).toThrow(/mayor a cero/)

    expect(() => buildFirmaSendPlan({
      walletAddress,
      destination: destinationAddress,
      amountAtoms: 101n,
      utxos: [firma, xecUtxo('4', 20_000n)]
    })).toThrow(/FIRMA insuficiente/)

    expect(() => buildFirmaSendPlan({
      walletAddress,
      destination: destinationAddress,
      amountAtoms: 100n,
      utxos: [firma]
    })).toThrow(/UTXO XEC puro/)
  })

  it('parses FIRMA amounts exactly to four decimal atoms and rejects excess precision', () => {
    expect(parseTokenAmount('0.0100', FIRMA_ALPHA.decimals)).toBe(100n)
    expect(parseTokenAmount('12.3456', FIRMA_ALPHA.decimals)).toBe(123_456n)
    expect(() => parseTokenAmount('0.00001', FIRMA_ALPHA.decimals)).toThrow(/Máximo 4 decimales/)
  })

  it('rejects an invalid eCash destination before building a preview', () => {
    expect(() => buildFirmaSendPlan({
      walletAddress,
      destination: 'firma:not-an-address',
      amountAtoms: 100n,
      utxos: [tokenUtxo({ marker: '9', atoms: 100n }), xecUtxo('a', 20_000n)]
    })).toThrow(/dirección eCash de destino no es válida/)
  })
})

describe('XolosWalletService FIRMA preview boundary', () => {
  const chronik = getChronik()
  let currentUtxos: ScriptUtxo[]

  beforeEach(() => {
    currentUtxos = [tokenUtxo({ marker: '5', atoms: 250n }), xecUtxo('6', 20_000n)]
    vi.spyOn(chronik, 'token').mockResolvedValue(canonicalTokenInfo())
    vi.spyOn(chronik, 'address').mockImplementation(() => ({
      utxos: async () => ({ outputScript: '', utxos: currentUtxos })
    }) as never)
    vi.spyOn(chronik, 'broadcastTx').mockResolvedValue({ txid: '7'.repeat(64) })
    vi.spyOn(xolosWalletService, 'getX402ActiveAccount').mockReturnValue({
      address: walletAddress,
      publicKey: Buffer.from(DUMMY_KEYPAIR.pk).toString('hex')
    })
    vi.spyOn(xolosWalletService, 'getSignatory').mockReturnValue({
      address: walletAddress,
      publicKeyHex: Buffer.from(DUMMY_KEYPAIR.pk).toString('hex'),
      publicKey: DUMMY_KEYPAIR.pk,
      signatory: P2PKHSignatory(DUMMY_KEYPAIR.sk, DUMMY_KEYPAIR.pk, ALL_BIP143)
    })
    vi.spyOn(xolosWalletService, 'withPrivateKey').mockImplementation((handler) => handler(DUMMY_KEYPAIR.sk))
    vi.spyOn(xolosWalletService, 'signTxBuilder').mockReturnValue({
      ser: () => new Uint8Array([1, 2, 3])
    } as never)
    vi.spyOn(xolosWalletService, 'getBalances').mockResolvedValue({} as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not access any real signing mechanism during preview', async () => {
    const preview = await xolosWalletService.prepareFirmaSend(destinationAddress, 100n)

    expect(preview.amountAtoms).toBe(100n)
    expect(chronik.token).toHaveBeenCalledWith(FIRMA_ALPHA.tokenId)
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.withPrivateKey).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).not.toHaveBeenCalled()
    expect(chronik.broadcastTx).not.toHaveBeenCalled()
  })

  it('rejects ticker-matching metadata when the returned Token ID is not canonical', async () => {
    const impostor = canonicalTokenInfo()
    impostor.tokenId = 'f'.repeat(64)
    vi.mocked(chronik.token).mockResolvedValueOnce(impostor)

    await expect(xolosWalletService.prepareFirmaSend(destinationAddress, 100n))
      .rejects.toThrow(/Token ID no coincide/)
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).not.toHaveBeenCalled()
  })

  it('aborts before signing when UTXOs changed after preview', async () => {
    const preview = await xolosWalletService.prepareFirmaSend(destinationAddress, 100n)
    currentUtxos = [tokenUtxo({ marker: '8', atoms: 250n }), xecUtxo('6', 20_000n)]

    await expect(xolosWalletService.sendFirma(preview)).rejects.toThrow(/nueva previsualización/)
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.withPrivateKey).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).not.toHaveBeenCalled()
    expect(chronik.broadcastTx).not.toHaveBeenCalled()
  })

  it('reaches local signing and refreshes balances only for an identical reconstructed plan', async () => {
    const preview = await xolosWalletService.prepareFirmaSend(destinationAddress, 100n)

    await expect(xolosWalletService.sendFirma(preview)).resolves.toBe('7'.repeat(64))

    expect(xolosWalletService.getSignatory).toHaveBeenCalledOnce()
    expect(xolosWalletService.signTxBuilder).toHaveBeenCalledOnce()
    expect(xolosWalletService.withPrivateKey).not.toHaveBeenCalled()
    expect(chronik.broadcastTx).toHaveBeenCalledOnce()
    expect(xolosWalletService.getBalances).toHaveBeenCalledOnce()
    expect(vi.mocked(chronik.address).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(xolosWalletService.getSignatory).mock.invocationCallOrder[0])
  })
})
