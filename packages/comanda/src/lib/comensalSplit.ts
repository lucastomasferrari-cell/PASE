// Order-by-seat (increment 3): reparto de la cuenta por comensal.
//
// Lógica pura (sin red ni estado) para poder testearla sola. Toma los ítems
// de una venta (cada uno con su comensal asignado o NULL = compartido) y
// calcula cuánto paga cada comensal:
//
//   monto_comensal = (asignado_a_ese_comensal + compartido / N) * factor_dto
//
// - Los ítems "compartidos" (comensal NULL) se reparten en partes iguales
//   entre los N comensales (estándar Toast/Resy "shared items split evenly").
// - El descuento de la venta se prorratea con un factor neto/bruto para que
//   la suma de los comensales coincida EXACTO con lo que el backend espera
//   cobrar (subtotal - descuento_total).
// - El remanente de redondeo se acumula en el ÚLTIMO comensal, garantizando
//   que Σ montos = neto centavo a centavo (sin esto, agregarPago dejaría la
//   venta sin cerrar por 1 centavo).

export interface ItemCuenta {
  id: number;
  comensal: number | null;
  subtotal: number;
}

export interface CuentaComensal {
  comensal: number;
  itemIds: number[];
  monto: number;
}

export interface RepartoComensal {
  cuentas: CuentaComensal[];
  /** Suma de subtotales de ítems compartidos (comensal NULL). */
  compartidoTotal: number;
  /** Suma bruta de todos los ítems (antes de descuento). */
  bruto: number;
  /** Lo que realmente se cobra: bruto - descuento. */
  neto: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function calcularCuentasPorComensal(
  items: ItemCuenta[],
  numComensales: number,
  descuentoTotal = 0,
): RepartoComensal {
  const n = Math.max(1, Math.floor(numComensales));
  const buckets = Array.from({ length: n }, () => ({ itemIds: [] as number[], monto: 0 }));
  let compartido = 0;
  let bruto = 0;

  for (const it of items) {
    const sub = Number(it.subtotal) || 0;
    bruto += sub;
    if (it.comensal && it.comensal >= 1 && it.comensal <= n) {
      const b = buckets[it.comensal - 1]!;
      b.itemIds.push(it.id);
      b.monto += sub;
    } else {
      compartido += sub;
    }
  }

  const neto = Math.max(0, bruto - (Number(descuentoTotal) || 0));
  const factor = bruto > 0 ? neto / bruto : 1;
  const share = compartido / n;

  const cuentas: CuentaComensal[] = buckets.map((b, i) => ({
    comensal: i + 1,
    itemIds: b.itemIds,
    monto: round2((b.monto + share) * factor),
  }));

  // Ajuste de redondeo: el remanente va al último comensal para que Σ = neto.
  const suma = cuentas.reduce((s, c) => s + c.monto, 0);
  const diff = round2(neto - suma);
  if (cuentas.length > 0 && Math.abs(diff) >= 0.01) {
    const last = cuentas[cuentas.length - 1]!;
    last.monto = round2(last.monto + diff);
  }

  return { cuentas, compartidoTotal: compartido, bruto, neto };
}
