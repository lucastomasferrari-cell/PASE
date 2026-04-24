import { useEffect, useState } from "react";
import { db } from "./supabase";
import {
  CATEGORIAS_COMPRA as _CC, GASTOS_FIJOS as _GF, GASTOS_VARIABLES as _GV,
  GASTOS_PUBLICIDAD as _GP, COMISIONES_CATS as _CO, GASTOS_IMPUESTOS as _GI,
} from "./constants";

// Fuente de verdad: tabla config_categorias (columna grupo agregada en
// migration 20260424). Este hook la consume con un cache en sessionStorage
// para que todas las pages compartan la misma lista sin N+1 fetches. Si el
// fetch falla (DB offline, RLS bloquea, etc), cae a las constants.ts como
// fallback transparente.
//
// Los nombres de los arrays exportados coinciden con las constants para
// minimizar cambios en JSX.

export interface CategoriasState {
  CATEGORIAS_COMPRA: string[];  // grupo = CMV (tipo = cat_compra)
  GASTOS_FIJOS: string[];       // grupo = Gastos Fijos
  GASTOS_VARIABLES: string[];   // grupo = Gastos Variables
  GASTOS_PUBLICIDAD: string[];  // grupo = Publicidad y MKT
  COMISIONES_CATS: string[];    // grupo = Comisiones
  GASTOS_IMPUESTOS: string[];   // grupo = Impuestos
  CATEGORIAS_INGRESO: string[]; // grupo = INGRESOS (nuevas)
  loading: boolean;
  source: "cache" | "db" | "fallback";
}

const CACHE_KEY = "pase_categorias_v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

const FALLBACK: Omit<CategoriasState, "loading" | "source"> = {
  CATEGORIAS_COMPRA: [..._CC],
  GASTOS_FIJOS: [..._GF],
  GASTOS_VARIABLES: [..._GV],
  GASTOS_PUBLICIDAD: [..._GP],
  COMISIONES_CATS: [..._CO],
  GASTOS_IMPUESTOS: [..._GI],
  CATEGORIAS_INGRESO: [
    "Liquidación Rappi", "Liquidación MercadoPago", "Liquidación PedidosYa",
    "Liquidación Evento", "Liquidación Bigbox", "Liquidación Fanbag",
    "Liquidación Nave", "Ingreso Socio", "Devolución Proveedor",
    "Otro Ingreso", "Transferencia Varios",
  ],
};

function readCache(): Omit<CategoriasState, "loading" | "source"> | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts || Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch { return null; }
}

function writeCache(data: Omit<CategoriasState, "loading" | "source">) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

function fromRows(rows: { tipo: string; nombre: string; orden: number; grupo: string | null; activo: boolean }[]): Omit<CategoriasState, "loading" | "source"> {
  const byTipo = (t: string) => rows
    .filter(r => r.tipo === t && r.activo)
    .sort((a, b) => (a.orden || 0) - (b.orden || 0))
    .map(r => r.nombre);
  return {
    CATEGORIAS_COMPRA: byTipo("cat_compra"),
    GASTOS_FIJOS: byTipo("gasto_fijo"),
    GASTOS_VARIABLES: byTipo("gasto_variable"),
    GASTOS_PUBLICIDAD: byTipo("gasto_publicidad"),
    COMISIONES_CATS: byTipo("gasto_comision"),
    GASTOS_IMPUESTOS: byTipo("gasto_impuesto"),
    CATEGORIAS_INGRESO: byTipo("cat_ingreso"),
  };
}

export function useCategorias(): CategoriasState {
  const [state, setState] = useState<CategoriasState>(() => {
    const cached = readCache();
    if (cached) return { ...cached, loading: false, source: "cache" };
    return { ...FALLBACK, loading: true, source: "fallback" };
  });

  useEffect(() => {
    // Si venimos del cache (source=cache), no re-fetcheamos esta sesión.
    if (state.source === "cache") return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await db.from("config_categorias")
          .select("tipo, nombre, orden, grupo, activo");
        if (cancelled) return;
        if (error || !data || data.length === 0) {
          // Fallback silencioso a constants.ts — no interrumpe UX.
          setState({ ...FALLBACK, loading: false, source: "fallback" });
          return;
        }
        const next = fromRows(data as any);
        writeCache(next);
        setState({ ...next, loading: false, source: "db" });
      } catch {
        if (!cancelled) setState({ ...FALLBACK, loading: false, source: "fallback" });
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
