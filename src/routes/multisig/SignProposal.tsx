import type { FormEvent } from 'react'
import { useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import TopBar from '../../components/TopBar'
import { XEC_SATS_PER_XEC } from '../../config/xecFees'
import type { EcashMultisigProposalInspection } from '../../services/EcashMultisigService'
import { ecashMultisigService } from '../../services/EcashMultisigService'

const formatXec = (sats: string) => (Number(BigInt(sats)) / XEC_SATS_PER_XEC).toFixed(2)

const roleLabel: Record<EcashMultisigProposalInspection['outputs'][number]['role'], string> = {
  destination: 'destino',
  tonalli_fee: 'fee Tonalli',
  change: 'cambio',
  op_return: 'memo L1',
  unknown: 'desconocido'
}

function SignProposal() {
  const { vaultId } = useParams()
  const vault = useMemo(() => (vaultId ? ecashMultisigService.getVault(vaultId) : null), [vaultId])
  const [partialTxHex, setPartialTxHex] = useState('')
  const [summary, setSummary] = useState<EcashMultisigProposalInspection | null>(null)
  const [txid, setTxid] = useState<string | null>(null)
  const [broadcasted, setBroadcasted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!vault) {
    return <Navigate to="/multisig" replace />
  }

  const refreshSummary = async (hex = partialTxHex) => {
    setError(null)
    setInspecting(true)
    setBroadcasted(false)
    try {
      const nextSummary = await ecashMultisigService.inspectProposal({ vault, partialTxHex: hex })
      setSummary(nextSummary)
    } catch (err) {
      setSummary(null)
      setError((err as Error).message)
    } finally {
      setInspecting(false)
    }
  }

  const handleSign = async (event: FormEvent) => {
    event.preventDefault()
    if (!summary) {
      setError('Revisa el resumen seguro antes de firmar.')
      return
    }
    setError(null)
    setTxid(null)
    setBroadcasted(false)
    setLoading(true)
    try {
      const result = await ecashMultisigService.signProposal({ vault, partialTxHex })
      setPartialTxHex(result.partialTxHex)
      await refreshSummary(result.partialTxHex)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleBroadcast = async () => {
    setError(null)
    setTxid(null)
    setBroadcasted(false)
    setLoading(true)
    try {
      const nextTxid = await ecashMultisigService.broadcast({ vault, partialTxHex })
      setError(null)
      setTxid(nextTxid)
      setBroadcasted(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">{vault.m}-de-{vault.n}</p>
          <h1 className="section-title">Firmar propuesta</h1>
          <p className="muted">Multifirma experimental. Usa primero montos pequeños.</p>
        </div>
        <Link className="cta outline" to="/multisig">
          Bovedas
        </Link>
      </header>

      <div className="error">
        1 dispositivo = 1 firmante. No importes varias semillas en el mismo dispositivo.
      </div>

      <form className="card" onSubmit={handleSign}>
        <label htmlFor="partial-tx">partialTxHex</label>
        <textarea
          id="partial-tx"
          rows={10}
          value={partialTxHex}
          onChange={(event) => {
            const nextHex = event.target.value
            setPartialTxHex(nextHex)
            setSummary(null)
            setTxid(null)
            setBroadcasted(false)
          }}
          onPaste={() => {
            window.setTimeout(() => {
              const nextHex = (document.getElementById('partial-tx') as HTMLTextAreaElement | null)?.value ?? ''
              if (nextHex.trim()) void refreshSummary(nextHex)
            }, 0)
          }}
          placeholder="Pega aqui la transaccion parcial"
        />
        <div className="actions">
          <button className="cta outline" type="button" onClick={() => void refreshSummary()} disabled={inspecting || !partialTxHex.trim()}>
            {inspecting ? 'Revisando...' : 'Ver resumen'}
          </button>
          <button className="cta primary" type="submit" disabled={broadcasted || loading || inspecting || !partialTxHex.trim() || !summary}>
            {loading ? 'Procesando...' : 'Agregar mi firma'}
          </button>
          <button className="cta" type="button" onClick={handleBroadcast} disabled={broadcasted || loading || inspecting || !summary?.isComplete}>
            Transmitir
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {broadcasted && txid && (
          <div className="success">
            Transacción transmitida correctamente. Txid: {txid}
          </div>
        )}
      </form>

      {summary && (
        <div className="card">
          <p className="muted">
            Inputs: {summary.inputsCount} - Estado: {summary.isComplete ? 'completa' : 'pendiente'}
          </p>
          {summary.warnings.length > 0 && (
            <div className="error">
              {summary.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          )}
          <div className="tx-list">
            {summary.signaturesByInput.map((inputSummary) => (
              <div className="tx-item" key={inputSummary.inputIndex}>
                <p className="muted">Input {inputSummary.inputIndex}</p>
                <strong>
                  {inputSummary.validSignatures}/{inputSummary.requiredSignatures} firmas validas
                  {inputSummary.isComplete ? ' - completo' : ' - pendiente'}
                </strong>
              </div>
            ))}
          </div>
          <div className="tx-list">
            {summary.outputs.map((output) => (
              <div className="tx-item" key={`${output.index}-${output.scriptHex}`}>
                <p className="muted">
                  Output {output.index} - {formatXec(output.sats)} XEC - {roleLabel[output.role]}
                </p>
                {output.address && <div className="address-box">{output.address}</div>}
                {output.role === 'op_return' && (
                  <>
                    <p className="muted">Memo L1 (OP_RETURN)</p>
                    <div className="address-box">{output.memoText || '(sin texto decodificado)'}</div>
                    {output.memoHex && (
                      <>
                        <p className="muted">memoHex</p>
                        <div className="address-box">{output.memoHex}</div>
                      </>
                    )}
                  </>
                )}
                {output.warning && <div className="error">{output.warning}</div>}
                <p className="muted">scriptHex</p>
                <div className="address-box">{output.scriptHex}</div>
              </div>
            ))}
          </div>
          <label htmlFor="signed-partial-tx">partialTxHex actualizado</label>
          <textarea id="signed-partial-tx" readOnly rows={10} value={partialTxHex} />
        </div>
      )}
    </div>
  )
}

export default SignProposal
