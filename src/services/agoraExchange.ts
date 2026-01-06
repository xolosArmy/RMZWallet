import {
  ALL_BIP143,
  Address,
  EccDummy,
  P2PKHSignatory,
  Script,
  TxBuilder,
  calcTxFee,
  fromHex,
  shaRmd160,
  slpSend
} from 'ecash-lib'
import { AgoraOffer, AgoraOneshot, AgoraOneshotAdSignatory, parseAgoraTx } from 'ecash-agora'
import type { ScriptUtxo, Tx } from 'chronik-client'
import { getChronik } from './ChronikClient'
import type { XolosWalletService } from './XolosWalletService'
import { XEC_DUST_SATS } from '../config/xecFees'

const SLP_NFT1_CHILD = 65
const FEE_PER_KB = 1200n
const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10

export type OneshotOfferSummary = {
  offerId: string
  tokenId: string
  tokenAtoms: bigint
  priceSats: bigint
  priceXec: string
  payoutAddress?: string
  tokenType?: number
}

const estimateFee = (inputCount: number, outputCount: number): bigint => {
  const txSize = TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE + outputCount * OUTPUT_SIZE
  return calcTxFee(txSize, FEE_PER_KB)
}

const selectXecUtxos = (params: {
  xecUtxos: ScriptUtxo[]
  tokenInputSats: bigint
  fixedOutputs: { sats: bigint }[]
  tokenInputsCount: number
}): { selected: ScriptUtxo[]; includeChange: boolean } => {
  const fixedOutputSats = params.fixedOutputs.reduce((sum, output) => sum + output.sats, 0n)
  const sorted = [...params.xecUtxos].sort((a, b) => {
    if (a.sats === b.sats) return 0
    return a.sats > b.sats ? -1 : 1
  })

  const selected: ScriptUtxo[] = []
  let totalInputSats = params.tokenInputSats

  for (const utxo of sorted) {
    selected.push(utxo)
    totalInputSats += utxo.sats

    const inputCount = params.tokenInputsCount + selected.length
    const outputsBase = params.fixedOutputs.length
    const feeWithChange = estimateFee(inputCount, outputsBase + 1)
    const feeWithoutChange = estimateFee(inputCount, outputsBase)

    const leftoverWithChange = totalInputSats - fixedOutputSats - feeWithChange
    if (leftoverWithChange >= BigInt(XEC_DUST_SATS)) {
      return { selected, includeChange: true }
    }

    const leftoverWithoutChange = totalInputSats - fixedOutputSats - feeWithoutChange
    if (leftoverWithoutChange >= 0n) {
      return { selected, includeChange: false }
    }
  }

  throw new Error('No hay suficiente XEC para cubrir fees y dust de la oferta.')
}

const selectXecUtxosForTarget = (utxos: ScriptUtxo[], targetSats: bigint): ScriptUtxo[] => {
  const sorted = [...utxos].sort((a, b) => {
    if (a.sats === b.sats) return 0
    return a.sats > b.sats ? -1 : 1
  })
  const selected: ScriptUtxo[] = []
  let total = 0n

  for (const utxo of sorted) {
    selected.push(utxo)
    total += utxo.sats
    if (total >= targetSats) {
      return selected
    }
  }

  throw new Error('No hay suficiente XEC para cubrir la compra.')
}

const buildInput = (utxo: ScriptUtxo, outputScript: Script, signatory: ReturnType<typeof P2PKHSignatory>) => {
  return {
    input: {
      prevOut: utxo.outpoint,
      signData: {
        sats: utxo.sats,
        outputScript
      }
    },
    signatory
  }
}

// Basado en Cashtab: getAgoraAdFuelSats para calcular el funding del ad setup SLP.
const getAgoraAdFuelSats = (redeemScript: Script, signatory: unknown, offerOutputs: { sats: bigint; script: Script }[]) => {
  const dummyOfferTx = new TxBuilder({
    inputs: [
      {
        input: {
          prevOut: {
            txid: '1111111111111111111111111111111111111111111111111111111111111111',
            outIdx: 1
          },
          signData: {
            sats: 100000n,
            redeemScript
          }
        },
        signatory: signatory as never
      }
    ],
    outputs: offerOutputs
  })
  const measureTx = dummyOfferTx.sign({ ecc: new EccDummy() })
  return BigInt(Math.ceil((measureTx.serSize() * Number(FEE_PER_KB)) / 1000))
}

const formatSatsToXec = (sats: bigint) => {
  const whole = sats / 100n
  const fraction = (sats % 100n).toString().padStart(2, '0')
  return `${whole.toString()}.${fraction}`
}

const parseOfferId = (offerId: string): { txid: string; vout: number } => {
  const trimmed = offerId.trim()
  if (!trimmed) {
    throw new Error('Ingresa un Offer ID válido.')
  }
  const parts = trimmed.split(':')
  if (parts.length !== 2) {
    throw new Error('Usa el formato txid:vout.')
  }
  const txid = parts[0].toLowerCase()
  const vout = Number(parts[1])
  if (!/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error('El txid no es válido.')
  }
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error('El vout debe ser un entero mayor o igual a 0.')
  }
  return { txid, vout }
}

const selectTokenUtxo = (params: { utxos: ScriptUtxo[]; tokenId: string; tokenAmount: bigint }): ScriptUtxo => {
  const sorted = params.utxos
    .filter(
      (utxo) =>
        utxo.token &&
        utxo.token.tokenId === params.tokenId &&
        utxo.token.tokenType.protocol === 'SLP' &&
        !utxo.token.isMintBaton
    )
    .sort((a, b) => {
      const aAtoms = a.token?.atoms ?? 0n
      const bAtoms = b.token?.atoms ?? 0n
      if (aAtoms === bAtoms) return 0
      return aAtoms > bAtoms ? 1 : -1
    })

  const selected = sorted.find((utxo) => (utxo.token?.atoms ?? 0n) >= params.tokenAmount)
  if (!selected) {
    throw new Error('No encontramos este token en tu billetera.')
  }
  return selected
}

const createSellOfferInternal = async (params: {
  tokenId: string
  tokenAtoms: bigint
  askXecSats: bigint
  payoutAddress: string
  keyInfo: { privateKeyHex: string; publicKeyHex: string }
}): Promise<{ offerTxid: string; adTxid: string; offerId: string }> => {
  const makerScript = Script.fromAddress(Address.parse(params.payoutAddress).cash().toString())
  const signer = P2PKHSignatory(fromHex(params.keyInfo.privateKeyHex), fromHex(params.keyInfo.publicKeyHex), ALL_BIP143)

  const chronik = getChronik()
  const utxos = await chronik.address(params.payoutAddress).utxos()
  const tokenInfo = await chronik.token(params.tokenId)
  if (tokenInfo?.tokenType?.protocol !== 'SLP') {
    throw new Error('Este flujo solo soporta tokens SLP.')
  }
  const tokenType = tokenInfo?.tokenType?.number ?? SLP_NFT1_CHILD
  const tokenUtxo = selectTokenUtxo({
    utxos: utxos.utxos,
    tokenId: params.tokenId,
    tokenAmount: params.tokenAtoms
  })
  const tokenAtoms = tokenUtxo.token?.atoms ?? 0n
  if (tokenAtoms < params.tokenAtoms) {
    throw new Error('No encontramos suficientes tokens para listar esta oferta.')
  }
  const offeredAtoms = params.tokenAtoms
  const changeAtoms = tokenAtoms - offeredAtoms

  const enforcedOutputs = [
    {
      sats: 0n,
      script: slpSend(params.tokenId, tokenType, [0n, offeredAtoms])
    },
    {
      sats: params.askXecSats,
      script: makerScript
    }
  ]

  const agoraOneshot = new AgoraOneshot({
    enforcedOutputs,
    cancelPk: fromHex(params.keyInfo.publicKeyHex)
  })
  const agoraAdScript = new Script(agoraOneshot.adScript().bytecode)
  const agoraAdP2sh = Script.p2sh(shaRmd160(agoraAdScript.bytecode))

  const offerScript = new Script(agoraOneshot.script().bytecode)
  const offerP2sh = Script.p2sh(shaRmd160(offerScript.bytecode))

  const offerOutputs = [
    { sats: 0n, script: slpSend(params.tokenId, tokenType, [offeredAtoms]) },
    { sats: BigInt(XEC_DUST_SATS), script: offerP2sh }
  ]

  const offerTxFuelSats = getAgoraAdFuelSats(
    agoraAdScript,
    AgoraOneshotAdSignatory(fromHex(params.keyInfo.privateKeyHex)),
    offerOutputs
  )

  const adFuelOutputSats = BigInt(XEC_DUST_SATS) + offerTxFuelSats

  const adSendAmounts = changeAtoms > 0n ? [offeredAtoms, changeAtoms] : [offeredAtoms]
  const adSetupOutputs = [
    { sats: 0n, script: slpSend(params.tokenId, tokenType, adSendAmounts) },
    { sats: adFuelOutputSats, script: agoraAdP2sh }
  ]
  if (changeAtoms > 0n) {
    adSetupOutputs.push({ sats: BigInt(XEC_DUST_SATS), script: makerScript })
  }

  const xecUtxos = utxos.utxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxos({
    xecUtxos,
    tokenInputSats: tokenUtxo.sats,
    fixedOutputs: adSetupOutputs,
    tokenInputsCount: 1
  })

  const adSetupInputs = [
    buildInput(tokenUtxo, makerScript, signer),
    ...funding.selected.map((utxo) => buildInput(utxo, makerScript, signer))
  ]
  const adSetupFinalOutputs = funding.includeChange ? [...adSetupOutputs, makerScript] : adSetupOutputs

  const adSetupTx = new TxBuilder({
    inputs: adSetupInputs,
    outputs: adSetupFinalOutputs
  }).sign({ feePerKb: FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) })

  const adBroadcast = await chronik.broadcastTx(adSetupTx.ser())

  const offerInputs = [
    {
      input: {
        prevOut: {
          txid: adBroadcast.txid,
          outIdx: 1
        },
        signData: {
          sats: adFuelOutputSats,
          redeemScript: agoraAdScript
        }
      },
      signatory: AgoraOneshotAdSignatory(fromHex(params.keyInfo.privateKeyHex)) as never
    }
  ]

  const offerTx = new TxBuilder({
    inputs: offerInputs,
    outputs: offerOutputs
  }).sign({ feePerKb: FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) })

  const offerBroadcast = await chronik.broadcastTx(offerTx.ser())

  return {
    offerTxid: offerBroadcast.txid,
    adTxid: adBroadcast.txid,
    offerId: `${offerBroadcast.txid}:1`
  }
}

const buildOneshotSummary = (offerId: string, tx: Tx, offerVout: number, agoraOneshot: AgoraOneshot) => {
  const offerOutput = tx.outputs[offerVout]
  const token = offerOutput?.token
  if (!offerOutput || !token) {
    throw new Error('La transacción no contiene el output de oferta esperado.')
  }
  const payoutOutput = agoraOneshot.enforcedOutputs[1]
  let payoutAddress: string | undefined
  if (payoutOutput?.script) {
    try {
      payoutAddress = Address.fromScript(payoutOutput.script).toString()
    } catch {
      payoutAddress = undefined
    }
  }
  const priceSats = agoraOneshot.askedSats()
  return {
    offerId,
    tokenId: token.tokenId,
    tokenAtoms: token.atoms,
    priceSats,
    priceXec: formatSatsToXec(priceSats),
    payoutAddress,
    tokenType: token.tokenType.number
  }
}

export const createSellOfferToken = async (params: {
  tokenId: string
  tokenAtoms: bigint
  askXecSats: bigint
  payoutAddress: string
  wallet: XolosWalletService
}): Promise<{ txid: string; offerId: string }> => {
  const walletKeyInfo = params.wallet.getKeyInfo()
  if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex) {
    throw new Error('No pudimos acceder a las llaves de tu billetera.')
  }
  const result = await createSellOfferInternal({
    tokenId: params.tokenId,
    tokenAtoms: params.tokenAtoms,
    askXecSats: params.askXecSats,
    payoutAddress: params.payoutAddress,
    keyInfo: {
      privateKeyHex: walletKeyInfo.privateKeyHex,
      publicKeyHex: walletKeyInfo.publicKeyHex
    }
  })
  return { txid: result.offerTxid, offerId: result.offerId }
}

export const loadOfferById = async (params: {
  offerId: string
  tokenId?: string
}): Promise<{ offer: AgoraOffer; summary: OneshotOfferSummary }> => {
  const outpoint = parseOfferId(params.offerId)
  const chronik = getChronik()
  const tx = await chronik.tx(outpoint.txid)
  const parsed = parseAgoraTx(tx)
  if (!parsed || parsed.type !== 'ONESHOT') {
    throw new Error('No pudimos interpretar esta oferta como oneshot.')
  }
  if (parsed.outpoint.outIdx !== outpoint.vout) {
    throw new Error('El Offer ID no coincide con el output oneshot.')
  }
  const offerOutput = tx.outputs[outpoint.vout]
  if (!offerOutput?.token) {
    throw new Error('La transacción no contiene el token esperado.')
  }
  if (params.tokenId && offerOutput.token.tokenId !== params.tokenId) {
    throw new Error('El Offer ID no corresponde al token esperado.')
  }
  const summary = buildOneshotSummary(params.offerId, tx, outpoint.vout, parsed.params)
  const offer = new AgoraOffer({
    variant: { type: 'ONESHOT', params: parsed.params },
    outpoint: parsed.outpoint,
    txBuilderInput: parsed.txBuilderInput,
    token: offerOutput.token,
    status: 'OPEN'
  })
  return { offer, summary }
}

export const acceptOfferById = async (params: {
  offerId: string
  wallet: XolosWalletService
}): Promise<{ txid: string }> => {
  const { offer } = await loadOfferById({ offerId: params.offerId })
  const walletKeyInfo = params.wallet.getKeyInfo()
  const xecAddress = walletKeyInfo.xecAddress ?? walletKeyInfo.address
  if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !xecAddress) {
    throw new Error('No pudimos acceder a las llaves de tu billetera.')
  }
  const recipientScript = Script.fromAddress(Address.parse(xecAddress).cash().toString())

  const askedSats = offer.askedSats()
  const feeSats = offer.acceptFeeSats({ recipientScript, feePerKb: FEE_PER_KB, acceptedAtoms: offer.token.atoms })
  const totalNeeded = askedSats + feeSats

  const chronik = getChronik()
  const addressUtxos = await chronik.address(xecAddress).utxos()
  const xecUtxos = addressUtxos.utxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxosForTarget(xecUtxos, totalNeeded)

  const signer = P2PKHSignatory(fromHex(walletKeyInfo.privateKeyHex), fromHex(walletKeyInfo.publicKeyHex), ALL_BIP143)
  const fuelInputs = funding.map((utxo) => buildInput(utxo, recipientScript, signer))

  const acceptTx = offer.acceptTx({
    covenantSk: fromHex(walletKeyInfo.privateKeyHex),
    covenantPk: fromHex(walletKeyInfo.publicKeyHex),
    fuelInputs,
    recipientScript,
    dustSats: BigInt(XEC_DUST_SATS),
    feePerKb: FEE_PER_KB
  })

  const broadcast = await chronik.broadcastTx(acceptTx.ser())
  return { txid: broadcast.txid }
}
