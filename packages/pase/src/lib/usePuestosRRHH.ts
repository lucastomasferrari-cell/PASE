import { useEffect, useState, useCallback } from "react";
import { db } from "./supabase";
import { useRealtimeTable } from "./useRealtimeTable";

// Catálogo de puestos para RRHH. Fuente de verdad: tabla rrhh_puestos
// (migration 202605122200). Patrón paralelo a useCategorias / useMediosCobro:
//   - SELECT abierto a todos los users del tenant → todos ven la misma lista.
//   - Cache en sessionStorage (TTL 1h).
//   - Realtime subscription → invalidación cross-tab automática.
//   - Fallback: si el SELECT falla o retorna 0 rows, queda []. Distinto de
//     useCategorias (que tiene fallback hardcoded) — los puestos son
//     específicos de cada tenant, no hay defaults razonables.
//
// El campo rrhh_empleados.puesto sigue siendo TEXT libre (retro-compat):
// empleados con puestos legacy fuera del catálogo conservan el valor. El
// dropdown del form lista los activos del catálogo, pero NO impide guardar
// un empleado existente con su puesto legacy.

export interface PuestoRRHH {
  id: number;
  nombre: string;
  activo: boolean;
  orden: number;
}

export interface PuestosRRHHState {
  puestos: PuestoRRHH[];               // todos (activos + inactivos)
  puestosActivos: PuestoRRHH[];        // solo activos, ordenados
  loading: boolean;
  source: "cache" | "db" | "empty";
  refresh: () => void;
}

const CACHE_KEY = "pase_puestos_rrhh_v1";
const CACHE_TTL_MS = 60 * 60 * 1000;

function readCache(): PuestoRRHH[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts || Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data as PuestoRRHH[];
  } catch { return null; }
}

function writeCache(data: PuestoRRHH[]) {
  try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch { /* sessionStorage puede fallar en modo privado */ }
}

function clearCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* idem */ }
}

export function usePuestosRRHH(): PuestosRRHHState {
  const [puestos, setPuestos] = useState<PuestoRRHH[]>(() => readCache() || []);
  const [loading, setLoading] = useState<boolean>(() => readCache() === null);
  const [source, setSource] = useState<"cache" | "db" | "empty">(() => readCache() ? "cache" : "empty");

  const fetchPuestos = useCallback(async (force: boolean) => {
    if (!force && readCache()) return;
    setLoading(true);
    try {
      const { data, error } = await db.from("rrhh_puestos")
        .select("id, nombre, activo, orden")
        .order("orden", { ascending: true })
        .order("nombre", { ascending: true });
      if (error) {
        console.warn(
          "[usePuestosRRHH] error en SELECT — catálogo queda vacío.",
          { cause: error.message }
        );
        setPuestos([]);
        setSource("empty");
      } else {
        const rows = (data || []) as PuestoRRHH[];
        writeCache(rows);
        setPuestos(rows);
        setSource(rows.length > 0 ? "db" : "empty");
      }
    } catch (e) {
      console.warn("[usePuestosRRHH] excepción en fetch:", e);
      setPuestos([]);
      setSource("empty");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (source === "cache") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPuestos(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    clearCache();
    fetchPuestos(true);
  }, [fetchPuestos]);

  // Realtime cross-tab: si alguien edita el catálogo desde Configuración,
  // todos los consumers se enteran sin esperar TTL.
  useRealtimeTable({ table: "rrhh_puestos", onChange: () => refresh() });

  const puestosActivos = puestos.filter(p => p.activo);
  return { puestos, puestosActivos, loading, source, refresh };
}
