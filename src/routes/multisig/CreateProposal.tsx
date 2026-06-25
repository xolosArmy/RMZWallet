import type { FormEvent } from 'react'
import { useMemo, useState } from 'react'
import { Link, Navigate, useParams } from 'react-router-dom'
import TopBar from '../../components/TopBar'
import { XEC_SATS_PER_XEC } from '../../config/xecFees'
import type { EcashMultisigProposal } from '../../services/EcashMultisigService'
import { ecashMultisigService, utf8Bytes } from '../../services/EcashMultisigService'

function CreateProposal() {
  const { vaultId } = useParams()
  const vault = useMemo(() => (vaultId ? ecashMultisigService.getVault(vaultId) : null), [vaultId])
  const [to, setTo] = useState('')
  const [amountXec, setAmountXec] = useState('')
  const [includeTonalliFee, setIncludeTonalliFee] = useState(false)
  const [memo, setMemo] = useState('')
  const [proposal, setProposal] = useState<EcashMultisigProposal | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const memoBytes = utf8Bytes(memo.trim()).length

  if (!vault) {
    return <Navigate to="/multisig" replace />
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setProposal(null)
    const amount = Number(amountXec)
    const amountSats = BigInt(Math.round(amount * XEC_SATS_PER_XEC))
    if (!Number.isFinite(amount) || amount <= 0 || amountSats <= 0n) {
      setError('Ingresa un monto XEC valido.')
      return
    }
    setLoading(true)
    try {
      const nextProposal = await ecashMultisigService.createProposal({
        vault,
        to: to.trim(),
        amountSats,
        includeTonalliFee,
        memo
      })
      setProposal(nextProposal)
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
          <h1 className="section-title">Crear propuesta</h1>
          <p className="muted">Multifirma experimental. Usa primero montos pequeños.</p>
        </div>
        <Link className="cta outline" to="/multisig">
          Bovedas
        </Link>
      </header>

      <div className="card">
        <p className="muted">Boveda P2SH</p>
        <div className="address-box">{vault.address}</div>
      </div>

      <div className="warning">Las propuestas multifirma usan un margen extra de fee para evitar rechazo por min relay fee.</div>

      <form className="card" onSubmit={handleSubmit}>
        <label htmlFor="proposal-to">Destino ecash:</label>
        <input
          id="proposal-to"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          placeholder="ecash:..."
        />

        <label htmlFor="proposal-amount">Monto XEC</label>
        <input
          id="proposal-amount"
          type="number"
          min={0}
          step="0.01"
          value={amountXec}
          onChange={(event) => setAmountXec(event.target.value)}
          placeholder="100.00"
        />

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={includeTonalliFee}
            onChange={(event) => setIncludeTonalliFee(event.target.checked)}
          />
          Incluir fee Tonalli
        </label>

        <label htmlFor="proposal-memo">Memo L1 opcional (OP_RETURN)</label>
        <input
          id="proposal-memo"
          value={memo}
          maxLength={120}
          onChange={(event) => setMemo(event.target.value)}
          placeholder="+:XEC.XEC:thor1..."
        />
        <p className={memoBytes > 80 ? 'error' : 'muted'}>
          Max 80 bytes UTF-8. Usar sólo si todos los firmantes esperan un memo L1. {memoBytes}/80
        </p>

        <div className="actions">
          <button className="cta primary" type="submit" disabled={loading}>
            {loading ? 'Creando...' : 'Crear partialTxHex'}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </form>

      {proposal && (
        <div className="card">
          <p className="muted">
            Firmas: {proposal.signaturesCount}/{proposal.requiredSignatures}
          </p>
          <label htmlFor="proposal-hex">partialTxHex copiable</label>
          <textarea id="proposal-hex" readOnly rows={10} value={proposal.partialTxHex} />
        </div>
      )}
    </div>
  )
}

export default CreateProposal
