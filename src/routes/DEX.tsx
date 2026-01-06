import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
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
import { useWallet } from '../context/useWallet'
import { RMZ_ETOKEN_ID } from '../config/rmzToken'
import { XOLOSARMY_NFT_PARENT_TOKEN_ID } from '../config/nfts'
import { getChronik } from '../services/ChronikClient'
import { xolosWalletService } from '../services/XolosWalletService'
import { fetchOwnedNfts, type NftAsset } from '../services/nftService'
import {
  acceptOfferByOfferId,
  checkAgoraAvailability,
  createSellOfferForTokenId,
  fetchOrderbookByTokenId,
  type AgoraOrder
} from '../services/agoraExchange'
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

function DEX() {
  const { address, initialized, refreshBalances, loading, error, backupVerified } = useWallet()
  const [rmzDecimals, setRmzDecimals] = useState<number | null>(null)
  const [dexTab, setDexTab] = useState<'maker' | 'taker' | 'nft' | 'mintpass'>('maker')
  const [searchParams] = useSearchParams()

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
  const [agoraPluginReady, setAgoraPluginReady] = useState(true)
  const [agoraPluginMessage, setAgoraPluginMessage] = useState<string | null>(null)
  const [agoraCheckStatus, setAgoraCheckStatus] = useState<number | null>(null)
  const [agoraCheckDetails, setAgoraCheckDetails] = useState<string | null>(null)
  const [agoraCheckEndpoint, setAgoraCheckEndpoint] = useState<string | null>(null)
  const [agoraCheckUrl, setAgoraCheckUrl] = useState<string | null>(null)
  const [agoraCheckBusy, setAgoraCheckBusy] = useState(false)

  const [ownedNfts, setOwnedNfts] = useState<NftAsset[]>([])
  const [nftTokenIdInput, setNftTokenIdInput] = useState('')
  const [nftOffers, setNftOffers] = useState<AgoraOrder[]>([])
  const [nftOfferError, setNftOfferError] = useState<string | null>(null)
  const [nftOffersLoading, setNftOffersLoading] = useState(false)
  const [nftSellPrice, setNftSellPrice] = useState('')
  const [nftSellTokenId, setNftSellTokenId] = useState('')
  const [nftSellBusy, setNftSellBusy] = useState(false)
  const [nftSellTxid, setNftSellTxid] = useState<string | null>(null)
  const [nftBuyBusy, setNftBuyBusy] = useState(false)
  const [nftBuyTxid, setNftBuyTxid] = useState<string | null>(null)

  const [mintPassOffers, setMintPassOffers] = useState<AgoraOrder[]>([])
  const [mintPassError, setMintPassError] = useState<string | null>(null)
  const [mintPassOffersLoading, setMintPassOffersLoading] = useState(false)
  const [mintPassSellAmount, setMintPassSellAmount] = useState('')
  const [mintPassSellPrice, setMintPassSellPrice] = useState('')
  const [mintPassSellBusy, setMintPassSellBusy] = useState(false)
  const [mintPassSellTxid, setMintPassSellTxid] = useState<string | null>(null)
  const [mintPassBuyBusy, setMintPassBuyBusy] = useState(false)
  const [mintPassBuyTxid, setMintPassBuyTxid] = useState<string | null>(null)

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
    let active = true
    const checkAgoraPlugin = async () => {
      setAgoraCheckBusy(true)
      const status = await checkAgoraAvailability()
      if (active) {
        setAgoraPluginReady(status.ok)
        setAgoraPluginMessage(status.ok ? null : status.message || 'El plugin Agora no está disponible en este nodo.')
        setAgoraCheckStatus(status.status ?? null)
        setAgoraCheckDetails(status.details ?? null)
        setAgoraCheckEndpoint(status.endpointPath ?? null)
        setAgoraCheckUrl(status.chronikUrl ?? null)
        setAgoraCheckBusy(false)
      }
    }
    checkAgoraPlugin()
    return () => {
      active = false
    }
  }, [])

  const loadMintPassOffers = useCallback(async () => {
    setMintPassError(null)
    setMintPassOffers([])
    setMintPassBuyTxid(null)

    if (!agoraPluginReady) {
      setMintPassError(agoraPluginMessage || 'El plugin Agora no está disponible en este nodo.')
      return
    }
    if (!XOLOSARMY_NFT_PARENT_TOKEN_ID) {
      setMintPassError('No se configuró el token padre para Mint Pass.')
      return
    }

    setMintPassOffersLoading(true)
    try {
      const offers = await fetchOrderbookByTokenId(XOLOSARMY_NFT_PARENT_TOKEN_ID)
      setMintPassOffers(offers)
    } catch (err) {
      setMintPassError((err as Error).message || 'No pudimos cargar ofertas del Mint Pass.')
    } finally {
      setMintPassOffersLoading(false)
    }
  }, [agoraPluginMessage, agoraPluginReady])

  const handleRetryAgoraCheck = useCallback(async () => {
    setAgoraCheckBusy(true)
    const status = await checkAgoraAvailability()
    setAgoraPluginReady(status.ok)
    setAgoraPluginMessage(status.ok ? null : status.message || 'El plugin Agora no está disponible en este nodo.')
    setAgoraCheckStatus(status.status ?? null)
    setAgoraCheckDetails(status.details ?? null)
    setAgoraCheckEndpoint(status.endpointPath ?? null)
    setAgoraCheckUrl(status.chronikUrl ?? null)
    setAgoraCheckBusy(false)
  }, [])

  useEffect(() => {
    const mode = searchParams.get('mode') || ''
    const tokenId = searchParams.get('tokenId') || ''
    if (mode === 'mintpass' && tokenId === XOLOSARMY_NFT_PARENT_TOKEN_ID) {
      setDexTab('mintpass')
      loadMintPassOffers()
      return
    }

    const nftTokenId = tokenId || searchParams.get('nftTokenId') || ''
    if (nftTokenId) {
      setDexTab('nft')
      setNftTokenIdInput(nftTokenId)
      if (mode === 'nft') {
        handleLoadNftOffers(nftTokenId)
      }
    }
  }, [handleLoadNftOffers, loadMintPassOffers, searchParams])

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

  const handleCreateOffer = async (event: React.FormEvent) => {
    event.preventDefault()
    setMakerError(null)
    setMakerTxid(null)
    setMakerOfferId(null)
    setMakerAdvanced(null)

    if (!agoraPluginReady) {
      setMakerError(agoraPluginMessage || 'El plugin Agora no está disponible en este nodo.')
      return
    }
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

    if (!agoraPluginReady) {
      setOfferLookupError(agoraPluginMessage || 'El plugin Agora no está disponible en este nodo.')
      return
    }
    if (!initialized || !backupVerified) {
      setOfferLookupError('Debes completar el onboarding y respaldar tu seed antes de comprar.')
      return
    }

    setBuyBusy(true)
    try {
      const walletKeyInfo = xolosWalletService.getKeyInfo()
      const xecAddress = walletKeyInfo.xecAddress ?? walletKeyInfo.address
      if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !xecAddress) {
        setOfferLookupError('No pudimos acceder a las llaves de tu billetera.')
        return
      }
      const recipientScript = Script.fromAddress(xecAddress)

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

      const addressUtxos = await getChronik().address(xecAddress).utxos()
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

  const handleLoadNftOffers = useCallback(async (overrideTokenId?: string) => {
    setNftOfferError(null)
    setNftOffers([])
    setNftBuyTxid(null)

    if (!agoraPluginReady) {
      setNftOfferError(agoraPluginMessage || 'El plugin Agora no está disponible en este nodo.')
      return
    }

    const tokenId = (overrideTokenId ?? nftTokenIdInput).trim()
    if (!tokenId) {
      setNftOfferError('Ingresa un tokenId de NFT válido.')
      return
    }

    setNftOffersLoading(true)
    try {
      const offers = await fetchOrderbookByTokenId(tokenId)
      setNftOffers(offers)
    } catch (err) {
      setNftOfferError((err as Error).message || 'No pudimos cargar ofertas para este NFT.')
    } finally {
      setNftOffersLoading(false)
    }
  }, [agoraPluginMessage, agoraPluginReady, nftTokenIdInput])

  const handleSellNft = async (event: React.FormEvent) => {
    event.preventDefault()
    setNftOfferError(null)
    setNftSellTxid(null)

    if (!agoraPluginReady) {
      setNftOfferError(agoraPluginMessage || 'El plugin Agora no está disponible en este nodo.')
      return
    }
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

    const walletKeyInfo = xolosWalletService.getKeyInfo()
    const xecAddress = walletKeyInfo.xecAddress ?? walletKeyInfo.address
    if (!walletKeyInfo.privateKeyHex || !walletKeyInfo.publicKeyHex || !xecAddress) {
      setNftOfferError('No pudimos acceder a las llaves de tu billetera.')
      return
    }

    setNftSellBusy(true)
    try {
      const { txid } = await createSellOfferForTokenId({
        tokenId,
        tokenAtoms: 1n,
        askXecSats: receiveXecSats,
        payoutAddress: xecAddress,
        wallet: xolosWalletService
      })
      setNftSellTxid(txid)
      await refreshBalances()
      await handleLoadNftOffers()
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

    if (!agoraPluginReady) {
      setMintPassError(agoraPluginMessage || 'El plugin Agora no está disponible en este nodo.')
      return
    }
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
      const { txid } = await createSellOfferForTokenId({
        tokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
        tokenAtoms: tokenAmount,
        askXecSats: receiveXecSats,
        payoutAddress: xecAddress,
        wallet: xolosWalletService
      })
      setMintPassSellTxid(txid)
      await refreshBalances()
      await loadMintPassOffers()
    } catch (err) {
      setMintPassError((err as Error).message || 'No se pudo listar el Mint Pass.')
    } finally {
      setMintPassSellBusy(false)
    }
  }

  const handleBuyNftOffer = async (offer: AgoraOrder) => {
    if (!initialized || !backupVerified || !address) {
      setNftOfferError('Debes completar el onboarding y respaldar tu seed antes de comprar.')
      return
    }

    if (!agoraPluginReady) {
      setNftOfferError(agoraPluginMessage || 'El plugin Agora no está disponible en este nodo.')
      return
    }
    setNftOfferError(null)
    setNftBuyTxid(null)
    setNftBuyBusy(true)
    try {
      const { txid } = await acceptOfferByOfferId({
        offerId: offer.offerId,
        tokenId: offer.tokenId,
        wallet: xolosWalletService
      })
      setNftBuyTxid(txid)
      await refreshBalances()
    } catch (err) {
      setNftOfferError((err as Error).message || 'No se pudo comprar el NFT.')
    } finally {
      setNftBuyBusy(false)
    }
  }

  const handleBuyMintPassOffer = async (offer: AgoraOrder) => {
    if (!initialized || !backupVerified || !address) {
      setMintPassError('Debes completar el onboarding y respaldar tu seed antes de comprar.')
      return
    }

    if (!agoraPluginReady) {
      setMintPassError(agoraPluginMessage || 'El plugin Agora no está disponible en este nodo.')
      return
    }
    setMintPassError(null)
    setMintPassBuyTxid(null)
    setMintPassBuyBusy(true)
    try {
      const { txid } = await acceptOfferByOfferId({
        offerId: offer.offerId,
        tokenId: XOLOSARMY_NFT_PARENT_TOKEN_ID,
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
      <div className="card">
        <p className="muted">DEX (Phase 1)</p>
        {!agoraPluginReady && (
          <div className="muted" style={{ marginTop: 8 }}>
            <div>DEX en modo solo lectura · {agoraPluginMessage || 'Plugin agora not loaded'}</div>
            <div style={{ marginTop: 6 }}>Chronik: {agoraCheckUrl || 'desconocida'}</div>
            <div>Endpoint: {agoraCheckEndpoint || '/plugin/agora/groups'}</div>
            {agoraCheckStatus !== null && <div>HTTP {agoraCheckStatus}</div>}
            {agoraCheckDetails && (
              <details style={{ marginTop: 6 }}>
                <summary>Detalles</summary>
                <div className="address-box" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                  {agoraCheckDetails}
                </div>
              </details>
            )}
            <div className="actions" style={{ marginTop: 8 }}>
              <button className="cta ghost" type="button" onClick={handleRetryAgoraCheck} disabled={agoraCheckBusy}>
                {agoraCheckBusy ? 'Reintentando...' : 'Reintentar'}
              </button>
            </div>
          </div>
        )}
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
              <p className="muted">Lista o compra NFTs de la colección xolosArmy.</p>
            </div>

            <form onSubmit={handleSellNft} className="card" style={{ marginBottom: 12 }}>
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
                <button className="cta primary" type="submit" disabled={nftSellBusy || !agoraPluginReady}>
                  {nftSellBusy ? 'Publicando...' : 'Publicar oferta'}
                </button>
              </div>
              {nftSellTxid && (
                <div className="success" style={{ marginTop: 12 }}>
                  Oferta publicada: <span className="address-box">{nftSellTxid}</span>
                </div>
              )}
            </form>

            <div className="card" style={{ marginBottom: 12 }}>
              <label htmlFor="nftTokenId">TokenId del NFT</label>
              <input
                id="nftTokenId"
                value={nftTokenIdInput}
                onChange={(event) => setNftTokenIdInput(event.target.value)}
                placeholder="Pega el tokenId del NFT"
              />
              <div className="actions" style={{ marginTop: 12 }}>
                <button
                  className="cta outline"
                  type="button"
                  onClick={handleLoadNftOffers}
                  disabled={nftOffersLoading || !agoraPluginReady}
                >
                  {nftOffersLoading ? 'Cargando...' : 'Cargar ofertas'}
                </button>
              </div>
            </div>

            {nftOfferError && <div className="error">{nftOfferError}</div>}

            {nftOffers.length > 0 && (
              <div className="card">
                <p className="card-kicker">Ofertas activas</p>
                {nftOffers.map((offer, index) => {
                  return (
                    <div className="tx-item" key={`${offer.offerId}-${index}`}>
                      <p>Precio: {offer.priceXec} XEC</p>
                      <div className="muted" style={{ marginTop: 6 }}>
                        Offer ID: {offer.offerId}
                      </div>
                      <div className="actions" style={{ marginTop: 8 }}>
                        <button
                          className="cta primary"
                          type="button"
                          onClick={() => handleBuyNftOffer(offer)}
                          disabled={nftBuyBusy || !agoraPluginReady}
                        >
                          {nftBuyBusy ? 'Comprando...' : 'Comprar'}
                        </button>
                      </div>
                    </div>
                  )
                })}
                {nftBuyTxid && (
                  <div className="success" style={{ marginTop: 12 }}>
                    Compra completada: <span className="address-box">{nftBuyTxid}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {dexTab === 'mintpass' && (
          <div style={{ marginTop: 16 }}>
            <div className="card" style={{ marginBottom: 12 }}>
              <p className="card-kicker">Mint Pass (Parent Token)</p>
              <p className="muted">Compra Mint Pass para poder mintear.</p>
              <div className="address-box" style={{ marginTop: 12 }}>
                {XOLOSARMY_NFT_PARENT_TOKEN_ID || 'Sin configurar'}
              </div>
              <div className="actions" style={{ marginTop: 12 }}>
                <button
                  className="cta outline"
                  type="button"
                  onClick={loadMintPassOffers}
                  disabled={mintPassOffersLoading || !agoraPluginReady}
                >
                  {mintPassOffersLoading ? 'Cargando...' : 'Cargar ofertas'}
                </button>
              </div>
            </div>

            <form onSubmit={handleSellMintPass} className="card" style={{ marginBottom: 12 }}>
              <p className="card-kicker">Vender Parent Token</p>
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
                <button className="cta primary" type="submit" disabled={mintPassSellBusy || !agoraPluginReady}>
                  {mintPassSellBusy ? 'Publicando...' : 'Publicar'}
                </button>
              </div>
              {mintPassSellTxid && (
                <div className="success" style={{ marginTop: 12 }}>
                  Oferta publicada: <span className="address-box">{mintPassSellTxid}</span>
                </div>
              )}
            </form>

            {mintPassError && <div className="error">{mintPassError}</div>}
            {mintPassOffersLoading && <div className="muted">Cargando ofertas...</div>}
            {!mintPassOffersLoading && mintPassOffers.length === 0 && !mintPassError && (
              <div className="muted">No hay ofertas activas.</div>
            )}

            {mintPassOffers.length > 0 && (
              <div className="card">
                <p className="card-kicker">Ofertas activas</p>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }}>Cantidad</th>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }}>Total XEC</th>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }}>XEC por Mint Pass</th>
                      <th style={{ textAlign: 'left', padding: '8px 6px' }} />
                    </tr>
                  </thead>
                  <tbody>
                    {mintPassOffers.map((offer, index) => {
                      const offeredAtoms = offer.tokenAtoms
                      const askedSats = offer.priceSats
                      const perUnitSats = offeredAtoms > 0n ? askedSats / offeredAtoms : 0n
                      return (
                        <tr key={`${offer.offerId}-${index}`}>
                          <td style={{ padding: '8px 6px' }}>{offeredAtoms.toString()}</td>
                          <td style={{ padding: '8px 6px' }}>{formatSatsToXec(askedSats)} XEC</td>
                          <td style={{ padding: '8px 6px' }}>{formatSatsToXec(perUnitSats)} XEC</td>
                          <td style={{ padding: '8px 6px' }}>
                            <button
                              className="cta primary"
                              type="button"
                              onClick={() => handleBuyMintPassOffer(offer)}
                              disabled={mintPassBuyBusy || !agoraPluginReady}
                            >
                              {mintPassBuyBusy ? 'Comprando...' : 'Comprar'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {mintPassBuyTxid && (
                  <div className="success" style={{ marginTop: 12 }}>
                    Compra completada: <span className="address-box">{mintPassBuyTxid}</span>
                  </div>
                )}
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

export default DEX
