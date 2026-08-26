import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { calcTxFee } from 'ecash-lib'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { getChronik } from '../services/ChronikClient'
import { EXTENDED_GAP_LIMIT } from '../services/XolosWalletService'
import {
  fetchOwnedNfts,
  mintXolosarmyNftChild,
  type NftAsset
} from '../services/nftService'
import {
  NFT_MINT_PLATFORM_FEE_SATS,
  NFT_MINT_PLATFORM_FEE_XEC,
  NFT_RESCAN_STORAGE_KEY
} from '../config/nfts'
import {
  NFT_COLLECTION_TRUST_REGISTRY,
  resolveNftCollectionParentTokenId,
  resolveRegisteredNftCollection,
  type CollectionId
} from '../domain/nftCollections'
import { countMintPassAtoms } from '../services/slpNftTxBuilder'
import { XEC_DUST_SATS, XEC_SATS_PER_XEC } from '../config/xecFees'
import {
  DEFAULT_IPFS_GATEWAY_BASE,
  getIpfsAssetUrl,
  ipfsToCid,
  ipfsToGatewayUrl,
  resolveIpfsGatewayBase
} from '../utils/ipfs'
import { WALLET_REFRESH_EVENT, type WalletRefreshDetail } from '../utils/walletRefresh'
import type { XolosLineage } from '../services/nftMetadata'
import { NftVerificationBadge } from '../features/nftVerification/NftVerificationBadge'
import { useNftVerification } from '../hooks/useNftVerification'

const FEE_PER_KB = 1200n
const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10

const COLLECTION_LABELS: Readonly<Record<CollectionId, string>> = Object.freeze({
  official: 'Official / Xolos Ramírez',
  community: 'xolosArmy Community'
})

const estimateMintFeeSats = (inputCount = 2, outputCount = 4) => {
  const txSize = TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE + outputCount * OUTPUT_SIZE
  return calcTxFee(txSize, FEE_PER_KB)
}

const formatTokenId = (tokenId: string) => `${tokenId.slice(0, 6)}...${tokenId.slice(-6)}`

function NftVerificationDetail({ nft, onClose }: { nft: NftAsset; onClose: () => void }) {
  const verificationState = useNftVerification(nft.tokenId)

  return (
    <section
      className="nft-verification-detail"
      aria-label={`Verificación on-chain de ${nft.name}`}
    >
      <div className="nft-verification-detail__header">
        <div>
          <p className="card-kicker">Verificación on-chain</p>
          <h2>{nft.name}</h2>
        </div>
        <NftVerificationBadge state={verificationState} />
      </div>
      <p className="muted nft-verification-detail__token">{nft.tokenId}</p>
      <p className="muted">
        El estado se obtiene exclusivamente del Genesis NFT1 observado por Chronik y del
        clasificador canónico. La metadata no determina esta señal.
      </p>
      <button className="cta ghost" type="button" onClick={onClose}>
        Cerrar detalle
      </button>
    </section>
  )
}

function Nfts() {
  const { address, initialized, backupVerified, loading, error, refreshBalances, rescanWallet } = useWallet()
  const [activeTab, setActiveTab] = useState<'owned' | 'mint' | 'collection'>('owned')
  const [nfts, setNfts] = useState<NftAsset[]>([])
  const [nftsLoading, setNftsLoading] = useState(false)
  const [nftsError, setNftsError] = useState<string | null>(null)
  const [imageObjectUrls, setImageObjectUrls] = useState<Record<string, string>>({})
  const [rescanBusy, setRescanBusy] = useState(false)
  const [selectedNftTokenId, setSelectedNftTokenId] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [externalUrl, setExternalUrl] = useState('')
  const [lineageEtapa, setLineageEtapa] = useState<'' | NonNullable<XolosLineage['etapa']>>('')
  const [lineageSexo, setLineageSexo] = useState('')
  const [lineageColor, setLineageColor] = useState('')
  const [lineageVariedad, setLineageVariedad] = useState('')
  const [lineageFechaNacimiento, setLineageFechaNacimiento] = useState('')
  const [lineageLugarNacimiento, setLineageLugarNacimiento] = useState('')
  const [lineageCriador, setLineageCriador] = useState('')
  const [lineagePadre, setLineagePadre] = useState('')
  const [lineageMadre, setLineageMadre] = useState('')
  const [lineageCamada, setLineageCamada] = useState('')
  const [lineageMicrochip, setLineageMicrochip] = useState('')
  const [lineageRegistroFcm, setLineageRegistroFcm] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [mintBusy, setMintBusy] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)
  const [mintTxid, setMintTxid] = useState<string | null>(null)
  const [mintTokenId, setMintTokenId] = useState<string | null>(null)

  const [selectedCollectionId, setSelectedCollectionId] = useState<CollectionId | null>(null)
  const [parentBalances, setParentBalances] = useState<Readonly<Record<CollectionId, bigint>>>({
    official: 0n,
    community: 0n
  })
  const [xecAvailableSats, setXecAvailableSats] = useState<bigint>(0n)
  const [parentTokenCopied, setParentTokenCopied] = useState(false)
  const didLogGateway = useRef(false)
  const selectedNft = useMemo(
    () => nfts.find((nft) => nft.tokenId === selectedNftTokenId) ?? null,
    [nfts, selectedNftTokenId]
  )
  const selectedParentTokenId = useMemo(
    () =>
      selectedCollectionId === null
        ? null
        : resolveNftCollectionParentTokenId(selectedCollectionId),
    [selectedCollectionId]
  )
  const selectedCollectionLabel =
    selectedCollectionId === null ? 'Sin seleccionar' : COLLECTION_LABELS[selectedCollectionId]
  const parentBalance = selectedCollectionId === null ? 0n : parentBalances[selectedCollectionId]

  useEffect(() => {
    if (!imageFile) {
      setImagePreview(null)
      return
    }
    const url = URL.createObjectURL(imageFile)
    setImagePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [imageFile])

  const loadNfts = useCallback(
    async (options: { refreshMetadata?: boolean } = {}) => {
      if (!address) return
      setNftsLoading(true)
      setNftsError(null)
      try {
        const owned = await fetchOwnedNfts(address, { refreshMetadata: options.refreshMetadata })
        setNfts(owned)
      } catch (err) {
        setNftsError((err as Error).message || 'No pudimos cargar tus NFTs.')
      } finally {
        setNftsLoading(false)
      }
    },
    [address]
  )

  const loadBalances = useCallback(async () => {
    if (!address) return
    try {
      const utxos = await getChronik().address(address).utxos()
      let xecSats = 0n
      for (const utxo of utxos.utxos) {
        if (!utxo.token) {
          xecSats += utxo.sats
        }
      }
      setParentBalances({
        official: countMintPassAtoms(
          utxos.utxos,
          resolveNftCollectionParentTokenId('official')
        ),
        community: countMintPassAtoms(
          utxos.utxos,
          resolveNftCollectionParentTokenId('community')
        )
      })
      setXecAvailableSats(xecSats)
    } catch {
      setParentBalances({ official: 0n, community: 0n })
      setXecAvailableSats(0n)
    }
  }, [address])

  const handleRescanNfts = useCallback(async () => {
    if (!initialized) return
    setRescanBusy(true)
    setNftsError(null)
    try {
      await rescanWallet({ gapLimit: EXTENDED_GAP_LIMIT })
      await refreshBalances()
      await loadNfts({ refreshMetadata: true })
      await loadBalances()
    } catch (err) {
      setNftsError((err as Error).message || 'No pudimos re-escanear tus NFTs.')
    } finally {
      setRescanBusy(false)
    }
  }, [initialized, loadBalances, loadNfts, refreshBalances, rescanWallet])

  useEffect(() => {
    if (!initialized) return
    loadNfts()
    loadBalances()
  }, [initialized, loadBalances, loadNfts])

  useEffect(() => {
    if (!initialized || typeof window === 'undefined') return
    const pending = localStorage.getItem(NFT_RESCAN_STORAGE_KEY)
    if (!pending) return
    localStorage.removeItem(NFT_RESCAN_STORAGE_KEY)
    void handleRescanNfts()
  }, [handleRescanNfts, initialized])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<WalletRefreshDetail>).detail ?? {}
      if (!detail.refreshNfts) return
      void handleRescanNfts()
    }
    window.addEventListener(WALLET_REFRESH_EVENT, handler as EventListener)
    return () => window.removeEventListener(WALLET_REFRESH_EVENT, handler as EventListener)
  }, [handleRescanNfts])

  const ipfsGatewayBase = useMemo(() => resolveIpfsGatewayBase(), [])
  const estimatedFeeSats = useMemo(() => estimateMintFeeSats(), [])
  const estimatedTotalSats = useMemo(
    () => BigInt(NFT_MINT_PLATFORM_FEE_SATS) + BigInt(XEC_DUST_SATS) + estimatedFeeSats,
    [estimatedFeeSats]
  )

  useEffect(() => {
    let isActive = true
    const createdUrls: string[] = []
    const controllers: AbortController[] = []

    setImageObjectUrls({})

    const loadImage = async (nft: NftAsset) => {
      if (!nft.imageCid) return
      const assetUrl = getIpfsAssetUrl(nft.imageCid, ipfsGatewayBase)
      const controller = new AbortController()
      controllers.push(controller)
      try {
        const response = await fetch(assetUrl, { mode: 'cors', signal: controller.signal })
        if (!response.ok) {
          throw new Error('Failed to load image')
        }
        const blob = await response.blob()
        if (!isActive) return
        const objectUrl = URL.createObjectURL(blob)
        createdUrls.push(objectUrl)
        setImageObjectUrls((prev) => ({ ...prev, [nft.tokenId]: objectUrl }))
      } catch {
        // Fallback to direct URL rendering.
      }
    }

    nfts.forEach((nft) => {
      void loadImage(nft)
    })

    return () => {
      isActive = false
      controllers.forEach((controller) => controller.abort())
      createdUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [nfts, ipfsGatewayBase])

  useEffect(() => {
    if (!import.meta.env.DEV || didLogGateway.current) return
    didLogGateway.current = true
    console.info('IPFS gateway base:', ipfsGatewayBase, 'fallback:', DEFAULT_IPFS_GATEWAY_BASE)
  }, [ipfsGatewayBase])

  const hasParentToken = parentBalance >= 1n
  const hasEnoughXec = xecAvailableSats >= estimatedTotalSats

  const handleCopyParentTokenId = async () => {
    if (selectedParentTokenId === null) return
    try {
      await navigator.clipboard.writeText(selectedParentTokenId)
      setParentTokenCopied(true)
      setTimeout(() => setParentTokenCopied(false), 1500)
    } catch (err) {
      console.error(err)
    }
  }

  const handleMint = async (event: React.FormEvent) => {
    event.preventDefault()
    setMintError(null)
    setMintTxid(null)
    setMintTokenId(null)

    if (!initialized || !backupVerified) {
      setMintError('Completa el onboarding y el respaldo antes de mintear.')
      return
    }
    if (selectedCollectionId === null) {
      setMintError('Selecciona Official o Community antes de mintear.')
      return
    }
    const collectionId = selectedCollectionId
    if (!name.trim()) {
      setMintError('Ingresa un nombre para el NFT.')
      return
    }
    if (!description.trim()) {
      setMintError('Ingresa una descripción para el NFT.')
      return
    }
    if (!imageFile) {
      setMintError('Debes subir una imagen para el NFT.')
      return
    }
    if (!hasParentToken) {
      setMintError(`Necesitas 1 Mint Pass de ${selectedCollectionLabel} para mintear un NFT.`)
      return
    }
    if (!hasEnoughXec) {
      setMintError('No hay suficientes XEC para cubrir la plataforma y la fee de red.')
      return
    }

    setMintBusy(true)
    try {
      const lineagePayload: XolosLineage = {
        etapa: lineageEtapa || undefined,
        sexo: lineageSexo.trim() || undefined,
        color: lineageColor.trim() || undefined,
        variedad: lineageVariedad.trim() || undefined,
        fechaNacimiento: lineageFechaNacimiento || undefined,
        lugarNacimiento: lineageLugarNacimiento.trim() || undefined,
        criador: lineageCriador.trim() || undefined,
        padre: lineagePadre.trim() || undefined,
        madre: lineageMadre.trim() || undefined,
        camada: lineageCamada.trim() || undefined,
        microchip: lineageMicrochip.trim() || undefined,
        registroFCM: lineageRegistroFcm.trim() || undefined
      }
      const hasLineageData = Object.values(lineagePayload).some((value) => typeof value !== 'undefined')

      const result = await mintXolosarmyNftChild({
        collectionId,
        name: name.trim(),
        description: description.trim(),
        imageFile,
        externalUrl: externalUrl.trim() || undefined,
        lineage: hasLineageData ? lineagePayload : undefined
      })
      setMintTxid(result.txid)
      setMintTokenId(result.childTokenId)
      await refreshBalances()
      await loadNfts()
      await loadBalances()
      setName('')
      setDescription('')
      setExternalUrl('')
      setLineageEtapa('')
      setLineageSexo('')
      setLineageColor('')
      setLineageVariedad('')
      setLineageFechaNacimiento('')
      setLineageLugarNacimiento('')
      setLineageCriador('')
      setLineagePadre('')
      setLineageMadre('')
      setLineageCamada('')
      setLineageMicrochip('')
      setLineageRegistroFcm('')
      setImageFile(null)
    } catch (err) {
      setMintError((err as Error).message || 'No pudimos mintear el NFT.')
    } finally {
      setMintBusy(false)
    }
  }

  if (!initialized) {
    return (
      <div className="page">
        <TopBar />
        <h1 className="section-title">NFTs</h1>
        <p className="muted">Configura tu wallet para mintear y mover NFTs.</p>
        <div className="actions">
          <Link className="cta primary" to="/onboarding">
            Ir a onboarding
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">NFTs de linaje</p>
          <h1 className="section-title">NFTs de linaje y coleccionables</h1>
          <p className="muted">Crea, verifica y mueve NFTs desde tu wallet no custodial.</p>
        </div>
        <div className="pill pill-ghost">2 colecciones on-chain</div>
      </header>

      <div className="card">
        <div className="actions" style={{ marginBottom: 12 }}>
          <button
            className={`cta ${activeTab === 'owned' ? 'primary' : 'ghost'}`}
            type="button"
            onClick={() => setActiveTab('owned')}
          >
            Mis NFTs
          </button>
          <button
            className={`cta ${activeTab === 'mint' ? 'primary' : 'ghost'}`}
            type="button"
            onClick={() => setActiveTab('mint')}
          >
            Mintear NFT
          </button>
          <button
            className={`cta ${activeTab === 'collection' ? 'primary' : 'ghost'}`}
            type="button"
            onClick={() => setActiveTab('collection')}
          >
            Colección
          </button>
          {activeTab === 'owned' && (
            <button
              className="cta ghost"
              type="button"
              onClick={handleRescanNfts}
              disabled={rescanBusy || nftsLoading}
            >
              {rescanBusy ? 'Re-escanear NFTs...' : 'Rescan NFTs'}
            </button>
          )}
        </div>

        {activeTab === 'owned' && (
          <div>
            {nftsLoading && <div className="muted">Cargando NFTs...</div>}
            {nftsError && <div className="error">{nftsError}</div>}
            {!nftsLoading && nfts.length === 0 && <div className="muted">Aún no tienes NFTs en esta wallet.</div>}
            {/* Dev check: start app, open /nfts, verify token name/ticker render and Open on IPFS opens. */}

            {selectedNft && (
              <NftVerificationDetail
                key={selectedNft.tokenId}
                nft={selectedNft}
                onClose={() => setSelectedNftTokenId(null)}
              />
            )}

            <div className="grid" style={{ marginTop: 12 }}>
              {nfts.map((nft) => (
                <div className="card nft-card" key={nft.tokenId}>
                  <div className="nft-thumb">
                    {nft.imageUrl || nft.imageCid ? (
                      <img
                        src={
                          imageObjectUrls[nft.tokenId] ||
                          (nft.imageCid
                            ? getIpfsAssetUrl(nft.imageCid, ipfsGatewayBase)
                            : nft.imageUrl)
                        }
                        alt={nft.name}
                      />
                    ) : (
                      <div className="nft-placeholder">Sin imagen</div>
                    )}
                  </div>
                  <h3>{nft.name}</h3>
                  <p className="muted">{formatTokenId(nft.tokenId)}</p>
                  <p className="muted">Ticker: {nft.genesisInfo?.tokenTicker || '—'}</p>
                  <p className="muted">Nombre: {nft.genesisInfo?.tokenName || '—'}</p>
                  <p className="muted">Decimales: {nft.genesisInfo?.decimals ?? '—'}</p>
                  {(() => {
                    const tokenUrl = nft.genesisInfo?.url
                    const metadataCid = nft.metadataCid || (tokenUrl ? ipfsToCid(tokenUrl) || undefined : undefined)
                    const metadataGateway =
                      (tokenUrl ? ipfsToGatewayUrl(tokenUrl, ipfsGatewayBase) : null) ||
                      (metadataCid ? getIpfsAssetUrl(metadataCid, ipfsGatewayBase) : null)
                    const metadataLink =
                      metadataGateway ||
                      (tokenUrl && (tokenUrl.startsWith('http://') || tokenUrl.startsWith('https://'))
                        ? tokenUrl
                        : null)
                    const metadataLinkLabel = metadataGateway ? 'Open on IPFS gateway' : 'Abrir enlace'
                    const imageGateway = nft.imageCid ? getIpfsAssetUrl(nft.imageCid, ipfsGatewayBase) : undefined
                    if (!tokenUrl && !metadataGateway) {
                      return <p className="muted">Documento: —</p>
                    }
                    return (
                      <div style={{ marginTop: 6 }}>
                        {metadataLink && (
                          <a className="cta ghost" href={metadataLink} target="_blank" rel="noreferrer">
                            {metadataLinkLabel}
                          </a>
                        )}
                        {imageGateway && (
                          <a className="cta ghost" href={imageGateway} target="_blank" rel="noreferrer">
                            Open image on IPFS
                          </a>
                        )}
                        <div
                          className="muted"
                          style={{
                            marginTop: 6,
                            fontFamily: "'Source Code Pro', 'SFMono-Regular', monospace",
                            fontSize: 12
                          }}
                        >
                          {tokenUrl}
                        </div>
                      </div>
                    )
                  })()}
                  <div className="actions" style={{ marginTop: 12 }}>
                    <button
                      className="cta primary"
                      type="button"
                      aria-pressed={selectedNftTokenId === nft.tokenId}
                      onClick={() => setSelectedNftTokenId(nft.tokenId)}
                    >
                      Verificar linaje
                    </button>
                    <Link className="cta outline" to={`/send-nft?tokenId=${nft.tokenId}`}>
                      Enviar
                    </Link>
                    <Link className="cta ghost" to={`/dex?mode=nft&tokenId=${nft.tokenId}`}>
                      Vender en DEX
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === 'mint' && (
          <form onSubmit={handleMint} style={{ marginTop: 12 }}>
            <fieldset className="card" style={{ marginBottom: 12 }} disabled={mintBusy}>
              <legend className="card-kicker">Selecciona la colección</legend>
              <label htmlFor="nftCollectionOfficial">
                <input
                  id="nftCollectionOfficial"
                  type="radio"
                  name="nftCollection"
                  value="official"
                  checked={selectedCollectionId === 'official'}
                  onChange={() => {
                    setSelectedCollectionId('official')
                    setMintError(null)
                    setMintTxid(null)
                    setMintTokenId(null)
                  }}
                />{' '}
                Official / Xolos Ramírez
              </label>
              <p className="muted" style={{ marginTop: 6 }}>
                Colección oficial de linaje verificado por su ascendencia NFT1 on-chain.
              </p>
              <label htmlFor="nftCollectionCommunity" style={{ marginTop: 12, display: 'block' }}>
                <input
                  id="nftCollectionCommunity"
                  type="radio"
                  name="nftCollection"
                  value="community"
                  checked={selectedCollectionId === 'community'}
                  onChange={() => {
                    setSelectedCollectionId('community')
                    setMintError(null)
                    setMintTxid(null)
                    setMintTokenId(null)
                  }}
                />{' '}
                xolosArmy Community
              </label>
              <p className="muted" style={{ marginTop: 6 }}>
                Colección comunitaria distinta. Un NFT Community no es automáticamente un NFT de
                linaje Official de Xolos Ramírez.
              </p>
              <p className="muted" style={{ marginTop: 10 }}>
                La metadata describe. La blockchain demuestra. La pertenencia depende del Parent
                NFT1 consumido en el Genesis del Child.
              </p>
            </fieldset>

            <div className="card highlight" style={{ marginBottom: 12 }}>
              <p className="card-kicker">Mint Pass · {selectedCollectionLabel}</p>
              <p>1 Mint Pass = 1 NFT · Al mintear se consume 1 Parent Token.</p>
              <div className="address-box" style={{ marginTop: 8 }}>
                {selectedParentTokenId ?? 'Selecciona una colección'}
              </div>
              {selectedCollectionId !== null && !hasParentToken && (
                <div className="error" style={{ marginTop: 8 }}>
                  Necesitas 1 Mint Pass de {selectedCollectionLabel} para mintear.
                </div>
              )}
              {selectedCollectionId !== null && !hasParentToken && (
                <div className="actions" style={{ marginTop: 12 }}>
                  <Link
                    className="cta primary"
                    to={`/dex?mode=mintpass&collectionId=${selectedCollectionId}`}
                  >
                    Conseguir Mint Pass de {selectedCollectionLabel}
                  </Link>
                </div>
              )}
            </div>
            <label htmlFor="nftName">Nombre</label>
            <input id="nftName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Linaje #23" />

            <label htmlFor="nftDescription" style={{ marginTop: 12 }}>
              Descripción
            </label>
            <textarea
              id="nftDescription"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Relato del NFT"
              rows={3}
            />

            <label htmlFor="nftExternal" style={{ marginTop: 12 }}>
              External URL (opcional)
            </label>
            <input
              id="nftExternal"
              value={externalUrl}
              onChange={(e) => setExternalUrl(e.target.value)}
              placeholder="https://..."
            />

            <div className="card" style={{ marginTop: 12 }}>
              <p className="card-kicker">
                {selectedCollectionId === 'official'
                  ? 'Lineage (opcional)'
                  : 'Datos descriptivos (opcional)'}
              </p>
              {selectedCollectionId === 'community' && (
                <p className="muted">
                  Estos campos no convierten un NFT Community en Official ni establecen confianza.
                </p>
              )}
              <label htmlFor="nftEtapa">Etapa</label>
              <select
                id="nftEtapa"
                value={lineageEtapa}
                onChange={(e) =>
                  setLineageEtapa(e.target.value as '' | NonNullable<XolosLineage['etapa']>)
                }
              >
                <option value="">Seleccionar etapa</option>
                <option value="adulto">Adulto</option>
                <option value="joven">Joven</option>
                <option value="recien-nacido">Recién nacido</option>
              </select>

              <label htmlFor="nftSexo" style={{ marginTop: 12 }}>
                Sexo
              </label>
              <input
                id="nftSexo"
                value={lineageSexo}
                onChange={(e) => setLineageSexo(e.target.value)}
                placeholder="Ej. Hembra"
              />

              <label htmlFor="nftColor" style={{ marginTop: 12 }}>
                Color
              </label>
              <input
                id="nftColor"
                value={lineageColor}
                onChange={(e) => setLineageColor(e.target.value)}
                placeholder="Ej. Negro"
              />

              <label htmlFor="nftVariedad" style={{ marginTop: 12 }}>
                Variedad
              </label>
              <input
                id="nftVariedad"
                value={lineageVariedad}
                onChange={(e) => setLineageVariedad(e.target.value)}
                placeholder="Ej. Sin pelo"
              />

              <label htmlFor="nftFechaNacimiento" style={{ marginTop: 12 }}>
                Fecha de nacimiento
              </label>
              <input
                id="nftFechaNacimiento"
                type="date"
                value={lineageFechaNacimiento}
                onChange={(e) => setLineageFechaNacimiento(e.target.value)}
              />

              <label htmlFor="nftLugarNacimiento" style={{ marginTop: 12 }}>
                Lugar de nacimiento
              </label>
              <input
                id="nftLugarNacimiento"
                value={lineageLugarNacimiento}
                onChange={(e) => setLineageLugarNacimiento(e.target.value)}
                placeholder="Ciudad / Estado"
              />

              <label htmlFor="nftCriador" style={{ marginTop: 12 }}>
                Criador
              </label>
              <input
                id="nftCriador"
                value={lineageCriador}
                onChange={(e) => setLineageCriador(e.target.value)}
                placeholder="Nombre del criador"
              />

              <label htmlFor="nftPadre" style={{ marginTop: 12 }}>
                Padre
              </label>
              <input
                id="nftPadre"
                value={lineagePadre}
                onChange={(e) => setLineagePadre(e.target.value)}
                placeholder="Nombre del padre"
              />

              <label htmlFor="nftMadre" style={{ marginTop: 12 }}>
                Madre
              </label>
              <input
                id="nftMadre"
                value={lineageMadre}
                onChange={(e) => setLineageMadre(e.target.value)}
                placeholder="Nombre de la madre"
              />

              <label htmlFor="nftCamada" style={{ marginTop: 12 }}>
                Camada
              </label>
              <input
                id="nftCamada"
                value={lineageCamada}
                onChange={(e) => setLineageCamada(e.target.value)}
                placeholder="Ej. Camada B"
              />

              <label htmlFor="nftMicrochip" style={{ marginTop: 12 }}>
                Microchip
              </label>
              <input
                id="nftMicrochip"
                value={lineageMicrochip}
                onChange={(e) => setLineageMicrochip(e.target.value)}
                placeholder="ID de microchip"
              />

              <label htmlFor="nftRegistroFcm" style={{ marginTop: 12 }}>
                Registro FCM
              </label>
              <input
                id="nftRegistroFcm"
                value={lineageRegistroFcm}
                onChange={(e) => setLineageRegistroFcm(e.target.value)}
                placeholder="Número de registro"
              />
            </div>

            <label htmlFor="nftImage" style={{ marginTop: 12 }}>
              Imagen
            </label>
            <input
              id="nftImage"
              type="file"
              accept="image/*"
              onChange={(e) => setImageFile(e.target.files?.[0] || null)}
            />

            {imagePreview && (
              <div className="nft-preview" style={{ marginTop: 12 }}>
                <img src={imagePreview} alt="Preview NFT" />
              </div>
            )}

            <div className="mint-cost" style={{ marginTop: 12 }}>
              <p>Plataforma: {NFT_MINT_PLATFORM_FEE_XEC.toLocaleString()} XEC</p>
              <p>Red (estimada): {(Number(estimatedFeeSats) / XEC_SATS_PER_XEC).toFixed(2)} XEC</p>
              <p>
                Total estimado: {(Number(estimatedTotalSats) / XEC_SATS_PER_XEC).toFixed(2)} XEC
              </p>
            </div>

            <div className="card" style={{ marginTop: 12 }} aria-label="Resumen antes de firmar">
              <p className="card-kicker">Resumen antes de firmar</p>
              <p>Colección: {selectedCollectionLabel}</p>
              <p className="muted">Parent NFT1 Group que se consumirá:</p>
              <div className="address-box">{selectedParentTokenId ?? 'Selecciona una colección'}</div>
              <p className="muted" style={{ marginTop: 8 }}>
                Mint Pass: exactamente 1 Group atom SLP NFT1 tipo 129.
              </p>
              <p className="muted">Resultado: NFT1 Child SLP tipo 65 ligado on-chain a ese Parent.</p>
              <p className="muted">
                Metadata: {name.trim() || 'Sin nombre'} · {description.trim() || 'Sin descripción'} ·{' '}
                {imageFile?.name || 'Sin imagen'}
              </p>
              <p className="muted">
                Plataforma: {NFT_MINT_PLATFORM_FEE_XEC.toLocaleString()} XEC · Red estimada:{' '}
                {(Number(estimatedFeeSats) / XEC_SATS_PER_XEC).toFixed(2)} XEC
              </p>
            </div>

            {selectedCollectionId !== null && !hasParentToken && (
              <div className="error">
                Necesitas 1 Mint Pass de {selectedCollectionLabel} para mintear.
              </div>
            )}
            {!hasEnoughXec && (
              <div className="error">No hay suficientes XEC para cubrir el fee de plataforma y red.</div>
            )}

            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="cta primary"
                type="submit"
                disabled={
                  !backupVerified ||
                  mintBusy ||
                  selectedCollectionId === null ||
                  !hasParentToken ||
                  !hasEnoughXec
                }
              >
                {mintBusy ? 'Subiendo y minteando...' : 'Subir a IPFS + Mintear'}
              </button>
            </div>

            {(mintError || error) && <div className="error">{mintError || error}</div>}
            {mintTxid && (
              <div className="success" style={{ marginTop: 12 }}>
                NFT minteado: <span className="address-box">{mintTokenId}</span>
                <div className="muted" style={{ marginTop: 6 }}>
                  Txid: {mintTxid}
                </div>
              </div>
            )}
          </form>
        )}

        {activeTab === 'collection' && (
          <div style={{ marginTop: 12 }}>
            <div className="card" style={{ marginBottom: 12 }}>
              <p className="card-kicker">Colecciones</p>
              <h2>Official y Community</h2>
              <p className="muted">
                Son colecciones criptográficamente distintas. La metadata describe; la blockchain
                demuestra su ascendencia NFT1.
              </p>
            </div>
            {(Object.keys(NFT_COLLECTION_TRUST_REGISTRY) as CollectionId[]).map((collectionId) => {
              const collection = resolveRegisteredNftCollection(collectionId)
              return (
                <div className="card" key={collectionId} style={{ marginBottom: 12 }}>
                  <p className="card-kicker">{COLLECTION_LABELS[collectionId]}</p>
                  <p className="muted">Parent Token ID</p>
                  <div className="address-box">{collection.parentTokenId}</div>
                  <p className="muted" style={{ marginTop: 12 }}>
                    Balance Mint Pass: {parentBalances[collectionId].toString()}
                  </p>
                  <div className="actions" style={{ marginTop: 8 }}>
                    <button
                      className="cta primary"
                      type="button"
                      onClick={() => {
                        setSelectedCollectionId(collectionId)
                        setActiveTab('mint')
                      }}
                    >
                      Seleccionar para mintear
                    </button>
                    {collectionId === selectedCollectionId && (
                      <button className="cta ghost" type="button" onClick={handleCopyParentTokenId}>
                        {parentTokenCopied ? 'Token ID copiado' : 'Copiar Token ID'}
                      </button>
                    )}
                  </div>
                  <p className="muted" style={{ marginTop: 6 }}>
                    Cada minteo consume 1 Group atom de esta colección.
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {loading && <div className="muted">Actualizando saldos...</div>}
    </div>
  )
}

export default Nfts
