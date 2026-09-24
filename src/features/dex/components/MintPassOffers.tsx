import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWallet } from '../../../context/useWallet'
import { type CollectionId } from '../../../domain/nftCollections'
import { parseDecimalToAtoms, parseXecToSats } from '../../../dex/agoraPhase1'
import {
  buyMintPassPublicOffer,
  createMintPassPartialOffer,
  listMintPassPublicOffers,
  type MintPassPublicOffer
} from '../../../services/mintPassPartialMarket'

const FEATURED_OFFER_ID = '7aaba8ad2d7c1e73aba7913407966242709346c0e8dfbe38f918731fac03d065:1'

const COLLECTION_LABELS: Readonly<Record<CollectionId, string>> = Object.freeze({
  official: 'Official / Xolos Ramírez',
  community: 'xolosArmy Community'
})

const sleep = (ms: number) => new Promise((resolve) => globalThis.setTimeout(resolve, ms))

export default function MintPassOffers() {
  const { initialized, backupVerified, refreshBalances } = useWallet()
  const [offers, setOffers] = useState<MintPassPublicOffer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successTxid, setSuccessTxid] = useState<string | null>(null)
  const [buyingOfferId, setBuyingOfferId] = useState<string | null>(null)
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [sellCollectionId, setSellCollectionId] = useState<CollectionId>('official')
  const [sellQuantity, setSellQuantity] = useState('1')
  const [sellUnitPrice, setSellUnitPrice] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [publishedOfferId, setPublishedOfferId] = useState<string | null>(null)

  const refreshOffers = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const active = await listMintPassPublicOffers()
      active.sort((a, b) => {
        if (a.offerId === FEATURED_OFFER_ID) return -1
        if (b.offerId === FEATURED_OFFER_ID) return 1
        if (a.variant !== b.variant) return a.variant === 'PARTIAL' ? -1 : 1
        return a.offerId.localeCompare(b.offerId)
      })
      setOffers(active)
      setQuantities((current) => {
        const next = { ...current }
        for (const offer of active) {
          if (!next[offer.offerId]) next[offer.offerId] = offer.minAcceptedAtoms.toString()
        }
        return next
      })
    } catch (err) {
      setError((err as Error).message || 'No pudimos cargar las ofertas públicas de Mint Pass.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshOffers()
  }, [refreshOffers])

  const featuredIsActive = useMemo(
    () => offers.some((offer) => offer.offerId === FEATURED_OFFER_ID),
    [offers]
  )

  const handleBuy = async (offer: MintPassPublicOffer) => {
    if (!initialized || !backupVerified) {
      setError('Debes completar el onboarding y respaldar tu seed antes de comprar.')
      return
    }
    setError(null)
    setSuccessTxid(null)
    let quantity: bigint
    try {
      quantity = parseDecimalToAtoms(quantities[offer.offerId] || '', 0)
      if (quantity < offer.minAcceptedAtoms) throw new Error(`Compra mínima: ${offer.minAcceptedAtoms.toString()} Mint Pass.`)
      if (quantity > offer.offeredAtoms) throw new Error('La cantidad supera los Mint Pass disponibles.')
    } catch (err) {
      setError((err as Error).message)
      return
    }

    setBuyingOfferId(offer.offerId)
    try {
      const result = await buyMintPassPublicOffer({
        collectionId: offer.collectionId,
        offerId: offer.offerId,
        quantity
      })
      setSuccessTxid(result.txid)
      await refreshBalances()
      await sleep(800)
      await refreshOffers()
    } catch (err) {
      setError((err as Error).message || 'No se pudo completar la compra de Mint Pass.')
    } finally {
      setBuyingOfferId(null)
    }
  }

  const handlePublish = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!initialized || !backupVerified) {
      setError('Debes completar el onboarding y respaldar tu seed antes de publicar.')
      return
    }
    setError(null)
    setPublishedOfferId(null)
    let quantity: bigint
    let unitPriceXecSats: bigint
    try {
      quantity = parseDecimalToAtoms(sellQuantity, 0)
      unitPriceXecSats = parseXecToSats(sellUnitPrice)
      if (quantity <= 0n) throw new Error('La cantidad debe ser mayor a cero.')
      if (unitPriceXecSats <= 0n) throw new Error('El precio debe ser mayor a cero.')
    } catch (err) {
      setError((err as Error).message)
      return
    }

    setPublishing(true)
    try {
      const result = await createMintPassPartialOffer({
        collectionId: sellCollectionId,
        quantity,
        unitPriceXecSats
      })
      setPublishedOfferId(result.offerId)
      await refreshBalances()
      await sleep(800)
      await refreshOffers()
    } catch (err) {
      setError((err as Error).message || 'No se pudo publicar la oferta parcial de Mint Pass.')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div className="card" style={{ marginBottom: 12 }}>
        <p className="card-kicker">Offers · Mint Pass</p>
        <h2 style={{ marginTop: 6 }}>Compra Mint Pass directamente en Tonalli</h2>
        <p className="muted">
          Las ofertas PARTIAL permiten comprar desde 1 Mint Pass sin salir del DEX. Las ofertas legacy ONESHOT conservan su mínimo on-chain original.
        </p>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="cta outline" type="button" onClick={() => void refreshOffers()} disabled={loading}>
            {loading ? 'Actualizando...' : 'Refrescar offers'}
          </button>
        </div>
      </div>

      {!featuredIsActive && !loading && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="card-kicker">Oferta destacada</p>
          <p className="muted">
            El Offer ID {FEATURED_OFFER_ID} no aparece actualmente como oferta activa en el índice Agora. Si sigue siendo ONESHOT, debe cancelarse y relistarse como PARTIAL para habilitar compra desde 1.
          </p>
        </div>
      )}

      {offers.length === 0 && !loading && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="muted">No hay Mint Pass activos en el índice público de Agora en este momento.</p>
        </div>
      )}

      {offers.map((offer) => {
        const isFeatured = offer.offerId === FEATURED_OFFER_ID
        const isPartial = offer.variant === 'PARTIAL'
        return (
          <div className="card" style={{ marginBottom: 12 }} key={offer.offerId}>
            <p className="card-kicker">{isFeatured ? 'Oferta destacada · ' : ''}{COLLECTION_LABELS[offer.collectionId]}</p>
            <div className="muted">Offer ID</div>
            <div className="address-box" style={{ marginTop: 6 }}>{offer.offerId}</div>
            <div style={{ marginTop: 12 }}>
              <strong>{offer.offeredAtoms.toString()} Mint Pass disponibles</strong>
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              Precio aprox. por unidad: {offer.unitPriceXec} XEC · Compra mínima: {offer.minAcceptedAtoms.toString()}
            </div>
            {!isPartial && (
              <div className="error" style={{ marginTop: 10 }}>
                Oferta legacy ONESHOT: es indivisible. Para habilitar compra desde 1 debe relistarse como PARTIAL.
              </div>
            )}
            <label htmlFor={`buy-${offer.offerId}`} style={{ marginTop: 12 }}>Cantidad a comprar</label>
            <input
              id={`buy-${offer.offerId}`}
              type="number"
              min={offer.minAcceptedAtoms.toString()}
              max={offer.offeredAtoms.toString()}
              step="1"
              value={quantities[offer.offerId] ?? offer.minAcceptedAtoms.toString()}
              onChange={(event) => setQuantities((current) => ({ ...current, [offer.offerId]: event.target.value }))}
            />
            <div className="actions" style={{ marginTop: 12 }}>
              <button
                className="cta primary"
                type="button"
                disabled={buyingOfferId !== null}
                onClick={() => void handleBuy(offer)}
              >
                {buyingOfferId === offer.offerId ? 'Comprando...' : isPartial ? 'Comprar Mint Pass' : 'Comprar oferta completa'}
              </button>
            </div>
          </div>
        )
      })}

      <form className="card" onSubmit={handlePublish} style={{ marginBottom: 12 }}>
        <p className="card-kicker">Publicar Mint Pass en Offers</p>
        <p className="muted">Las nuevas ofertas se crean como Agora PARTIAL con compra mínima exacta de 1 Mint Pass.</p>
        <label htmlFor="offersCollection">Colección</label>
        <select id="offersCollection" value={sellCollectionId} onChange={(event) => setSellCollectionId(event.target.value as CollectionId)}>
          <option value="official">{COLLECTION_LABELS.official}</option>
          <option value="community">{COLLECTION_LABELS.community}</option>
        </select>
        <label htmlFor="offersQty" style={{ marginTop: 12 }}>Cantidad</label>
        <input id="offersQty" type="number" min="1" step="1" value={sellQuantity} onChange={(event) => setSellQuantity(event.target.value)} />
        <label htmlFor="offersPrice" style={{ marginTop: 12 }}>Precio por unidad (XEC)</label>
        <input id="offersPrice" value={sellUnitPrice} onChange={(event) => setSellUnitPrice(event.target.value)} placeholder="Ej. 5500" />
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="cta primary" type="submit" disabled={publishing}>
            {publishing ? 'Publicando...' : 'Publicar oferta desde 1 Mint Pass'}
          </button>
        </div>
        {publishedOfferId && (
          <div className="success" style={{ marginTop: 12 }}>
            Oferta PARTIAL publicada: <span className="address-box">{publishedOfferId}</span>
          </div>
        )}
      </form>

      {successTxid && (
        <div className="success" style={{ marginTop: 12 }}>
          Compra completada: <span className="address-box">{successTxid}</span>
        </div>
      )}
      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}
    </div>
  )
}
