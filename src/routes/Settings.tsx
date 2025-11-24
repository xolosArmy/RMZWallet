import TopBar from '../components/TopBar'

function Settings() {
  return (
    <div className="page">
      <TopBar />
      <header className="section-header">
        <div>
          <p className="eyebrow">Ajustes</p>
          <h1 className="section-title">Próximamente</h1>
          <p className="muted">Controles de respaldo, idioma y más vivirán aquí.</p>
        </div>
      </header>

      <div className="card">
        <p className="muted">
          Aquí vivirá la exportación de seed (con autenticación local), cambio de idioma y la versión de la app.
        </p>
      </div>
    </div>
  )
}

export default Settings
