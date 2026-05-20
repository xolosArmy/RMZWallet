import { formatAtomsToDecimal, formatSatsToXec } from '../../../dex/agoraPhase1'
import type { ActiveDexOffer } from '../types'

type ListingCardProps = {
  offer: ActiveDexOffer
  rmzDecimals: number | null
  onSelectOffer: (offerId: string) => void | Promise<void>
}

export default function ListingCard({ offer, rmzDecimals, onSelectOffer }: ListingCardProps) {
  const offeredDisplay = rmzDecimals === null ? offer.tokenAtoms.toString() : formatAtomsToDecimal(offer.tokenAtoms, rmzDecimals)
  const askedDisplay = formatSatsToXec(offer.askedSats)

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <p className="card-kicker">Oferta activa on-chain</p>
      <div className="success">
        {offeredDisplay} RMZ por {askedDisplay} XEC
      </div>
      <p className="muted" style={{ marginTop: 8 }}>
        Offer ID: {offer.offerId}
      </p>
      <p className="muted">Tipo: {offer.variantType}</p>
      <div className="actions" style={{ marginTop: 12 }}>
        <button className="cta" type="button" onClick={() => void onSelectOffer(offer.offerId)}>
          Cargar esta oferta
        </button>
      </div>
    </div>
  )
}
