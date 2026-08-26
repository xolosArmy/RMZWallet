import {
  ALL_BIP143,
  Address,
  P2PKHSignatory,
  Script,
  Tx,
  TxBuilder,
  calcTxFee,
  fromHex,
  slpGenesis,
  slpMint,
  slpSend
} from 'ecash-lib'
import type { GenesisInfo, ScriptUtxo } from 'chronik-client'
import { XEC_DUST_SATS } from '../config/xecFees'
import {
  NFT_MINT_FEE_RECEIVER_ADDRESS,
  NFT_MINT_PLATFORM_FEE_SATS
} from '../config/nfts'
import {
  resolveNftCollectionParentTokenId,
  type CollectionId
} from '../domain/nftCollections'
import { getChronik } from './ChronikClient'
import type { WalletSignatory } from './XolosWalletService'

export const SLP_NFT1_CHILD = 65
export const SLP_NFT1_GROUP = 129
export const XOLOSARMY_MINT_PASS_ADMIN_ADDRESS = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'
export const MINT_PASS_MAX_QUANTITY = 100
const NFT_CHILD_GENESIS_AMOUNT = 1n
const NFT_PARENT_GENESIS_AMOUNT = 1000n
export const NFT_PARENT_MINT_BATON_VOUT = 2
const FEE_PER_KB = 1200n
const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10

type MintPassWallet = {
  getSignatory: () => WalletSignatory
  signTxBuilder: (builder: TxBuilder, options?: { feePerKb?: bigint; dustSats?: bigint }) => ReturnType<TxBuilder['sign']>
}

type MintPassChronik = {
  address: (address: string) => {
    utxos: () => Promise<{ utxos: ScriptUtxo[] }>
  }
  broadcastTx: (rawTx: Uint8Array | string) => Promise<{ txid: string }>
}

export type NftMintPassChronikReader = Pick<MintPassChronik, 'address'>

export type NftChildMintPassSelection = {
  readonly kind: 'exact' | 'fanout'
  readonly parentTokenId: string
  readonly utxo: ScriptUtxo
}

export type NftChildMintPassExpectation = {
  readonly kind: NftChildMintPassSelection['kind']
  readonly parentTokenId: string
  readonly outpoint: {
    readonly txid: string
    readonly outIdx: number
  }
}

export type MintPassBatonInfo = {
  outpoint: string
  txid: string
  vout: number
  sats: bigint
}

export type MintPassAdminState = {
  hasBaton: boolean
  baton: MintPassBatonInfo | null
  mintPassBalance: bigint
}

export type MintPassMintResult = {
  txid: string
  rawTxHex: string
  batonOutpoint: string
  expectedBatonVout: number
  expectedBatonOutpoint: string
  estimatedFeeSats: bigint
  outputCount: number
}

const estimateFee = (inputCount: number, outputCount: number): bigint => {
  const txSize = TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE + outputCount * OUTPUT_SIZE
  return calcTxFee(txSize, FEE_PER_KB)
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

  throw new Error('No hay suficiente XEC para cubrir fees y dust del NFT.')
}

const resolveAddressScript = (address: string) => Script.fromAddress(Address.parse(address).cash().toString())

const normalizeCashAddress = (address: string) => Address.parse(address).cash().toString()

const isSlpToken = (utxo: ScriptUtxo, tokenId: string, tokenType: number) => {
  try {
    return Boolean(
      utxo &&
        typeof utxo === 'object' &&
        utxo.token &&
        utxo.token.tokenId === tokenId &&
        utxo.token.tokenType.protocol === 'SLP' &&
        utxo.token.tokenType.number === tokenType &&
        !utxo.token.isMintBaton
    )
  } catch {
    return false
  }
}

const CANONICAL_TOKEN_ID_PATTERN = /^[0-9a-f]{64}$/

const isSpendableNft1GroupToken = (utxo: ScriptUtxo, parentTokenId: string): boolean => {
  try {
    return Boolean(
      utxo &&
        typeof utxo === 'object' &&
        utxo.isCoinbase === false &&
        typeof utxo.sats === 'bigint' &&
        utxo.sats > 0n &&
        utxo.outpoint &&
        CANONICAL_TOKEN_ID_PATTERN.test(utxo.outpoint.txid) &&
        Number.isInteger(utxo.outpoint.outIdx) &&
        utxo.outpoint.outIdx >= 0 &&
        utxo.token &&
        utxo.token.tokenId === parentTokenId &&
        utxo.token.tokenType.protocol === 'SLP' &&
        utxo.token.tokenType.type === 'SLP_TOKEN_TYPE_NFT1_GROUP' &&
        utxo.token.tokenType.number === SLP_NFT1_GROUP &&
        utxo.token.isMintBaton === false &&
        typeof utxo.token.atoms === 'bigint' &&
        utxo.token.atoms >= 1n
    )
  } catch {
    return false
  }
}

export const selectNftChildMintPass = (
  utxos: readonly ScriptUtxo[],
  collectionId: CollectionId
): NftChildMintPassSelection | null => {
  const parentTokenId = resolveNftCollectionParentTokenId(collectionId)
  const exact = utxos.find(
    (utxo) => isSpendableNft1GroupToken(utxo, parentTokenId) && utxo.token?.atoms === 1n
  )
  if (exact) {
    return { kind: 'exact', parentTokenId, utxo: exact }
  }

  const fanout = utxos.find(
    (utxo) => isSpendableNft1GroupToken(utxo, parentTokenId) && (utxo.token?.atoms ?? 0n) > 1n
  )
  return fanout ? { kind: 'fanout', parentTokenId, utxo: fanout } : null
}

export const snapshotNftChildMintPass = (
  selection: NftChildMintPassSelection
): NftChildMintPassExpectation =>
  Object.freeze({
    kind: selection.kind,
    parentTokenId: selection.parentTokenId,
    outpoint: Object.freeze({ ...selection.utxo.outpoint })
  })

const selectExpectedNftChildMintPass = (
  utxos: readonly ScriptUtxo[],
  collectionId: CollectionId,
  expected: NftChildMintPassExpectation
): NftChildMintPassSelection | null => {
  const canonicalParentTokenId = resolveNftCollectionParentTokenId(collectionId)
  if (expected.parentTokenId !== canonicalParentTokenId) return null
  if (
    !CANONICAL_TOKEN_ID_PATTERN.test(expected.outpoint.txid) ||
    !Number.isInteger(expected.outpoint.outIdx) ||
    expected.outpoint.outIdx < 0
  ) {
    return null
  }

  const candidate = utxos.find(
    (utxo) =>
      utxo?.outpoint?.txid === expected.outpoint.txid &&
      utxo.outpoint.outIdx === expected.outpoint.outIdx
  )
  if (!candidate) return null

  const selection = selectNftChildMintPass([candidate], collectionId)
  return selection?.kind === expected.kind ? selection : null
}

export const assertNftChildMintPassAvailable = async (params: {
  address: string
  collectionId: CollectionId
  chronik?: NftMintPassChronikReader
}): Promise<NftChildMintPassSelection> => {
  const chronik = params.chronik ?? getChronik()
  const response = await chronik.address(params.address).utxos()
  const selection = selectNftChildMintPass(response.utxos, params.collectionId)
  if (!selection) {
    throw new Error('Necesitas al menos 1 Mint Pass de la colección seleccionada para mintear.')
  }
  return selection
}


export const validateMintPassQuantity = (quantity: number | string | bigint): bigint => {
  if (typeof quantity === 'bigint') {
    if (quantity < 1n || quantity > BigInt(MINT_PASS_MAX_QUANTITY)) {
      throw new Error(`La cantidad debe ser un entero entre 1 y ${MINT_PASS_MAX_QUANTITY}.`)
    }
    return quantity
  }

  const raw = typeof quantity === 'number' ? String(quantity) : quantity.trim()
  if (!/^\d+$/.test(raw)) {
    throw new Error(`La cantidad debe ser un entero entre 1 y ${MINT_PASS_MAX_QUANTITY}.`)
  }
  const atoms = BigInt(raw)
  if (atoms < 1n || atoms > BigInt(MINT_PASS_MAX_QUANTITY)) {
    throw new Error(`La cantidad debe ser un entero entre 1 y ${MINT_PASS_MAX_QUANTITY}.`)
  }
  return atoms
}

export const isSlpNft1GroupMintBaton = (utxo: ScriptUtxo, parentTokenId: string) =>
  Boolean(
    utxo.token &&
      utxo.token.tokenId === parentTokenId &&
      utxo.token.tokenType.protocol === 'SLP' &&
      utxo.token.tokenType.number === SLP_NFT1_GROUP &&
      utxo.token.isMintBaton === true
  )

export const findSlpNft1GroupMintBaton = (utxos: ScriptUtxo[], parentTokenId: string): ScriptUtxo => {
  const batons = utxos.filter((utxo) => isSlpNft1GroupMintBaton(utxo, parentTokenId))
  if (batons.length !== 1) {
    throw new Error(
      `Se esperaba exactamente un mint baton del Parent seleccionado; encontrados: ${batons.length}.`
    )
  }
  return batons[0]
}

export const countMintPassAtoms = (utxos: readonly ScriptUtxo[], parentTokenId: string): bigint =>
  utxos.reduce((sum, utxo) => {
    if (!isSpendableNft1GroupToken(utxo, parentTokenId)) return sum
    return sum + (utxo.token?.atoms ?? 0n)
  }, 0n)

const toBatonInfo = (utxo: ScriptUtxo): MintPassBatonInfo => ({
  txid: utxo.outpoint.txid,
  vout: utxo.outpoint.outIdx,
  outpoint: `${utxo.outpoint.txid}:${utxo.outpoint.outIdx}`,
  sats: utxo.sats
})

export const getMintPassAdminState = async (params: {
  address: string
  parentTokenId: string
}): Promise<MintPassAdminState> => {
  const response = await getChronik().address(params.address).utxos()
  const mintPassBalance = countMintPassAtoms(response.utxos, params.parentTokenId)
  const batons = response.utxos.filter((utxo) => isSlpNft1GroupMintBaton(utxo, params.parentTokenId))
  return {
    hasBaton: batons.length === 1,
    baton: batons.length === 1 ? toBatonInfo(batons[0]) : null,
    mintPassBalance
  }
}

const createParentFanoutTx = async (params: {
  address: string
  keyInfo: { privateKeyHex: string; publicKeyHex: string }
  parentTokenId: string
  parentUtxo: ScriptUtxo
}): Promise<string> => {
  const addressScript = resolveAddressScript(params.address)
  const signer = P2PKHSignatory(fromHex(params.keyInfo.privateKeyHex), fromHex(params.keyInfo.publicKeyHex), ALL_BIP143)

  const parentAtoms = params.parentUtxo.token?.atoms ?? 0n
  if (parentAtoms <= 1n) {
    throw new Error('No hay suficientes tokens padre para crear un UTXO de 1 unidad.')
  }
  const changeAtoms = parentAtoms - 1n
  const sendAmounts = changeAtoms > 0n ? [1n, changeAtoms] : [1n]
  const opReturn = slpSend(params.parentTokenId, SLP_NFT1_GROUP, sendAmounts)

  const outputs = [
    { sats: 0n, script: opReturn },
    { sats: BigInt(XEC_DUST_SATS), script: addressScript }
  ]

  if (changeAtoms > 0n) {
    outputs.push({ sats: BigInt(XEC_DUST_SATS), script: addressScript })
  }

  const chronik = getChronik()
  const addressUtxos = await chronik.address(params.address).utxos()
  const xecUtxos = addressUtxos.utxos.filter((utxo) => !utxo.token)

  const funding = selectXecUtxos({
    xecUtxos,
    tokenInputSats: params.parentUtxo.sats,
    fixedOutputs: outputs,
    tokenInputsCount: 1
  })

  const inputs = [
    buildInput(params.parentUtxo, addressScript, signer),
    ...funding.selected.map((utxo) => buildInput(utxo, addressScript, signer))
  ]
  const finalOutputs = funding.includeChange ? [...outputs, addressScript] : outputs
  const txBuilder = new TxBuilder({ inputs, outputs: finalOutputs })
  const signedTx = txBuilder.sign({ feePerKb: FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) })
  const broadcast = await chronik.broadcastTx(signedTx.ser())
  return broadcast.txid
}

// Basado en Cashtab: getNftChildGenesisTargetOutputs (SLP NFT1 child GENESIS).
export const mintNftChildGenesis = async (params: {
  address: string
  keyInfo: { privateKeyHex: string; publicKeyHex: string }
  genesisInfo: GenesisInfo
  collectionId: CollectionId
  expectedMintPass: NftChildMintPassExpectation
}): Promise<{ txid: string }> => {
  const parentTokenId = resolveNftCollectionParentTokenId(params.collectionId)
  if (!NFT_MINT_FEE_RECEIVER_ADDRESS) {
    throw new Error('Falta configurar la dirección treasury para el fee de minteo.')
  }

  const chronik = getChronik()
  const addressScript = resolveAddressScript(params.address)

  const utxoResponse = await chronik.address(params.address).utxos()
  let allUtxos = utxoResponse.utxos

  let mintPassSelection = selectExpectedNftChildMintPass(
    allUtxos,
    params.collectionId,
    params.expectedMintPass
  )
  if (!mintPassSelection) {
    throw new Error('El Mint Pass validado cambió antes de construir el minteo.')
  }

  if (mintPassSelection.kind === 'fanout') {
    await createParentFanoutTx({
      address: params.address,
      keyInfo: params.keyInfo,
      parentTokenId,
      parentUtxo: mintPassSelection.utxo
    })

    const refreshed = await chronik.address(params.address).utxos()
    allUtxos = refreshed.utxos
    mintPassSelection = selectNftChildMintPass(allUtxos, params.collectionId)
    if (!mintPassSelection || mintPassSelection.kind !== 'exact') {
      throw new Error('Necesitas al menos 1 token padre para mintear un NFT.')
    }
  }

  if (mintPassSelection.kind !== 'exact') {
    throw new Error('No pudimos preparar un UTXO de 1 token padre para el minteo.')
  }
  const parentInput = mintPassSelection.utxo
  const signer = P2PKHSignatory(
    fromHex(params.keyInfo.privateKeyHex),
    fromHex(params.keyInfo.publicKeyHex),
    ALL_BIP143
  )

  const opReturn = slpGenesis(SLP_NFT1_CHILD, params.genesisInfo, NFT_CHILD_GENESIS_AMOUNT, undefined)

  const feeReceiverScript = resolveAddressScript(NFT_MINT_FEE_RECEIVER_ADDRESS)

  const fixedOutputs = [
    { sats: 0n, script: opReturn },
    { sats: BigInt(XEC_DUST_SATS), script: addressScript },
    { sats: BigInt(NFT_MINT_PLATFORM_FEE_SATS), script: feeReceiverScript }
  ]

  const xecUtxos = allUtxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxos({
    xecUtxos,
    tokenInputSats: parentInput.sats,
    fixedOutputs,
    tokenInputsCount: 1
  })

  const inputs = [
    buildInput(parentInput, addressScript, signer),
    ...funding.selected.map((utxo) => buildInput(utxo, addressScript, signer))
  ]
  const outputs = funding.includeChange ? [...fixedOutputs, addressScript] : fixedOutputs

  const txBuilder = new TxBuilder({ inputs, outputs })
  const signedTx = txBuilder.sign({ feePerKb: FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) })
  const broadcast = await chronik.broadcastTx(signedTx.ser())

  return { txid: broadcast.txid }
}

export const mintSlpNft1GroupParentGenesis = async (params: {
  address: string
  genesisInfo: GenesisInfo
  keyInfo?: { privateKeyHex: string; publicKeyHex: string }
}): Promise<{ txid: string; tokenId: string; batonVout: number }> => {
  if (!params.keyInfo?.privateKeyHex || !params.keyInfo?.publicKeyHex) {
    throw new Error('Falta la llave privada/pública para firmar el genesis del parent.')
  }

  const chronik = getChronik()
  const addressScript = resolveAddressScript(params.address)
  const signer = P2PKHSignatory(
    fromHex(params.keyInfo.privateKeyHex),
    fromHex(params.keyInfo.publicKeyHex),
    ALL_BIP143
  )

  const utxoResponse = await chronik.address(params.address).utxos()
  const xecUtxos = utxoResponse.utxos.filter((utxo) => !utxo.token)

  const genesisInfo: GenesisInfo = { ...params.genesisInfo, decimals: 0 }
  const opReturn = slpGenesis(SLP_NFT1_GROUP, genesisInfo, NFT_PARENT_GENESIS_AMOUNT, NFT_PARENT_MINT_BATON_VOUT)

  const fixedOutputs = [
    { sats: 0n, script: opReturn },
    { sats: BigInt(XEC_DUST_SATS), script: addressScript },
    { sats: BigInt(XEC_DUST_SATS), script: addressScript }
  ]

  const funding = selectXecUtxos({
    xecUtxos,
    tokenInputSats: 0n,
    fixedOutputs,
    tokenInputsCount: 0
  })

  const inputs = funding.selected.map((utxo) => buildInput(utxo, addressScript, signer))
  const outputs = funding.includeChange ? [...fixedOutputs, addressScript] : fixedOutputs

  const txBuilder = new TxBuilder({ inputs, outputs })
  const signedTx = txBuilder.sign({ feePerKb: FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) })
  const broadcast = await chronik.broadcastTx(signedTx.ser())

  return { txid: broadcast.txid, tokenId: broadcast.txid, batonVout: NFT_PARENT_MINT_BATON_VOUT }
}


export const mintSlpNft1GroupPasses = async (params: {
  wallet: MintPassWallet
  address: string
  parentTokenId: string
  quantity: number | string | bigint
  mintDestinationAddress: string
  batonDestinationAddress: string
  broadcast?: boolean
  chronik?: MintPassChronik
}): Promise<MintPassMintResult> => {
  const quantityAtoms = validateMintPassQuantity(params.quantity)
  const ownerAddress = normalizeCashAddress(params.address)
  const mintDestinationAddress = normalizeCashAddress(params.mintDestinationAddress)
  const batonDestinationAddress = normalizeCashAddress(params.batonDestinationAddress)
  const signer = params.wallet.getSignatory()
  const signerAddress = normalizeCashAddress(signer.address)

  if (signerAddress !== ownerAddress) {
    throw new Error('La wallet desbloqueada no controla la dirección propietaria del mint baton.')
  }

  const chronik = params.chronik ?? getChronik()
  const utxoResponse = await chronik.address(ownerAddress).utxos()
  const allUtxos = utxoResponse.utxos
  const batonInput = findSlpNft1GroupMintBaton(allUtxos, params.parentTokenId)
  const ownerScript = resolveAddressScript(ownerAddress)
  const mintDestinationScript = resolveAddressScript(mintDestinationAddress)
  const batonDestinationScript = resolveAddressScript(batonDestinationAddress)

  const opReturn = slpMint(params.parentTokenId, SLP_NFT1_GROUP, quantityAtoms, NFT_PARENT_MINT_BATON_VOUT)
  const fixedOutputs = [
    { sats: 0n, script: opReturn },
    { sats: BigInt(XEC_DUST_SATS), script: mintDestinationScript },
    { sats: BigInt(XEC_DUST_SATS), script: batonDestinationScript }
  ]

  const xecUtxos = allUtxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxos({
    xecUtxos,
    tokenInputSats: batonInput.sats,
    fixedOutputs,
    tokenInputsCount: 1
  })

  const inputs = [
    buildInput(batonInput, ownerScript, signer.signatory),
    ...funding.selected.map((utxo) => buildInput(utxo, ownerScript, signer.signatory))
  ]
  const outputs = funding.includeChange ? [...fixedOutputs, ownerScript] : fixedOutputs
  const txBuilder = new TxBuilder({ inputs, outputs })
  const signedTx = params.wallet.signTxBuilder(txBuilder, { feePerKb: FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) }) as Tx
  const rawTxHex = signedTx.toHex()
  const outputSats = signedTx.outputs.reduce((sum, output) => sum + output.sats, 0n)
  const inputSats = [batonInput, ...funding.selected].reduce((sum, utxo) => sum + utxo.sats, 0n)
  const estimatedFeeSats = inputSats - outputSats
  const plannedTxid = signedTx.txid()

  let txid = plannedTxid
  if (params.broadcast === true) {
    const broadcast = await chronik.broadcastTx(signedTx.ser())
    txid = broadcast.txid
  }

  return {
    txid,
    rawTxHex,
    batonOutpoint: `${batonInput.outpoint.txid}:${batonInput.outpoint.outIdx}`,
    expectedBatonVout: NFT_PARENT_MINT_BATON_VOUT,
    expectedBatonOutpoint: `${txid}:${NFT_PARENT_MINT_BATON_VOUT}`,
    estimatedFeeSats,
    outputCount: signedTx.outputs.length
  }
}

export const sendNftChild = async (params: {
  address: string
  keyInfo: { privateKeyHex: string; publicKeyHex: string }
  tokenId: string
  destinationAddress: string
}): Promise<{ txid: string }> => {
  const chronik = getChronik()
  const addressScript = resolveAddressScript(params.address)
  const destinationScript = resolveAddressScript(params.destinationAddress)
  const signer = P2PKHSignatory(fromHex(params.keyInfo.privateKeyHex), fromHex(params.keyInfo.publicKeyHex), ALL_BIP143)

  const utxoResponse = await chronik.address(params.address).utxos()
  const allUtxos = utxoResponse.utxos

  const nftInput = allUtxos.find((utxo) => isSlpToken(utxo, params.tokenId, SLP_NFT1_CHILD))
  if (!nftInput) {
    throw new Error('No encontramos este NFT en tu billetera.')
  }

  const opReturn = slpSend(params.tokenId, SLP_NFT1_CHILD, [1n])
  const fixedOutputs = [
    { sats: 0n, script: opReturn },
    { sats: BigInt(XEC_DUST_SATS), script: destinationScript }
  ]

  const xecUtxos = allUtxos.filter((utxo) => !utxo.token)
  const funding = selectXecUtxos({
    xecUtxos,
    tokenInputSats: nftInput.sats,
    fixedOutputs,
    tokenInputsCount: 1
  })

  const inputs = [
    buildInput(nftInput, addressScript, signer),
    ...funding.selected.map((utxo) => buildInput(utxo, addressScript, signer))
  ]
  const outputs = funding.includeChange ? [...fixedOutputs, addressScript] : fixedOutputs

  const txBuilder = new TxBuilder({ inputs, outputs })
  const signedTx = txBuilder.sign({ feePerKb: FEE_PER_KB, dustSats: BigInt(XEC_DUST_SATS) })
  const broadcast = await chronik.broadcastTx(signedTx.ser())

  return { txid: broadcast.txid }
}
