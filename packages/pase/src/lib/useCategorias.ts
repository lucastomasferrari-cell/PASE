import { useCallback, useEffect, useState } from "react";
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
  // Mapa categoría (nombre) → tipo de gasto (variable/fijo/publicidad/comision/impuesto).
  // Permite que los forms muestren el tipo derivado de la categoría como
  // readonly, en vez de aceptar combos incoherentes.
  categoriaToTipo: Record<string, string>;
  loading: boolean;
  source: "cache" | "db" | "fallback";
  refresh: () => Promise<void>; // invalida sessionStorage y re-fetcha
}

// Bump v3→v4: incorpora categoriaToTipo. Caches v3 no lo tienen y los
// dropdowns que dependen del map quedarían rotos hasta el siguiente
// fetch. El bump fuerza re-fetch en todas las sesiones existentes.
const CACHE_KEY = "pase_categorias_v4";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

type CategoriasData = Omit<CategoriasState, "loading" | "source" | "refresh">;

// Mapa tipo-en-DB → tipo-en-form. La columna gastos.tipo guarda los valores
// sin prefijo "gasto_". Si en config_categorias hay un tipo no listado acá,
// el form caerá en string vacío y el usuario tendrá que arreglarlo desde
// Configuración → Conceptos.
const TIPO_DB_TO_FORM: Record<string, string> = {
  gasto_fijo: "fijo",
  gasto_variable: "variable",
  gasto_publicidad: "publicidad",
  gasto_comision: "comision",
  gasto_impuesto: "impuesto",
};

function buildCategoriaToTipo(data: Omit<CategoriasData, "categoriaToTipo">): Record<string, string> {
  const m: Record<string, string> = {};
  for (const c of data.GASTOS_FIJOS)      m[c] = "fijo";
  for (const c of data.GASTOS_VARIABLES)  m[c] = "variable";
  for (const c of data.GASTOS_PUBLICIDAD) m[c] = "publicidad";
  for (const c of data.COMISIONES_CATS)   m[c] = "comision";
  for (const c of data.GASTOS_IMPUESTOS)  m[c] = "impuesto";
  return m;
}

const _FALLBACK_BASE: Omit<CategoriasData, "categoriaToTipo"> = {
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

const FALLBACK: CategoriasData = {
  ..._FALLBACK_BASE,
  categoriaToTipo: buildCategoriaToTipo(_FALLBACK_BASE),
};

function readCache(): CategoriasData | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts || Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch { return null; }
}

function writeCache(data: CategoriasData) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch { /* sessionStorage puede fallar en modo privado o quota lleno — no crítico */ }
}

interface ConfigCategoriaRow {
  tipo: string;
  nombre: string;
  orden: number;
  grupo: string | null;
  activo: boolean;
}

function fromRows(rows: ConfigCategoriaRow[]): CategoriasData {
  const byTipo = (t: string) => rows
    .filter(r => r.tipo === t && r.activo)
    .sort((a, b) => (a.orden || 0) - (b.orden || 0))
    .map(r => r.nombre);
  const base: Omit<CategoriasData, "categoriaToTipo"> = {
    CATEGORIAS_COMPRA: byTipo("cat_compra"),
    GASTOS_FIJOS: byTipo("gasto_fijo"),
    GASTOS_VARIABLES: byTipo("gasto_variable"),
    GASTOS_PUBLICIDAD: byTipo("gasto_publicidad"),
    COMISIONES_CATS: byTipo("gasto_comision"),
    GASTOS_IMPUESTOS: byTipo("gasto_impuesto"),
    CATEGORIAS_INGRESO: byTipo("cat_ingreso"),
  };
  // El map se arma directo desde los rows para soportar cualquier categoría
  // que viva en config_categorias bajo un tipo conocido — incluso si el
  // nombre se duplica entre tipos, la última gana (no debería pasar).
  const map: Record<string, string> = {};
  for (const r of rows) {
    if (!r.activo) continue;
    const formTipo = TIPO_DB_TO_FORM[r.tipo];
    if (formTipo) map[r.nombre] = formTipo;
  }
  return { ...base, categoriaToTipo: map };
}

export function useCategorias(): CategoriasState {
  // refresh() invalida sessionStorage + re-fetcha. La definición está acá
  // arriba para que el initial useState pueda incluirla sin "ReferenceError".
  const refresh = useCallback(async () => {
    try { sessionStorage.removeItem(CACHE_KEY); } catch { /* idem writeCache */ }
    // TODO(lint-cleanup): setState se declara abajo (l.108). El comentario
    // de l.88-89 documenta que el orden es intencional para que el initial
    // useState pueda incluir refresh. La regla immutability pide invertir
    // el orden — riesgoso reorganizar acá sin verificar.
    // eslint-disable-next-line react-hooks/immutability
    setState(s => ({ ...s, loading: true }));
    try {
      const { data, error } = await db.from("config_categorias")
        .select("tipo, nombre, orden, grupo, activo");
      if (error || !data || data.length === 0) {
        setState(s => ({ ...FALLBACK, loading: false, source: "fallback", refresh: s.refresh }));
        return;
      }
      const next = fromRows(data as ConfigCategoriaRow[]);
      writeCache(next);
      setState(s => ({ ...next, loading: false, source: "db", refresh: s.refresh }));
    } catch {
      setState(s => ({ ...FALLBACK, loading: false, source: "fallback", refresh: s.refresh }));
    }
  }, []);

  const [state, setState] = useState<CategoriasState>(() => {
    const cached = readCache();
    if (cached) return { ...cached, loading: false, source: "cache", refresh };
    return { ...FALLBACK, loading: true, source: "fallback", refresh };
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
          setState(s => ({ ...FALLBACK, loading: false, source: "fallback", refresh: s.refresh }));
          return;
        }
        const next = fromRows(data as ConfigCategoriaRow[]);
        writeCache(next);
        setState(s => ({ ...next, loading: false, source: "db", refresh: s.refresh }));
      } catch {
        if (!cancelled) setState(s => ({ ...FALLBACK, loading: false, source: "fallback", refresh: s.refresh }));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
