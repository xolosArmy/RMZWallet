import { XOLOSARMY_NFT_PARENT_TOKEN_ID } from '../config/nfts'
import { ipfsToGatewayUrl } from '../utils/ipfs'

export type XolosarmyMetadataParams = {
  name: string
  description: string
  imageCid: string
  externalUrl?: string
  attributes?: Array<Record<string, unknown>>
}

export const buildXolosarmyNftMetadata = ({
  name,
  description,
  imageCid,
  externalUrl,
  attributes = []
}: XolosarmyMetadataParams) => {
  return {
    name,
    description,
    image: `ipfs://${imageCid}`,
    external_url: externalUrl,
    collection: {
      name: 'xolosArmy NFTs',
      family: 'XolosArmy'
    },
    attributes,
    parent: XOLOSARMY_NFT_PARENT_TOKEN_ID,
    app: 'Tonalli RMZWallet'
  }
}

export const getIpfsUrl = (cidOrIpfsUri: string, gateway?: string): string => {
  if (!cidOrIpfsUri) return ''
  if (cidOrIpfsUri.startsWith('http://') || cidOrIpfsUri.startsWith('https://')) {
    return cidOrIpfsUri
  }
  return ipfsToGatewayUrl(cidOrIpfsUri, gateway) || ''
}
