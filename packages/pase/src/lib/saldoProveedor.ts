// Cálculo del saldo (deuda) por proveedor.
//
// Modelo confirmado por Lucas (2026-05-06), actualizado con fix de NC
// parcialmente aplicada (2026-05-12 — bug T-19 de la auditoría):
//
//   saldo = SUM(facturas activas) + SUM(remitos sin factura) - SUM(NCs con saldo)
//
// Específicamente:
//   - Factura `pendiente`/`vencida` con tipo != 'nota_credito' →
//     suma `total - sum(pagos JSONB)`.
//   - Factura `pagada`/`anulada` → no aporta.
//   - NC con `estado != pagada/anulada` → resta su SALDO RESTANTE, no su
//     total original. El saldo restante es `abs(total) - SUM(nc_aplicaciones)`.
//     Antes se restaba el total completo aunque estuviera parcialmente
//     aplicada → bug de saldo proveedor que aparecía como crédito ficticio.
//   - Remito con `factura_id IS NULL` y `estado='sin_factura'` → suma `monto`.
//   - Remito con factura_id (vinculado), pagado o anulado → no aporta (la
//     factura ya cuenta su monto, o el pago ya descontó).

export interface SaldoFactura {
  id?: string | null;
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

// Fila de la tabla nc_aplicaciones. Solo necesitamos saber qué NC y cuánto
// se le aplicó. Las claves son las mismas que devuelve Supabase.
export interface SaldoNcAplicacion {
  nc_id: string;
  monto: number | string | null;
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : v != null ? parseFloat(String(v)) : 0;
  return Number.isFinite(n) ? n : 0;
}

// Helper: dado el array de aplicaciones, calcula cuánto se aplicó por cada
// nc_id. Map<nc_id, total_aplicado>. Devuelve Map vacío si no hay datos.
export function aplicacionesPorNc(
  aplicaciones: SaldoNcAplicacion[] | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!Array.isArray(aplicaciones)) return out;
  for (const a of aplicaciones) {
    if (!a?.nc_id) continue;
    out.set(a.nc_id, (out.get(a.nc_id) || 0) + num(a.monto));
  }
  return out;
}

// Saldo restante de una NC = abs(total) - sum(aplicaciones). Nunca negativo.
export function saldoNcRestante(
  nc: SaldoFactura,
  aplicaciones: Map<string, number>,
): number {
  const aplicado = nc.id ? (aplicaciones.get(nc.id) || 0) : 0;
  return Math.max(0, Math.abs(num(nc.total)) - aplicado);
}

export function calcularSaldosPorProveedor(
  facturas: SaldoFactura[],
  remitos: SaldoRemito[],
  ncAplicaciones?: SaldoNcAplicacion[] | null,
): Map<number, number> {
  const out = new Map<number, number>();
  const aplicMap = aplicacionesPorNc(ncAplicaciones);

  for (const f of facturas) {
    if (f.prov_id == null) continue;
    if (f.estado === 'anulada' || f.estado === 'pagada') continue;
    const k = Number(f.prov_id);
    const isNC = (f.tipo || 'factura') === 'nota_credito';
    if (isNC) {
      // Resta SOLO el saldo restante (abs(total) - sum aplicaciones).
      // Antes restaba abs(total) completo aunque la NC ya hubiera sido
      // aplicada parcialmente → saldo proveedor en negativo ficticio.
      const saldoNc = saldoNcRestante(f, aplicMap);
      out.set(k, (out.get(k) || 0) - saldoNc);
      continue;
    }
    const pagado = Array.isArray(f.pagos)
      ? f.pagos.reduce((s, p) => s + num(p?.monto), 0)
      : 0;
    const total = num(f.total);
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
