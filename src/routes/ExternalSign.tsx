import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ALL_BIP143, P2PKHSignatory, Script, Tx, TxBuilder, fromHex, toHex } from 'ecash-lib'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { getChronik } from '../services/ChronikClient'
import { xolosWalletService } from '../services/XolosWalletService'
import {
  EXTERNAL_SIGN_REQUEST_STORAGE_KEY,
  EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY,
  extractOutpointsFromUnsignedTxHex,
  parseExternalSignRequestParam,
  parseExternalSignRequestStored,
  type ExternalSignRequest
} from '../utils/externalSign'

const ONBOARDING_RETURN_TO = '/external-sign'

type ExternalSignResult = {
  signedTxHex: string
  txid?: string
}

function isWalletReady() {
  const keyInfo = xolosWalletService.getKeyInfo()
  return {
    ready: Boolean(keyInfo.address && keyInfo.privateKeyHex && keyInfo.publicKeyHex),
    keyInfo
  }
}

function toFriendlyError(message: string): string {
  if (message.startsWith('INPUT_NOT_OWNED:')) {
    const outpoint = message.slice('INPUT_NOT_OWNED:'.length)
    return `No se pudo firmar: el input ${outpoint} no pertenece a esta wallet.`
  }

  if (message.startsWith('PREVOUT_NOT_FOUND:')) {
    const outpoint = message.slice('PREVOUT_NOT_FOUND:'.length)
    return `No se pudo firmar: no se encontró el prevout ${outpoint} en Chronik.`
  }

  return message || 'No se pudo procesar la solicitud de firma externa.'
}

async function signExternalRequest(request: ExternalSignRequest): Promise<ExternalSignResult> {
  console.info(
    `[external-sign] request received flow=${request.meta?.flow ?? 'unknown'} broadcast=${request.broadcast === true}`
  )

  const outpoints = extractOutpointsFromUnsignedTxHex(request.unsignedTxHex)
  console.info(`[external-sign] derived inputs=${outpoints.length}`)

  const wallet = isWalletReady()
  if (!wallet.ready || !wallet.keyInfo.privateKeyHex || !wallet.keyInfo.publicKeyHex || !wallet.keyInfo.address) {
    throw new Error('No pudimos acceder a la cuenta activa para firmar.')
  }

  const unsignedTx = Tx.fromHex(request.unsignedTxHex)
  const chronik = getChronik()

  const signer = P2PKHSignatory(
    fromHex(wallet.keyInfo.privateKeyHex),
    fromHex(wallet.keyInfo.publicKeyHex),
    ALL_BIP143
  )
  const walletScript = Script.fromAddress(wallet.keyInfo.address.replace(/^ecash:/, ''))
  const walletScriptHex = toHex(walletScript.bytecode).toLowerCase()

  const prevTxCache = new Map<string, Awaited<ReturnType<ReturnType<typeof getChronik>['tx']>>>()
  const builder = TxBuilder.fromTx(unsignedTx)

  for (let index = 0; index < unsignedTx.inputs.length; index += 1) {
    const input = unsignedTx.inputs[index]
    const txid = outpoints[index]?.txid
    const vout = outpoints[index]?.vout

    if (!txid || vout === undefined) {
      throw new Error(`No se pudo derivar outpoint para input ${index}.`)
    }

    let prevTx = prevTxCache.get(txid)
    if (!prevTx) {
      prevTx = await chronik.tx(txid)
      prevTxCache.set(txid, prevTx)
    }

    const prevOutput = prevTx.outputs[vout]
    if (!prevOutput) {
      throw new Error(`PREVOUT_NOT_FOUND:${txid}:${vout}`)
    }

    const prevScriptHex = (prevOutput.outputScript ?? '').toLowerCase()
    if (!prevScriptHex || prevScriptHex !== walletScriptHex) {
      throw new Error(`INPUT_NOT_OWNED:${txid}:${vout}`)
    }

    const parsedPrevScript = new Script(fromHex(prevOutput.outputScript))

    builder.inputs[index].input = {
      ...builder.inputs[index].input,
      prevOut: input.prevOut
    }
    builder.inputs[index].input.signData = {
      sats: BigInt(prevOutput.sats),
      outputScript: parsedPrevScript
    }
    builder.inputs[index].signatory = signer
  }

  const signedTx = builder.sign()
  const signedTxHex = signedTx.toHex()

  if (request.broadcast !== true) {
    return { signedTxHex }
  }

  const broadcast = await chronik.broadcastTx(signedTxHex)
  console.info(`[external-sign] broadcast success txid=${broadcast.txid}`)

  if (!broadcast.txid) {
    throw new Error('La red no devolvió txid al hacer broadcast.')
  }

  return {
    signedTxHex,
    txid: broadcast.txid
  }
}

function ExternalSign() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { initialized } = useWallet()

  const [request, setRequest] = useState<ExternalSignRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ExternalSignResult | null>(null)
  const [processing, setProcessing] = useState(false)
  const processingRef = useRef(false)

  const walletReady = useMemo(() => initialized && isWalletReady().ready, [initialized])

  useEffect(() => {
    const fromQuery = searchParams.get('request')

    try {
      if (fromQuery && fromQuery.trim().length > 0) {
        const parsed = parseExternalSignRequestParam(fromQuery)
        sessionStorage.setItem(EXTERNAL_SIGN_REQUEST_STORAGE_KEY, JSON.stringify(parsed))
        setRequest(parsed)
        setError(null)
        return
      }

      const fromSession = sessionStorage.getItem(EXTERNAL_SIGN_REQUEST_STORAGE_KEY)
      if (!fromSession) {
        setRequest(null)
        setError('No se encontró una solicitud externa para firmar.')
        return
      }

      const parsedSession = parseExternalSignRequestStored(fromSession)
      setRequest(parsedSession)
      setError(null)
    } catch (err) {
      const message = (err as Error).message || 'Request inválido para external-sign.'
      setRequest(null)
      setError(message)
    }
  }, [searchParams])

  useEffect(() => {
    if (!request || walletReady) return

    sessionStorage.setItem(EXTERNAL_SIGN_REQUEST_STORAGE_KEY, JSON.stringify(request))
    sessionStorage.setItem(EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY, ONBOARDING_RETURN_TO)
    navigate(`/onboarding?returnTo=${encodeURIComponent(ONBOARDING_RETURN_TO)}`, { replace: true })
  }, [navigate, request, walletReady])

  useEffect(() => {
    if (!request || !walletReady || processingRef.current) return

    processingRef.current = true
    setProcessing(true)
    setError(null)

    void (async () => {
      try {
        const signed = await signExternalRequest(request)
        setResult(signed)
        sessionStorage.removeItem(EXTERNAL_SIGN_REQUEST_STORAGE_KEY)
        sessionStorage.removeItem(EXTERNAL_SIGN_RETURN_TO_STORAGE_KEY)
      } catch (err) {
        setResult(null)
        setError(toFriendlyError((err as Error).message || 'No se pudo procesar la firma externa.'))
        processingRef.current = false
      } finally {
        setProcessing(false)
      }
    })()
  }, [request, walletReady])

  return (
    <div className="page">
      <TopBar />

      <header className="section-header">
        <div>
          <p className="eyebrow">TONALLI_SIGN_REQUEST</p>
          <h1 className="section-title">Firma externa</h1>
          <p className="muted">Firmado desde unsignedTxHex sin pedir txid:vout manual.</p>
        </div>
      </header>

      <section className="card">
        {request && (
          <>
            <p className="muted">Flow: {request.meta?.flow ?? 'N/D'}</p>
            <p className="muted">Broadcast: {request.broadcast === true ? 'Sí' : 'No'}</p>
          </>
        )}

        {processing && <div className="muted">Procesando firma externa...</div>}
        {error && <div className="error">{error}</div>}

        {result && (
          <div className="success">
            <p>{result.txid ? `Firma y broadcast completados. Txid: ${result.txid}` : 'Firma completada (sin broadcast).'}</p>
            <label htmlFor="signed-tx">signedTxHex</label>
            <textarea id="signed-tx" rows={4} value={result.signedTxHex} readOnly />
          </div>
        )}
      </section>
    </div>
  )
}

export default ExternalSign
