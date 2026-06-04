import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { buildAliasRegistration, type AliasRegistrationData } from '@xolosarmy/tonalli-core'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import { XEC_SATS_PER_XEC } from '../config/xecFees'
import { parseTokenAmount } from '../utils/tokenFormat'

type AliasTxResult = {
  rmzTxid: string
  aliasTxid: string
}

const formatXecFromSats = (sats: number) => (sats / XEC_SATS_PER_XEC).toLocaleString(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

const explorerUrl = (txid: string) => `https://explorer.xolosarmy.xyz/tx/${txid}`

function RegisterAlias() {
  const {
    address,
    balance,
    initialized,
    backupVerified,
    loading,
    error,
    sendRMZ,
    estimateAliasRegistration,
    registerAliasOnChain
  } = useWallet()
  const [aliasInput, setAliasInput] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const [networkFeeSats, setNetworkFeeSats] = useState<number | null>(null)
  const [totalXecCostSats, setTotalXecCostSats] = useState<number | null>(null)
  const [rmzTxid, setRmzTxid] = useState<string | null>(null)
  const [aliasTxid, setAliasTxid] = useState<string | null>(null)
  const [result, setResult] = useState<AliasTxResult | null>(null)
  const [step, setStep] = useState<'idle' | 'rmz' | 'alias' | 'done'>('idle')

  const preview = useMemo<{ registration: AliasRegistrationData | null; error: string | null }>(() => {
    if (!aliasInput.trim()) return { registration: null, error: null }
    if (!address) return { registration: null, error: 'La billetera no tiene direccion eCash cargada.' }

    try {
      return {
        registration: buildAliasRegistration(aliasInput, address),
        error: null
      }
    } catch (err) {
      return {
        registration: null,
        error: (err as Error).message || 'Alias invalido.'
      }
    }
  }, [address, aliasInput])

  useEffect(() => {
    let cancelled = false
    const runEstimate = async () => {
      setEstimateError(null)
      setNetworkFeeSats(null)
      setTotalXecCostSats(null)

      if (!initialized || !backupVerified || !preview.registration) return

      try {
        const estimate = await estimateAliasRegistration(preview.registration)
        if (cancelled) return
        setNetworkFeeSats(estimate.networkFeeSats)
        setTotalXecCostSats(estimate.totalCostSats)
      } catch (err) {
        if (cancelled) return
        setEstimateError((err as Error).message)
      }
    }

    void runEstimate()
    return () => {
      cancelled = true
    }
  }, [backupVerified, estimateAliasRegistration, initialized, preview.registration])

  const registration = preview.registration
  const serviceFeeAmount = registration?.serviceFee.amount ?? 1600
  const protocolFeeSats = registration?.protocolFee.sats ?? null

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setLocalError(null)
    setRmzTxid(null)
    setAliasTxid(null)
    setResult(null)
    setStep('idle')

    if (!initialized || !backupVerified) {
      setLocalError('Debes completar el onboarding y el respaldo de tu frase semilla antes de registrar un alias.')
      return
    }

    if (!registration) {
      setLocalError(preview.error || 'Ingresa un alias valido.')
      return
    }

    if (!balance) {
      setLocalError('No pudimos cargar tus saldos. Actualiza la billetera e intenta de nuevo.')
      return
    }

    const requiredRmzAtoms = parseTokenAmount(String(registration.serviceFee.amount), balance.rmzDecimals)
    if (balance.rmzAtoms < requiredRmzAtoms) {
      setLocalError(`No hay suficientes RMZ. Se requieren ${registration.serviceFee.amount} RMZ.`)
      return
    }

    let xecEstimate = totalXecCostSats
    if (xecEstimate === null) {
      try {
        const estimate = await estimateAliasRegistration(registration)
        xecEstimate = estimate.totalCostSats
        setNetworkFeeSats(estimate.networkFeeSats)
        setTotalXecCostSats(estimate.totalCostSats)
      } catch (err) {
        setLocalError((err as Error).message)
        return
      }
    }

    if (BigInt(xecEstimate) > balance.xec) {
      setLocalError(`No hay suficiente XEC. Se requieren ${formatXecFromSats(xecEstimate)} XEC para fee oficial y red.`)
      return
    }

    try {
      setStep('rmz')
      const paidRmzTxid = await sendRMZ(registration.serviceFee.receiverAddress, String(registration.serviceFee.amount))
      setRmzTxid(paidRmzTxid)

      setStep('alias')
      const registeredAliasTxid = await registerAliasOnChain(registration)
      setAliasTxid(registeredAliasTxid)
      const txResult = { rmzTxid: paidRmzTxid, aliasTxid: registeredAliasTxid }
      setResult(txResult)
      setStep('done')
    } catch (err) {
      setLocalError((err as Error).message)
      setStep('idle')
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Register Alias / Identidad</p>
          <h1 className="section-title">Registra tu alias .xec</h1>
          <p className="muted">Reserva una identidad eCash para esta direccion con una operacion de dos pasos.</p>
        </div>
      </header>

      {!backupVerified && (
        <div className="error">
          Debes completar el onboarding y el respaldo de tu frase semilla antes de registrar un alias.
        </div>
      )}

      <form className="card" onSubmit={handleSubmit}>
        <label htmlFor="alias">Alias</label>
        <input
          id="alias"
          value={aliasInput}
          onChange={(event) => setAliasInput(event.target.value)}
          placeholder="xolosarmy"
          autoCapitalize="none"
          autoCorrect="off"
        />

        {preview.error && <div className="error">{preview.error}</div>}

        <div className="fee-breakdown">
          <div>
            <span>Alias</span>
            <strong>{registration ? registration.alias : '-'}</strong>
          </div>
          <div>
            <span>Direccion destino</span>
            <strong className="address-box">{address || '-'}</strong>
          </div>
          <div>
            <span>Official eCash Alias protocol fee</span>
            <strong>{protocolFeeSats !== null ? `${formatXecFromSats(protocolFeeSats)} XEC` : '-'}</strong>
          </div>
          <div>
            <span>Tarifa de red estimada</span>
            <strong>{networkFeeSats !== null ? `${formatXecFromSats(networkFeeSats)} XEC` : '-'}</strong>
          </div>
          <div>
            <span>xolosArmy service fee</span>
            <strong>{serviceFeeAmount} RMZ</strong>
          </div>
          {registration && (
            <div className="muted">
              Tesoreria RMZ: <span className="address-box">{registration.serviceFee.receiverAddress}</span>
            </div>
          )}
          <div className="total-line">
            <span>Total XEC estimado</span>
            <strong>{totalXecCostSats !== null ? `${formatXecFromSats(totalXecCostSats)} XEC` : '-'}</strong>
          </div>
          <p className="muted note">
            Paso 1 envia 1600 RMZ a tesoreria. Paso 2 registra el alias con OP_RETURN .xec y fee oficial XEC.
          </p>
        </div>

        {estimateError && <div className="error">{estimateError}</div>}
        {(localError || error) && <div className="error">{localError || error}</div>}

        <div className="actions">
          <button
            className="cta"
            type="submit"
            disabled={!initialized || !backupVerified || loading || !registration || Boolean(preview.error)}
          >
            {step === 'rmz' ? 'Enviando RMZ...' : step === 'alias' ? 'Registrando alias...' : 'Registrar alias'}
          </button>
        </div>

        {(rmzTxid || aliasTxid) && (
          <div className="success">
            <p className="success-title">Transacciones</p>
            {rmzTxid && (
              <p className="success-hash">
                RMZ fee tx:
                <a href={explorerUrl(rmzTxid)} target="_blank" rel="noopener noreferrer" className="success-link">
                  {rmzTxid}
                </a>
              </p>
            )}
            {aliasTxid && (
              <p className="success-hash">
                Alias tx:
                <a href={explorerUrl(aliasTxid)} target="_blank" rel="noopener noreferrer" className="success-link">
                  {aliasTxid}
                </a>
              </p>
            )}
            {result && <pre className="address-box">{JSON.stringify(result, null, 2)}</pre>}
            {aliasTxid && <p className="muted">El alias puede aparecer despues de confirmacion y refresh de alias.ecash.mx.</p>}
          </div>
        )}
      </form>
    </div>
  )
}

export default RegisterAlias
