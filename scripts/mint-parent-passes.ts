import * as MinimalXecWalletModule from 'minimal-xec-wallet'
import { ALL_BIP143, Address, P2PKHSignatory, TxBuilder, fromHex } from 'ecash-lib'
import { getWalletReceivePath } from '../src/services/XolosWalletService'
import {
  MINT_PASS_MAX_QUANTITY,
  XOLOSARMY_MINT_PASS_ADMIN_ADDRESS,
  getMintPassAdminState,
  mintSlpNft1GroupPasses,
  validateMintPassQuantity
} from '../src/services/slpNftTxBuilder'
import { XOLOSARMY_NFT_PARENT_TOKEN_ID } from '../src/config/nfts'
import { formatSatsToXec } from '../src/dex/agoraPhase1'

const DEFAULT_CHRONIK_URLS = ['https://chronik.xolosarmy.xyz', 'https://chronik.e.cash']
const mnemonicEnv = process.env.MNEMONIC
const addrIndexEnv = process.env.ADDR_INDEX
const mintQtyEnv = process.env.MINT_QTY || '1'
const mintToAddrEnv = process.env.MINT_TO_ADDR || XOLOSARMY_MINT_PASS_ADMIN_ADDRESS
const batonToAddrEnv = process.env.BATON_TO_ADDR || XOLOSARMY_MINT_PASS_ADMIN_ADDRESS
const broadcastEnabled = process.env.BROADCAST === '1' && process.env.CONFIRM_MINT === 'YES'

const addrIndex = addrIndexEnv ? Number.parseInt(addrIndexEnv, 10) : 0
if (!Number.isInteger(addrIndex) || addrIndex < 0) {
  throw new Error('ADDR_INDEX debe ser un entero >= 0.')
}

const quantity = validateMintPassQuantity(mintQtyEnv)
const mintToAddress = Address.parse(mintToAddrEnv).cash().toString()
const batonToAddress = Address.parse(batonToAddrEnv).cash().toString()

if (!mnemonicEnv || mnemonicEnv.trim().split(/\s+/).length < 12) {
  throw new Error('Define MNEMONIC en el entorno para derivar la wallet administradora. El script no imprime ni almacena la seed.')
}

type MinimalXECWalletCtor = new (...args: unknown[]) => unknown
const MinimalXECWallet = (() => {
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

const walletForDerivation = new MinimalXECWallet(undefined, {
  hdPath: getWalletReceivePath(addrIndex),
  chronikUrls: DEFAULT_CHRONIK_URLS,
  enableDonations: false
})
const keyDerivation = (walletForDerivation as {
  keyDerivation?: {
    deriveFromMnemonic: (mnemonic: string, hdPath?: string) => {
      privateKey: string
      publicKey: string
      address: string
    }
  }
}).keyDerivation

if (!keyDerivation || typeof keyDerivation.deriveFromMnemonic !== 'function') {
  throw new Error('No se encontró el derivador de llaves de la billetera.')
}

const derived = keyDerivation.deriveFromMnemonic(mnemonicEnv.trim(), getWalletReceivePath(addrIndex))
const derivedAddress = Address.parse(derived.address).cash().toString()

if (derivedAddress !== XOLOSARMY_MINT_PASS_ADMIN_ADDRESS) {
  throw new Error(`La dirección derivada no es la administradora. Derivada: ${derivedAddress}`)
}

const privateKey = fromHex(derived.privateKey)
const publicKey = fromHex(derived.publicKey)
const signatory = P2PKHSignatory(privateKey, publicKey, ALL_BIP143)
const wallet = {
  getSignatory: () => ({
    address: derivedAddress,
    publicKeyHex: derived.publicKey,
    publicKey,
    signatory
  }),
  signTxBuilder: (builder: TxBuilder, options?: { feePerKb?: bigint; dustSats?: bigint }) => builder.sign(options)
}

const adminState = await getMintPassAdminState({
  address: derivedAddress,
  parentTokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID
})
if (!adminState.hasBaton || !adminState.baton) {
  throw new Error('Chronik no confirma un mint baton único del Parent oficial en la dirección administradora.')
}

const result = await mintSlpNft1GroupPasses({
  wallet,
  address: derivedAddress,
  parentTokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
  quantity,
  mintDestinationAddress: mintToAddress,
  batonDestinationAddress: batonToAddress,
  broadcast: broadcastEnabled
})

console.log('Mint Pass SLP NFT1 Group MINT')
console.log(`mode: ${broadcastEnabled ? 'BROADCAST' : 'DRY_RUN'}`)
console.log(`parentTokenId: ${XOLOSARMY_NFT_PARENT_TOKEN_ID}`)
console.log(`adminAddress: ${derivedAddress}`)
console.log(`currentBaton: ${adminState.baton.outpoint}`)
console.log(`quantity: ${quantity.toString()}`)
console.log(`mintTo: ${mintToAddress}`)
console.log(`batonTo: ${batonToAddress}`)
console.log(`expectedBatonVout: ${result.expectedBatonVout}`)
console.log(`expectedBatonOutpoint: ${result.expectedBatonOutpoint}`)
console.log(`estimatedFee: ${formatSatsToXec(result.estimatedFeeSats)} XEC`)
console.log(`txid: ${result.txid}`)

if (!broadcastEnabled) {
  console.log('dryRun: no se transmitió. Para transmitir usa BROADCAST=1 CONFIRM_MINT=YES.')
}

if (quantity > BigInt(MINT_PASS_MAX_QUANTITY)) {
  throw new Error('Cantidad fuera del límite operativo.')
}
