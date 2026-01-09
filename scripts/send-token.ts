import type { ScriptUtxo } from 'chronik-client'
import * as MinimalXecWalletModule from 'minimal-xec-wallet'
import {
  ALL_BIP143,
  Address,
  P2PKHSignatory,
  Script,
  TxBuilder,
  alpSend,
  calcTxFee,
  emppScript,
  fromHex,
  slpSend
} from 'ecash-lib'
import { getWalletReceivePath } from '../src/services/XolosWalletService'
import { getChronik } from '../src/services/ChronikClient'
import { TOKEN_DUST_SATS } from '../src/dex/agoraPhase1'

const DEFAULT_CHRONIK_URLS = ['https://chronik.xolosarmy.xyz', 'https://chronik.e.cash']
const FEE_PER_KB = 1200n
const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10

const addressEnv = process.env.ADDR
const mnemonicEnv = process.env.MNEMONIC
const addrIndexEnv = process.env.ADDR_INDEX
const privateKeyHexEnv = process.env.PRIVATE_KEY_HEX
const publicKeyHexEnv = process.env.PUBLIC_KEY_HEX
const chronikUrlEnv = process.env.CHRONIK_URL || process.env.VITE_CHRONIK_URL
const tokenIdEnv = process.env.TOKEN_ID
const tokenAmountEnv = process.env.TOKEN_AMOUNT
const toAddrEnv = process.env.TO_ADDR

const addrIndex = addrIndexEnv ? Number.parseInt(addrIndexEnv, 10) : 0
if (!Number.isFinite(addrIndex) || addrIndex < 0) {
  throw new Error('ADDR_INDEX debe ser un entero >= 0.')
}

if (!tokenIdEnv || !tokenIdEnv.trim()) {
  throw new Error('Define TOKEN_ID antes de ejecutar este script.')
}

if (!tokenAmountEnv || !tokenAmountEnv.trim()) {
  throw new Error('Define TOKEN_AMOUNT antes de ejecutar este script.')
}

if (!toAddrEnv || !toAddrEnv.trim()) {
  throw new Error('Define TO_ADDR antes de ejecutar este script.')
}

const tokenId = tokenIdEnv.trim()
const tokenAmountRaw = tokenAmountEnv.trim()
const toAddrRaw = toAddrEnv.trim()

type KeyInfo = { privateKeyHex: string; publicKeyHex: string }

const MinimalXECWallet = (() => {
  type MinimalXECWalletCtor = new (...args: unknown[]) => unknown
  const moduleExports = MinimalXecWalletModule as unknown as {
    MinimalXECWallet?: MinimalXECWalletCtor
    default?: MinimalXECWalletCtor
  }
  if (moduleExports.MinimalXECWallet) return moduleExports.MinimalXECWallet
  if (moduleExports.default) return moduleExports.default
  return undefined
})()

if (!MinimalXECWallet) {
  throw new Error('MinimalXECWallet constructor not found (module export mismatch)')
}

const estimateFee = (inputCount: number, outputCount: number): bigint => {
  const txSize = TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE + outputCount * OUTPUT_SIZE
  return calcTxFee(txSize, FEE_PER_KB)
}

const normalizeAddress = (address: string): string => Address.parse(address).cash().toString()

const resolveAddressScript = (address: string) => Script.fromAddress(normalizeAddress(address))

const sumSats = (utxos: ScriptUtxo[]): bigint => utxos.reduce((sum, utxo) => sum + utxo.sats, 0n)

const selectTokenUtxos = (
  utxos: ScriptUtxo[],
  targetAtoms: bigint
): { selected: ScriptUtxo[]; totalAtoms: bigint } => {
  const sorted = [...utxos].sort((a, b) => {
    const aAtoms = a.token?.atoms ?? 0n
    const bAtoms = b.token?.atoms ?? 0n
    if (aAtoms === bAtoms) return 0
    return aAtoms > bAtoms ? -1 : 1
  })

  const selected: ScriptUtxo[] = []
  let totalAtoms = 0n

  for (const utxo of sorted) {
    if (!utxo.token) continue
    selected.push(utxo)
    totalAtoms += utxo.token.atoms
    if (totalAtoms >= targetAtoms) break
  }

  if (totalAtoms < targetAtoms) {
    throw new Error('No hay suficientes tokens para completar el envío.')
  }

  return { selected, totalAtoms }
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
    if (leftoverWithChange >= TOKEN_DUST_SATS) {
      return { selected, includeChange: true }
    }

    const leftoverWithoutChange = totalInputSats - fixedOutputSats - feeWithoutChange
    if (leftoverWithoutChange >= 0n) {
      return { selected, includeChange: false }
    }
  }

  throw new Error('No hay suficiente XEC para cubrir dust y comisiones.')
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

let resolvedAddress = addressEnv
let derivedAddress: string | null = null
let keyInfo: KeyInfo | null = null

if (privateKeyHexEnv && publicKeyHexEnv) {
  if (!resolvedAddress) {
    throw new Error('Define ADDR (ecash:...) antes de ejecutar este script.')
  }
  keyInfo = { privateKeyHex: privateKeyHexEnv, publicKeyHex: publicKeyHexEnv }
} else {
  if (!mnemonicEnv || mnemonicEnv.trim().split(/\s+/).length < 12) {
    throw new Error('Define MNEMONIC (12 palabras) para derivar las llaves.')
  }
  const wallet = new MinimalXECWallet(undefined, {
    hdPath: getWalletReceivePath(addrIndex),
    chronikUrls: DEFAULT_CHRONIK_URLS,
    enableDonations: false
  })
  const keyDerivation = (wallet as { keyDerivation?: { deriveFromMnemonic: (mnemonic: string, hdPath?: string) => {
    privateKey: string
    publicKey: string
    address: string
  } } }).keyDerivation

  if (!keyDerivation || typeof keyDerivation.deriveFromMnemonic !== 'function') {
    throw new Error('No se encontró el derivador de llaves de la billetera.')
  }

  const derived = keyDerivation.deriveFromMnemonic(mnemonicEnv.trim(), getWalletReceivePath(addrIndex))
  derivedAddress = derived.address
  keyInfo = { privateKeyHex: derived.privateKey, publicKeyHex: derived.publicKey }

  if (addressEnv && normalizeAddress(addressEnv) !== normalizeAddress(derivedAddress)) {
    throw new Error('ADDR no coincide con la dirección derivada para este MNEMONIC/ADDR_INDEX')
  }
  resolvedAddress = resolvedAddress || derivedAddress
}

if (!resolvedAddress || !keyInfo) {
  throw new Error('No se pudieron resolver la dirección o las llaves para firmar.')
}

resolvedAddress = normalizeAddress(resolvedAddress)

const toAddress = (() => {
  try {
    return normalizeAddress(toAddrRaw)
  } catch {
    throw new Error('TO_ADDR no es una dirección eCash válida.')
  }
})()

const parsedTokenAmount = (() => {
  if (!/^\d+$/.test(tokenAmountRaw)) {
    throw new Error('TOKEN_AMOUNT debe ser un entero sin decimales.')
  }
  const amount = BigInt(tokenAmountRaw)
  if (amount <= 0n) {
    throw new Error('TOKEN_AMOUNT debe ser mayor a cero.')
  }
  return amount
})()

console.log(`derivedAddress: ${derivedAddress ?? resolvedAddress}`)
console.log(`addrIndex: ${addrIndex}`)
console.log(`chronikUrl: ${chronikUrlEnv ?? DEFAULT_CHRONIK_URLS.join(',')}`)

const chronik = getChronik()
const tokenInfo = await chronik.token(tokenId)
const tokenProtocol = tokenInfo?.tokenType?.protocol
const tokenType = tokenInfo?.tokenType?.number
const tokenDecimals = tokenInfo?.genesisInfo?.decimals

if (!tokenProtocol || tokenType === undefined) {
  throw new Error('No pudimos cargar la información del token.')
}
if (tokenProtocol !== 'SLP' && tokenProtocol !== 'ALP') {
  throw new Error('Solo se soportan tokens SLP o ALP.')
}
if (tokenDecimals !== undefined && tokenDecimals !== 0) {
  throw new Error('Este script solo soporta tokens con decimales 0.')
}

const utxoResponse = await chronik.address(resolvedAddress).utxos()
const allUtxos = utxoResponse.utxos
const tokenUtxos = allUtxos.filter(
  (utxo) =>
    utxo.token &&
    utxo.token.tokenId === tokenId &&
    utxo.token.tokenType.protocol === tokenProtocol &&
    !utxo.token.isMintBaton
)

const tokenSelection = selectTokenUtxos(tokenUtxos, parsedTokenAmount)
const tokenInputSats = sumSats(tokenSelection.selected)
const tokenChangeAtoms = tokenSelection.totalAtoms - parsedTokenAmount

const sendAmounts = tokenChangeAtoms > 0n ? [parsedTokenAmount, tokenChangeAtoms] : [parsedTokenAmount]
const opReturnScript =
  tokenProtocol === 'SLP'
    ? slpSend(tokenId, tokenType, sendAmounts)
    : emppScript([alpSend(tokenId, tokenType, sendAmounts)])

const destinationScript = resolveAddressScript(toAddress)
const addressScript = resolveAddressScript(resolvedAddress)

const fixedOutputs = [
  { sats: 0n, script: opReturnScript },
  { sats: TOKEN_DUST_SATS, script: destinationScript }
]

if (tokenChangeAtoms > 0n) {
  fixedOutputs.push({ sats: TOKEN_DUST_SATS, script: addressScript })
}

const xecUtxos = allUtxos.filter((utxo) => !utxo.token)
const funding = selectXecUtxos({
  xecUtxos,
  tokenInputSats,
  fixedOutputs,
  tokenInputsCount: tokenSelection.selected.length
})

const signer = P2PKHSignatory(fromHex(keyInfo.privateKeyHex), fromHex(keyInfo.publicKeyHex), ALL_BIP143)
const inputs = [
  ...tokenSelection.selected.map((utxo) => buildInput(utxo, addressScript, signer)),
  ...funding.selected.map((utxo) => buildInput(utxo, addressScript, signer))
]

const outputs = funding.includeChange ? [...fixedOutputs, addressScript] : fixedOutputs
const txBuilder = new TxBuilder({ inputs, outputs })
const signedTx = txBuilder.sign({ feePerKb: FEE_PER_KB, dustSats: TOKEN_DUST_SATS })
const broadcast = await chronik.broadcastTx(signedTx.ser())

console.log(`txid: ${broadcast.txid}`)
