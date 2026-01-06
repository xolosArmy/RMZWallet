import type { FormEvent } from 'react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
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

    if (!destination.startsWith('ecash:')) {
      setLocalError('La dirección debe ser una dirección eCash (prefijo ecash:).')
      return
    }

    try {
      const result = await sendNft({ tokenId, destinationAddress: destination.trim() })
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
          <p className="muted">Transfiere tu guardián a otra wallet eCash.</p>
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
        <label htmlFor="destination">Destino (ecash:...)</label>
        <input
          id="destination"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="ecash:..."
        />

        <label htmlFor="amount" style={{ marginTop: 12 }}>
          Cantidad
        </label>
        <input id="amount" type="text" value="1" readOnly />

        <div className="actions" style={{ marginTop: 12 }}>
          <button className="cta" type="submit" disabled={!initialized || !backupVerified || loading}>
            Enviar NFT
          </button>
        </div>

        {(localError || error) && <div className="error">{localError || error}</div>}
        {txid && (
          <div className="success">
            Transacción enviada: <span className="address-box">{txid}</span>
          </div>
        )}
      </form>
    </div>
  )
}

export default SendNft
