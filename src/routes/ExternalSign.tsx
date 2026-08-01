import TopBar from '../components/TopBar'

export function ExternalSignDisabled() {
  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">TONALLI_AUTHORIZATION_BOUNDARY</p>
          <h1 className="section-title">Firma externa deshabilitada</h1>
          <p className="muted">No hay perfiles productivos registrados.</p>
        </div>
      </header>
      <section className="card">
        <div className="error">EXTERNAL_SIGN_DISABLED</div>
        <p className="muted">La ruta no firma ni transmite contenido.</p>
      </section>
    </div>
  )
}

export default ExternalSignDisabled
