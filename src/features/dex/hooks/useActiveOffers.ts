import { useEffect, useState } from 'react'
import { Agora } from 'ecash-agora'
import { getChronik } from '../../../services/ChronikClient'

export type ActiveOfferPreview = {
  offerId: string
  askedSats: bigint
  tokenAtoms: bigint
}

const isPluginUnavailableError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { status?: number; message?: string }
  return candidate.status === 404 || /404|plugin/i.test(candidate.message || '')
}

const toActiveOfferPreview = (offer: unknown): ActiveOfferPreview | null => {
  if (!offer || typeof offer !== 'object') return null
  const candidate = offer as {
    outpoint?: { txid?: string; outIdx?: number }
    token?: { atoms?: bigint }
    askedSats?: (atoms?: bigint) => bigint
  }
  const txid = candidate.outpoint?.txid?.trim()
  const outIdx = candidate.outpoint?.outIdx
  const tokenAtoms = candidate.token?.atoms
  if (!txid || !Number.isInteger(outIdx) || typeof tokenAtoms !== 'bigint' || typeof candidate.askedSats !== 'function') {
    return null
  }

  return {
    offerId: `${txid}:${outIdx}`,
    askedSats: candidate.askedSats(tokenAtoms),
    tokenAtoms
  }
}

export function useActiveOffers(tokenId: string) {
  const [offers, setOffers] = useState<ActiveOfferPreview[]>([])
  const [pluginUnavailable, setPluginUnavailable] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        setLoading(true)
        const agora = new Agora(getChronik() as never)
        const activeOffers = await agora.activeOffersByTokenId(tokenId)
        if (cancelled) return
        setOffers(activeOffers.map(toActiveOfferPreview).filter((offer): offer is ActiveOfferPreview => offer !== null))
        setPluginUnavailable(false)
      } catch (error) {
        if (cancelled) return
        if (isPluginUnavailableError(error)) {
          setOffers([])
          setPluginUnavailable(true)
        } else {
          setOffers([])
          setPluginUnavailable(false)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [tokenId])

  return { offers, pluginUnavailable, loading }
}
