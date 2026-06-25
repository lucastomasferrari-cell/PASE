// kpisService — KPIs de marketing calculados desde NUESTROS datos (clientes).
// Una sola lectura liviana (campos numéricos) y se computa todo en el front.
// Para bases muy grandes se topea en 8000 filas (suficiente para un local).

import { db } from './supabase';

export interface Kpis {
  total: number;
  conPedidos: number;
  nuevos30: number;
  recompra: number;          // clientes con 2+ pedidos
  tasaRecompra: number;      // recompra / conPedidos (0-1)
  perdidos: number;          // sin pedir 60d+
  riesgo: number;            // 30-60d
  recurrentes: number;       // 5+ pedidos
  aceptanMarketing: number;
  gastoTotal: number;
  ltv: number;               // gasto total / clientes con pedidos
  ticketProm: number;        // gasto total / pedidos totales
  topeado: boolean;          // true si se alcanzó el límite de filas
}

const LIMITE = 8000;

export async function getKpis(): Promise<{ data: Kpis | null; error: string | null }> {
  const { data, error } = await db()
    .from('clientes')
    .select('total_pedidos, total_gastado, ultimo_pedido_at, primer_pedido_at, acepta_marketing')
    .is('deleted_at', null)
    .limit(LIMITE);
  if (error) return { data: null, error: error.message };

  const rows = (data ?? []) as Array<{
    total_pedidos: number | null; total_gastado: number | null;
    ultimo_pedido_at: string | null; primer_pedido_at: string | null;
    acepta_marketing: boolean | null;
  }>;

  const ahora = Date.now();
  const dias = (n: number) => ahora - n * 24 * 60 * 60 * 1000;
  let conPedidos = 0, nuevos30 = 0, recompra = 0, perdidos = 0, riesgo = 0, recurrentes = 0, aceptan = 0;
  let gastoTotal = 0, pedidosTotal = 0;

  for (const r of rows) {
    const ped = Number(r.total_pedidos ?? 0);
    const gas = Number(r.total_gastado ?? 0);
    gastoTotal += gas; pedidosTotal += ped;
    if (ped >= 1) conPedidos++;
    if (ped >= 2) recompra++;
    if (ped >= 5) recurrentes++;
    if (r.acepta_marketing) aceptan++;
    if (r.primer_pedido_at && new Date(r.primer_pedido_at).getTime() >= dias(30)) nuevos30++;
    if (r.ultimo_pedido_at) {
      const t = new Date(r.ultimo_pedido_at).getTime();
      if (ped >= 1 && t < dias(60)) perdidos++;
      else if (t >= dias(60) && t < dias(30)) riesgo++;
    }
  }

  return {
    data: {
      total: rows.length,
      conPedidos, nuevos30, recompra,
      tasaRecompra: conPedidos ? recompra / conPedidos : 0,
      perdidos, riesgo, recurrentes, aceptanMarketing: aceptan,
      gastoTotal,
      ltv: conPedidos ? gastoTotal / conPedidos : 0,
      ticketProm: pedidosTotal ? gastoTotal / pedidosTotal : 0,
      topeado: rows.length >= LIMITE,
    },
    error: null,
  };
}
