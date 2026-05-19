export function Tenants() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-admin-text">Tenants</h1>
        <p className="text-xs text-admin-muted mt-1">
          Gestión de cuentas (alta, suspensión, eliminación, restore).
        </p>
      </header>
      <div className="rounded border border-admin-border bg-admin-surface p-6 text-sm text-admin-muted">
        Pantalla pendiente. Va a reemplazar el scaffolding actual de Tenants.tsx
        dentro de PASE. Hoy hay RPC <code className="text-admin-accent">crear_tenant</code> + <code className="text-admin-accent">restore_tenant</code> listos para conectar.
      </div>
    </div>
  );
}
