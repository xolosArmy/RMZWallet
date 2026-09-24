import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import TopBar from '../components/TopBar'
import AliasResolutionStatus from '../components/AliasResolutionStatus'
import { useWallet } from '../context/useWallet'
import { useAliasResolution } from '../hooks/useAliasResolution'
import { fetchNftDetails, sendNft } from '../services/nftService'

function SendNft() {
  const { initialized, backupVerified, loading, error, refreshBalances } = useWallet()
  const [searchParams] = useSearchParams()
  const tokenId = searchParams.get('tokenId') || ''
  const [destination, setDestination] = useState('')
  const [txid, setTxid] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [nftName, setNftName] = useState<string>('')
  const [nftImage, setNftImage] = useState<string>('')
  const aliasResolution = useAliasResolution(destination)
  const canSubmit =
    initialized &&
    backupVerified &&
    !loading &&
    Boolean(tokenId) &&
    aliasResolution.status === 'confirmed' &&
    Boolean(aliasResolution.resolvedAddress)

  useEffect(() => {
    let active = true
    const load = async () => {
      if (!tokenId) return
      try {
        const info = await fetchNftDetails(tokenId)
        if (!active) return
        setNftName(String(info.metadata?.name || info.genesisInfo?.tokenName || 'NFT'))
        setNftImage(info.imageUrl || '')
      } catch {
        if (!active) return
        setNftName('NFT')
      }
    }
    load()
    return () => {
      active = false
    }
  }, [tokenId])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLocalError(null)
    setTxid(null)

    if (!initialized || !backupVerified) {
      setLocalError('Debes completar el onboarding y el respaldo de tu seed antes de enviar NFTs.')
      return
    }

    if (!tokenId) {
      setLocalError('Selecciona un NFT válido para enviar.')
      return
    }

    const destinationAddress = aliasResolution.resolvedAddress
    if (aliasResolution.status !== 'confirmed' || !destinationAddress) {
      setLocalError(aliasResolution.errorMessage || 'El destinatario debe resolverse antes de enviar.')
      return
    }

    try {
      const result = await sendNft({ tokenId, destinationAddress })
      setTxid(result.txid)
      await refreshBalances()
    } catch (err) {
      setLocalError((err as Error).message)
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Enviar</p>
          <h1 className="section-title">NFT hacia otra dirección</h1>
          <p className="muted">Transfiere tu NFT a otra wallet eCash después de verificar el token ID y la dirección.</p>
        </div>
        <Link className="cta ghost" to="/nfts">
          Volver a NFTs
        </Link>
      </header>

      <div className="card" style={{ marginBottom: 16 }}>
        <p className="card-kicker">NFT seleccionado</p>
        <div className="nft-inline">
          <div className="nft-thumb small">
            {nftImage ? <img src={nftImage} alt={nftName} /> : <div className="nft-placeholder">Sin imagen</div>}
          </div>
          <div>
            <h3>{nftName}</h3>
            <p className="muted">{tokenId || 'Sin tokenId'}</p>
          </div>
        </div>
      </div>

      <form className="card" onSubmit={handleSubmit}>
        <label htmlFor="destination">Destino (ecash:... o alias .xec)</label>
        <input
          id="destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="ecash:... o xolosarmy.xec"
        />
        <AliasResolutionStatus resolution={aliasResolution} />

        <label htmlFor="amount" style={{ marginTop: 12 }}>
          Cantidad
        </label>
        <input id="amount" type="text" value="1" readOnly />

        <div className="actions" style={{ marginTop: 12 }}>
          <button className="cta" type="submit" disabled={!canSubmit}>
            Enviar NFT
          </button>
        </div>

        {(localError || error) && <div className="error">{localError || error}</div>}
        {txid && (
          <div className="success">
            <p className="success-title">Transaction successful!</p>
            <p className="success-hash">
              Hash:
              <a
                href={`https://explorer.xolosarmy.xyz/tx/${txid}`}
                target="_blank"
                rel="noopener noreferrer"
                className="success-link"
              >
                {txid}
              </a>
            </p>
          </div>
        )}
      </form>
    </div>
  )
}

export default SendNft
