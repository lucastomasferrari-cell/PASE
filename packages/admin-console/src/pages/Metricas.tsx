export function Metricas() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-admin-text">Métricas</h1>
        <p className="text-xs text-admin-muted mt-1">
          Uso del sistema, errores, performance. Vista cross-tenant.
        </p>
      </header>
      <div className="rounded border border-admin-border bg-admin-surface p-6 text-sm text-admin-muted">
        Pantalla pendiente. Va a mostrar uso por tenant (logins activos, ventas
        cargadas, errores RPC), bandera roja si algún tenant deja de operar.
      </div>
    </div>
  );
}
