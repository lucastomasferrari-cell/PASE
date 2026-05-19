export function Pagos() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-admin-text">Pagos</h1>
        <p className="text-xs text-admin-muted mt-1">
          Billing/suscripciones cuando arrancás a vender PASE+COMANDA a otros restaurantes.
        </p>
      </header>
      <div className="rounded border border-admin-border bg-admin-surface p-6 text-sm text-admin-muted">
        Pantalla pendiente. Pendiente decidir gateway: MercadoPago Subscriptions
        vs Stripe vs cobro manual con facturación AFIP propia.
      </div>
    </div>
  );
}
