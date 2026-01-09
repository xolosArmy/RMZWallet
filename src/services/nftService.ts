import type { GenesisInfo, ScriptUtxo } from 'chronik-client'
import { getChronik } from './ChronikClient'
import { uploadFileToPinata, uploadJsonToPinata } from './pinata'
import { buildXolosarmyNftMetadata } from './nftMetadata'
import { mintNftChildGenesis, sendNftChild } from './slpNftTxBuilder'
import { XOLOSARMY_NFT_PARENT_TOKEN_ID } from '../config/nfts'
import { xolosWalletService } from './XolosWalletService'
import { ipfsToCid, ipfsToGatewayUrl } from '../utils/ipfs'

const NFT_CACHE_KEY = 'tonalli_nft_cache_v1'
const SLP_NFT1_CHILD = 65
const shouldLogNftDebug = () => import.meta.env.DEV

export type NftAsset = {
  tokenId: string
  name: string
  imageUrl: string
  imageCid?: string
  metadataCid?: string
  metadata?: Record<string, unknown>
  genesisInfo?: GenesisInfo
}

export type NftDetails = {
  tokenId: string
  metadata?: Record<string, unknown>
  metadataCid?: string
  imageCid?: string
  imageUrl?: string
  genesisInfo?: GenesisInfo
  groupTokenId?: string
}

type CacheState = {
  tokenIds: string[]
  metadataByTokenId: Record<string, { metadata?: Record<string, unknown>; metadataCid?: string }>
  parentByTokenId: Record<string, string>
}

const readCache = (): CacheState => {
  if (typeof window === 'undefined') {
    return { tokenIds: [], metadataByTokenId: {}, parentByTokenId: {} }
  }
  const raw = localStorage.getItem(NFT_CACHE_KEY)
  if (!raw) {
    return { tokenIds: [], metadataByTokenId: {}, parentByTokenId: {} }
  }
  try {
    const parsed = JSON.parse(raw) as CacheState
    return {
      tokenIds: parsed.tokenIds ?? [],
      metadataByTokenId: parsed.metadataByTokenId ?? {},
      parentByTokenId: parsed.parentByTokenId ?? {}
    }
  } catch {
    return { tokenIds: [], metadataByTokenId: {}, parentByTokenId: {} }
  }
}

const writeCache = (state: CacheState) => {
  if (typeof window === 'undefined') return
  localStorage.setItem(NFT_CACHE_KEY, JSON.stringify(state))
}

const updateCache = (patch: Partial<CacheState>) => {
  const current = readCache()
  const next = {
    tokenIds: patch.tokenIds ?? current.tokenIds,
    metadataByTokenId: patch.metadataByTokenId ?? current.metadataByTokenId,
    parentByTokenId: patch.parentByTokenId ?? current.parentByTokenId
  }
  writeCache(next)
  return next
}

const cacheTokenId = (tokenId: string) => {
  const current = readCache()
  if (current.tokenIds.includes(tokenId)) return
  updateCache({ tokenIds: [...current.tokenIds, tokenId] })
}

const cacheMetadata = (tokenId: string, metadata?: Record<string, unknown>, metadataCid?: string) => {
  const current = readCache()
  updateCache({
    metadataByTokenId: {
      ...current.metadataByTokenId,
      [tokenId]: { metadata, metadataCid }
    }
  })
}

const cacheParent = (tokenId: string, parentId: string) => {
  const current = readCache()
  updateCache({
    parentByTokenId: {
      ...current.parentByTokenId,
      [tokenId]: parentId
    }
  })
}

const getCachedMetadata = (tokenId: string) => readCache().metadataByTokenId[tokenId]

const hashJsonToSha256Hex = async (json: unknown): Promise<string> => {
  const data = new TextEncoder().encode(JSON.stringify(json))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const isNftChildUtxo = (utxo: ScriptUtxo) => {
  if (!utxo.token) return false
  if (utxo.token.tokenType.protocol !== 'SLP') return false
  if (utxo.token.tokenType.number !== SLP_NFT1_CHILD) return false
  if (utxo.token.isMintBaton) return false
  try {
    return BigInt(utxo.token.atoms) === 1n
  } catch {
    return false
  }
}

export const mintXolosarmyNftChild = async (params: {
  name: string
  description: string
  imageFile: File
  externalUrl?: string
}): Promise<{ childTokenId: string; txid: string; metadataCid: string }> => {
  const walletKeyInfo = xolosWalletService.getKeyInfo()
  const address = walletKeyInfo.xecAddress ?? walletKeyInfo.address
  if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !address) {
    throw new Error('No pudimos acceder a las llaves de tu billetera.')
  }
  if (!XOLOSARMY_NFT_PARENT_TOKEN_ID) {
    throw new Error('Falta configurar el token padre de la colección.')
  }

  const imageResult = await uploadFileToPinata(params.imageFile)
  const metadata = buildXolosarmyNftMetadata({
    name: params.name,
    description: params.description,
    imageCid: imageResult.cid,
    externalUrl: params.externalUrl
  })

  const metadataResult = await uploadJsonToPinata(metadata)
  const documentUrl = `ipfs://${metadataResult.cid}`
  const documentHash = await hashJsonToSha256Hex(metadata)

  const genesisInfo: GenesisInfo = {
    tokenTicker: 'XOLOSNFT',
    tokenName: params.name,
    url: documentUrl,
    hash: documentHash,
    decimals: 0
  }

  const { txid } = await mintNftChildGenesis({
    address,
    keyInfo: {
      privateKeyHex: walletKeyInfo.privateKeyHex,
      publicKeyHex: walletKeyInfo.publicKeyHex
    },
    genesisInfo
  })

  cacheTokenId(txid)
  cacheMetadata(txid, metadata, metadataResult.cid)
  cacheParent(txid, XOLOSARMY_NFT_PARENT_TOKEN_ID)

  return { childTokenId: txid, txid, metadataCid: metadataResult.cid }
}

export const fetchNftDetails = async (
  tokenId: string,
  options: { refreshMetadata?: boolean } = {}
): Promise<NftDetails> => {
  const cached = getCachedMetadata(tokenId)
  let metadata = options.refreshMetadata ? undefined : cached?.metadata
  let metadataCid = cached?.metadataCid

  let tokenInfo: { genesisInfo?: GenesisInfo; groupTokenId?: string } | null = null

  try {
    tokenInfo = await getChronik().token(tokenId)
  } catch {
    tokenInfo = null
  }

  if (tokenInfo?.groupTokenId) {
    cacheParent(tokenId, tokenInfo.groupTokenId)
  }

  const tokenUrl = tokenInfo?.genesisInfo?.url
  if (tokenUrl) {
    const cidFromUrl = ipfsToCid(tokenUrl)
    if (cidFromUrl) {
      metadataCid = metadataCid || cidFromUrl
    }
  }

  if (!metadata && tokenInfo?.genesisInfo?.url) {
    const url = tokenInfo.genesisInfo.url
    const httpUrl =
      url.startsWith('http://') || url.startsWith('https://') ? url : ipfsToGatewayUrl(url) || ''
    if (httpUrl) {
      try {
        const response = await fetch(httpUrl)
        if (response.ok) {
          metadata = (await response.json()) as Record<string, unknown>
          cacheMetadata(tokenId, metadata, metadataCid)
        } else if (shouldLogNftDebug()) {
          console.warn('[NFT] Metadata fetch error', tokenId, response.status)
        }
      } catch (err) {
        if (shouldLogNftDebug()) {
          console.warn('[NFT] Metadata fetch error', tokenId, err)
        }
      }
    }
  }

  if (!metadata && cached?.metadata) {
    metadata = cached.metadata
  }

  const rawImage = metadata?.image ? String(metadata.image) : ''
  const imageCid = rawImage ? ipfsToCid(rawImage) || undefined : undefined
  const image =
    rawImage && (rawImage.startsWith('http://') || rawImage.startsWith('https://'))
      ? rawImage
      : rawImage
      ? ipfsToGatewayUrl(rawImage) || ''
      : ''

  return {
    tokenId,
    metadata,
    metadataCid,
    imageCid,
    imageUrl: image,
    genesisInfo: tokenInfo?.genesisInfo,
    groupTokenId: tokenInfo?.groupTokenId
  }
}

export const fetchOwnedNfts = async (
  walletAddress: string,
  options: { refreshMetadata?: boolean } = {}
): Promise<NftAsset[]> => {
  if (!walletAddress) return []
  if (shouldLogNftDebug()) {
    console.info('[NFT] Scanning addresses for NFTs:', [walletAddress])
  }
  const utxosResponse = await getChronik().address(walletAddress).utxos()
  const allUtxos = utxosResponse.utxos
  const tokenUtxos = allUtxos.filter((utxo) => Boolean(utxo.token))
  const candidates = tokenUtxos.filter(isNftChildUtxo)
  if (shouldLogNftDebug()) {
    const tokenIds = candidates
      .map((utxo) => utxo.token?.tokenId)
      .filter((tokenId): tokenId is string => Boolean(tokenId))
      .map((tokenId) => tokenId.toLowerCase())
    console.info('[NFT] Total UTXOs:', allUtxos.length)
    console.info('[NFT] Token UTXOs:', tokenUtxos.length)
    console.info('[NFT] NFT child UTXOs found:', candidates.length)
    console.info('[NFT] NFT tokenIds found:', tokenIds)
  }

  const uniqueUtxos: ScriptUtxo[] = []
  const seenTokenIds = new Set<string>()
  for (const utxo of candidates) {
    const tokenId = utxo.token?.tokenId
    if (!tokenId) continue
    const normalizedTokenId = tokenId.toLowerCase()
    if (seenTokenIds.has(normalizedTokenId)) continue
    seenTokenIds.add(normalizedTokenId)
    uniqueUtxos.push(utxo)
  }

  const details = await Promise.all(
    uniqueUtxos.map(async (utxo) => {
      const tokenId = utxo.token?.tokenId || ''
      try {
        const info = await fetchNftDetails(tokenId, { refreshMetadata: options.refreshMetadata })
        const name = String(info.metadata?.name || info.genesisInfo?.tokenName || 'NFT sin nombre')
        return {
          tokenId,
          name,
          imageUrl: info.imageUrl || '',
          imageCid: info.imageCid,
          metadataCid: info.metadataCid,
          metadata: info.metadata,
          genesisInfo: info.genesisInfo
        }
      } catch (err) {
        if (shouldLogNftDebug()) {
          console.warn('[NFT] Failed to load NFT details', tokenId, err)
        }
        return {
          tokenId,
          name: `NFT ${tokenId.slice(0, 6)}`,
          imageUrl: '',
          genesisInfo: undefined
        }
      }
    })
  )

  return details
}

export const sendNft = async (params: {
  tokenId: string
  destinationAddress: string
}): Promise<{ txid: string }> => {
  const walletKeyInfo = xolosWalletService.getKeyInfo()
  const address = walletKeyInfo.xecAddress ?? walletKeyInfo.address
  if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !address) {
    throw new Error('No pudimos acceder a las llaves de tu billetera.')
  }

  return sendNftChild({
    address,
    keyInfo: {
      privateKeyHex: walletKeyInfo.privateKeyHex,
      publicKeyHex: walletKeyInfo.publicKeyHex
    },
    tokenId: params.tokenId,
    destinationAddress: params.destinationAddress
  })
}
