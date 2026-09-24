import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from '../context/useWallet'
import type { WalletCapability } from '../domain/walletCapabilities'
import { isWalletCapabilityEnabled } from '../domain/walletCapabilityGuard'
import TopBar from './TopBar'

export function CapabilityBlocked({
  title = 'Protege tu Tonalli para continuar'
}: {
  title?: string
}) {
  return (
    <div className="page" data-testid="capability-blocked">
      <TopBar />
      <h1 className="section-title">{title}</h1>
      <p className="muted">
        Esta operación se activa después de guardar tu frase de recuperación.
      </p>
      <div className="actions">
        <Link className="cta primary" to="/backup">Proteger ahora</Link>
        <Link className="cta ghost" to="/">Volver al inicio</Link>
      </div>
    </div>
  )
}

export function RequireCapability({
  capability,
  children
}: {
  capability: WalletCapability
  children: ReactNode
}) {
  const wallet = useWallet()
  if (!isWalletCapabilityEnabled(wallet, capability)) {
    return <CapabilityBlocked />
  }
  return children
}
