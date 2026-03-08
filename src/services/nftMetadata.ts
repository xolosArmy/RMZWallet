import { XOLOSARMY_NFT_PARENT_TOKEN_ID } from '../config/nfts'
import { ipfsToGatewayUrl } from '../utils/ipfs'

export type XolosLineage = {
  slug?: string
  etapa?: 'adulto' | 'joven' | 'recien-nacido'
  sexo?: string
  color?: string
  variedad?: string
  fechaNacimiento?: string
  lugarNacimiento?: string
  criador?: string
  padre?: string
  madre?: string
  camada?: string
  microchip?: string
  registroFCM?: string
}

export type XolosarmyMetadataParams = {
  name: string
  description: string
  imageCid: string
  externalUrl?: string
  attributes?: Array<Record<string, unknown>>
  lineage?: XolosLineage
}

const normalizeOptionalString = (value: string | undefined): string | undefined => {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

const buildLineageMetadata = (lineage?: XolosLineage): XolosLineage | undefined => {
  if (!lineage) return undefined
  const cleaned: XolosLineage = {
    slug: normalizeOptionalString(lineage.slug),
    etapa: lineage.etapa,
    sexo: normalizeOptionalString(lineage.sexo),
    color: normalizeOptionalString(lineage.color),
    variedad: normalizeOptionalString(lineage.variedad),
    fechaNacimiento: normalizeOptionalString(lineage.fechaNacimiento),
    lugarNacimiento: normalizeOptionalString(lineage.lugarNacimiento),
    criador: normalizeOptionalString(lineage.criador),
    padre: normalizeOptionalString(lineage.padre),
    madre: normalizeOptionalString(lineage.madre),
    camada: normalizeOptionalString(lineage.camada),
    microchip: normalizeOptionalString(lineage.microchip),
    registroFCM: normalizeOptionalString(lineage.registroFCM)
  }
  const hasAnyField = Object.values(cleaned).some((value) => typeof value !== 'undefined')
  return hasAnyField ? cleaned : undefined
}

const hasTrait = (attributes: Array<Record<string, unknown>>, traitType: string) =>
  attributes.some((attribute) => attribute.trait_type === traitType)

const appendLineageTraits = (attributes: Array<Record<string, unknown>>, lineage?: XolosLineage) => {
  if (!lineage) return attributes
  const mirroredTraits: Array<{ trait_type: string; value: string | undefined }> = [
    { trait_type: 'Sexo', value: lineage.sexo },
    { trait_type: 'Variedad', value: lineage.variedad },
    { trait_type: 'Etapa', value: lineage.etapa }
  ]
  const nextAttributes = [...attributes]
  for (const trait of mirroredTraits) {
    const value = normalizeOptionalString(trait.value)
    if (!value || hasTrait(nextAttributes, trait.trait_type)) continue
    nextAttributes.push({ trait_type: trait.trait_type, value })
  }
  return nextAttributes
}

export const buildXolosarmyNftMetadata = ({
  name,
  description,
  imageCid,
  externalUrl,
  attributes = [],
  lineage
}: XolosarmyMetadataParams) => {
  const lineageMetadata = buildLineageMetadata(lineage)
  const metadata = {
    name,
    description,
    image: `ipfs://${imageCid}`,
    external_url: externalUrl,
    collection: {
      name: 'xolosArmy NFTs',
      family: 'Xolos Ramírez'
    },
    attributes: appendLineageTraits(attributes, lineageMetadata),
    lineage: lineageMetadata,
    parent: XOLOSARMY_NFT_PARENT_TOKEN_ID,
    app: 'Tonalli RMZWallet',
    schema_version: lineageMetadata ? '1.1.0' : undefined
  }
  return metadata
}

export const getIpfsUrl = (cidOrIpfsUri: string, gateway?: string): string => {
  if (!cidOrIpfsUri) return ''
  if (cidOrIpfsUri.startsWith('http://') || cidOrIpfsUri.startsWith('https://')) {
    return cidOrIpfsUri
  }
  return ipfsToGatewayUrl(cidOrIpfsUri, gateway) || ''
}
