import { Script } from 'ecash-lib'
import { AgoraOffer } from 'ecash-agora'
import type { ScriptUtxo } from 'chronik-client'
import { getChronik } from './ChronikClient'
import { xolosWalletService } from './XolosWalletService'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import { parseAgoraOfferFromTx, parseOfferId } from '../dex/agoraPhase1'

const FEE_PER_KB = 1200n

type AcceptedAtomsPreparer = {
  prepareAcceptedAtoms(atoms: bigint): bigint
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

  throw new Error('No hay suficiente XEC para aceptar la oferta.')
}

const buildInput = (utxo: ScriptUtxo, outputScript: Script, signatory: unknown) => {
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

export const resolveAcceptedAtoms = (params: {
  agoraPartial: AcceptedAtomsPreparer
  offeredAtoms: bigint
  desiredAtoms?: bigint
}): bigint => {
  if (params.offeredAtoms <= 0n) {
    throw new Error('La oferta no contiene RMZ disponibles.')
  }

  if (params.desiredAtoms !== undefined) {
    if (params.desiredAtoms <= 0n) {
      throw new Error('La cantidad a comprar debe ser mayor a cero.')
    }
    if (params.desiredAtoms > params.offeredAtoms) {
      throw new Error('La cantidad a comprar supera los RMZ disponibles en la oferta.')
    }
  }

  const targetAtoms = params.desiredAtoms ?? params.offeredAtoms
  const acceptedAtoms = params.agoraPartial.prepareAcceptedAtoms(targetAtoms)

  if (acceptedAtoms <= 0n) {
    throw new Error('La cantidad aceptada por Agora debe ser mayor a cero.')
  }
  if (acceptedAtoms > params.offeredAtoms) {
    throw new Error('La cantidad aceptada por Agora supera los RMZ disponibles en la oferta.')
  }

  return acceptedAtoms
}

export const buyOfferById = async (offerId: string, desiredAtoms?: bigint): Promise<{
  txid: string
  acceptedAtoms: bigint
  remainingOfferId?: string
}> => {
  const outpoint = parseOfferId(offerId)
  const tx = await getChronik().tx(outpoint.txid)
  const offerDetails = parseAgoraOfferFromTx(tx, outpoint.vout, RMZ_ETOKEN_ID)

  const signer = xolosWalletService.getSignatory()
  const recipientScript = Script.fromAddress(signer.address)

  const offer = new AgoraOffer({
    variant: { type: 'PARTIAL', params: offerDetails.agoraPartial },
    outpoint: { txid: outpoint.txid, outIdx: outpoint.vout },
    txBuilderInput: {
      prevOut: { txid: outpoint.txid, outIdx: outpoint.vout },
      signData: {
        sats: offerDetails.offerOutput.sats,
        redeemScript: offerDetails.agoraPartial.script()
      }
    },
    token: offerDetails.token,
    status: 'OPEN'
  })

  const acceptedAtoms = resolveAcceptedAtoms({
    agoraPartial: offerDetails.agoraPartial,
    offeredAtoms: offerDetails.offeredAtoms,
    desiredAtoms
  })
  const askedSats = offer.askedSats(acceptedAtoms)
  const feeSats = offer.acceptFeeSats({ recipientScript, acceptedAtoms, feePerKb: FEE_PER_KB })
  const totalNeeded = askedSats + feeSats

  const addressUtxos = await getChronik().address(signer.address).utxos()
  const xecUtxos = addressUtxos.utxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxosForTarget(xecUtxos, totalNeeded)

  const fuelInputs = funding.map((utxo) => buildInput(utxo, recipientScript, signer.signatory))

  const acceptTx = xolosWalletService.withPrivateKey((privateKey) =>
    offer.acceptTx({
      covenantSk: privateKey,
      covenantPk: signer.publicKey,
      fuelInputs,
      recipientScript,
      acceptedAtoms,
      dustSats: offerDetails.offerOutput.sats,
      feePerKb: FEE_PER_KB
    })
  )

  const broadcast = await getChronik().broadcastTx(acceptTx.ser())
  const remainingOfferId = acceptedAtoms < offerDetails.offeredAtoms ? `${broadcast.txid}:2` : undefined
  return { txid: broadcast.txid, acceptedAtoms, remainingOfferId }
}
