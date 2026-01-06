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
import { Agora, AgoraOffer, AgoraOneshot, AgoraOneshotAdSignatory } from 'ecash-agora'
import type { ScriptUtxo } from 'chronik-client'
import { getChronik } from './ChronikClient'
import { XEC_DUST_SATS } from '../config/xecFees'

const SLP_NFT1_CHILD = 65
const FEE_PER_KB = 1200n
const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10

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

let agoraInstance: Agora | null = null
const getAgora = () => {
  if (!agoraInstance) {
    agoraInstance = new Agora(getChronik(), BigInt(XEC_DUST_SATS))
  }
  return agoraInstance
}

export const fetchOrderbookByTokenId = async (tokenId: string): Promise<AgoraOffer[]> => {
  return getAgora().activeOffersByTokenId(tokenId)
}

const selectTokenUtxo = (params: {
  utxos: ScriptUtxo[]
  tokenId: string
  tokenType: number
  tokenAmount: bigint
}): ScriptUtxo => {
  const sorted = params.utxos
    .filter(
      (utxo) =>
        utxo.token &&
        utxo.token.tokenId === params.tokenId &&
        utxo.token.tokenType.protocol === 'SLP' &&
        utxo.token.tokenType.number === params.tokenType &&
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

// Basado en Cashtab: flujo de listado SLP (ad setup + offer oneshot).
export const createSellTokenOffer = async (params: {
  tokenId: string
  receiveXecSats: bigint
  makerAddress: string
  keyInfo: { privateKeyHex: string; publicKeyHex: string }
  tokenType?: number
  tokenAmount?: bigint
}): Promise<{ offerTxid: string; adTxid: string }> => {
  const makerScript = Script.fromAddress(Address.parse(params.makerAddress).cash().toString())
  const signer = P2PKHSignatory(fromHex(params.keyInfo.privateKeyHex), fromHex(params.keyInfo.publicKeyHex), ALL_BIP143)
  const tokenType = params.tokenType ?? SLP_NFT1_CHILD
  const tokenAmount = params.tokenAmount ?? 1n

  const chronik = getChronik()
  const utxos = await chronik.address(params.makerAddress).utxos()
  const tokenUtxo = selectTokenUtxo({ utxos: utxos.utxos, tokenId: params.tokenId, tokenType, tokenAmount })
  const tokenAtoms = tokenUtxo.token?.atoms ?? 0n
  if (tokenAtoms < tokenAmount) {
    throw new Error('No encontramos suficientes tokens para listar esta oferta.')
  }
  const changeAtoms = tokenAtoms - tokenAmount

  const enforcedOutputs = [
    {
      sats: 0n,
      script: slpSend(params.tokenId, tokenType, [0n, tokenAmount])
    },
    {
      sats: params.receiveXecSats,
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
    { sats: 0n, script: slpSend(params.tokenId, tokenType, [tokenAmount]) },
    { sats: BigInt(XEC_DUST_SATS), script: offerP2sh }
  ]

  const offerTxFuelSats = getAgoraAdFuelSats(
    agoraAdScript,
    AgoraOneshotAdSignatory(fromHex(params.keyInfo.privateKeyHex)),
    offerOutputs
  )

  const adFuelOutputSats = BigInt(XEC_DUST_SATS) + offerTxFuelSats

  const adSendAmounts = changeAtoms > 0n ? [tokenAmount, changeAtoms] : [tokenAmount]
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

  return { offerTxid: offerBroadcast.txid, adTxid: adBroadcast.txid }
}

export const acceptTokenOffer = async (params: {
  offer: AgoraOffer
  recipientAddress: string
  keyInfo: { privateKeyHex: string; publicKeyHex: string }
}): Promise<{ txid: string }> => {
  const recipientScript = Script.fromAddress(Address.parse(params.recipientAddress).cash().toString())
  const chronik = getChronik()

  const acceptedAtoms = params.offer.token.atoms
  const askedSats = params.offer.askedSats(acceptedAtoms)
  const feeSats = params.offer.acceptFeeSats({ recipientScript, acceptedAtoms, feePerKb: FEE_PER_KB })
  const totalNeeded = askedSats + feeSats

  const addressUtxos = await chronik.address(params.recipientAddress).utxos()
  const xecUtxos = addressUtxos.utxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxosForTarget(xecUtxos, totalNeeded)

  const signer = P2PKHSignatory(fromHex(params.keyInfo.privateKeyHex), fromHex(params.keyInfo.publicKeyHex), ALL_BIP143)
  const fuelInputs = funding.map((utxo) => buildInput(utxo, recipientScript, signer))

  const acceptTx = params.offer.acceptTx({
    covenantSk: fromHex(params.keyInfo.privateKeyHex),
    covenantPk: fromHex(params.keyInfo.publicKeyHex),
    fuelInputs,
    recipientScript,
    acceptedAtoms,
    dustSats: BigInt(XEC_DUST_SATS),
    feePerKb: FEE_PER_KB
  })

  const broadcast = await chronik.broadcastTx(acceptTx.ser())
  return { txid: broadcast.txid }
}
