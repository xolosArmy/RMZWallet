const DEFAULT_PARENT = 'bf8e0b5cd60fe4d6354c662b28542e0f3c3d69941eb039426d65bcdb7fe9f48c'
const DEFAULT_FEE_ADDR = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'

type ViteEnv = Record<string, string | undefined> & { DEV?: boolean }

function getEnv(name: string): string | undefined {
  const viteEnv = (import.meta as unknown as { env?: ViteEnv }).env ?? {}
  if (name in viteEnv) {
    return viteEnv[name]
  }
  const nodeEnv = (typeof process !== 'undefined' ? (process as { env?: ViteEnv }).env : undefined) ?? {}
  if (name in nodeEnv) {
    return nodeEnv[name]
  }
  return undefined
}

const resolvedParentTokenId = getEnv('VITE_XOLOSARMY_NFT_PARENT_TOKEN_ID') || DEFAULT_PARENT
const isValidTokenId = (tokenId: string) => /^[0-9a-fA-F]{64}$/.test(tokenId)

export const XOLOSARMY_NFT_PARENT_TOKEN_ID = resolvedParentTokenId
export const XOLOSARMY_NFT_PARENT_TOKEN_ID_ERROR =
  ((import.meta as unknown as { env?: ViteEnv }).env?.DEV ?? false) &&
  !isValidTokenId(resolvedParentTokenId)
    ? 'Invalid parent tokenId configuration'
    : ''

if ((import.meta as unknown as { env?: ViteEnv }).env?.DEV) {
  console.info('XOLOSARMY parent token id:', resolvedParentTokenId)
  if (!isValidTokenId(resolvedParentTokenId)) {
    console.warn('Invalid parent tokenId configuration')
  }
}

export const NFT_MINT_PLATFORM_FEE_XEC = 5500
export const NFT_MINT_PLATFORM_FEE_SATS = NFT_MINT_PLATFORM_FEE_XEC * 100

export const NFT_MINT_FEE_RECEIVER_ADDRESS =
  (import.meta as unknown as { env?: ViteEnv }).env?.VITE_NFT_MINT_FEE_RECEIVER_ADDRESS ||
  DEFAULT_FEE_ADDR

export const NFT_RESCAN_STORAGE_KEY = 'tonalli_nft_rescan_pending'

export const DEFAULT_PINATA_GATEWAY =
  getEnv('VITE_PINATA_GATEWAY') || getEnv('PINATA_GATEWAY') || ''
