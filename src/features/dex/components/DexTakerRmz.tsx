import type { Dispatch, SetStateAction } from 'react'
import { useMemo, useState } from 'react'
import { RMZ_ETOKEN_ID } from '../../../config/rmzToken'
import { useActiveOffers } from '../hooks/useActiveOffers'

type DexTakerRmzProps = {
  offerIdInput: string
  setOfferIdInput: Dispatch<SetStateAction<string>>
  offerLookupError: string | null
  offerBusy: boolean
  onLookupOffer: () => void
  buyBusy: boolean
  onBuyOffer: () => void
  buyTxid: string | null
  offerSummary: { offeredDisplay: string; askedDisplay: string } | null
  payoutAddress: string | null
}

type FeaturedOffer = {
  id: string
  label: string
  summary: string
}

const FEATURED_OFFERS: FeaturedOffer[] = [
  {
    id: '22b2856ea7913071216be589c0eb7b1ed5334810a5041cca2fdb0143761c07f1:1',
    label: 'Pack Básico',
    summary: '100 RMZ por 50,000 XEC'
  },
  {
    id: '67e456dab49064ee289455f16e36db97eaa681a8c5d15ff3f57b072bb73ef49e:1',
    label: 'Pack Inversor',
    summary: '500 RMZ por 250,000 XEC'
  }
]

export default function DexTakerRmz({
  offerIdInput,
  setOfferIdInput,
  offerLookupError,
  offerBusy,
  onLookupOffer,
  buyBusy,
  onBuyOffer,
  buyTxid,
  offerSummary,
  payoutAddress
}: DexTakerRmzProps) {
  const { offers, pluginUnavailable, loading } = useActiveOffers(RMZ_ETOKEN_ID)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)

  const activeOfferCount = useMemo(() => offers.length, [offers])

  const handleCopyId = async (offerId: string) => {
    try {
      await navigator.clipboard.writeText(offerId)
      setCopyStatus(`ID copiado: ${offerId}`)
      window.setTimeout(() => setCopyStatus(null), 1800)
    } catch {
      setCopyStatus('No se pudo copiar el ID.')
      window.setTimeout(() => setCopyStatus(null), 1800)
    }
  }

  return (
    <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
      <div className="card">
        <p className="card-kicker">Tienda Oficial</p>
        <p className="muted">Precio real: 1 RMZ = 500 XEC.</p>
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          {FEATURED_OFFERS.map((offer) => (
            <div key={offer.id} className="tx-item">
              <h3 style={{ marginBottom: 4 }}>{offer.label}</h3>
              <p className="muted">{offer.summary}</p>
              <div className="address-box" style={{ fontFamily: 'monospace', marginTop: 8 }}>
                {offer.id}
              </div>
              <div className="actions" style={{ marginTop: 8 }}>
                <button
                  className="cta outline"
                  type="button"
                  onClick={() => {
                    setOfferIdInput(offer.id)
                    window.setTimeout(onLookupOffer, 0)
                  }}
                >
                  Cargar oferta
                </button>
                <button className="cta ghost" type="button" onClick={() => handleCopyId(offer.id)}>
                  Copiar ID
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <p className="card-kicker">Estado Agora</p>
        {pluginUnavailable ? (
          <p className="muted">El plugin Agora no está cargado en Chronik. Se ocultan las ofertas dinámicas.</p>
        ) : loading ? (
          <p className="muted">Sincronizando ofertas activas...</p>
        ) : (
          <p className="muted">Ofertas activas detectadas para RMZ: {activeOfferCount}</p>
        )}
      </div>

      <div>
        <label htmlFor="offerId">Offer ID (txid:vout o JSON)</label>
        <textarea
          id="offerId"
          value={offerIdInput}
          onChange={(event) => setOfferIdInput(event.target.value)}
          placeholder="txid:vout"
          rows={3}
        />
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="cta" type="button" onClick={onLookupOffer} disabled={offerBusy}>
            {offerBusy ? 'Verificando...' : 'Cargar oferta'}
          </button>
        </div>

        {offerLookupError && <div className="error">{offerLookupError}</div>}

        {offerSummary && (
          <div style={{ marginTop: 16 }}>
            <div className="success">Oferta lista: {offerSummary.offeredDisplay} RMZ por {offerSummary.askedDisplay} XEC</div>
            {payoutAddress && (
              <p className="muted" style={{ marginTop: 8 }}>
                Pago a: {payoutAddress}
              </p>
            )}
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="cta primary" type="button" onClick={onBuyOffer} disabled={buyBusy}>
                {buyBusy ? 'Comprando...' : 'Comprar RMZ'}
              </button>
            </div>
            {buyTxid && (
              <div className="success" style={{ marginTop: 12 }}>
                Compra completada: <span className="address-box">{buyTxid}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {copyStatus && <div className="success">{copyStatus}</div>}
    </div>
  )
}
