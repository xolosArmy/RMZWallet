import { Script } from 'ecash-lib'
import { Agora, AgoraOffer } from 'ecash-agora'
import type { ScriptUtxo, Tx } from 'chronik-client'
import { getChronik } from './ChronikClient'
import { xolosWalletService } from './XolosWalletService'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import { parseAgoraOfferFromTx, parseOfferId } from '../dex/agoraPhase1'

const FEE_PER_KB = 1200n
const REMAINING_OFFER_INDEX_WAIT_MS = 600
const OFFER_ALREADY_CHANGED_MESSAGE = 'Esta oferta ya fue comprada o modificada. Recarga la oferta restante.'
export const MISSING_OR_SPENT_MESSAGE =
  'La oferta o alguno de tus UTXOs ya fue gastado. Recarga la wallet y vuelve a cargar la oferta.'

type AcceptedAtomsPreparer = {
  prepareAcceptedAtoms(atoms: bigint): bigint
}

type ActiveOfferCandidate = {
  outpoint?: { txid?: string; outIdx?: number; vout?: number }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const isMissingOrSpentError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return /missingorspent|bad-txns-inputs-missingorspent|Missing inputs/i.test(message)
}

export const toFriendlyBroadcastError = (error: unknown): Error => {
  if (isMissingOrSpentError(error)) {
    return new Error(MISSING_OR_SPENT_MESSAGE)
  }
  return error instanceof Error ? error : new Error(String(error))
}

export const isPartialAccept = (params: { acceptedAtoms: bigint; offeredAtoms: bigint }): boolean =>
  params.acceptedAtoms < params.offeredAtoms

export const findRemainingOfferId = (offers: ActiveOfferCandidate[], txid: string): string | undefined => {
  const normalizedTxid = txid.toLowerCase()
  for (const offer of offers) {
    const outpoint = offer.outpoint
    const outpointTxid = outpoint?.txid?.toLowerCase()
    const outIdx = outpoint?.outIdx ?? outpoint?.vout
    if (outpointTxid === normalizedTxid && typeof outIdx === 'number' && Number.isInteger(outIdx) && outIdx >= 0) {
      return `${outpointTxid}:${outIdx}`
    }
  }
  return undefined
}

export const assertOfferOutputUnspent = (tx: Tx, vout: number) => {
  const output = tx.outputs[vout]
  if (!output || output.spentBy) {
    throw new Error(OFFER_ALREADY_CHANGED_MESSAGE)
  }
}

const fetchLiveOfferTx = async (txid: string, vout: number): Promise<Tx> => {
  let tx: Tx
  try {
    tx = await getChronik().tx(txid)
  } catch {
    throw new Error(OFFER_ALREADY_CHANGED_MESSAGE)
  }
  assertOfferOutputUnspent(tx, vout)
  return tx
}

const resolveRemainingOfferId = async (txid: string): Promise<string | undefined> => {
  const load = async () => {
    const agora = new Agora(getChronik() as never)
    const activeOffers = await agora.activeOffersByTokenId(RMZ_ETOKEN_ID)
    return findRemainingOfferId(activeOffers as ActiveOfferCandidate[], txid)
  }

  try {
    return (await load()) ?? (await delay(REMAINING_OFFER_INDEX_WAIT_MS).then(load))
  } catch {
    return undefined
  }
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
  isPartial: boolean
  remainingOfferId?: string
}> => {
  const outpoint = parseOfferId(offerId)
  const tx = await fetchLiveOfferTx(outpoint.txid, outpoint.vout)
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
  const isPartial = isPartialAccept({ acceptedAtoms, offeredAtoms: offerDetails.offeredAtoms })
  const askedSats = offer.askedSats(acceptedAtoms)
  const feeSats = offer.acceptFeeSats({ recipientScript, acceptedAtoms, feePerKb: FEE_PER_KB })
  const totalNeeded = askedSats + feeSats

  await xolosWalletService.getBalances()
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

  try {
    const broadcast = await getChronik().broadcastTx(acceptTx.ser())
    await xolosWalletService.getBalances()
    const remainingOfferId = isPartial ? await resolveRemainingOfferId(broadcast.txid) : undefined
    return { txid: broadcast.txid, acceptedAtoms, isPartial, remainingOfferId }
  } catch (error) {
    throw toFriendlyBroadcastError(error)
  }
}
