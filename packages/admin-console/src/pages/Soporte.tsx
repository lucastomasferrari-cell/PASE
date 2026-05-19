export function Soporte() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-admin-text">Soporte</h1>
        <p className="text-xs text-admin-muted mt-1">
          Tickets reportados desde PASE y COMANDA. Auto-clasificados por LLM.
        </p>
      </header>

      <div className="rounded border border-admin-border bg-admin-surface p-6 text-sm text-admin-muted">
        Pantalla pendiente — Fase 4 del plan. Acá va a venir:
        <ul className="list-disc list-inside mt-3 space-y-1 text-xs">
          <li>Cola de tickets filtrable por sistema, estado, prioridad.</li>
          <li>Detalle con pregunta + respuesta LLM + captura + contexto técnico.</li>
          <li>Acciones: responder, asignar prioridad, cerrar, generar resumen markdown.</li>
        </ul>
      </div>
    </div>
  );
}
