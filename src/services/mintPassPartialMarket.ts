import { Agora, AgoraOffer, AgoraPartial, AgoraPartialAdSignatory } from 'ecash-agora'
import { Address, EccDummy, Script, TxBuilder, calcTxFee, shaRmd160, slpSend } from 'ecash-lib'
import type { ScriptUtxo } from 'chronik-client'
import { resolveNftCollectionParentTokenId, type CollectionId } from '../domain/nftCollections'
import { XEC_DUST_SATS } from '../config/xecFees'
import { getAgoraChronik, getChronik } from './ChronikClient'
import { xolosWalletService } from './XolosWalletService'

const FEE_PER_KB = 1200n
const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10
const NANO_SATS_PER_SAT = 1_000_000_000n

export type MintPassPublicOffer = Readonly<{
  offerId: string
  collectionId: CollectionId
  tokenId: string
  offeredAtoms: bigint
  minAcceptedAtoms: bigint
  unitPriceXec: string
  variant: 'PARTIAL' | 'ONESHOT'
}>

const formatSatsToXec = (sats: bigint) => {
  const whole = sats / 100n
  const fraction = (sats % 100n).toString().padStart(2, '0')
  return `${whole.toString()}.${fraction}`
}

const estimateFee = (inputCount: number, outputCount: number): bigint => {
  const txSize = TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE + outputCount * OUTPUT_SIZE
  return calcTxFee(txSize, FEE_PER_KB)
}

const buildInput = (utxo: ScriptUtxo, outputScript: Script, signatory: unknown) => ({
  input: {
    prevOut: utxo.outpoint,
    signData: {
      sats: utxo.sats,
      outputScript
    }
  },
  signatory: signatory as never
})

const selectXecUtxos = (params: {
  xecUtxos: ScriptUtxo[]
  tokenInputSats: bigint
  fixedOutputs: { sats: bigint }[]
  tokenInputsCount: number
}) => {
  const fixedOutputSats = params.fixedOutputs.reduce((sum, output) => sum + output.sats, 0n)
  const sorted = [...params.xecUtxos].sort((a, b) => (a.sats === b.sats ? 0 : a.sats > b.sats ? -1 : 1))
  const selected: ScriptUtxo[] = []
  let totalInputSats = params.tokenInputSats

  for (const utxo of sorted) {
    selected.push(utxo)
    totalInputSats += utxo.sats
    const inputCount = params.tokenInputsCount + selected.length
    const outputsBase = params.fixedOutputs.length
    const feeWithChange = estimateFee(inputCount, outputsBase + 1)
    if (totalInputSats - fixedOutputSats - feeWithChange >= BigInt(XEC_DUST_SATS)) {
      return { selected, includeChange: true }
    }
    const feeWithoutChange = estimateFee(inputCount, outputsBase)
    if (totalInputSats - fixedOutputSats - feeWithoutChange >= 0n) {
      return { selected, includeChange: false }
    }
  }
  throw new Error('No hay suficiente XEC para cubrir fees y dust de la oferta.')
}

const selectXecUtxosForTarget = (utxos: ScriptUtxo[], targetSats: bigint) => {
  const sorted = [...utxos].sort((a, b) => (a.sats === b.sats ? 0 : a.sats > b.sats ? -1 : 1))
  const selected: ScriptUtxo[] = []
  let total = 0n
  for (const utxo of sorted) {
    selected.push(utxo)
    total += utxo.sats
    if (total >= targetSats) return selected
  }
  throw new Error('No hay suficiente XEC para cubrir la compra.')
}

const selectTokenUtxo = (utxos: ScriptUtxo[], tokenId: string, tokenAtoms: bigint) => {
  const selected = [...utxos]
    .filter(
      (utxo) =>
        utxo.token?.tokenId === tokenId &&
        utxo.token.tokenType.protocol === 'SLP' &&
        !utxo.token.isMintBaton &&
        utxo.token.atoms >= tokenAtoms
    )
    .sort((a, b) => {
      const aAtoms = a.token?.atoms ?? 0n
      const bAtoms = b.token?.atoms ?? 0n
      return aAtoms === bAtoms ? 0 : aAtoms < bAtoms ? -1 : 1
    })[0]
  if (!selected) throw new Error('No encontramos suficientes Mint Pass en tu billetera.')
  return selected
}

const getAgoraAdFuelSats = (redeemScript: Script, signatory: unknown, outputs: { sats: bigint; script: Script }[]) => {
  const dummy = new TxBuilder({
    inputs: [
      {
        input: {
          prevOut: { txid: '11'.repeat(32), outIdx: 1 },
          signData: { sats: 100000n, redeemScript }
        },
        signatory: signatory as never
      }
    ],
    outputs
  })
  const measured = dummy.sign({ ecc: new EccDummy() })
  return BigInt(Math.ceil((measured.serSize() * Number(FEE_PER_KB)) / 1000))
}

const offerIdOf = (offer: AgoraOffer) => `${offer.outpoint.txid}:${offer.outpoint.outIdx}`

const getActiveOffer = async (collectionId: CollectionId, offerId: string): Promise<AgoraOffer> => {
  const tokenId = resolveNftCollectionParentTokenId(collectionId)
  const agora = new Agora(getAgoraChronik() as never)
  const offers = await agora.activeOffersByTokenId(tokenId)
  const offer = offers.find((candidate) => offerIdOf(candidate) === offerId)
  if (!offer) throw new Error('La oferta ya no está activa o todavía no fue indexada por Agora.')
  return offer
}

export const listMintPassPublicOffers = async (): Promise<MintPassPublicOffer[]> => {
  const agora = new Agora(getAgoraChronik() as never)
  const collections: CollectionId[] = ['official', 'community']
  const result: MintPassPublicOffer[] = []

  for (const collectionId of collections) {
    const tokenId = resolveNftCollectionParentTokenId(collectionId)
    const offers = await agora.activeOffersByTokenId(tokenId)
    for (const offer of offers) {
      if (offer.variant.type === 'PARTIAL') {
        const minAcceptedAtoms = offer.variant.params.minAcceptedAtoms()
        const oneAtom = offer.variant.params.prepareAcceptedAtoms(1n)
        const pricedAtoms = oneAtom > 0n ? oneAtom : minAcceptedAtoms
        result.push({
          offerId: offerIdOf(offer),
          collectionId,
          tokenId,
          offeredAtoms: offer.token.atoms,
          minAcceptedAtoms,
          unitPriceXec: formatSatsToXec(offer.askedSats(pricedAtoms) / pricedAtoms),
          variant: 'PARTIAL'
        })
      } else {
        result.push({
          offerId: offerIdOf(offer),
          collectionId,
          tokenId,
          offeredAtoms: offer.token.atoms,
          minAcceptedAtoms: offer.token.atoms,
          unitPriceXec: formatSatsToXec(offer.askedSats() / offer.token.atoms),
          variant: 'ONESHOT'
        })
      }
    }
  }

  return result
}

export const createMintPassPartialOffer = async (params: {
  collectionId: CollectionId
  quantity: bigint
  unitPriceXecSats: bigint
}): Promise<{ txid: string; offerId: string; minAcceptedAtoms: bigint }> => {
  if (params.quantity <= 0n) throw new Error('La cantidad debe ser mayor a cero.')
  if (params.unitPriceXecSats <= 0n) throw new Error('El precio por unidad debe ser mayor a cero.')

  const tokenId = resolveNftCollectionParentTokenId(params.collectionId)
  const signer = xolosWalletService.getSignatory()
  const chronik = getChronik()
  const address = Address.parse(signer.address).cash().toString()
  const makerScript = Script.fromAddress(address)
  const tokenInfo = await chronik.token(tokenId)
  if (tokenInfo.tokenType.protocol !== 'SLP') throw new Error('El Mint Pass canónico no es SLP.')

  const tokenType = tokenInfo.tokenType.number
  const agoraPartial = AgoraPartial.approximateParams({
    offeredAtoms: params.quantity,
    priceNanoSatsPerAtom: params.unitPriceXecSats * NANO_SATS_PER_SAT,
    makerPk: signer.publicKey,
    minAcceptedAtoms: 1n,
    tokenId,
    tokenType,
    tokenProtocol: 'SLP',
    enforcedLockTime: Math.floor(Date.now() / 1000),
    dustSats: BigInt(XEC_DUST_SATS)
  })
  const offeredAtoms = agoraPartial.offeredAtoms()
  if (offeredAtoms !== params.quantity || agoraPartial.prepareAcceptedAtoms(1n) !== 1n || agoraPartial.minAcceptedAtoms() !== 1n) {
    throw new Error('Agora no pudo representar esta oferta con compra mínima exacta de 1 Mint Pass.')
  }

  const utxos = await chronik.address(address).utxos()
  const tokenUtxo = selectTokenUtxo(utxos.utxos, tokenId, offeredAtoms)
  const tokenAtoms = tokenUtxo.token?.atoms ?? 0n
  const changeAtoms = tokenAtoms - offeredAtoms

  const adScript = agoraPartial.adScript()
  const adP2sh = Script.p2sh(shaRmd160(adScript.bytecode))
  const offerScript = agoraPartial.script()
  const offerP2sh = Script.p2sh(shaRmd160(offerScript.bytecode))
  const offerOutputs = [
    { sats: 0n, script: slpSend(tokenId, tokenType, [offeredAtoms]) },
    { sats: BigInt(XEC_DUST_SATS), script: offerP2sh }
  ]
  const adSignatory = xolosWalletService.withPrivateKey((privateKey) => AgoraPartialAdSignatory(privateKey))
  const offerFuelSats = getAgoraAdFuelSats(adScript, adSignatory, offerOutputs)
  const adFuelSats = BigInt(XEC_DUST_SATS) + offerFuelSats
  const sendAmounts = changeAtoms > 0n ? [offeredAtoms, changeAtoms] : [offeredAtoms]
  const adOutputs = [
    { sats: 0n, script: slpSend(tokenId, tokenType, sendAmounts) },
    { sats: adFuelSats, script: adP2sh }
  ]
  if (changeAtoms > 0n) adOutputs.push({ sats: BigInt(XEC_DUST_SATS), script: makerScript })

  const funding = selectXecUtxos({
    xecUtxos: utxos.utxos.filter((utxo) => !utxo.token),
    tokenInputSats: tokenUtxo.sats,
    fixedOutputs: adOutputs,
    tokenInputsCount: 1
  })
  const adInputs = [
    buildInput(tokenUtxo, makerScript, signer.signatory),
    ...funding.selected.map((utxo) => buildInput(utxo, makerScript, signer.signatory))
  ]
  const finalAdOutputs = funding.includeChange ? [...adOutputs, makerScript] : adOutputs
  const adTx = new TxBuilder({ inputs: adInputs, outputs: finalAdOutputs }).sign({
    feePerKb: FEE_PER_KB,
    dustSats: BigInt(XEC_DUST_SATS)
  })
  const adBroadcast = await chronik.broadcastTx(adTx.ser())

  const offerTx = new TxBuilder({
    inputs: [
      {
        input: {
          prevOut: { txid: adBroadcast.txid, outIdx: 1 },
          signData: { sats: adFuelSats, redeemScript: adScript }
        },
        signatory: adSignatory as never
      }
    ],
    outputs: offerOutputs
  }).sign({ feePerKb: FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) })
  const broadcast = await chronik.broadcastTx(offerTx.ser())
  return {
    txid: broadcast.txid,
    offerId: `${broadcast.txid}:1`,
    minAcceptedAtoms: agoraPartial.minAcceptedAtoms()
  }
}

export const buyMintPassPublicOffer = async (params: {
  collectionId: CollectionId
  offerId: string
  quantity: bigint
}): Promise<{ txid: string; acceptedAtoms: bigint }> => {
  if (params.quantity <= 0n) throw new Error('Compra al menos 1 Mint Pass.')
  const offer = await getActiveOffer(params.collectionId, params.offerId)

  let acceptedAtoms: bigint
  if (offer.variant.type === 'PARTIAL') {
    acceptedAtoms = offer.variant.params.prepareAcceptedAtoms(params.quantity)
    if (acceptedAtoms !== params.quantity) throw new Error('La granularidad de Agora ajustaría la cantidad solicitada; operación cancelada.')
    if (acceptedAtoms < offer.variant.params.minAcceptedAtoms()) throw new Error('La cantidad es menor al mínimo permitido por la oferta.')
  } else {
    if (params.quantity !== offer.token.atoms) {
      throw new Error(`Esta oferta legacy es indivisible y requiere comprar ${offer.token.atoms.toString()} Mint Pass. Debe relistarse como PARTIAL para comprar desde 1.`)
    }
    acceptedAtoms = offer.token.atoms
  }
  if (acceptedAtoms > offer.token.atoms) throw new Error('La cantidad supera los Mint Pass disponibles.')

  const signer = xolosWalletService.getSignatory()
  const recipientScript = Script.fromAddress(Address.parse(signer.address).cash().toString())
  const acceptedParam = offer.variant.type === 'PARTIAL' ? acceptedAtoms : undefined
  const askedSats = offer.variant.type === 'PARTIAL' ? offer.askedSats(acceptedAtoms) : offer.askedSats()
  const feeSats = offer.acceptFeeSats({ recipientScript, acceptedAtoms: acceptedParam, feePerKb: FEE_PER_KB })
  const utxos = await getChronik().address(signer.address).utxos()
  const funding = selectXecUtxosForTarget(utxos.utxos.filter((utxo) => !utxo.token), askedSats + feeSats)
  const fuelInputs = funding.map((utxo) => buildInput(utxo, recipientScript, signer.signatory))
  const tx = xolosWalletService.withPrivateKey((privateKey) =>
    offer.acceptTx({
      covenantSk: privateKey,
      covenantPk: signer.publicKey,
      fuelInputs,
      recipientScript,
      acceptedAtoms: acceptedParam,
      dustSats: BigInt(XEC_DUST_SATS),
      feePerKb: FEE_PER_KB
    })
  )
  const broadcast = await getChronik().broadcastTx(tx.ser())
  return { txid: broadcast.txid, acceptedAtoms }
}
