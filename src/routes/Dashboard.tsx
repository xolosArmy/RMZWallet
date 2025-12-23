import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { AgoraOffer, AgoraPartial } from 'ecash-agora'
import {
  ALP_STANDARD,
  ALL_BIP143,
  Address,
  P2PKHSignatory,
  Script,
  TxBuilder,
  calcTxFee,
  fromHex
} from 'ecash-lib'
import type { ScriptUtxo } from 'chronik-client'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/WalletContext'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import { getChronik } from '../services/ChronikClient'
import { xolosWalletService } from '../services/XolosWalletService'
import {
  TOKEN_DUST_SATS,
  buildAlpAgoraListOutputs,
  calcPriceNanoSatsFromTotal,
  calcPriceNanoSatsPerAtom,
  formatOfferSummary,
  formatSatsToXec,
  parseAgoraOfferFromTx,
  parseDecimalToAtoms,
  parseOfferId,
  parseXecToSats
} from '../dex/agoraPhase1'

const DEFAULT_PAYOUT_ADDRESS = 'ecash:qplm2jhzuteklx9naquzwfe97tx3h8eu4gyq385tw8'
const FEE_PER_KB = 1200n
const P2PKH_INPUT_SIZE = 148
const OUTPUT_SIZE = 34
const TX_OVERHEAD = 10

const estimateFee = (inputCount: number, outputCount: number): bigint => {
  const txSize = TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE + outputCount * OUTPUT_SIZE
  return calcTxFee(txSize, FEE_PER_KB)
}

const pow10 = (decimals: number): bigint => 10n ** BigInt(decimals)

function Dashboard() {
  const { address, balance, initialized, refreshBalances, loading, error, backupVerified } = useWallet()
  const [rmzDecimals, setRmzDecimals] = useState<number | null>(null)
  const [dexTab, setDexTab] = useState<'maker' | 'taker'>('maker')

  const [sellAmount, setSellAmount] = useState('')
  const [pricingMode, setPricingMode] = useState<'perUnit' | 'total'>('perUnit')
  const [xecPerRmz, setXecPerRmz] = useState('')
  const [totalXecWanted, setTotalXecWanted] = useState('')
  const [payoutAddress, setPayoutAddress] = useState(DEFAULT_PAYOUT_ADDRESS)
  const [makerError, setMakerError] = useState<string | null>(null)
  const [makerTxid, setMakerTxid] = useState<string | null>(null)
  const [makerOfferId, setMakerOfferId] = useState<string | null>(null)
  const [makerAdvanced, setMakerAdvanced] = useState<string | null>(null)
  const [makerBusy, setMakerBusy] = useState(false)

  const [offerIdInput, setOfferIdInput] = useState('')
  const [offerLookupError, setOfferLookupError] = useState<string | null>(null)
  const [offerDetails, setOfferDetails] = useState<ReturnType<typeof parseAgoraOfferFromTx> | null>(null)
  const [offerOutpoint, setOfferOutpoint] = useState<{ txid: string; vout: number } | null>(null)
  const [offerBusy, setOfferBusy] = useState(false)
  const [buyBusy, setBuyBusy] = useState(false)
  const [buyTxid, setBuyTxid] = useState<string | null>(null)

  useEffect(() => {
    if (initialized) {
      refreshBalances()
    }
  }, [initialized, refreshBalances])

  useEffect(() => {
    let active = true
    const loadTokenInfo = async () => {
      if (!initialized) return
      try {
        const tokenInfo = await getChronik().token(RMZ_ETOKEN_ID)
        if (active) {
          setRmzDecimals(tokenInfo.genesisInfo.decimals)
        }
      } catch (err) {
        console.error(err)
        if (active) setRmzDecimals(null)
      }
    }
    loadTokenInfo()
    return () => {
      active = false
    }
  }, [initialized])

  const atomsPerToken = useMemo(() => (rmzDecimals === null ? null : pow10(rmzDecimals)), [rmzDecimals])

  const computedTotalXec = useMemo(() => {
    if (!sellAmount || pricingMode !== 'perUnit' || rmzDecimals === null) return ''
    try {
      const offeredAtoms = parseDecimalToAtoms(sellAmount, rmzDecimals)
      const priceSats = parseXecToSats(xecPerRmz)
      const priceNano = calcPriceNanoSatsPerAtom({ xecPerTokenSats: priceSats, tokenDecimals: rmzDecimals })
      const totalSats = (priceNano * offeredAtoms) / 1_000_000_000n
      return formatSatsToXec(totalSats)
    } catch {
      return ''
    }
  }, [sellAmount, pricingMode, rmzDecimals, xecPerRmz])

  const computedXecPerRmz = useMemo(() => {
    if (!sellAmount || pricingMode !== 'total' || rmzDecimals === null || !atomsPerToken) return ''
    try {
      const offeredAtoms = parseDecimalToAtoms(sellAmount, rmzDecimals)
      const totalSats = parseXecToSats(totalXecWanted)
      const priceNano = calcPriceNanoSatsFromTotal({ totalSats, offeredAtoms })
      const perTokenSats = (priceNano * atomsPerToken) / 1_000_000_000n
      return formatSatsToXec(perTokenSats)
    } catch {
      return ''
    }
  }, [sellAmount, pricingMode, rmzDecimals, atomsPerToken, totalXecWanted])

  const handleCreateOffer = async (event: React.FormEvent) => {
    event.preventDefault()
    setMakerError(null)
    setMakerTxid(null)
    setMakerOfferId(null)
    setMakerAdvanced(null)

    if (!initialized || !backupVerified) {
      setMakerError('Debes completar el onboarding y respaldar tu seed antes de crear una oferta.')
      return
    }
    if (!address) {
      setMakerError('No se encontró la dirección de la billetera.')
      return
    }
    if (rmzDecimals === null) {
      setMakerError('No pudimos cargar los decimales del token RMZ.')
      return
    }

    let payout
    try {
      payout = Address.parse(payoutAddress).cash().toString()
    } catch {
      setMakerError('La dirección de pago no es válida.')
      return
    }

    let walletKeyInfo
    try {
      walletKeyInfo = xolosWalletService.getKeyInfo()
    } catch (err) {
      setMakerError((err as Error).message)
      return
    }

    if (Address.parse(walletKeyInfo.address).cash().toString() !== payout) {
      setMakerError('La dirección de pago debe coincidir con la dirección actual de tu billetera.')
      return
    }

    let offeredAtoms: bigint
    try {
      offeredAtoms = parseDecimalToAtoms(sellAmount, rmzDecimals)
    } catch (err) {
      setMakerError((err as Error).message)
      return
    }

    if (offeredAtoms <= 0n) {
      setMakerError('El monto a vender debe ser mayor a cero.')
      return
    }

    let priceNanoSatsPerAtom: bigint
    try {
      if (pricingMode === 'perUnit') {
        const priceSats = parseXecToSats(xecPerRmz)
        priceNanoSatsPerAtom = calcPriceNanoSatsPerAtom({ xecPerTokenSats: priceSats, tokenDecimals: rmzDecimals })
      } else {
        const totalSats = parseXecToSats(totalXecWanted)
        priceNanoSatsPerAtom = calcPriceNanoSatsFromTotal({ totalSats, offeredAtoms })
      }
    } catch (err) {
      setMakerError((err as Error).message)
      return
    }

    if (priceNanoSatsPerAtom <= 0n) {
      setMakerError('El precio debe ser mayor a cero.')
      return
    }

    const minAcceptedAtoms = offeredAtoms / 1000n > 0n ? offeredAtoms / 1000n : offeredAtoms

    let agoraPartial: AgoraPartial
    try {
      agoraPartial = AgoraPartial.approximateParams({
        offeredAtoms,
        priceNanoSatsPerAtom,
        makerPk: fromHex(walletKeyInfo.publicKeyHex),
        minAcceptedAtoms,
        tokenId: RMZ_ETOKEN_ID,
        tokenType: ALP_STANDARD,
        tokenProtocol: 'ALP',
        enforcedLockTime: Math.floor(Date.now() / 1000),
        dustSats: TOKEN_DUST_SATS
      })
    } catch (err) {
      setMakerError((err as Error).message || 'No se pudo preparar la oferta.')
      return
    }

    const actualOfferedAtoms = agoraPartial.offeredAtoms()

    setMakerBusy(true)
    try {
      const chronik = getChronik()
      const addressUtxos = await chronik.address(walletKeyInfo.address).utxos()
      const p2pkhScript = Script.fromAddress(walletKeyInfo.address)

      const tokenUtxos = addressUtxos.utxos.filter(
        (utxo) =>
          utxo.token &&
          utxo.token.tokenId === RMZ_ETOKEN_ID &&
          utxo.token.tokenType.protocol === 'ALP' &&
          !utxo.token.isMintBaton
      )

      const tokenSelection = selectTokenUtxos(tokenUtxos, actualOfferedAtoms)
      const tokenInputSats = sumSats(tokenSelection.selected)
      const tokenChangeAtoms = tokenSelection.totalAtoms - actualOfferedAtoms

      const sendAmounts = tokenChangeAtoms > 0n ? [actualOfferedAtoms, tokenChangeAtoms] : [actualOfferedAtoms]
      const listOutputs = buildAlpAgoraListOutputs({
        agoraPartial,
        tokenId: RMZ_ETOKEN_ID,
        sendAmounts
      })

      if (tokenChangeAtoms > 0n) {
        listOutputs.push({ sats: TOKEN_DUST_SATS, script: p2pkhScript })
      }

      const xecUtxos = addressUtxos.utxos.filter((utxo) => !utxo.token)
      const funding = selectXecUtxos({
        xecUtxos,
        tokenInputSats,
        fixedOutputs: listOutputs,
        tokenInputsCount: tokenSelection.selected.length
      })

      const signer = P2PKHSignatory(fromHex(walletKeyInfo.privateKeyHex), fromHex(walletKeyInfo.publicKeyHex), ALL_BIP143)
      const inputs = [
        ...tokenSelection.selected.map((utxo) => buildInput(utxo, p2pkhScript, signer)),
        ...funding.selected.map((utxo) => buildInput(utxo, p2pkhScript, signer))
      ]

      const outputs = funding.includeChange ? [...listOutputs, p2pkhScript] : listOutputs
      const txBuilder = new TxBuilder({ inputs, outputs })
      const signedTx = txBuilder.sign({ feePerKb: FEE_PER_KB, dustSats: TOKEN_DUST_SATS })

      const broadcast = await chronik.broadcastTx(signedTx.ser())

      const offerId = `${broadcast.txid}:1`
      setMakerTxid(broadcast.txid)
      setMakerOfferId(offerId)

      const advancedDetails = [
        `sellAtoms=${actualOfferedAtoms.toString()}`,
        `priceNanoSatsPerAtom=${priceNanoSatsPerAtom.toString()}`,
        `minAcceptedAtoms=${agoraPartial.minAcceptedAtoms().toString()}`,
        `tokenChangeAtoms=${tokenChangeAtoms.toString()}`
      ].join('\n')
      setMakerAdvanced(advancedDetails)
      await refreshBalances()
    } catch (err) {
      setMakerError((err as Error).message || 'No se pudo crear la oferta.')
    } finally {
      setMakerBusy(false)
    }
  }

  const handleCopyOfferId = async () => {
    if (!makerOfferId) return
    try {
      await navigator.clipboard.writeText(makerOfferId)
    } catch (err) {
      console.error(err)
    }
  }

  const handleLookupOffer = async () => {
    setOfferLookupError(null)
    setOfferDetails(null)
    setOfferOutpoint(null)
    setBuyTxid(null)

    let outpoint
    try {
      outpoint = parseOfferId(offerIdInput)
    } catch (err) {
      setOfferLookupError((err as Error).message)
      return
    }

    setOfferBusy(true)
    try {
      const tx = await getChronik().tx(outpoint.txid)
      const parsed = parseAgoraOfferFromTx(tx, outpoint.vout, RMZ_ETOKEN_ID)
      setOfferDetails(parsed)
      setOfferOutpoint(outpoint)
    } catch (err) {
      setOfferLookupError((err as Error).message || 'No pudimos validar esta oferta.')
    } finally {
      setOfferBusy(false)
    }
  }

  const handleBuyOffer = async () => {
    if (!offerDetails || !offerOutpoint || !address) return
    setBuyTxid(null)
    setOfferLookupError(null)

    if (!initialized || !backupVerified) {
      setOfferLookupError('Debes completar el onboarding y respaldar tu seed antes de comprar.')
      return
    }

    setBuyBusy(true)
    try {
      const walletKeyInfo = xolosWalletService.getKeyInfo()
      const recipientScript = Script.fromAddress(walletKeyInfo.address)

      const offer = new AgoraOffer({
        variant: { type: 'PARTIAL', params: offerDetails.agoraPartial },
        outpoint: { txid: offerOutpoint.txid, outIdx: offerOutpoint.vout },
        txBuilderInput: {
          prevOut: { txid: offerOutpoint.txid, outIdx: offerOutpoint.vout },
          signData: {
            sats: offerDetails.offerOutput.sats,
            redeemScript: offerDetails.agoraPartial.script()
          }
        },
        token: offerDetails.token,
        status: 'OPEN'
      })

      const acceptedAtoms = offerDetails.agoraPartial.prepareAcceptedAtoms(offerDetails.offeredAtoms)
      const askedSats = offer.askedSats(acceptedAtoms)
      const feeSats = offer.acceptFeeSats({ recipientScript, acceptedAtoms, feePerKb: FEE_PER_KB })
      const totalNeeded = askedSats + feeSats

      const addressUtxos = await getChronik().address(walletKeyInfo.address).utxos()
      const xecUtxos = addressUtxos.utxos.filter((utxo) => !utxo.token)
      const funding = selectXecUtxosForTarget(xecUtxos, totalNeeded)

      const signer = P2PKHSignatory(fromHex(walletKeyInfo.privateKeyHex), fromHex(walletKeyInfo.publicKeyHex), ALL_BIP143)
      const fuelInputs = funding.map((utxo) => buildInput(utxo, recipientScript, signer))

      const acceptTx = offer.acceptTx({
        covenantSk: fromHex(walletKeyInfo.privateKeyHex),
        covenantPk: fromHex(walletKeyInfo.publicKeyHex),
        fuelInputs,
        recipientScript,
        acceptedAtoms,
        dustSats: offerDetails.offerOutput.sats,
        feePerKb: FEE_PER_KB
      })

      const broadcast = await getChronik().broadcastTx(acceptTx.ser())
      setBuyTxid(broadcast.txid)
      await refreshBalances()
    } catch (err) {
      setOfferLookupError((err as Error).message || 'No se pudo completar la compra.')
    } finally {
      setBuyBusy(false)
    }
  }

  if (!initialized) {
    return (
      <div className="page">
        <TopBar />
        <h1 className="section-title">Bienvenido</h1>
        <p className="muted">Configura tu billetera para ver tus saldos.</p>
        <div className="actions">
          <Link className="cta primary" to="/onboarding">
            Ir a onboarding
          </Link>
        </div>
      </div>
    )
  }

  const offerSummary = offerDetails && rmzDecimals !== null
    ? formatOfferSummary({
        offeredAtoms: offerDetails.offeredAtoms,
        tokenDecimals: rmzDecimals,
        askedSats: offerDetails.askedSats
      })
    : null

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Panel principal</p>
          <h1 className="section-title">Guardianía RMZ sobre eCash</h1>
          <p className="muted">
            Saldos, gas y tu dirección protegida en una sola vista. La seed nunca sale de tu dispositivo.
          </p>
        </div>
        <div className="actions">
          <Link className="cta primary" to="/send">
            Enviar RMZ
          </Link>
          <Link className="cta outline" to="/receive">
            Recibir
          </Link>
          <Link className="cta outline" to="/scan">
            Escanear QR para recibir RMZ
          </Link>
          <Link className="cta outline" to="/reveal-seed">
            Ver frase seed
          </Link>
        </div>
      </header>

      <div className="grid">
        <div className="card">
          <p className="muted">Balance RMZ</p>
          <h2 style={{ marginTop: 4, fontSize: 32 }}>
            {balance ? `${balance.rmz} RMZ` : 'Cargando...'}
          </h2>
        </div>
        <div className="card">
          <p className="muted">Gas de red (XEC)</p>
          <h3 style={{ marginTop: 4 }}>{balance ? `${balance.xecFormatted} XEC` : 'Cargando...'}</h3>
          <p className="muted">({balance ? `${balance.xec} sats` : 'sats...'})</p>
        </div>
      </div>

      <div className="card">
        <p className="muted">Dirección eCash</p>
        <div className="address-box">{address}</div>
      </div>

      <div className="card">
        <p className="muted">DEX (Phase 1)</p>
        <div className="actions" style={{ marginTop: 8 }}>
          <button
            className={`cta ${dexTab === 'maker' ? 'primary' : 'ghost'}`}
            type="button"
            onClick={() => setDexTab('maker')}
          >
            Crear Offer (Vender RMZ)
          </button>
          <button
            className={`cta ${dexTab === 'taker' ? 'primary' : 'ghost'}`}
            type="button"
            onClick={() => setDexTab('taker')}
          >
            Comprar Offer (Pegar ID)
          </button>
        </div>

        {dexTab === 'maker' && (
          <form onSubmit={handleCreateOffer} style={{ marginTop: 16 }}>
            <label htmlFor="sellAmount">Monto a vender (RMZ)</label>
            <input
              id="sellAmount"
              value={sellAmount}
              onChange={(event) => setSellAmount(event.target.value)}
              placeholder="Ej. 250"
            />

            <label style={{ marginTop: 12 }}>Precio</label>
            <div className="actions" style={{ marginTop: 8 }}>
              <button
                className={`cta ${pricingMode === 'perUnit' ? 'outline' : 'ghost'}`}
                type="button"
                onClick={() => setPricingMode('perUnit')}
              >
                XEC por RMZ
              </button>
              <button
                className={`cta ${pricingMode === 'total' ? 'outline' : 'ghost'}`}
                type="button"
                onClick={() => setPricingMode('total')}
              >
                Total XEC deseado
              </button>
            </div>

            {pricingMode === 'perUnit' ? (
              <>
                <label htmlFor="xecPerRmz" style={{ marginTop: 12 }}>
                  XEC por RMZ
                </label>
                <input
                  id="xecPerRmz"
                  value={xecPerRmz}
                  onChange={(event) => setXecPerRmz(event.target.value)}
                  placeholder="Ej. 1.25"
                />
                <label htmlFor="totalXecWanted" style={{ marginTop: 12 }}>
                  Total XEC deseado
                </label>
                <input
                  id="totalXecWanted"
                  value={computedTotalXec}
                  readOnly
                  placeholder="Se calcula automáticamente"
                />
              </>
            ) : (
              <>
                <label htmlFor="totalXecWanted" style={{ marginTop: 12 }}>
                  Total XEC deseado
                </label>
                <input
                  id="totalXecWanted"
                  value={totalXecWanted}
                  onChange={(event) => setTotalXecWanted(event.target.value)}
                  placeholder="Ej. 1200"
                />
                <label htmlFor="xecPerRmz" style={{ marginTop: 12 }}>
                  XEC por RMZ
                </label>
                <input
                  id="xecPerRmz"
                  value={computedXecPerRmz}
                  readOnly
                  placeholder="Se calcula automáticamente"
                />
              </>
            )}

            <label htmlFor="payoutAddress" style={{ marginTop: 12 }}>
              Dirección de pago (XEC)
            </label>
            <input
              id="payoutAddress"
              value={payoutAddress}
              onChange={(event) => setPayoutAddress(event.target.value)}
              placeholder="ecash:..."
            />

            <div className="actions" style={{ marginTop: 16 }}>
              <button className="cta" type="submit" disabled={makerBusy || loading}>
                {makerBusy ? 'Creando...' : 'Crear oferta'}
              </button>
            </div>

            {makerError && <div className="error">{makerError}</div>}
            {makerOfferId && (
              <div className="success">
                <div>Offer ID:</div>
                <div className="address-box" style={{ marginTop: 8 }}>
                  {makerOfferId}
                </div>
                <div className="actions" style={{ marginTop: 8 }}>
                  <button className="cta ghost" type="button" onClick={handleCopyOfferId}>
                    Copiar ID
                  </button>
                </div>
              </div>
            )}
            {makerTxid && (
              <div className="success">
                Txid publicado: <span className="address-box">{makerTxid}</span>
              </div>
            )}

            <details style={{ marginTop: 12 }}>
              <summary>Avanzado</summary>
              <div className="address-box" style={{ marginTop: 8, whiteSpace: 'pre-line' }}>
                {makerAdvanced || 'Los datos técnicos aparecerán al crear la oferta.'}
              </div>
            </details>
          </form>
        )}

        {dexTab === 'taker' && (
          <div style={{ marginTop: 16 }}>
            <label htmlFor="offerId">Offer ID (txid:vout o JSON)</label>
            <textarea
              id="offerId"
              value={offerIdInput}
              onChange={(event) => setOfferIdInput(event.target.value)}
              placeholder="txid:vout"
              rows={3}
            />
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="cta" type="button" onClick={handleLookupOffer} disabled={offerBusy}>
                {offerBusy ? 'Verificando...' : 'Cargar oferta'}
              </button>
            </div>

            {offerLookupError && <div className="error">{offerLookupError}</div>}

            {offerDetails && offerSummary && (
              <div style={{ marginTop: 16 }}>
                <div className="success">
                  Oferta lista: {offerSummary.offeredDisplay} RMZ por {offerSummary.askedDisplay} XEC
                </div>
                <p className="muted" style={{ marginTop: 8 }}>
                  Pago a: {offerDetails.payoutAddress}
                </p>
                <div className="actions" style={{ marginTop: 12 }}>
                  <button className="cta primary" type="button" onClick={handleBuyOffer} disabled={buyBusy}>
                    {buyBusy ? 'Comprando...' : 'Comprar RMZ'}
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
        )}
      </div>

      {loading && <div className="muted">Actualizando saldos...</div>}
      {error && <div className="error">{error}</div>}
    </div>
  )
}

function selectTokenUtxos(utxos: ScriptUtxo[], targetAtoms: bigint): { selected: ScriptUtxo[]; totalAtoms: bigint } {
  const sorted = [...utxos].sort((a, b) => {
    const aAtoms = a.token?.atoms ?? 0n
    const bAtoms = b.token?.atoms ?? 0n
    if (aAtoms === bAtoms) return 0
    return aAtoms > bAtoms ? -1 : 1
  })

  const selected: ScriptUtxo[] = []
  let totalAtoms = 0n

  for (const utxo of sorted) {
    if (!utxo.token) continue
    selected.push(utxo)
    totalAtoms += utxo.token.atoms
    if (totalAtoms >= targetAtoms) break
  }

  if (totalAtoms < targetAtoms) {
    throw new Error('No hay suficientes tokens RMZ para crear esta oferta.')
  }

  return { selected, totalAtoms }
}

function selectXecUtxos(params: {
  xecUtxos: ScriptUtxo[]
  tokenInputSats: bigint
  fixedOutputs: { sats: bigint }[]
  tokenInputsCount: number
}): { selected: ScriptUtxo[]; includeChange: boolean } {
  const fixedOutputSats = params.fixedOutputs.reduce((sum, output) => sum + output.sats, 0n)
  const sorted = [...params.xecUtxos].sort((a, b) => {
    if (a.sats === b.sats) return 0
    return a.sats > b.sats ? -1 : 1
  })

  const selected: ScriptUtxo[] = []
  let totalInputSats = params.tokenInputSats

  for (const utxo of sorted) {
    selected.push(utxo)
    totalInputSats += utxo.sats

    const inputCount = params.tokenInputsCount + selected.length
    const outputsBase = params.fixedOutputs.length
    const feeWithChange = estimateFee(inputCount, outputsBase + 1)
    const feeWithoutChange = estimateFee(inputCount, outputsBase)

    const leftoverWithChange = totalInputSats - fixedOutputSats - feeWithChange
    if (leftoverWithChange >= TOKEN_DUST_SATS) {
      return { selected, includeChange: true }
    }

    const leftoverWithoutChange = totalInputSats - fixedOutputSats - feeWithoutChange
    if (leftoverWithoutChange >= 0n) {
      return { selected, includeChange: false }
    }
  }

  throw new Error('No hay suficiente XEC para cubrir dust y comisiones.')
}

function selectXecUtxosForTarget(utxos: ScriptUtxo[], targetSats: bigint): ScriptUtxo[] {
  const sorted = [...utxos].sort((a, b) => {
    if (a.sats === b.sats) return 0
    return a.sats > b.sats ? -1 : 1
  })
  const selected: ScriptUtxo[] = []
  let total = 0n

  for (const utxo of sorted) {
    selected.push(utxo)
    total += utxo.sats
    if (total >= targetSats) {
      return selected
    }
  }

  throw new Error('No hay suficiente XEC para aceptar la oferta.')
}

function sumSats(utxos: ScriptUtxo[]): bigint {
  return utxos.reduce((sum, utxo) => sum + utxo.sats, 0n)
}

function buildInput(utxo: ScriptUtxo, outputScript: Script, signatory: ReturnType<typeof P2PKHSignatory>) {
  return {
    input: {
      prevOut: utxo.outpoint,
      signData: {
        sats: utxo.sats,
        outputScript
      }
    },
    signatory
  }
}

export default Dashboard
