import {
  ALL_BIP143,
  Address,
  P2PKHSignatory,
  Script,
  TxBuilder,
  calcTxFee,
  fromHex,
  slpGenesis,
  slpSend
} from 'ecash-lib'
import type { GenesisInfo, ScriptUtxo } from 'chronik-client'
import { XEC_DUST_SATS } from '../config/xecFees'
import {
  NFT_MINT_FEE_RECEIVER_ADDRESS,
  NFT_MINT_PLATFORM_FEE_SATS,
  XOLOSARMY_NFT_PARENT_TOKEN_ID
} from '../config/nfts'
import { getChronik } from './ChronikClient'

const SLP_NFT1_CHILD = 65
const SLP_NFT1_GROUP = 129
const NFT_CHILD_GENESIS_AMOUNT = 1n
const NFT_PARENT_GENESIS_AMOUNT = 1000n
const NFT_PARENT_MINT_BATON_VOUT = 2
const FEE_PER_KB = 1200n
const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10

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

const isSlpToken = (utxo: ScriptUtxo, tokenId: string, tokenType: number) =>
  utxo.token &&
  utxo.token.tokenId === tokenId &&
  utxo.token.tokenType.protocol === 'SLP' &&
  utxo.token.tokenType.number === tokenType &&
  !utxo.token.isMintBaton

// Basado en Cashtab: getNftChildGenesisInput para asegurar burning de 1 parent por NFT child.
const selectParentMintInput = (utxos: ScriptUtxo[], parentTokenId: string) => {
  return utxos.find((utxo) => isSlpToken(utxo, parentTokenId, SLP_NFT1_GROUP) && utxo.token?.atoms === 1n)
}

const selectParentFanoutInput = (utxos: ScriptUtxo[], parentTokenId: string) => {
  return utxos.find((utxo) => isSlpToken(utxo, parentTokenId, SLP_NFT1_GROUP) && (utxo.token?.atoms ?? 0n) > 1n)
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
}): Promise<{ txid: string }> => {
  if (!XOLOSARMY_NFT_PARENT_TOKEN_ID) {
    throw new Error('Falta configurar el token padre para NFTs en el entorno.')
  }
  if (!NFT_MINT_FEE_RECEIVER_ADDRESS) {
    throw new Error('Falta configurar la dirección treasury para el fee de minteo.')
  }

  const chronik = getChronik()
  const addressScript = resolveAddressScript(params.address)
  const signer = P2PKHSignatory(fromHex(params.keyInfo.privateKeyHex), fromHex(params.keyInfo.publicKeyHex), ALL_BIP143)

  const utxoResponse = await chronik.address(params.address).utxos()
  let allUtxos = utxoResponse.utxos

  let parentInput = selectParentMintInput(allUtxos, XOLOSARMY_NFT_PARENT_TOKEN_ID)
  if (!parentInput) {
    const fanoutCandidate = selectParentFanoutInput(allUtxos, XOLOSARMY_NFT_PARENT_TOKEN_ID)
    if (!fanoutCandidate) {
      throw new Error('Necesitas al menos 1 token padre para mintear un NFT.')
    }
    await createParentFanoutTx({
      address: params.address,
      keyInfo: params.keyInfo,
      parentTokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
      parentUtxo: fanoutCandidate
    })

    const refreshed = await chronik.address(params.address).utxos()
    allUtxos = refreshed.utxos
    parentInput = selectParentMintInput(allUtxos, XOLOSARMY_NFT_PARENT_TOKEN_ID)
  }

  if (!parentInput) {
    throw new Error('No pudimos preparar un UTXO de 1 token padre para el minteo.')
  }

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
