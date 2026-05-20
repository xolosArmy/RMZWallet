import { useCallback, useEffect, useState } from 'react'
import { Agora, type AgoraOffer } from 'ecash-agora'
import { RMZ_ETOKEN_ID } from '../../../config/rmzToken'
import { getChronik } from '../../../services/ChronikClient'
import type { ActiveDexOffer } from '../types'

const mapAgoraOfferToActiveDexOffer = (offer: AgoraOffer): ActiveDexOffer => {
  const { txid, outIdx } = offer.outpoint
  const tokenAtoms =
    offer.variant.type === 'PARTIAL'
      ? offer.variant.params.offeredAtoms()
      : offer.token.atoms
  const askedSats =
    offer.variant.type === 'PARTIAL'
      ? offer.askedSats(offer.variant.params.prepareAcceptedAtoms(tokenAtoms))
      : offer.askedSats()

  return {
    offerId: `${txid}:${outIdx}`,
    txid,
    outIdx,
    tokenId: offer.token.tokenId,
    tokenAtoms,
    askedSats,
    variantType: offer.variant.type,
    rawOffer: offer,
    kind: 'rmz'
  }
}

export function useActiveOffers(params?: { enabled?: boolean }) {
  const enabled = params?.enabled ?? true
  const [offers, setOffers] = useState<ActiveDexOffer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pluginUnavailable, setPluginUnavailable] = useState(false)

  const reload = useCallback(async () => {
    if (!enabled) {
      setOffers([])
      setError(null)
      setPluginUnavailable(false)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    setPluginUnavailable(false)
    try {
      const agora = new Agora(getChronik())
      // Agora.activeOffersByTokenId depends on Chronik exposing the "agora"
      // plugin routes. Some nodes do not load that plugin and return 404s.
      const activeOffers = await agora.activeOffersByTokenId(RMZ_ETOKEN_ID)
      const normalized = activeOffers
        .filter((offer) => offer.status === 'OPEN')
        .map(mapAgoraOfferToActiveDexOffer)
        .sort((a, b) => {
          if (a.askedSats === b.askedSats) return 0
          return a.askedSats < b.askedSats ? -1 : 1
        })
      setOffers(normalized)
    } catch (err) {
      const errorMessage = (err as Error).message || ''
      setOffers([])
      if (
        errorMessage.includes('Plugin "agora" not loaded') ||
        errorMessage.includes('status 404') ||
        errorMessage.includes('Failed getting /plugin/agora')
      ) {
        setPluginUnavailable(true)
        setError(null)
      } else {
        setError(errorMessage || 'No pudimos cargar las ofertas activas de RMZ.')
      }
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void reload()
  }, [reload])

  return { offers, loading, error, pluginUnavailable, reload }
}
