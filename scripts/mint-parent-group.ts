import type { GenesisInfo } from 'chronik-client'
import * as MinimalXecWalletModule from 'minimal-xec-wallet'
import { getWalletReceivePath } from '../src/services/XolosWalletService'
import { mintSlpNft1GroupParentGenesis } from '../src/services/slpNftTxBuilder'

const addressEnv = process.env.ADDR
const mnemonicEnv = process.env.MNEMONIC
const addrIndexEnv = process.env.ADDR_INDEX
const privateKeyHexEnv = process.env.PRIVATE_KEY_HEX
const publicKeyHexEnv = process.env.PUBLIC_KEY_HEX
const chronikUrlEnv = process.env.CHRONIK_URL || process.env.VITE_CHRONIK_URL

const addrIndex = addrIndexEnv ? Number.parseInt(addrIndexEnv, 10) : 0
if (!Number.isFinite(addrIndex) || addrIndex < 0) {
  throw new Error('ADDR_INDEX debe ser un entero >= 0.')
}

type KeyInfo = { privateKeyHex: string; publicKeyHex: string }

const MinimalXECWallet = (() => {
  const moduleExports = MinimalXecWalletModule as unknown as {
    MinimalXECWallet?: new (...args: any[]) => any
    default?: new (...args: any[]) => any
  }
  if (moduleExports.MinimalXECWallet) return moduleExports.MinimalXECWallet
  if (moduleExports.default) return moduleExports.default
  return undefined
})()

if (!MinimalXECWallet) {
  throw new Error('MinimalXECWallet constructor not found (module export mismatch)')
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
    chronikUrls: ['https://chronik.xolosarmy.xyz', 'https://chronik.e.cash'],
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

  if (addressEnv && addressEnv !== derivedAddress) {
    throw new Error('ADDR no coincide con la dirección derivada para este MNEMONIC/ADDR_INDEX')
  }
  resolvedAddress = resolvedAddress || derivedAddress
}

if (!resolvedAddress || !keyInfo) {
  throw new Error('No se pudieron resolver la dirección o las llaves para firmar.')
}

console.log(`derivedAddress: ${derivedAddress ?? resolvedAddress}`)
console.log(`addrIndex: ${addrIndex}`)
if (chronikUrlEnv) {
  console.log(`chronikUrl: ${chronikUrlEnv}`)
}

const genesisInfo: GenesisInfo = {
  tokenTicker: 'RMZState',
  tokenName: 'XolosArmy Network State',
  url: 'https://xolosarmy.xyz',
  hash: undefined,
  decimals: 0
}

const { txid, tokenId } = await mintSlpNft1GroupParentGenesis({
  address: resolvedAddress,
  genesisInfo,
  keyInfo
})

console.log(`txid: ${txid}`)
console.log(`tokenId: ${tokenId}`)
