// Cálculo del saldo (deuda) por proveedor.
//
// Modelo confirmado por Lucas (2026-05-06):
//   saldo = SUM(facturas activas) + SUM(remitos no enlazados a factura) - pagos
//
// Específicamente:
//   - Factura `pendiente`/`vencida` con tipo distinto a 'nota_credito' →
//     suma `total - sum(pagos JSONB)`.
//   - Factura `pagada`/`anulada` → no aporta.
//   - Factura tipo 'nota_credito' → resta `total` (crédito a favor).
//   - Remito con `factura_id IS NULL` y `estado='sin_factura'` → suma `monto`.
//   - Remito con factura_id (vinculado), pagado o anulado → no aporta (la
//     factura ya cuenta su monto, o el pago ya descontó).
//
// Esta función es pura: dado el mismo input devuelve el mismo output.
// Vive en lib/ para que Proveedores.tsx y Dashboard.tsx (y cualquier otra
// vista futura) compartan un único cálculo y nunca diverjan otra vez.
//
// La columna `proveedores.saldo` persistida queda como cache "best effort"
// — la fuente de verdad es este cálculo en runtime.

export interface SaldoFactura {
  prov_id: number | null;
  total: number | string | null;
  estado: string;
  tipo?: string | null;
  pagos?: Array<{ monto?: number | string | null }> | null;
}

export interface SaldoRemito {
  prov_id: number | null;
  monto: number | string | null;
  estado: string;
  factura_id?: string | null;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : v != null ? parseFloat(String(v)) : 0;
  return Number.isFinite(n) ? n : 0;
}

export function calcularSaldosPorProveedor(
  facturas: SaldoFactura[],
  remitos: SaldoRemito[],
): Map<number, number> {
  const out = new Map<number, number>();

  for (const f of facturas) {
    if (f.prov_id == null) continue;
    if (f.estado === 'anulada' || f.estado === 'pagada') continue;
    const k = Number(f.prov_id);
    const isNC = (f.tipo || 'factura') === 'nota_credito';
    const total = num(f.total);
    if (isNC) {
      out.set(k, (out.get(k) || 0) - Math.abs(total));
      continue;
    }
    const pagado = Array.isArray(f.pagos)
      ? f.pagos.reduce((s, p) => s + num(p?.monto), 0)
      : 0;
    const restante = Math.max(0, total - pagado);
    out.set(k, (out.get(k) || 0) + restante);
  }

  for (const r of remitos) {
    if (r.prov_id == null) continue;
    if (r.factura_id != null) continue;        // vinculado: la factura ya cuenta
    if (r.estado !== 'sin_factura') continue;  // anulado / pagado / facturado: 0
    const k = Number(r.prov_id);
    out.set(k, (out.get(k) || 0) + num(r.monto));
  }

  return out;
}
