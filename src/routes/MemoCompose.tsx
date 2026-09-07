import { Link } from 'react-router-dom'
import TopBar from '../components/TopBar'
import { useWallet } from '../context/useWallet'
import TonalliMemoComposer from '../components/tonalliMemo/TonalliMemoComposer'

export function MemoCompose() {
  const { address } = useWallet()

  return (
    <div className="page memo-compose-page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Tonalli Memo</p>
          <h1 className="section-title">Componer y Publicar Memo TM1</h1>
          <p className="muted">
            Creación oficial y publicación en cadena de Tonalli Memos verificados mediante consenso de titularidad.
          </p>
        </div>
        <div className="quick-actions" aria-label="Acciones de composición de Memo">
          <Link className="cta outline" to="/memo">
            Volver al feed
          </Link>
          <Link className="cta outline" to="/memo/draft/tm1">
            Vista previa borrador
          </Link>
        </div>
      </header>

      <TonalliMemoComposer
        initialOwnerAddress={address || undefined}
        initialAlias="satoshi.xec"
      />
    </div>
  )
}

export default MemoCompose
