import { useCallback, useEffect, useState } from 'react'
import { FIRMA_ALPHA } from '../../../config/firmaAlpha'
import { formatSatsToXec } from '../../../dex/agoraPhase1'
import { useWallet } from '../../../context/useWallet'
import {
  FirmaAgoraUnavailableError,
  discoverFirmaOffers,
  executeFirmaBuy,
  executeFirmaSale,
  formatFirmaAtoms,
  prepareBestFirmaBuy,
  prepareFirmaSale,
  type FirmaBuyPreview,
  type FirmaOfferSummary,
  type FirmaSaleMode,
  type FirmaSalePreview
} from '../../../services/firmaAlphaExchange'

type FirmaAction = 'buy' | FirmaSaleMode
type FirmaPreview = FirmaBuyPreview | FirmaSalePreview

const offerPrice = (offer: FirmaOfferSummary) => {
  const satsPerFirma = (offer.askedSats * 10n ** BigInt(FIRMA_ALPHA.decimals)) / offer.offeredAtoms
  return formatSatsToXec(satsPerFirma)
}

export default function FirmaAlphaMarket() {
  const { balance, backupVerified, refreshBalances } = useWallet()
  const [action, setAction] = useState<FirmaAction>('buy')
  const [amount, setAmount] = useState('')
  const [sellPrice, setSellPrice] = useState('')
  const [offers, setOffers] = useState<FirmaOfferSummary[]>([])
  const [liquidityAtoms, setLiquidityAtoms] = useState(0n)
  const [marketBusy, setMarketBusy] = useState(true)
  const [operationBusy, setOperationBusy] = useState(false)
  const [pluginUnavailable, setPluginUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<FirmaPreview | null>(null)
  const [result, setResult] = useState<{ txid: string; offerId?: string } | null>(null)

  const refreshMarket = useCallback(async () => {
    setMarketBusy(true)
    try {
      const orderbook = await discoverFirmaOffers()
      setOffers(orderbook.offers)
      setLiquidityAtoms(orderbook.totalLiquidityAtoms)
      setPluginUnavailable(false)
    } catch (cause) {
      setOffers([])
      setLiquidityAtoms(0n)
      if (cause instanceof FirmaAgoraUnavailableError) {
        setPluginUnavailable(true)
      } else {
        setError((cause as Error).message || 'No se pudo cargar el mercado FIRMA.')
      }
    } finally {
      setMarketBusy(false)
    }
  }, [])

  useEffect(() => {
    void refreshMarket()
  }, [refreshMarket])

  const selectAction = (next: FirmaAction) => {
    setAction(next)
    setPreview(null)
    setResult(null)
    setError(null)
  }

  const prepare = async () => {
    setOperationBusy(true)
    setPreview(null)
    setResult(null)
    setError(null)
    try {
      const nextPreview = action === 'buy'
        ? await prepareBestFirmaBuy(amount)
        : await prepareFirmaSale({ amount, xecPerFirma: sellPrice, mode: action })
      setPreview(nextPreview)
    } catch (cause) {
      setError((cause as Error).message || 'No se pudo preparar la operación FIRMA.')
    } finally {
      setOperationBusy(false)
    }
  }

  const confirm = async () => {
    if (!preview) return
    if (!backupVerified) {
      setError('Debes respaldar tu seed antes de firmar una operación FIRMA.')
      return
    }

    setOperationBusy(true)
    setError(null)
    try {
      if (preview.kind === 'buy') {
        const txid = await executeFirmaBuy(preview)
        setResult({ txid })
      } else {
        setResult(await executeFirmaSale(preview))
      }
      setPreview(null)
      await refreshBalances()
      await refreshMarket()
    } catch (cause) {
      setError((cause as Error).message || 'No se pudo transmitir la operación FIRMA.')
    } finally {
      setOperationBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 16, display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="actions" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <p className="card-kicker">Mercado XEC ↔ FIRMA</p>
            <h2 style={{ margin: '4px 0' }}>Firma Alpha <span aria-label="verificado">✓</span></h2>
          </div>
          <div className="success">Token verificado</div>
        </div>
        <p className="muted">ALP estándar · {FIRMA_ALPHA.decimals} decimales · identidad validada contra la génesis.</p>
        <div className="address-box" style={{ marginTop: 10, overflowWrap: 'anywhere' }}>
          {FIRMA_ALPHA.tokenId}
        </div>
        <div className="grid" style={{ marginTop: 12 }}>
          <div className="tx-item">
            <strong>Saldo FIRMA</strong>
            <div>{balance?.firmaFormatted ?? '0'} FIRMA</div>
          </div>
          <div className="tx-item">
            <strong>Saldo XEC</strong>
            <div>{balance?.xecFormatted ?? '0.00'} XEC</div>
          </div>
          <div className="tx-item">
            <strong>Liquidez FIRMA disponible</strong>
            <div>{marketBusy ? 'Sincronizando…' : `${formatFirmaAtoms(liquidityAtoms)} FIRMA`}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="actions">
          <button className={`cta ${action === 'buy' ? 'primary' : 'ghost'}`} type="button" onClick={() => selectAction('buy')}>
            Comprar Firma
          </button>
          <button className={`cta ${action === 'sell' ? 'primary' : 'ghost'}`} type="button" onClick={() => selectAction('sell')}>
            Vender Firma
          </button>
          <button className={`cta ${action === 'redeem' ? 'primary' : 'ghost'}`} type="button" onClick={() => selectAction('redeem')}>
            Redimir Firma a XEC
          </button>
        </div>

        <label htmlFor="firmaAmount" style={{ marginTop: 14 }}>Cantidad FIRMA</label>
        <input
          id="firmaAmount"
          inputMode="decimal"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value)
            setPreview(null)
          }}
          placeholder={action === 'redeem' ? 'Mínimo 0.01' : 'Ej. 1.0000'}
        />

        {action === 'sell' && (
          <>
            <label htmlFor="firmaSellPrice" style={{ marginTop: 12 }}>Precio por FIRMA (XEC)</label>
            <input
              id="firmaSellPrice"
              inputMode="decimal"
              value={sellPrice}
              onChange={(event) => {
                setSellPrice(event.target.value)
                setPreview(null)
              }}
              placeholder="Ej. 7000.00"
            />
          </>
        )}

        {action === 'buy' && pluginUnavailable && (
          <div className="error" style={{ marginTop: 12 }}>
            El Chronik configurado no expone el plugin Agora. Configura un endpoint con Agora para descubrir ofertas automáticamente.
          </div>
        )}
        {action === 'buy' && !pluginUnavailable && !marketBusy && offers.length === 0 && (
          <p className="muted" style={{ marginTop: 12 }}>No hay ofertas FIRMA activas.</p>
        )}
        {action === 'redeem' && (
          <p className="muted" style={{ marginTop: 10 }}>
            Redimir crea una oferta Agora on-chain al bid oficial para que el sweeper FIRMA la acepte. No es retiro fiat, banco, KYC ni custodia.
          </p>
        )}

        <div className="actions" style={{ marginTop: 14 }}>
          <button
            className="cta outline"
            type="button"
            disabled={operationBusy || (action === 'buy' && (pluginUnavailable || offers.length === 0))}
            onClick={prepare}
          >
            {operationBusy ? 'Preparando…' : 'Previsualizar operación'}
          </button>
          <button className="cta ghost" type="button" disabled={marketBusy} onClick={refreshMarket}>
            Actualizar mercado
          </button>
        </div>
      </div>

      {preview && (
        <div className="card" role="region" aria-label="Previsualización obligatoria FIRMA">
          <p className="card-kicker">Previsualización obligatoria</p>
          <h3>{preview.kind === 'buy' ? 'Comprar FIRMA' : preview.kind === 'sell' ? 'Publicar venta FIRMA' : 'Redimir FIRMA a XEC'}</h3>
          <div className="address-box" style={{ marginTop: 12, whiteSpace: 'pre-line' }}>
            {preview.kind === 'buy'
              ? [
                  `Recibir: ${formatFirmaAtoms(preview.acceptedAtoms)} FIRMA`,
                  `Precio efectivo: ${preview.effectivePriceXecPerFirma} XEC/FIRMA`,
                  `Pago al maker: ${formatSatsToXec(preview.askedSats)} XEC`,
                  `Comisión estimada: ${formatSatsToXec(preview.networkFeeSats)} XEC`,
                  `Total máximo: ${formatSatsToXec(preview.totalSats)} XEC`,
                  `Inputs XEC: ${preview.inputOutpoints.length}`,
                  `Offer ID: ${preview.offerId}`,
                  `Dirección maker: ${preview.payoutAddress}`
                ].join('\n')
              : [
                  `Bloquear: ${formatFirmaAtoms(preview.offeredAtoms)} FIRMA`,
                  `Recibir al completarse: ${formatSatsToXec(preview.askedSats)} XEC`,
                  `Precio efectivo: ${preview.priceXecPerFirma} XEC/FIRMA`,
                  `Comisión estimada: ${formatSatsToXec(preview.networkFeeSats)} XEC`,
                  `Cambio FIRMA: ${formatFirmaAtoms(preview.tokenChangeAtoms)} FIRMA`,
                  ...(preview.kind === 'redeem'
                    ? [`Bid oficial: ${preview.bidPriceXec} XEC/FIRMA`, `Capacidad sweeper: ${formatSatsToXec(preview.redemptionCapacitySats ?? 0n)} XEC`]
                    : [])
                ].join('\n')}
          </div>
          {'adjustedForAgora' in preview && preview.adjustedForAgora && (
            <div className="muted" style={{ marginTop: 8 }}>Agora ajustó la cantidad a su granularidad representable.</div>
          )}
          <p className="muted" style={{ marginTop: 10 }}>
            Nada se firma al previsualizar. Al confirmar, la transacción se reconstruye y valida; la firma ocurre exclusivamente en esta billetera.
          </p>
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="cta primary" type="button" disabled={operationBusy} onClick={confirm}>
              {operationBusy ? 'Firmando y transmitiendo…' : 'Confirmar, firmar localmente y transmitir'}
            </button>
            <button className="cta ghost" type="button" disabled={operationBusy} onClick={() => setPreview(null)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {result && (
        <div className="success">
          Operación transmitida. TXID: <span className="address-box">{result.txid}</span>
          {result.offerId && <div style={{ marginTop: 8 }}>Offer ID: <span className="address-box">{result.offerId}</span></div>}
        </div>
      )}

      <div className="card">
        <p className="card-kicker">Ofertas FIRMA verificadas</p>
        {marketBusy ? (
          <p className="muted">Consultando Agora…</p>
        ) : offers.length === 0 ? (
          <p className="muted">Sin ofertas verificadas disponibles.</p>
        ) : (
          offers.slice(0, 8).map((offer) => (
            <div className="tx-item" key={offer.offerId} style={{ marginTop: 8 }}>
              <strong>{formatFirmaAtoms(offer.offeredAtoms)} FIRMA</strong>
              <div className="muted">
                {offerPrice(offer)} XEC/FIRMA · mínimo {formatFirmaAtoms(offer.minAcceptedAtoms)} FIRMA · {offer.source === 'official' ? 'liquidez oficial' : offer.source === 'own' ? 'oferta propia' : 'liquidez peer'}
              </div>
              <div className="address-box" style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{offer.offerId}</div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
