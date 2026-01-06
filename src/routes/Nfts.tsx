import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { calcTxFee } from 'ecash-lib'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { getChronik } from '../services/ChronikClient'
import {
  fetchOwnedNfts,
  mintXolosarmyNftChild,
  type NftAsset
} from '../services/nftService'
import {
  NFT_MINT_PLATFORM_FEE_SATS,
  NFT_MINT_PLATFORM_FEE_XEC,
  XOLOSARMY_NFT_PARENT_TOKEN_ID
} from '../config/nfts'
import { XEC_DUST_SATS, XEC_SATS_PER_XEC } from '../config/xecFees'

const SLP_NFT1_GROUP = 129
const FEE_PER_KB = 1200n
const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10

const estimateMintFeeSats = (inputCount = 2, outputCount = 4) => {
  const txSize = TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE + outputCount * OUTPUT_SIZE
  return calcTxFee(txSize, FEE_PER_KB)
}

const formatTokenId = (tokenId: string) => `${tokenId.slice(0, 6)}...${tokenId.slice(-6)}`

function Nfts() {
  const { address, initialized, backupVerified, loading, error, refreshBalances } = useWallet()
  const [activeTab, setActiveTab] = useState<'owned' | 'mint' | 'collection'>('owned')
  const [nfts, setNfts] = useState<NftAsset[]>([])
  const [nftsLoading, setNftsLoading] = useState(false)
  const [nftsError, setNftsError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [externalUrl, setExternalUrl] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [mintBusy, setMintBusy] = useState(false)
  const [mintError, setMintError] = useState<string | null>(null)
  const [mintTxid, setMintTxid] = useState<string | null>(null)
  const [mintTokenId, setMintTokenId] = useState<string | null>(null)

  const [parentBalance, setParentBalance] = useState<bigint>(0n)
  const [xecAvailableSats, setXecAvailableSats] = useState<bigint>(0n)
  const [parentTokenCopied, setParentTokenCopied] = useState(false)

  useEffect(() => {
    if (!imageFile) {
      setImagePreview(null)
      return
    }
    const url = URL.createObjectURL(imageFile)
    setImagePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [imageFile])

  const loadNfts = useCallback(async () => {
    if (!address) return
    setNftsLoading(true)
    setNftsError(null)
    try {
      const owned = await fetchOwnedNfts(address)
      setNfts(owned)
    } catch (err) {
      setNftsError((err as Error).message || 'No pudimos cargar tus NFTs.')
    } finally {
      setNftsLoading(false)
    }
  }, [address])

  const loadBalances = useCallback(async () => {
    if (!address) return
    try {
      const utxos = await getChronik().address(address).utxos()
      let parentAtoms = 0n
      let xecSats = 0n
      for (const utxo of utxos.utxos) {
        if (!utxo.token) {
          xecSats += utxo.sats
          continue
        }
        if (
          utxo.token.tokenId === XOLOSARMY_NFT_PARENT_TOKEN_ID &&
          utxo.token.tokenType.protocol === 'SLP' &&
          utxo.token.tokenType.number === SLP_NFT1_GROUP &&
          !utxo.token.isMintBaton
        ) {
          parentAtoms += utxo.token.atoms
        }
      }
      setParentBalance(parentAtoms)
      setXecAvailableSats(xecSats)
    } catch {
      setParentBalance(0n)
      setXecAvailableSats(0n)
    }
  }, [address])

  useEffect(() => {
    if (!initialized) return
    loadNfts()
    loadBalances()
  }, [initialized, loadBalances, loadNfts])

  const estimatedFeeSats = useMemo(() => estimateMintFeeSats(), [])
  const estimatedTotalSats = useMemo(
    () => BigInt(NFT_MINT_PLATFORM_FEE_SATS) + BigInt(XEC_DUST_SATS) + estimatedFeeSats,
    [estimatedFeeSats]
  )

  const hasParentToken = parentBalance >= 1n
  const hasEnoughXec = xecAvailableSats >= estimatedTotalSats

  const handleCopyParentTokenId = async () => {
    if (!XOLOSARMY_NFT_PARENT_TOKEN_ID) return
    try {
      await navigator.clipboard.writeText(XOLOSARMY_NFT_PARENT_TOKEN_ID)
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
      setMintError('Necesitas al menos 1 Mint Pass (Parent Token) para mintear un NFT.')
      return
    }
    if (!hasEnoughXec) {
      setMintError('No hay suficientes XEC para cubrir la plataforma y la fee de red.')
      return
    }

    setMintBusy(true)
    try {
      const result = await mintXolosarmyNftChild({
        name: name.trim(),
        description: description.trim(),
        imageFile,
        externalUrl: externalUrl.trim() || undefined
      })
      setMintTxid(result.txid)
      setMintTokenId(result.childTokenId)
      await refreshBalances()
      await loadNfts()
      await loadBalances()
      setName('')
      setDescription('')
      setExternalUrl('')
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
        <p className="muted">Configura tu billetera para mintear y mover NFTs.</p>
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
          <p className="eyebrow">Guardianía</p>
          <h1 className="section-title">xolosArmy NFTs</h1>
          <p className="muted">Crea, resguarda y mueve NFTs dentro del templo Tonalli.</p>
        </div>
        <div className="pill pill-ghost">Colección única</div>
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
        </div>

        {activeTab === 'owned' && (
          <div>
            {nftsLoading && <div className="muted">Cargando NFTs...</div>}
            {nftsError && <div className="error">{nftsError}</div>}
            {!nftsLoading && nfts.length === 0 && <div className="muted">Aún no tienes NFTs en tu guardianía.</div>}

            <div className="grid" style={{ marginTop: 12 }}>
              {nfts.map((nft) => (
                <div className="card nft-card" key={nft.tokenId}>
                  <div className="nft-thumb">
                    {nft.imageUrl ? (
                      <img src={nft.imageUrl} alt={nft.name} />
                    ) : (
                      <div className="nft-placeholder">Sin imagen</div>
                    )}
                  </div>
                  <h3>{nft.name}</h3>
                  <p className="muted">{formatTokenId(nft.tokenId)}</p>
                  <div className="actions" style={{ marginTop: 12 }}>
                    <Link className="cta outline" to={`/send-nft?tokenId=${nft.tokenId}`}>
                      Enviar
                    </Link>
                    <Link className="cta ghost" to={`/dex?nftTokenId=${nft.tokenId}`}>
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
            <div className="card highlight" style={{ marginBottom: 12 }}>
              <p className="card-kicker">Mint Pass</p>
              <p>1 Mint Pass = 1 NFT · Al mintear se consume 1 Parent Token.</p>
              {!hasParentToken && (
                <div className="error" style={{ marginTop: 8 }}>
                  Necesitas 1 Mint Pass (Parent Token) para mintear.
                </div>
              )}
              {!hasParentToken && (
                <div className="actions" style={{ marginTop: 12 }}>
                  <Link
                    className="cta primary"
                    to={`/dex?tokenId=${XOLOSARMY_NFT_PARENT_TOKEN_ID}&mode=mintpass`}
                  >
                    Conseguir Mint Pass
                  </Link>
                </div>
              )}
            </div>
            <label htmlFor="nftName">Nombre</label>
            <input id="nftName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Guardian #23" />

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

            {!hasParentToken && <div className="error">Necesitas 1 Mint Pass (Parent Token) para mintear.</div>}
            {!hasEnoughXec && (
              <div className="error">No hay suficientes XEC para cubrir el fee de plataforma y red.</div>
            )}

            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="cta primary"
                type="submit"
                disabled={!backupVerified || mintBusy || !hasParentToken || !hasEnoughXec}
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
              <p className="card-kicker">Colección</p>
              <h2>xolosArmy NFTs</h2>
              <p className="muted">Guardianía exclusiva de Tonalli.</p>
            </div>
            <div className="card">
              <p className="muted">Parent Token ID</p>
              <div className="address-box">{XOLOSARMY_NFT_PARENT_TOKEN_ID || 'Sin configurar'}</div>
              <div className="actions" style={{ marginTop: 8 }}>
                <button className="cta ghost" type="button" onClick={handleCopyParentTokenId}>
                  {parentTokenCopied ? 'Token ID copiado' : 'Copiar Token ID'}
                </button>
              </div>
              <p className="muted" style={{ marginTop: 12 }}>
                Balance Mint Pass: {parentBalance.toString()}
              </p>
              <p className="muted" style={{ marginTop: 6 }}>
                Cada minteo consume 1 Parent Token (Mint Pass).
              </p>
            </div>
          </div>
        )}
      </div>

      {loading && <div className="muted">Actualizando saldos...</div>}
    </div>
  )
}

export default Nfts
