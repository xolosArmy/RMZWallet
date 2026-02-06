import { ALL_BIP143, P2PKHSignatory, Script, fromHex } from 'ecash-lib'
import { AgoraOffer } from 'ecash-agora'
import type { ScriptUtxo } from 'chronik-client'
import { getChronik } from './ChronikClient'
import { xolosWalletService } from './XolosWalletService'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import { parseAgoraOfferFromTx, parseOfferId } from '../dex/agoraPhase1'

const FEE_PER_KB = 1200n

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

export const buyOfferById = async (offerId: string): Promise<{ txid: string }> => {
  const outpoint = parseOfferId(offerId)
  const tx = await getChronik().tx(outpoint.txid)
  const offerDetails = parseAgoraOfferFromTx(tx, outpoint.vout, RMZ_ETOKEN_ID)

  const walletKeyInfo = xolosWalletService.getKeyInfo()
  const xecAddress = walletKeyInfo.xecAddress ?? walletKeyInfo.address
  if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !xecAddress) {
    throw new Error('No pudimos acceder a las llaves de tu billetera.')
  }
  const recipientScript = Script.fromAddress(xecAddress)

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

  const acceptedAtoms = offerDetails.agoraPartial.prepareAcceptedAtoms(offerDetails.offeredAtoms)
  const askedSats = offer.askedSats(acceptedAtoms)
  const feeSats = offer.acceptFeeSats({ recipientScript, acceptedAtoms, feePerKb: FEE_PER_KB })
  const totalNeeded = askedSats + feeSats

  const addressUtxos = await getChronik().address(xecAddress).utxos()
  const xecUtxos = addressUtxos.utxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxosForTarget(xecUtxos, totalNeeded)

  const signer = P2PKHSignatory(fromHex(walletKeyInfo.privateKeyHex), fromHex(walletKeyInfo.publicKeyHex), ALL_BIP143)
  const fuelInputs = funding.map((utxo) => buildInput(utxo, recipientScript, signer))

  const acceptTx = offer.acceptTx({
    covenantSk: fromHex(walletKeyInfo.privateKeyHex),
    covenantPk: fromHex(walletKeyInfo.publicKeyHex),
    fuelInputs,
    recipientScript,
    acceptedAtoms,
    dustSats: offerDetails.offerOutput.sats,
    feePerKb: FEE_PER_KB
  })

  const broadcast = await getChronik().broadcastTx(acceptTx.ser())
  return { txid: broadcast.txid }
}
