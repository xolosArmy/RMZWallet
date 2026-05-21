import { formatOfferSummary, type ParsedAgoraOffer } from '../../../dex/agoraPhase1'
import ListingCard from './ListingCard'
import { useActiveOffers } from '../hooks/useActiveOffers'

const FEATURED_OFFERS = [
  {
    id: '22b2856ea7913071216be589c0eb7b1ed5334810a5041cca2fdb0143761c07f1:1',
    title: 'Pack Básico',
    description: '100 RMZ por 50,000 XEC'
  },
  {
    id: '67e456dab49064ee289455f16e36db97eaa681a8c5d15ff3f57b072bb73ef49e:1',
    title: 'Pack Inversor',
    description: '500 RMZ por 250,000 XEC'
  }
] as const

type DexTakerRmzProps = {
  rmzDecimals: number | null
  offerIdInput: string
  onOfferIdInputChange: (value: string) => void
  onLookupOffer: (offerId?: string) => void | Promise<void>
  offerBusy: boolean
  offerLookupError: string | null
  offerDetails: ParsedAgoraOffer | null
  onBuyOffer: () => void | Promise<void>
  buyBusy: boolean
  buyTxid: string | null
}

export default function DexTakerRmz({
  rmzDecimals,
  offerIdInput,
  onOfferIdInputChange,
  onLookupOffer,
  offerBusy,
  offerLookupError,
  offerDetails,
  onBuyOffer,
  buyBusy,
  buyTxid
}: DexTakerRmzProps) {
  const { offers, loading, error, pluginUnavailable, reload } = useActiveOffers()

  const offerSummary =
    offerDetails && rmzDecimals !== null
      ? formatOfferSummary({
          offeredAtoms: offerDetails.offeredAtoms,
          tokenDecimals: rmzDecimals,
          askedSats: offerDetails.askedSats
        })
      : null

  const handleLoadOffer = async (selectedOfferId: string) => {
    onOfferIdInputChange(selectedOfferId)
    await onLookupOffer(selectedOfferId)
  }

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      console.error('Error al copiar al portapapeles:', err)
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div
        className="card"
        style={{ marginBottom: 16, border: '1px solid rgba(57, 208, 194, 0.3)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="card-kicker" style={{ color: 'var(--teal)' }}>Tienda Oficial RMZ</p>
        </div>
        <p className="muted" style={{ marginTop: 4 }}>
          Ofertas verificadas disponibles para compra instantánea.
        </p>
        <div className="grid" style={{ marginTop: 12 }}>
          {FEATURED_OFFERS.map((offer) => (
            <div
              className="tx-item"
              key={offer.id}
              style={{ background: 'rgba(57, 208, 194, 0.05)' }}
            >
              <h3 style={{ margin: '0 0 4px 0', fontSize: '1.1em' }}>{offer.title}</h3>
              <p className="muted" style={{ marginBottom: 8 }}>{offer.description}</p>

              <p
                style={{
                  fontSize: '0.8em',
                  wordBreak: 'break-all',
                  fontFamily: 'monospace',
                  marginBottom: 12
                }}
                className="muted"
              >
                ID: {offer.id}
              </p>

              <div className="actions" style={{ display: 'flex', gap: '8px', flexWrap: 'nowrap' }}>
                <button
                  className="cta primary small"
                  type="button"
                  style={{ flex: 1, padding: '8px' }}
                  disabled={offerBusy}
                  onClick={() => void handleLoadOffer(offer.id)}
                >
                  Cargar esta oferta
                </button>
                <button
                  className="cta ghost small"
                  type="button"
                  style={{ padding: '8px' }}
                  onClick={() => void handleCopy(offer.id)}
                  title="Copiar ID"
                >
                  Copiar ID
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="card-kicker">Mercado P2P en la red</p>
          <button className="cta ghost small" type="button" onClick={() => void reload()} disabled={loading}>
            {loading ? 'Actualizando...' : 'Refrescar'}
          </button>
        </div>
        <p className="muted" style={{ marginTop: 4 }}>
          Explora ofertas activas on-chain o sigue usando tu Offer ID manual.
        </p>
        {loading && <p className="muted" style={{ marginTop: 8 }}>Buscando ofertas activas...</p>}
        {pluginUnavailable && !loading && (
          <p className="muted" style={{ marginTop: 8 }}>
            El escaneo automatico de P2P no esta disponible en este nodo Chronik. Usa la Tienda Oficial de arriba o pega un Offer ID manualmente.
          </p>
        )}
        {error && !pluginUnavailable && (
          <div className="error" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && !pluginUnavailable && offers.length === 0 && (
          <p className="muted" style={{ marginTop: 12 }}>
            No encontramos ofertas activas de RMZ en este momento.
          </p>
        )}
        {!loading && !pluginUnavailable && offers.length > 0 && (
          <div className="tx-list" style={{ marginTop: 12 }}>
            {offers.map((offer) => (
              <ListingCard
                key={offer.offerId}
                offer={offer}
                rmzDecimals={rmzDecimals}
                onSelectOffer={handleLoadOffer}
              />
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <p className="card-kicker">Comprar Offer Manualmente</p>
        <label htmlFor="offerId">Offer ID (txid:vout o JSON)</label>
        <textarea
          id="offerId"
          value={offerIdInput}
          onChange={(event) => onOfferIdInputChange(event.target.value)}
          placeholder="txid:vout"
          rows={3}
        />
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="cta" type="button" onClick={() => void onLookupOffer()} disabled={offerBusy}>
            {offerBusy ? 'Verificando en la blockchain...' : 'Cargar oferta pegada'}
          </button>
        </div>

        {offerLookupError && <div className="error">{offerLookupError}</div>}

        {offerDetails && offerSummary && (
          <div
            style={{
              marginTop: 16,
              padding: 16,
              border: '1px solid var(--accent)',
              borderRadius: '12px',
              background: 'rgba(255, 122, 26, 0.05)'
            }}
          >
            <h3 style={{ margin: '0 0 8px 0' }}>Oferta lista para comprar</h3>
            <div className="success" style={{ margin: 0 }}>
              Obtienes: <strong>{offerSummary.offeredDisplay} RMZ</strong>
              <br />
              Pagas: <strong>{offerSummary.askedDisplay} XEC</strong>
            </div>
            <p className="muted" style={{ marginTop: 8, fontSize: '0.9em' }}>
              Pago a: <span style={{ fontFamily: 'monospace' }}>{offerDetails.payoutAddress}</span>
            </p>
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="cta primary"
                type="button"
                onClick={() => void onBuyOffer()}
                disabled={buyBusy}
                style={{ width: '100%', fontSize: '1.1em', padding: '14px' }}
              >
                {buyBusy ? 'Transmitiendo compra...' : 'Firmar y comprar RMZ'}
              </button>
            </div>
            {buyTxid && (
              <div className="success" style={{ marginTop: 12 }}>
                Compra completada: <span className="address-box">{buyTxid}</span>
              </div>
            )}
            <details style={{ marginTop: 12 }}>
              <summary>Avanzado</summary>
              <div className="address-box" style={{ marginTop: 8, whiteSpace: 'pre-line' }}>
                {[
                  `sellAtoms=${offerDetails.offeredAtoms.toString()}`,
                  `askedSats=${offerDetails.askedSats.toString()}`,
                  `priceNanoSatsPerAtom=${offerDetails.priceNanoSatsPerAtom.toString()}`,
                  `payoutAddress=${offerDetails.payoutAddress}`
                ].join('\n')}
              </div>
            </details>
          </div>
        )}
      </div>
    </div>
  )
}
