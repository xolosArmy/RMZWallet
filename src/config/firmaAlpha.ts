import type { TokenInfo } from 'chronik-client'

export type VerifiedDexAsset = Readonly<{
  tokenId: string
  displayName: string
  onChainName: string
  ticker: string
  protocol: 'ALP'
  tokenType: number
  decimals: number
  genesisAuthPubkeyHex: string
  officialLiquidityPubkeyHex?: string
  redeemAddress: string
}>

/**
 * Canonical Firma Alpha identity.
 *
 * Keep this definition tied to the genesis transaction. A ticker or display
 * name is never enough to identify FIRMA; every wallet and Agora path must
 * match tokenId as well as the ALP token metadata below.
 */
export const FIRMA_ALPHA: VerifiedDexAsset = Object.freeze({
  tokenId: '0387947fd575db4fb19a3e322f635dec37fd192b5941625b66bc4b2c3008cbf0',
  displayName: 'Firma Alpha',
  onChainName: 'Firma',
  ticker: 'FIRMA',
  protocol: 'ALP',
  tokenType: 0,
  decimals: 4,
  genesisAuthPubkeyHex: '03fba49912622cf8bb5b3729b1b5da3e72c6b57d369c8647f6cc7c6cbed510d105',
  redeemAddress: 'ecash:qr8hdk8rxjc5nj6f450eth3nnslxa8k4gysrtyfxc5'
})

export const FIRMA_ALPHA_TOKEN_ID = FIRMA_ALPHA.tokenId

export function assertFirmaAlphaTokenInfo(tokenInfo: TokenInfo): TokenInfo {
  const tokenId = tokenInfo.tokenId.toLowerCase()
  const tokenType = tokenInfo.tokenType
  const genesis = tokenInfo.genesisInfo

  if (tokenId !== FIRMA_ALPHA.tokenId) {
    throw new Error('Token FIRMA falso: el Token ID no coincide con Firma Alpha.')
  }
  if (tokenType.protocol !== FIRMA_ALPHA.protocol || tokenType.number !== FIRMA_ALPHA.tokenType) {
    throw new Error('La génesis FIRMA no usa el estándar ALP esperado.')
  }
  if (genesis.decimals !== FIRMA_ALPHA.decimals) {
    throw new Error('La génesis FIRMA no tiene los 4 decimales canónicos.')
  }
  if (genesis.tokenTicker !== FIRMA_ALPHA.ticker || genesis.tokenName !== FIRMA_ALPHA.onChainName) {
    throw new Error('La metadata de la génesis FIRMA no coincide con la configuración canónica.')
  }
  if ((genesis.authPubkey || '').toLowerCase() !== FIRMA_ALPHA.genesisAuthPubkeyHex) {
    throw new Error('La clave de autoridad FIRMA no coincide con la génesis verificada.')
  }

  return tokenInfo
}
