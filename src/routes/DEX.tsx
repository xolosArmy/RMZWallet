import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import TopBar from '../components/TopBar'
import MintPassOffers from '../features/dex/components/MintPassOffers'
import DEXLegacy from './DEXLegacy'

const LEGACY_EXTERNAL_MARKETPLACE = 'https://marketplace.xolosarmy.xyz/'

export default function DEX() {
  const [searchParams, setSearchParams] = useSearchParams()
  const legacyDeepLink = useMemo(
    () =>
      searchParams.has('mode') ||
      searchParams.has('tokenId') ||
      searchParams.has('nftTokenId'),
    [searchParams]
  )
  const showTrading = searchParams.get('view') === 'trading' || legacyDeepLink

  if (showTrading) {
    return (
      <div className="tonalli-dex-legacy">
        <style>{`.tonalli-dex-legacy a[href="${LEGACY_EXTERNAL_MARKETPLACE}"] { display: none !important; }`}</style>
        <DEXLegacy />
        <div className="actions" style={{ marginTop: 12 }}>
          <button
            className="cta outline"
            type="button"
            onClick={() => setSearchParams({ view: 'offers' })}
          >
            Ir a Offers
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <TopBar />
      <div className="card">
        <p className="muted">DEX · Tonalli Wallet</p>
        <h1 className="section-title" style={{ marginTop: 6 }}>Offers</h1>
        <p className="muted">
          Mercado on-chain de Tonalli. Las ofertas nuevas de Mint Pass usan Agora PARTIAL para permitir compras desde 1 unidad.
        </p>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="cta primary" type="button">Offers</button>
          <button
            className="cta ghost"
            type="button"
            onClick={() => setSearchParams({ view: 'trading' })}
          >
            Trading avanzado
          </button>
        </div>
      </div>
      <MintPassOffers />
    </div>
  )
}
