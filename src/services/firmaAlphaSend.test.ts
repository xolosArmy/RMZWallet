import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScriptUtxo, TokenInfo } from 'chronik-client'
import { DUMMY_KEYPAIR } from 'ecash-agora'
import {
  ALL_BIP143,
  Address,
  Ecc,
  P2PKHSignatory,
  Script,
  Tx,
  parseAlp,
  parseEmppScript,
  shaRmd160,
  toHex,
  toHexRev
} from 'ecash-lib'
import { FIRMA_ALPHA } from '../config/firmaAlpha'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import { TOKEN_DUST_SATS } from '../dex/agoraPhase1'
import { parseTokenAmount } from '../utils/tokenFormat'
import { getChronik } from './ChronikClient'
import type { WalletSignatory } from './XolosWalletService'
import { WALLET_DERIVATION_PATH, xolosWalletService } from './XolosWalletService'
import {
  ECASH_STANDARD_PROFILE_ID,
  TONALLI_LEGACY_PROFILE_ID,
  getDerivationPath
} from './derivationProfiles'
import type { DerivationProfileId } from './derivationProfiles'
import {
  FIRMA_SEND_FEE_PER_KB,
  buildFirmaSendPlan,
  createSignedFirmaSendBuilder
} from './firmaAlphaSend'
import type { FirmaInputOwner, FirmaOwnedUtxo } from './firmaAlphaSend'

const testSkA = Uint8Array.from(DUMMY_KEYPAIR.sk)
const testPkA = Uint8Array.from(DUMMY_KEYPAIR.pk)
const testSkB = new Uint8Array(32)
testSkB[31] = 2
const testPkB = new Ecc().derivePubkey(testSkB)

const addressForPk = (publicKey: Uint8Array) => Address.p2pkh(shaRmd160(publicKey)).toString()
const walletAddress = addressForPk(testPkA)
const secondaryAddress = addressForPk(testPkB)
const destinationPk = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x55)])
const destinationAddress = addressForPk(destinationPk)
const foreignPk = Uint8Array.from([0x03, ...new Uint8Array(32).fill(0x77)])
const foreignAddress = addressForPk(foreignPk)

const owner = (params: {
  address?: string
  publicKey?: Uint8Array
  branch?: 'receive' | 'change'
  index?: number
  profileId?: DerivationProfileId
} = {}): FirmaInputOwner => {
  const branch = params.branch ?? 'receive'
  const index = params.index ?? 0
  const profileId = params.profileId ?? TONALLI_LEGACY_PROFILE_ID
  return {
    profileId,
    account: 0,
    address: params.address ?? walletAddress,
    publicKeyHex: toHex(params.publicKey ?? testPkA),
    branch,
    index,
    hdPath: getDerivationPath(profileId, branch, index)
  }
}

const primaryOwner = owner()
const secondaryOwner = owner({ address: secondaryAddress, publicKey: testPkB, index: 1 })

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

const owned = (utxo: ScriptUtxo, inputOwner: FirmaInputOwner = primaryOwner): FirmaOwnedUtxo => ({
  utxo,
  owner: inputOwner
})

const buildPlan = (params: { amountAtoms: bigint; ownedUtxos: FirmaOwnedUtxo[] }) =>
  buildFirmaSendPlan({
    changeOwner: primaryOwner,
    destination: destinationAddress,
    ...params
  })

describe('Firma Alpha HD-aware ALP SEND plan', () => {
  it('builds the same safe FIRMA plan for an eCash-standard 1899 owner', () => {
    const standardOwner = owner({ profileId: ECASH_STANDARD_PROFILE_ID })
    const plan = buildFirmaSendPlan({
      changeOwner: standardOwner,
      destination: destinationAddress,
      amountAtoms: 100n,
      ownedUtxos: [
        owned(tokenUtxo({ marker: '0', atoms: 100n }), standardOwner),
        owned(xecUtxo('1', 20_000n), standardOwner)
      ]
    })

    expect(plan.changeOwner.profileId).toBe(ECASH_STANDARD_PROFILE_ID)
    expect(plan.preview.changeHdPath).toBe("m/44'/1899'/0'/0/0")
    expect(plan.preview.tokenInputOutpoints).toHaveLength(1)
  })

  it('rejects cross-profile ownership before any signatory can be requested', () => {
    const standardOwner = owner({ profileId: ECASH_STANDARD_PROFILE_ID })
    const signatoryResolver = vi.fn()

    expect(() => buildFirmaSendPlan({
      changeOwner: standardOwner,
      destination: destinationAddress,
      amountAtoms: 100n,
      ownedUtxos: [
        owned(tokenUtxo({ marker: '0', atoms: 100n }), primaryOwner),
        owned(xecUtxo('1', 20_000n), standardOwner)
      ]
    })).toThrow(/perfiles de derivación distintos/)
    expect(signatoryResolver).not.toHaveBeenCalled()
  })

  it('rejects an owner whose full path belongs to a different profile', () => {
    const mismatchedOwner: FirmaInputOwner = {
      ...owner({ profileId: ECASH_STANDARD_PROFILE_ID }),
      hdPath: getDerivationPath(TONALLI_LEGACY_PROFILE_ID, 'receive', 0)
    }

    expect(() => buildFirmaSendPlan({
      changeOwner: mismatchedOwner,
      destination: destinationAddress,
      amountAtoms: 100n,
      ownedUtxos: [
        owned(tokenUtxo({ marker: '0', atoms: 100n }), mismatchedOwner),
        owned(xecUtxo('1', 20_000n), mismatchedOwner)
      ]
    })).toThrow(/metadata HD propietaria/)
  })

  it('selects only canonical FIRMA, preserves token change and funds the fee with wallet-owned pure XEC', () => {
    const canonical = tokenUtxo({ marker: 'a', atoms: 250n })
    const rmz = tokenUtxo({ marker: 'b', atoms: 999n, tokenId: RMZ_ETOKEN_ID })
    const fakeFirma = tokenUtxo({ marker: 'c', atoms: 999n, tokenId: 'c'.repeat(64) })
    const nft = tokenUtxo({ marker: 'd', atoms: 1n, tokenId: 'd'.repeat(64), protocol: 'SLP', tokenType: 65 })
    const mintBaton = tokenUtxo({ marker: 'e', atoms: 0n, isMintBaton: true })
    const pureXec = xecUtxo('f', 20_000n)

    const plan = buildPlan({
      amountAtoms: 100n,
      ownedUtxos: [rmz, fakeFirma, nft, mintBaton, canonical, pureXec].map((utxo) => owned(utxo))
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

  it('prepares 0.0100 FIRMA when the active address has zero but another wallet receive path owns it (case A)', () => {
    const plan = buildPlan({
      amountAtoms: 100n,
      ownedUtxos: [
        owned(xecUtxo('1', 20_000n), primaryOwner),
        owned(tokenUtxo({ marker: '2', atoms: 100n }), secondaryOwner)
      ]
    })

    expect(plan.preview.balanceBeforeAtoms).toBe(100n)
    expect(plan.preview.balanceAfterAtoms).toBe(0n)
    expect(plan.preview.tokenInputOutpoints).toEqual([`${'2'.repeat(64)}:0`])
    expect(plan.tokenInputs[0].owner.hdPath).toBe(secondaryOwner.hdPath)
  })

  it('consolidates FIRMA split across two wallet HD paths (case B)', () => {
    const forty = owned(tokenUtxo({ marker: '3', atoms: 40n }), primaryOwner)
    const sixty = owned(tokenUtxo({ marker: '4', atoms: 60n }), secondaryOwner)
    const plan = buildPlan({
      amountAtoms: 100n,
      ownedUtxos: [forty, sixty, owned(xecUtxo('5', 20_000n), primaryOwner)]
    })

    expect(plan.preview.balanceBeforeAtoms).toBe(100n)
    expect(plan.preview.tokenInputOutpoints).toEqual([
      `${sixty.utxo.outpoint.txid}:0`,
      `${forty.utxo.outpoint.txid}:0`
    ])
    expect(plan.tokenInputs.map(({ owner: inputOwner }) => inputOwner.hdPath)).toEqual([
      secondaryOwner.hdPath,
      primaryOwner.hdPath
    ])
  })

  it('attaches the signatory resolved for each selected input owner (case D)', () => {
    const primaryFirma = owned(tokenUtxo({ marker: '5', atoms: 40n }), primaryOwner)
    const secondaryFirma = owned(tokenUtxo({ marker: '6', atoms: 60n }), secondaryOwner)
    const feeFuel = owned(xecUtxo('7', 20_000n), primaryOwner)
    const plan = buildPlan({ amountAtoms: 100n, ownedUtxos: [primaryFirma, secondaryFirma, feeFuel] })
    const primarySignatory = P2PKHSignatory(testSkA, testPkA, ALL_BIP143)
    const secondarySignatory = P2PKHSignatory(testSkB, testPkB, ALL_BIP143)
    const builder = createSignedFirmaSendBuilder(plan, (inputOwner) =>
      inputOwner.hdPath === primaryOwner.hdPath ? primarySignatory : secondarySignatory
    )

    expect(builder.inputs.map(({ signatory }) => signatory)).toEqual([
      secondarySignatory,
      primarySignatory,
      primarySignatory
    ])
  })

  it('never makes a foreign UTXO eligible without a wallet HD owner (case C)', () => {
    const walletFirma = owned(tokenUtxo({ marker: '6', atoms: 100n }), secondaryOwner)
    const foreignFirma = tokenUtxo({ marker: '7', atoms: 1_000_000n })
    expect(foreignAddress).not.toBe(primaryOwner.address)
    expect(foreignAddress).not.toBe(secondaryOwner.address)

    expect(() => buildPlan({
      amountAtoms: 101n,
      // foreignFirma intentionally cannot enter the typed owned-UTXO set.
      ownedUtxos: [walletFirma, owned(xecUtxo('8', 20_000n), primaryOwner)]
    })).toThrow(/FIRMA insuficiente/)
    expect(foreignFirma.token?.atoms).toBe(1_000_000n)
  })

  it('returns FIRMA and XEC change to the explicit active receive-0 policy (case E)', () => {
    const plan = buildPlan({
      amountAtoms: 100n,
      ownedUtxos: [
        owned(tokenUtxo({ marker: '9', atoms: 150n }), secondaryOwner),
        owned(xecUtxo('a', 20_000n), secondaryOwner)
      ]
    })
    const changeScriptHex = toHex(Script.fromAddress(primaryOwner.address).bytecode)
    const tokenChange = plan.outputs[2]
    const xecChange = plan.outputs[3]

    expect(plan.preview.changeAddress).toBe(primaryOwner.address)
    expect(plan.preview.changeHdPath).toBe(WALLET_DERIVATION_PATH)
    expect('bytecode' in tokenChange).toBe(false)
    if (!('bytecode' in tokenChange)) expect(toHex(tokenChange.script.bytecode)).toBe(changeScriptHex)
    expect('bytecode' in xecChange).toBe(true)
    if ('bytecode' in xecChange) expect(toHex(xecChange.bytecode)).toBe(changeScriptHex)
  })

  it('creates a full send with no FIRMA change output', () => {
    const plan = buildPlan({
      amountAtoms: 100n,
      ownedUtxos: [
        owned(tokenUtxo({ marker: 'b', atoms: 100n })),
        owned(xecUtxo('c', 20_000n))
      ]
    })

    expect(plan.preview.firmaChangeAtoms).toBe(0n)
    expect(plan.preview.balanceAfterAtoms).toBe(0n)
    const opReturn = plan.outputs[0]
    if ('bytecode' in opReturn) throw new Error('Expected fixed ALP OP_RETURN output')
    const parsed = parseAlp(parseEmppScript(opReturn.script)?.[0] as Uint8Array)
    expect(parsed).toMatchObject({ txType: 'SEND', sendAtomsArray: [100n] })
  })

  it('rejects zero, insufficient FIRMA and missing pure-XEC fee fuel', () => {
    const firma = owned(tokenUtxo({ marker: 'd', atoms: 100n }))
    expect(() => buildPlan({
      amountAtoms: 0n,
      ownedUtxos: [firma, owned(xecUtxo('e', 20_000n))]
    })).toThrow(/mayor a cero/)

    expect(() => buildPlan({
      amountAtoms: 101n,
      ownedUtxos: [firma, owned(xecUtxo('e', 20_000n))]
    })).toThrow(/FIRMA insuficiente/)

    expect(() => buildPlan({ amountAtoms: 100n, ownedUtxos: [firma] }))
      .toThrow(/UTXO XEC puro/)
  })

  it('parses FIRMA amounts exactly to four decimal atoms and rejects excess precision', () => {
    expect(parseTokenAmount('0.0100', FIRMA_ALPHA.decimals)).toBe(100n)
    expect(parseTokenAmount('12.3456', FIRMA_ALPHA.decimals)).toBe(123_456n)
    expect(() => parseTokenAmount('0.00001', FIRMA_ALPHA.decimals)).toThrow(/Máximo 4 decimales/)
  })

  it('rejects an invalid eCash destination before building a preview', () => {
    expect(() => buildFirmaSendPlan({
      changeOwner: primaryOwner,
      destination: 'firma:not-an-address',
      amountAtoms: 100n,
      ownedUtxos: [
        owned(tokenUtxo({ marker: 'f', atoms: 100n })),
        owned(xecUtxo('1', 20_000n))
      ]
    })).toThrow(/dirección eCash de destino no es válida/)
  })
})

describe('ecash-lib dummy estimate versus real FIRMA signature', () => {
  it('produces the same contractual inputs, outputs, size, XEC change and fee with test keys', () => {
    const tokenA = owned(tokenUtxo({ marker: '2', atoms: 40n }), primaryOwner)
    const tokenB = owned(tokenUtxo({ marker: '3', atoms: 80n }), secondaryOwner)
    const feeFuel = owned(xecUtxo('4', 20_000n), primaryOwner)
    const plan = buildPlan({ amountAtoms: 100n, ownedUtxos: [tokenA, tokenB, feeFuel] })
    const signatories = new Map([
      [primaryOwner.hdPath, P2PKHSignatory(testSkA, testPkA, ALL_BIP143)],
      [secondaryOwner.hdPath, P2PKHSignatory(testSkB, testPkB, ALL_BIP143)]
    ])

    const realTx = createSignedFirmaSendBuilder(plan, (inputOwner) => {
      const signatory = signatories.get(inputOwner.hdPath)
      if (!signatory) throw new Error(`Missing test signatory for ${inputOwner.hdPath}`)
      return signatory
    }).sign({ feePerKb: FIRMA_SEND_FEE_PER_KB, dustSats: TOKEN_DUST_SATS })
    const parsed = Tx.fromHex(realTx.toHex())
    const inputSats = [...plan.tokenInputs, ...plan.xecInputs]
      .reduce((total, { utxo }) => total + utxo.sats, 0n)
    const actualFee = inputSats - parsed.outputs.reduce((total, output) => total + output.sats, 0n)

    expect(parsed.serSize()).toBe(plan.estimatedTx.serSize())
    expect(actualFee).toBe(plan.preview.networkFeeSats)
    expect(parsed.outputs.map((output) => [output.sats, toHex(output.script.bytecode)]))
      .toEqual(plan.estimatedTx.outputs.map((output) => [output.sats, toHex(output.script.bytecode)]))
    expect(realTx.inputs.map(({ prevOut }) => `${String(prevOut.txid)}:${prevOut.outIdx}`))
      .toEqual(plan.preview.inputOutpoints)
    expect(parsed.inputs.map(({ prevOut }) => `${toHexRev(prevOut.txid as Uint8Array)}:${prevOut.outIdx}`))
      .toEqual(plan.preview.inputOutpoints)

    const alp = parseAlp(parseEmppScript(parsed.outputs[0].script)?.[0] as Uint8Array)
    expect(alp).toEqual({
      txType: 'SEND',
      tokenType: FIRMA_ALPHA.tokenType,
      tokenId: FIRMA_ALPHA.tokenId,
      sendAtomsArray: [100n, 20n]
    })
    expect(toHex(parsed.outputs[1].script.bytecode))
      .toBe(toHex(Script.fromAddress(destinationAddress).bytecode))
    expect(toHex(parsed.outputs[2].script.bytecode))
      .toBe(toHex(Script.fromAddress(primaryOwner.address).bytecode))
    expect(toHex(parsed.outputs.at(-1)?.script.bytecode ?? new Uint8Array()))
      .toBe(toHex(Script.fromAddress(primaryOwner.address).bytecode))
    expect(parsed.outputs.at(-1)?.sats).toBe(
      inputSats - (TOKEN_DUST_SATS * 2n) - plan.preview.networkFeeSats
    )
  })
})

type FirmaServiceInternals = {
  getFirmaSpendOwners: () => FirmaInputOwner[]
  getFirmaChangeOwner: () => FirmaInputOwner
  deriveHdSignatory: (inputOwner: FirmaInputOwner) => WalletSignatory
}

describe('XolosWalletService FIRMA HD preview boundary', () => {
  const chronik = getChronik()
  const internals = xolosWalletService as unknown as FirmaServiceInternals
  let utxosByAddress: Map<string, ScriptUtxo[]>
  let deriveHdSignatory: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    utxosByAddress = new Map([
      [walletAddress, [xecUtxo('5', 20_000n)]],
      [secondaryAddress, [tokenUtxo({ marker: '6', atoms: 100n })]]
    ])
    vi.spyOn(chronik, 'token').mockResolvedValue(canonicalTokenInfo())
    vi.spyOn(chronik, 'address').mockImplementation((address: string) => ({
      utxos: async () => ({ outputScript: '', utxos: utxosByAddress.get(address) ?? [] })
    }) as never)
    vi.spyOn(chronik, 'broadcastTx').mockResolvedValue({ txid: '7'.repeat(64) })
    vi.spyOn(xolosWalletService, 'getX402ActiveAccount').mockReturnValue({
      address: walletAddress,
      publicKey: toHex(testPkA)
    })
    vi.spyOn(internals, 'getFirmaSpendOwners').mockReturnValue([primaryOwner, secondaryOwner])
    vi.spyOn(internals, 'getFirmaChangeOwner').mockReturnValue(primaryOwner)
    deriveHdSignatory = vi.spyOn(internals, 'deriveHdSignatory').mockImplementation((inputOwner) => {
      const isPrimary = inputOwner.hdPath === primaryOwner.hdPath
      const privateKey = isPrimary ? testSkA : testSkB
      const publicKey = isPrimary ? testPkA : testPkB
      return {
        address: inputOwner.address,
        publicKeyHex: inputOwner.publicKeyHex,
        publicKey,
        signatory: P2PKHSignatory(privateKey, publicKey, ALL_BIP143)
      }
    })
    vi.spyOn(xolosWalletService, 'getSignatory')
    vi.spyOn(xolosWalletService, 'withPrivateKey')
    vi.spyOn(xolosWalletService, 'signTxBuilder').mockReturnValue({
      ser: () => new Uint8Array([1, 2, 3])
    } as never)
    vi.spyOn(xolosWalletService, 'getBalances').mockResolvedValue({} as never)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prepares spendable HD FIRMA while the active address itself holds zero (case A)', async () => {
    const preview = await xolosWalletService.prepareFirmaSend(destinationAddress, 100n)

    expect(preview.balanceBeforeAtoms).toBe(100n)
    expect(preview.tokenInputOutpoints).toEqual([`${'6'.repeat(64)}:0`])
    expect(chronik.address).toHaveBeenCalledWith(walletAddress)
    expect(chronik.address).toHaveBeenCalledWith(secondaryAddress)
    expect(deriveHdSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.withPrivateKey).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).not.toHaveBeenCalled()
    expect(chronik.broadcastTx).not.toHaveBeenCalled()
  })

  it('selects split FIRMA and assigns every HD input its own signatory only after revalidation (cases B and D)', async () => {
    utxosByAddress.set(walletAddress, [tokenUtxo({ marker: '8', atoms: 40n }), xecUtxo('9', 20_000n)])
    utxosByAddress.set(secondaryAddress, [tokenUtxo({ marker: 'a', atoms: 60n })])
    const preview = await xolosWalletService.prepareFirmaSend(destinationAddress, 100n)

    await expect(xolosWalletService.sendFirma(preview)).resolves.toBe('7'.repeat(64))

    expect(preview.tokenInputOutpoints).toEqual([`${'a'.repeat(64)}:0`, `${'8'.repeat(64)}:0`])
    expect(deriveHdSignatory).toHaveBeenCalledTimes(2)
    expect(deriveHdSignatory.mock.calls.map((call: [FirmaInputOwner]) => call[0].hdPath).sort()).toEqual([
      primaryOwner.hdPath,
      secondaryOwner.hdPath
    ].sort())
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).toHaveBeenCalledOnce()
    expect(vi.mocked(chronik.address).mock.invocationCallOrder[2])
      .toBeLessThan(deriveHdSignatory.mock.invocationCallOrder[0])
  })

  it('never queries or selects a foreign address outside the HD ownership set (case C)', async () => {
    utxosByAddress.set(foreignAddress, [tokenUtxo({ marker: 'b', atoms: 1_000_000n }), xecUtxo('c', 20_000n)])

    await expect(xolosWalletService.prepareFirmaSend(destinationAddress, 101n))
      .rejects.toThrow(/FIRMA insuficiente/)
    expect(chronik.address).not.toHaveBeenCalledWith(foreignAddress)
    expect(deriveHdSignatory).not.toHaveBeenCalled()
  })

  it('rejects ticker-matching metadata when the returned Token ID is not canonical', async () => {
    const impostor = canonicalTokenInfo()
    impostor.tokenId = 'f'.repeat(64)
    vi.mocked(chronik.token).mockResolvedValueOnce(impostor)

    await expect(xolosWalletService.prepareFirmaSend(destinationAddress, 100n))
      .rejects.toThrow(/Token ID no coincide/)
    expect(deriveHdSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).not.toHaveBeenCalled()
  })

  it('aborts before HD key derivation when UTXOs changed after preview', async () => {
    const preview = await xolosWalletService.prepareFirmaSend(destinationAddress, 100n)
    utxosByAddress.set(secondaryAddress, [tokenUtxo({ marker: 'd', atoms: 100n })])

    await expect(xolosWalletService.sendFirma(preview)).rejects.toThrow(/nueva previsualización/)
    expect(deriveHdSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.getSignatory).not.toHaveBeenCalled()
    expect(xolosWalletService.withPrivateKey).not.toHaveBeenCalled()
    expect(xolosWalletService.signTxBuilder).not.toHaveBeenCalled()
    expect(chronik.broadcastTx).not.toHaveBeenCalled()
  })

  it('reaches local signing and refreshes balances only for an identical reconstructed plan', async () => {
    const preview = await xolosWalletService.prepareFirmaSend(destinationAddress, 100n)

    await expect(xolosWalletService.sendFirma(preview)).resolves.toBe('7'.repeat(64))

    expect(deriveHdSignatory).toHaveBeenCalledTimes(2)
    expect(xolosWalletService.signTxBuilder).toHaveBeenCalledOnce()
    expect(xolosWalletService.withPrivateKey).not.toHaveBeenCalled()
    expect(chronik.broadcastTx).toHaveBeenCalledOnce()
    expect(xolosWalletService.getBalances).toHaveBeenCalledOnce()
    expect(vi.mocked(chronik.address).mock.invocationCallOrder[2])
      .toBeLessThan(deriveHdSignatory.mock.invocationCallOrder[0])
  })

  it('includes owner path and token atoms in preview-to-confirm integrity', async () => {
    const preview = await xolosWalletService.prepareFirmaSend(destinationAddress, 100n)
    const changedOwner = { ...secondaryOwner, hdPath: `m/44'/899'/0'/1/1`, branch: 'change' as const }
    vi.mocked(internals.getFirmaSpendOwners).mockReturnValueOnce([primaryOwner, changedOwner])

    await expect(xolosWalletService.sendFirma(preview)).rejects.toThrow(/nueva previsualización/)
    expect(deriveHdSignatory).not.toHaveBeenCalled()
  })
})
