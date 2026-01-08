const DEFAULT_PARENT = '170aa1303e761e132f40c861751905fee1148c213b8352435c89950d721909e9'
const DEFAULT_FEE_ADDR = 'ecash:qq7qn90ev23ecastqmn8as00u8mcp4tzsspvt5dtlk'

function getEnv(name: string): string | undefined {
  const viteEnv = (import.meta as any)?.env
  if (viteEnv && typeof viteEnv === 'object' && name in viteEnv) {
    return viteEnv[name]
  }
  if (typeof process !== 'undefined' && process?.env) {
    return process.env[name]
  }
  return undefined
}

export const XOLOSARMY_NFT_PARENT_TOKEN_ID =
  (import.meta as any)?.env?.VITE_XOLOSARMY_NFT_PARENT_TOKEN_ID || DEFAULT_PARENT

export const NFT_MINT_PLATFORM_FEE_XEC = 5500
export const NFT_MINT_PLATFORM_FEE_SATS = NFT_MINT_PLATFORM_FEE_XEC * 100

export const NFT_MINT_FEE_RECEIVER_ADDRESS =
  (import.meta as any)?.env?.VITE_NFT_MINT_FEE_RECEIVER_ADDRESS || DEFAULT_FEE_ADDR

export const DEFAULT_PINATA_GATEWAY =
  getEnv('VITE_PINATA_GATEWAY') || getEnv('PINATA_GATEWAY') || ''
