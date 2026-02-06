import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { AgoraPartial } from 'ecash-agora'
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
import { useWallet } from '../context/useWallet'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import {
  NFT_RESCAN_STORAGE_KEY,
  XOLOSARMY_NFT_PARENT_TOKEN_ID,
  XOLOSARMY_NFT_PARENT_TOKEN_ID_ERROR
} from '../config/nfts'
import { getChronik } from '../services/ChronikClient'
import { EXTENDED_GAP_LIMIT, xolosWalletService } from '../services/XolosWalletService'
import { fetchNftDetails, fetchOwnedNfts, type NftAsset } from '../services/nftService'
import { acceptOfferById, createSellOfferToken, loadOfferById, type OneshotOfferSummary } from '../services/agoraExchange'
import { buyOfferById } from '../services/buyOfferById'
import { wcWallet } from '../lib/walletconnect/WcWallet'
import type { OfferPublishedPayload } from '../lib/walletconnect/WcWallet'
import WcDebugPanel from '../components/WcDebugPanel'
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

const OFFER_STORAGE_KEY = 'tonalli_dex_offers'

type SavedOffer = {
  offerId: string
  tokenId: string
  kind: 'nft' | 'mintpass' | 'token'
  createdAt: number
  askXec: string
}
const estimateFee = (inputCount: number, outputCount: number): bigint => {
  const txSize = TX_OVERHEAD + inputCount * P2PKH_INPUT_SIZE + outputCount * OUTPUT_SIZE
  return calcTxFee(txSize, FEE_PER_KB)
}

const pow10 = (decimals: number): bigint => 10n ** BigInt(decimals)

const loadSavedOffers = (): SavedOffer[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(OFFER_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as SavedOffer[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const persistSavedOffers = (offers: SavedOffer[]) => {
  if (typeof window === 'undefined') return
  localStorage.setItem(OFFER_STORAGE_KEY, JSON.stringify(offers))
}

function DEX() {
  const { address, initialized, refreshBalances, rescanWallet, loading, error, backupVerified } = useWallet()
  const [rmzDecimals, setRmzDecimals] = useState<number | null>(null)
  const [dexTab, setDexTab] = useState<'maker' | 'taker' | 'nft' | 'mintpass'>('maker')
  const [searchParams] = useSearchParams()
  const debugEnabled = useMemo(() => searchParams.get('debug') === '1', [searchParams])

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

  const [ownedNfts, setOwnedNfts] = useState<NftAsset[]>([])
  const [nftTokenIdInput, setNftTokenIdInput] = useState('')
  const [nftOfferIdInput, setNftOfferIdInput] = useState('')
  const [nftOfferSummary, setNftOfferSummary] = useState<OneshotOfferSummary | null>(null)
  const [nftOfferPreview, setNftOfferPreview] = useState<{ name: string; imageUrl: string } | null>(null)
  const [nftOfferError, setNftOfferError] = useState<string | null>(null)
  const [nftOfferLoading, setNftOfferLoading] = useState(false)
  const [nftSellPrice, setNftSellPrice] = useState('')
  const [nftSellTokenId, setNftSellTokenId] = useState('')
  const [nftSellBusy, setNftSellBusy] = useState(false)
  const [nftSellTxid, setNftSellTxid] = useState<string | null>(null)
  const [nftSellOfferId, setNftSellOfferId] = useState<string | null>(null)
  const [nftBuyBusy, setNftBuyBusy] = useState(false)
  const [nftBuyTxid, setNftBuyTxid] = useState<string | null>(null)

  const [mintPassOfferIdInput, setMintPassOfferIdInput] = useState('')
  const [mintPassOfferSummary, setMintPassOfferSummary] = useState<OneshotOfferSummary | null>(null)
  const [mintPassError, setMintPassError] = useState<string | null>(null)
  const [mintPassOfferLoading, setMintPassOfferLoading] = useState(false)
  const [mintPassSellAmount, setMintPassSellAmount] = useState('')
  const [mintPassSellPrice, setMintPassSellPrice] = useState('')
  const [mintPassSellBusy, setMintPassSellBusy] = useState(false)
  const [mintPassSellTxid, setMintPassSellTxid] = useState<string | null>(null)
  const [mintPassSellOfferId, setMintPassSellOfferId] = useState<string | null>(null)
  const [mintPassBuyBusy, setMintPassBuyBusy] = useState(false)
  const [mintPassBuyTxid, setMintPassBuyTxid] = useState<string | null>(null)
  const [savedOffers, setSavedOffers] = useState<SavedOffer[]>(() => loadSavedOffers())

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


  useEffect(() => {
    const mode = searchParams.get('mode') || ''
    const tokenId = searchParams.get('tokenId') || ''
    if (mode === 'mintpass' && tokenId === XOLOSARMY_NFT_PARENT_TOKEN_ID) {
      setDexTab('mintpass')
      return
    }

    const nftTokenId = tokenId || searchParams.get('nftTokenId') || ''
    if (nftTokenId) {
      setDexTab('nft')
      setNftTokenIdInput(nftTokenId)
      setNftSellTokenId(nftTokenId)
    }
  }, [searchParams])

  useEffect(() => {
    let active = true
    const loadOwnedNfts = async () => {
      if (!initialized || !address || dexTab !== 'nft') return
      try {
        const owned = await fetchOwnedNfts(address)
        if (active) setOwnedNfts(owned)
      } catch {
        if (active) setOwnedNfts([])
      }
    }
    loadOwnedNfts()
    return () => {
      active = false
    }
  }, [address, dexTab, initialized])
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

  const computedMintPassTotal = useMemo(() => {
    if (!mintPassSellAmount || !mintPassSellPrice) return ''
    try {
      const amount = parseDecimalToAtoms(mintPassSellAmount, 0)
      const priceSats = parseXecToSats(mintPassSellPrice)
      const totalSats = priceSats * amount
      return formatSatsToXec(totalSats)
    } catch {
      return ''
    }
  }, [mintPassSellAmount, mintPassSellPrice])

  const saveOffer = useCallback((offer: SavedOffer) => {
    setSavedOffers((prev) => {
      const next = [offer, ...prev.filter((item) => item.offerId !== offer.offerId)]
      persistSavedOffers(next)
      return next
    })
  }, [])

  const savedNftOffers = useMemo(() => savedOffers.filter((offer) => offer.kind === 'nft'), [savedOffers])
  const savedMintPassOffers = useMemo(() => savedOffers.filter((offer) => offer.kind === 'mintpass'), [savedOffers])

  const markNftRescanPending = useCallback(() => {
    if (typeof window === 'undefined') return
    localStorage.setItem(NFT_RESCAN_STORAGE_KEY, Date.now().toString())
  }, [])

  const handleCopyText = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
    } catch (err) {
      console.error(err)
    }
  }, [])

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

    const xecAddress = walletKeyInfo.xecAddress ?? walletKeyInfo.address
    if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !xecAddress) {
      setMakerError('No pudimos acceder a las llaves de tu billetera.')
      return
    }

    if (Address.parse(xecAddress).cash().toString() !== payout) {
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
      const addressUtxos = await chronik.address(xecAddress).utxos()
      const p2pkhScript = Script.fromAddress(xecAddress)

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
      const priceCandidate = pricingMode === 'perUnit' ? xecPerRmz : totalXecWanted
      const priceXecRaw = Number(priceCandidate)
      const priceXec = Number.isFinite(priceXecRaw) ? priceXecRaw : 0
      const sessionSummary = wcWallet.getOfferEventTargetsSummary()
      console.info('[Tonalli][DEX][publish] sessions', {
        total: sessionSummary.totalSessions,
        eligibleTopics: sessionSummary.eligibleTopics,
        eligibleChains: sessionSummary.eligibleChains
      })
      const offerPayload: OfferPublishedPayload = {
        version: 1,
        offerId,
        txid: broadcast.txid,
        tokenId: RMZ_ETOKEN_ID,
        kind: 'rmz',
        priceXec,
        amount: actualOfferedAtoms.toString(),
        seller: xecAddress,
        timestamp: Math.floor(Date.now() / 1000),
        source: 'tonalli'
      }
      await wcWallet.publishOrQueueOffer(offerPayload)
      console.debug(
        '[Tonalli][DEX][publish] kind=',
        'rmz',
        'offerId=',
        offerId,
        'txid=',
        broadcast.txid,
        'tokenId=',
        RMZ_ETOKEN_ID,
        'priceXec=',
        priceXec
      )
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
      const offerId = `${offerOutpoint.txid}:${offerOutpoint.vout}`
      const { txid } = await buyOfferById(offerId)
      setBuyTxid(txid)
      await refreshBalances()
    } catch (err) {
      setOfferLookupError((err as Error).message || 'No se pudo completar la compra.')
    } finally {
      setBuyBusy(false)
    }
  }

  const handleLoadNftOffer = useCallback(async (overrideOfferId?: string) => {
    setNftOfferError(null)
    setNftOfferSummary(null)
    setNftOfferPreview(null)
    setNftBuyTxid(null)

    const offerId = (overrideOfferId ?? nftOfferIdInput).trim()
    if (!offerId) {
      setNftOfferError('Ingresa un Offer ID de NFT válido.')
      return
    }

    setNftOfferLoading(true)
    try {
      const result = await loadOfferById({ offerId })
      setNftOfferSummary(result.summary)
      const nftDetails = await fetchNftDetails(result.summary.tokenId)
      setNftOfferPreview({
        name: String(nftDetails.metadata?.name || nftDetails.genesisInfo?.tokenName || 'NFT'),
        imageUrl: nftDetails.imageUrl || ''
      })
    } catch (err) {
      setNftOfferError((err as Error).message || 'No pudimos cargar esta oferta de NFT.')
    } finally {
      setNftOfferLoading(false)
    }
  }, [nftOfferIdInput])

  const handleSellNft = async (event: React.FormEvent) => {
    event.preventDefault()
    setNftOfferError(null)
    setNftSellTxid(null)
    setNftSellOfferId(null)

    if (!initialized || !backupVerified) {
      setNftOfferError('Debes completar el onboarding y respaldar tu seed antes de listar.')
      return
    }

    const tokenId = nftSellTokenId || nftTokenIdInput.trim()
    if (!tokenId) {
      setNftOfferError('Selecciona un NFT para vender.')
      return
    }

    let receiveXecSats: bigint
    try {
      receiveXecSats = parseXecToSats(nftSellPrice)
    } catch (err) {
      setNftOfferError((err as Error).message)
      return
    }

    if (receiveXecSats <= 0n) {
      setNftOfferError('El precio debe ser mayor a cero.')
      return
    }

    setNftSellBusy(true)
    try {
      const walletKeyInfo = xolosWalletService.getKeyInfo()
      const xecAddress = walletKeyInfo.xecAddress ?? walletKeyInfo.address
      if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !xecAddress) {
        setNftOfferError('No pudimos acceder a las llaves de tu billetera.')
        return
      }
      const { txid, offerId } = await createSellOfferToken({
        tokenId,
        tokenAtoms: 1n,
        askXecSats: receiveXecSats,
        payoutAddress: xecAddress,
        wallet: xolosWalletService
      })
      setNftSellTxid(txid)
      setNftSellOfferId(offerId)
      saveOffer({
        offerId,
        tokenId,
        kind: 'nft',
        createdAt: Date.now(),
        askXec: nftSellPrice
      })
      const priceXecRaw = Number(nftSellPrice)
      const priceXec = Number.isFinite(priceXecRaw) ? priceXecRaw : 0
      const sessionSummary = wcWallet.getOfferEventTargetsSummary()
      console.info('[Tonalli][DEX][publish] sessions', {
        total: sessionSummary.totalSessions,
        eligibleTopics: sessionSummary.eligibleTopics,
        eligibleChains: sessionSummary.eligibleChains
      })
      const offerPayload: OfferPublishedPayload = {
        version: 1,
        offerId,
        txid,
        tokenId,
        kind: 'nft',
        priceXec,
        seller: xecAddress,
        timestamp: Math.floor(Date.now() / 1000),
        source: 'tonalli'
      }
      await wcWallet.publishOrQueueOffer(offerPayload)
      console.debug(
        '[Tonalli][DEX][publish] kind=',
        'nft',
        'offerId=',
        offerId,
        'txid=',
        txid,
        'tokenId=',
        tokenId,
        'priceXec=',
        priceXec
      )
      await refreshBalances()
    } catch (err) {
      setNftOfferError((err as Error).message || 'No se pudo listar el NFT.')
    } finally {
      setNftSellBusy(false)
    }
  }

  const handleSellMintPass = async (event: React.FormEvent) => {
    event.preventDefault()
    setMintPassError(null)
    setMintPassSellTxid(null)
    setMintPassSellOfferId(null)

    if (!initialized || !backupVerified) {
      setMintPassError('Debes completar el onboarding y respaldar tu seed antes de listar.')
      return
    }

    if (!XOLOSARMY_NFT_PARENT_TOKEN_ID) {
      setMintPassError('No se configuró el token padre para Mint Pass.')
      return
    }

    let tokenAmount: bigint
    try {
      tokenAmount = parseDecimalToAtoms(mintPassSellAmount, 0)
    } catch (err) {
      setMintPassError((err as Error).message)
      return
    }

    if (tokenAmount <= 0n) {
      setMintPassError('La cantidad debe ser mayor a cero.')
      return
    }

    let pricePerUnitSats: bigint
    try {
      pricePerUnitSats = parseXecToSats(mintPassSellPrice)
    } catch (err) {
      setMintPassError((err as Error).message)
      return
    }

    if (pricePerUnitSats <= 0n) {
      setMintPassError('El precio por unidad debe ser mayor a cero.')
      return
    }

    const walletKeyInfo = xolosWalletService.getKeyInfo()
    const xecAddress = walletKeyInfo.xecAddress ?? walletKeyInfo.address
    if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !xecAddress) {
      setMintPassError('No pudimos acceder a las llaves de tu billetera.')
      return
    }

    setMintPassSellBusy(true)
    try {
      const receiveXecSats = pricePerUnitSats * tokenAmount
      const { txid, offerId } = await createSellOfferToken({
        tokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
        tokenAtoms: tokenAmount,
        askXecSats: receiveXecSats,
        payoutAddress: xecAddress,
        wallet: xolosWalletService
      })
      setMintPassSellTxid(txid)
      setMintPassSellOfferId(offerId)
      saveOffer({
        offerId,
        tokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
        kind: 'mintpass',
        createdAt: Date.now(),
        askXec: mintPassSellPrice
      })
      const priceXecRaw = Number(mintPassSellPrice)
      const priceXec = Number.isFinite(priceXecRaw) ? priceXecRaw : 0
      const sessionSummary = wcWallet.getOfferEventTargetsSummary()
      console.info('[Tonalli][DEX][publish] sessions', {
        total: sessionSummary.totalSessions,
        eligibleTopics: sessionSummary.eligibleTopics,
        eligibleChains: sessionSummary.eligibleChains
      })
      const offerPayload: OfferPublishedPayload = {
        version: 1,
        offerId,
        txid,
        tokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
        kind: 'mintpass',
        priceXec,
        seller: xecAddress,
        timestamp: Math.floor(Date.now() / 1000),
        source: 'tonalli'
      }
      await wcWallet.publishOrQueueOffer(offerPayload)
      console.debug(
        '[Tonalli][DEX][publish] kind=',
        'mintpass',
        'offerId=',
        offerId,
        'txid=',
        txid,
        'tokenId=',
        XOLOSARMY_NFT_PARENT_TOKEN_ID,
        'priceXec=',
        priceXec
      )
      await refreshBalances()
    } catch (err) {
      setMintPassError((err as Error).message || 'No se pudo listar el Mint Pass.')
    } finally {
      setMintPassSellBusy(false)
    }
  }

  const handleBuyNftOffer = async () => {
    if (!initialized || !backupVerified || !address) {
      setNftOfferError('Debes completar el onboarding y respaldar tu seed antes de comprar.')
      return
    }
    if (!nftOfferSummary) {
      setNftOfferError('Primero carga un Offer ID válido.')
      return
    }

    setNftOfferError(null)
    setNftBuyTxid(null)
    setNftBuyBusy(true)
    try {
      const { txid } = await acceptOfferById({
        offerId: nftOfferSummary.offerId,
        wallet: xolosWalletService
      })
      setNftBuyTxid(txid)
      markNftRescanPending()
      if (address) {
        await getChronik().address(address).utxos()
        const owned = await fetchOwnedNfts(address, { refreshMetadata: true })
        if (dexTab === 'nft') {
          setOwnedNfts(owned)
        }
      }
      try {
        await rescanWallet({ gapLimit: EXTENDED_GAP_LIMIT })
      } catch {
        await refreshBalances()
      }
    } catch (err) {
      setNftOfferError((err as Error).message || 'No se pudo comprar el NFT.')
    } finally {
      setNftBuyBusy(false)
    }
  }

  const handleLoadMintPassOffer = async (overrideOfferId?: string) => {
    setMintPassError(null)
    setMintPassOfferSummary(null)
    setMintPassBuyTxid(null)

    const offerId = (overrideOfferId ?? mintPassOfferIdInput).trim()
    if (!offerId) {
      setMintPassError('Ingresa un Offer ID válido para Mint Pass.')
      return
    }

    setMintPassOfferLoading(true)
    try {
      const result = await loadOfferById({ offerId, tokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID })
      setMintPassOfferSummary(result.summary)
    } catch (err) {
      setMintPassError((err as Error).message || 'No pudimos cargar esta oferta de Mint Pass.')
    } finally {
      setMintPassOfferLoading(false)
    }
  }

  const handleBuyMintPassOffer = async () => {
    if (!initialized || !backupVerified || !address) {
      setMintPassError('Debes completar el onboarding y respaldar tu seed antes de comprar.')
      return
    }
    if (!mintPassOfferSummary) {
      setMintPassError('Primero carga un Offer ID válido.')
      return
    }

    setMintPassError(null)
    setMintPassBuyTxid(null)
    setMintPassBuyBusy(true)
    try {
      const { txid } = await acceptOfferById({
        offerId: mintPassOfferSummary.offerId,
        wallet: xolosWalletService
      })
      setMintPassBuyTxid(txid)
      await refreshBalances()
    } catch (err) {
      setMintPassError((err as Error).message || 'No se pudo comprar el Mint Pass.')
    } finally {
      setMintPassBuyBusy(false)
    }
  }

  if (!initialized) {
    return (
      <div className="page">
        <TopBar />
        {XOLOSARMY_NFT_PARENT_TOKEN_ID_ERROR && (
          <div className="error" style={{ marginBottom: 12 }}>
            {XOLOSARMY_NFT_PARENT_TOKEN_ID_ERROR}
          </div>
        )}
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

  const offerSummary =
    offerDetails && rmzDecimals !== null
      ? formatOfferSummary({
          offeredAtoms: offerDetails.offeredAtoms,
          tokenDecimals: rmzDecimals,
          askedSats: offerDetails.askedSats
        })
      : null

  return (
    <div className="page">
      <TopBar />
      {XOLOSARMY_NFT_PARENT_TOKEN_ID_ERROR && (
        <div className="error" style={{ marginBottom: 12 }}>
          {XOLOSARMY_NFT_PARENT_TOKEN_ID_ERROR}
        </div>
      )}
      <div className="card">
        <p className="muted">DEX (Phase 1)</p>
        <div className="muted" style={{ marginTop: 8 }}>
          Atomic DEX (oneshot): funciona por Offer ID (txid:vout). No hay orderbook en la red.
        </div>
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
          <button
            className={`cta ${dexTab === 'nft' ? 'primary' : 'ghost'}`}
            type="button"
            onClick={() => setDexTab('nft')}
          >
            NFT Market
          </button>
          <button
            className={`cta ${dexTab === 'mintpass' ? 'primary' : 'ghost'}`}
            type="button"
            onClick={() => setDexTab('mintpass')}
          >
            Mint Pass
          </button>

          {/* Botón Marketplace Externo */}
          <a
            href="https://xololegend.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="cta outline"
            style={{
              marginLeft: 'auto',
              borderColor: 'var(--teal)',
              color: 'var(--teal)',
              borderStyle: 'dashed',
            }}
          >
            🛒 Adquirir RMZ en XoloLegend
          </a>
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

        {dexTab === 'nft' && (
          <div style={{ marginTop: 16 }}>
            <div className="card" style={{ marginBottom: 12 }}>
              <p className="card-kicker">NFT Market</p>
              <p className="muted">Crea o acepta ofertas oneshot con Offer ID.</p>
            </div>

            <div className="card" style={{ marginBottom: 12 }}>
              <p className="card-kicker">Comprar NFT (Offer ID)</p>
              <label htmlFor="nftOfferId">Offer ID</label>
              <input
                id="nftOfferId"
                value={nftOfferIdInput}
                onChange={(event) => setNftOfferIdInput(event.target.value)}
                placeholder="txid:vout"
              />
              <div className="actions" style={{ marginTop: 12 }}>
                <button
                  className="cta outline"
                  type="button"
                  onClick={() => handleLoadNftOffer()}
                  disabled={nftOfferLoading}
                >
                  {nftOfferLoading ? 'Cargando...' : 'Cargar oferta NFT'}
                </button>
                <button className="cta primary" type="button" onClick={handleBuyNftOffer} disabled={nftBuyBusy}>
                  {nftBuyBusy ? 'Comprando...' : 'Comprar'}
                </button>
              </div>
              {nftOfferSummary && (
                <div style={{ marginTop: 12 }}>
                  <div className="nft-inline">
                    <div className="nft-thumb small">
                      {nftOfferPreview?.imageUrl ? (
                        <img src={nftOfferPreview.imageUrl} alt={nftOfferPreview.name} />
                      ) : (
                        <div className="nft-placeholder">Sin imagen</div>
                      )}
                    </div>
                    <div>
                      <h3>{nftOfferPreview?.name || 'NFT'}</h3>
                      <p className="muted">{nftOfferSummary.tokenId}</p>
                    </div>
                  </div>
                  <div className="muted" style={{ marginTop: 8 }}>
                    Precio: {nftOfferSummary.priceXec} XEC
                  </div>
                  {nftOfferSummary.payoutAddress && (
                    <div className="muted" style={{ marginTop: 6 }}>
                      Pago a: {nftOfferSummary.payoutAddress}
                    </div>
                  )}
                </div>
              )}
              {nftBuyTxid && (
                <div className="success" style={{ marginTop: 12 }}>
                  Compra completada: <span className="address-box">{nftBuyTxid}</span>
                </div>
              )}
            </div>

            <form onSubmit={handleSellNft} className="card" style={{ marginBottom: 12 }}>
              <p className="card-kicker">Crear oferta de NFT</p>
              <label htmlFor="nftOwned">NFT propio</label>
              <select
                id="nftOwned"
                value={nftSellTokenId}
                onChange={(event) => {
                  const next = event.target.value
                  setNftSellTokenId(next)
                  if (next) setNftTokenIdInput(next)
                }}
              >
                <option value="">Selecciona un NFT de tu guardianía</option>
                {ownedNfts.map((nft) => (
                  <option key={nft.tokenId} value={nft.tokenId}>
                    {nft.name} · {nft.tokenId.slice(0, 8)}...
                  </option>
                ))}
              </select>

              <label htmlFor="nftTokenId" style={{ marginTop: 12 }}>
                TokenId del NFT (manual)
              </label>
              <input
                id="nftTokenId"
                value={nftTokenIdInput}
                onChange={(event) => setNftTokenIdInput(event.target.value)}
                placeholder="Pega el tokenId del NFT"
              />

              <label htmlFor="nftSellPrice" style={{ marginTop: 12 }}>
                Precio en XEC
              </label>
              <input
                id="nftSellPrice"
                value={nftSellPrice}
                onChange={(event) => setNftSellPrice(event.target.value)}
                placeholder="Ej. 2500"
              />
              <div className="actions" style={{ marginTop: 12 }}>
                <button className="cta primary" type="submit" disabled={nftSellBusy}>
                  {nftSellBusy ? 'Publicando...' : 'Publicar oferta'}
                </button>
              </div>
              {nftSellOfferId && (
                <div className="success" style={{ marginTop: 12 }}>
                  Offer ID: <span className="address-box">{nftSellOfferId}</span>
                  <div className="actions" style={{ marginTop: 8 }}>
                    <button className="cta ghost" type="button" onClick={() => handleCopyText(nftSellOfferId)}>
                      Copiar Offer ID
                    </button>
                  </div>
                  <div className="muted" style={{ marginTop: 6 }}>
                    Comparte este Offer ID para que alguien lo compre.
                  </div>
                </div>
              )}
              {nftSellTxid && (
                <div className="success" style={{ marginTop: 12 }}>
                  Txid publicado: <span className="address-box">{nftSellTxid}</span>
                </div>
              )}
            </form>

            {nftOfferError && <div className="error">{nftOfferError}</div>}

            {savedNftOffers.length > 0 && (
              <div className="card">
                <p className="card-kicker">Mis ofertas guardadas</p>
                {savedNftOffers.map((offer) => (
                  <div className="tx-item" key={offer.offerId}>
                    <p>Offer ID: {offer.offerId}</p>
                    <p className="muted">Precio: {offer.askXec} XEC</p>
                    <div className="actions" style={{ marginTop: 8 }}>
                      <button className="cta ghost" type="button" onClick={() => handleCopyText(offer.offerId)}>
                        Copiar
                      </button>
                      <button
                        className="cta outline"
                        type="button"
                        onClick={() => {
                          setNftOfferIdInput(offer.offerId)
                          handleLoadNftOffer(offer.offerId)
                        }}
                      >
                        Abrir
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {dexTab === 'mintpass' && (
          <div style={{ marginTop: 16 }}>
            <div className="card" style={{ marginBottom: 12 }}>
              <p className="card-kicker">Mint Pass (Parent Token)</p>
              <p className="muted">Para comprar Mint Pass necesitas un Offer ID compartido.</p>
              <div className="address-box" style={{ marginTop: 12 }}>
                {XOLOSARMY_NFT_PARENT_TOKEN_ID || 'Sin configurar'}
              </div>
            </div>

            <div className="card" style={{ marginBottom: 12 }}>
              <p className="card-kicker">Comprar Mint Pass (Offer ID)</p>
              <label htmlFor="mintPassOfferId">Offer ID</label>
              <input
                id="mintPassOfferId"
                value={mintPassOfferIdInput}
                onChange={(event) => setMintPassOfferIdInput(event.target.value)}
                placeholder="txid:vout"
              />
              <div className="actions" style={{ marginTop: 12 }}>
                <button
                  className="cta outline"
                  type="button"
                  onClick={() => handleLoadMintPassOffer()}
                  disabled={mintPassOfferLoading}
                >
                  {mintPassOfferLoading ? 'Cargando...' : 'Cargar oferta'}
                </button>
                <button className="cta primary" type="button" onClick={handleBuyMintPassOffer} disabled={mintPassBuyBusy}>
                  {mintPassBuyBusy ? 'Comprando...' : 'Comprar'}
                </button>
              </div>
              {mintPassOfferSummary && (
                <div style={{ marginTop: 12 }}>
                  <div className="muted">Cantidad: {mintPassOfferSummary.tokenAtoms.toString()}</div>
                  <div className="muted" style={{ marginTop: 6 }}>
                    Total: {mintPassOfferSummary.priceXec} XEC
                  </div>
                  {mintPassOfferSummary.payoutAddress && (
                    <div className="muted" style={{ marginTop: 6 }}>
                      Pago a: {mintPassOfferSummary.payoutAddress}
                    </div>
                  )}
                </div>
              )}
              {mintPassBuyTxid && (
                <div className="success" style={{ marginTop: 12 }}>
                  Compra completada: <span className="address-box">{mintPassBuyTxid}</span>
                </div>
              )}
            </div>

            <form onSubmit={handleSellMintPass} className="card" style={{ marginBottom: 12 }}>
              <p className="card-kicker">Crear oferta de Mint Pass</p>
              <label htmlFor="mintPassAmount">Cantidad</label>
              <input
                id="mintPassAmount"
                value={mintPassSellAmount}
                onChange={(event) => setMintPassSellAmount(event.target.value)}
                placeholder="Ej. 1"
              />
              <label htmlFor="mintPassPrice" style={{ marginTop: 12 }}>
                Precio por unidad (XEC)
              </label>
              <input
                id="mintPassPrice"
                value={mintPassSellPrice}
                onChange={(event) => setMintPassSellPrice(event.target.value)}
                placeholder="Ej. 2500"
              />
              <label htmlFor="mintPassTotal" style={{ marginTop: 12 }}>
                Total XEC deseado
              </label>
              <input id="mintPassTotal" value={computedMintPassTotal} readOnly placeholder="Se calcula automáticamente" />
              <div className="actions" style={{ marginTop: 12 }}>
                <button className="cta primary" type="submit" disabled={mintPassSellBusy}>
                  {mintPassSellBusy ? 'Publicando...' : 'Publicar'}
                </button>
              </div>
              {mintPassSellOfferId && (
                <div className="success" style={{ marginTop: 12 }}>
                  Offer ID: <span className="address-box">{mintPassSellOfferId}</span>
                  <div className="actions" style={{ marginTop: 8 }}>
                    <button className="cta ghost" type="button" onClick={() => handleCopyText(mintPassSellOfferId)}>
                      Copiar Offer ID
                    </button>
                  </div>
                  <div className="muted" style={{ marginTop: 6 }}>
                    Comparte este Offer ID para que alguien lo compre.
                  </div>
                </div>
              )}
              {mintPassSellTxid && (
                <div className="success" style={{ marginTop: 12 }}>
                  Txid publicado: <span className="address-box">{mintPassSellTxid}</span>
                </div>
              )}
            </form>

            {mintPassError && <div className="error">{mintPassError}</div>}

            {savedMintPassOffers.length > 0 && (
              <div className="card">
                <p className="card-kicker">Mis ofertas guardadas</p>
                {savedMintPassOffers.map((offer) => (
                  <div className="tx-item" key={offer.offerId}>
                    <p>Offer ID: {offer.offerId}</p>
                    <p className="muted">Precio: {offer.askXec} XEC</p>
                    <div className="actions" style={{ marginTop: 8 }}>
                      <button className="cta ghost" type="button" onClick={() => handleCopyText(offer.offerId)}>
                        Copiar
                      </button>
                      <button
                        className="cta outline"
                        type="button"
                        onClick={() => {
                          setMintPassOfferIdInput(offer.offerId)
                          handleLoadMintPassOffer(offer.offerId)
                        }}
                      >
                        Abrir
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {loading && <div className="muted">Actualizando saldos...</div>}
      {error && <div className="error">{error}</div>}
      {debugEnabled && <WcDebugPanel />}
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

export default DEX
