import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import TopBar from '../../components/TopBar'
import { TONALLI_SERVICE_FEE_XEC, XEC_SATS_PER_XEC } from '../../config/xecFees'
import type { EcashMultisigVault } from '../../services/EcashMultisigService'
import { ecashMultisigService } from '../../services/EcashMultisigService'

type VaultBalance = {
  sats: bigint
  loading: boolean
  error: string | null
}

type FundVaultState = {
  amountXec: string
  includeTonalliFee: boolean
  loading: boolean
  error: string | null
  txid: string | null
}

const emptyFundState = (): FundVaultState => ({
  amountXec: '',
  includeTonalliFee: false,
  loading: false,
  error: null,
  txid: null
})

const parseXecAmountToSats = (value: string) => {
  const trimmed = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) {
    throw new Error('Ingresa un monto XEC puro valido, con maximo 2 decimales.')
  }
  const [whole, fraction = ''] = trimmed.split('.')
  const sats = BigInt(whole) * BigInt(XEC_SATS_PER_XEC) + BigInt(fraction.padEnd(2, '0'))
  if (sats <= 0n) {
    throw new Error('El monto debe ser mayor a cero.')
  }
  return sats
}

const formatPreviewAmount = (value: string) => {
  try {
    return `${formatXec(parseXecAmountToSats(value))} XEC`
  } catch {
    return 'Pendiente'
  }
}

const formatXec = (sats: bigint) => (Number(sats) / XEC_SATS_PER_XEC).toFixed(2)

function VaultDashboard() {
  const [vaults, setVaults] = useState<EcashMultisigVault[]>([])
  const [balances, setBalances] = useState<Record<string, VaultBalance>>({})
  const [exportJson, setExportJson] = useState('')
  const [importJson, setImportJson] = useState('')
  const [importStatus, setImportStatus] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [fundForms, setFundForms] = useState<Record<string, FundVaultState>>({})

  const refreshVaults = useCallback(() => {
    const savedVaults = ecashMultisigService.listVaults()
    setVaults(savedVaults)
    setBalances({})
    savedVaults.forEach((vault) => {
      setBalances((current) => ({
        ...current,
        [vault.id]: { sats: 0n, loading: true, error: null }
      }))
      void ecashMultisigService.getVaultUtxos(vault)
        .then((utxos) => {
          const sats = utxos
            .filter((utxo) => !utxo.token)
            .reduce((sum, utxo) => sum + utxo.sats, 0n)
          setBalances((current) => ({
            ...current,
            [vault.id]: { sats, loading: false, error: null }
          }))
        })
        .catch((err) => {
          setBalances((current) => ({
            ...current,
            [vault.id]: { sats: 0n, loading: false, error: (err as Error).message }
          }))
        })
    })
  }, [])

  useEffect(() => {
    refreshVaults()
  }, [refreshVaults])

  const updateFundForm = (vaultId: string, patch: Partial<FundVaultState>) => {
    setFundForms((current) => ({
      ...current,
      [vaultId]: {
        ...(current[vaultId] ?? emptyFundState()),
        ...patch
      }
    }))
  }

  const handleFundVault = async (vault: EcashMultisigVault) => {
    const form = fundForms[vault.id] ?? emptyFundState()
    updateFundForm(vault.id, { loading: true, error: null, txid: null })
    try {
      const amountSats = parseXecAmountToSats(form.amountXec)
      const txid = await ecashMultisigService.fundVault({
        vault,
        amountSats,
        includeTonalliFee: form.includeTonalliFee
      })
      updateFundForm(vault.id, { loading: false, txid, error: null })
      refreshVaults()
    } catch (err) {
      updateFundForm(vault.id, { loading: false, error: (err as Error).message })
    }
  }

  const handleImport = () => {
    setImportError(null)
    setImportStatus(null)
    try {
      const vault = ecashMultisigService.importVault(importJson)
      setImportJson('')
      setImportStatus(`Boveda importada: ${vault.label}`)
      refreshVaults()
    } catch (err) {
      setImportError((err as Error).message)
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">eCash P2SH</p>
          <h1 className="section-title">Bovedas multifirma</h1>
          <p className="muted">Multifirma experimental. Usa primero montos pequeños.</p>
        </div>
        <div className="actions">
          <Link className="cta primary" to="/multisig/create">
            Crear boveda
          </Link>
          <Link className="cta outline" to="/">
            Volver
          </Link>
        </div>
      </header>

      <div className="error">
        1 dispositivo = 1 firmante. No importes varias semillas en el mismo dispositivo.
      </div>

      <div className="card">
        <p className="eyebrow">Importar boveda</p>
        <label htmlFor="vault-import-json">JSON publico de boveda</label>
        <textarea
          id="vault-import-json"
          rows={6}
          value={importJson}
          onChange={(event) => {
            setImportJson(event.target.value)
            setImportError(null)
            setImportStatus(null)
          }}
          placeholder="Pega aqui el JSON exportado"
        />
        <div className="actions">
          <button className="cta outline" type="button" onClick={handleImport} disabled={!importJson.trim()}>
            Importar boveda
          </button>
        </div>
        {importError && <div className="error">{importError}</div>}
        {importStatus && <div className="success">{importStatus}</div>}
      </div>

      {exportJson && (
        <div className="card">
          <p className="eyebrow">Export publico</p>
          <label htmlFor="vault-export-json">JSON sin private keys</label>
          <textarea id="vault-export-json" readOnly rows={10} value={exportJson} />
        </div>
      )}

      {vaults.length === 0 && (
        <div className="card">
          <p className="muted">No hay bovedas guardadas en este dispositivo.</p>
          <Link className="cta primary" to="/multisig/create">
            Crear primera boveda
          </Link>
        </div>
      )}

      <div className="grid">
        {vaults.map((vault) => {
          const balance = balances[vault.id]
          return (
            <div className="card" key={vault.id}>
              <p className="eyebrow">{vault.m}-de-{vault.n}</p>
              <h2 style={{ marginTop: 0 }}>{vault.label}</h2>
              <p className="muted">Direccion P2SH para recibir fondos</p>
              <div className="address-box">{vault.address}</div>
              <p className="muted">
                Balance XEC puro:{' '}
                {balance?.loading
                  ? 'Cargando...'
                  : balance?.error
                    ? 'No disponible'
                    : `${formatXec(balance?.sats ?? 0n)} XEC`}
              </p>
              {balance?.error && <div className="error">{balance.error}</div>}
              <div className="fund-vault">
                <p className="eyebrow">Fondear boveda</p>
                <p className="muted">
                  Este fondeo usa la wallet actual single-sig para enviar XEC a la direccion P2SH de la boveda.
                </p>
                <label htmlFor={`fund-${vault.id}`}>Monto XEC puro</label>
                <input
                  id={`fund-${vault.id}`}
                  inputMode="decimal"
                  value={(fundForms[vault.id] ?? emptyFundState()).amountXec}
                  onChange={(event) => updateFundForm(vault.id, {
                    amountXec: event.target.value,
                    error: null,
                    txid: null
                  })}
                  placeholder="0.00"
                />
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={(fundForms[vault.id] ?? emptyFundState()).includeTonalliFee}
                    onChange={(event) => updateFundForm(vault.id, {
                      includeTonalliFee: event.target.checked,
                      error: null,
                      txid: null
                    })}
                  />
                  Incluir fee Tonalli
                </label>
                <div className="address-box">
                  Direccion: {vault.address}
                  <br />
                  Monto: {formatPreviewAmount((fundForms[vault.id] ?? emptyFundState()).amountXec)}
                  <br />
                  Fee Tonalli: {(fundForms[vault.id] ?? emptyFundState()).includeTonalliFee ? `${TONALLI_SERVICE_FEE_XEC} XEC` : 'No incluida'}
                </div>
                <div className="error">Experimental: usa primero montos pequenos y verifica el txid.</div>
                <button
                  className="cta outline"
                  type="button"
                  disabled={(fundForms[vault.id] ?? emptyFundState()).loading || !(fundForms[vault.id] ?? emptyFundState()).amountXec.trim()}
                  onClick={() => void handleFundVault(vault)}
                >
                  {(fundForms[vault.id] ?? emptyFundState()).loading ? 'Fondeando...' : 'Fondear boveda'}
                </button>
                {(fundForms[vault.id] ?? emptyFundState()).error && (
                  <div className="error">{(fundForms[vault.id] ?? emptyFundState()).error}</div>
                )}
                {(fundForms[vault.id] ?? emptyFundState()).txid && (
                  <div className="success">Txid: {(fundForms[vault.id] ?? emptyFundState()).txid}</div>
                )}
              </div>
              <div className="actions">
                <Link className="cta" to={`/multisig/${vault.id}/propose`}>
                  Crear propuesta
                </Link>
                <Link className="cta outline" to={`/multisig/${vault.id}/sign`}>
                  Firmar / transmitir
                </Link>
                <button className="cta outline" type="button" onClick={() => setExportJson(ecashMultisigService.exportVault(vault))}>
                  Exportar JSON
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default VaultDashboard
