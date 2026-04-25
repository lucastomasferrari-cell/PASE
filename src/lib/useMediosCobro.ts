import { useEffect, useState, useCallback } from "react";
import { db } from "./supabase";
import { MEDIOS_COBRO as _MC, MEDIO_A_CUENTA as _MAC } from "./constants";

// Fuente de verdad: tabla medios_cobro (migration 20260424).
// Patrón paralelo a useCategorias: cache en sessionStorage + fallback a
// constants.ts si la DB no responde. Los consumidores piden via:
//   const { mediosDisponibles, cuentaDestino } = useMediosCobro();
//   const lista = mediosDisponibles(localActivo);
//   const cuenta = cuentaDestino("EFECTIVO SALON", localActivo);
//
// local_id resolution: si hay un row con local_id === localActivo y otro
// global (local_id NULL) con el mismo nombre, gana el local-specific.

export interface MedioCobro {
  id: number;
  nombre: string;
  local_id: number | null;
  cuenta_destino: string | null;
  activo: boolean;
  orden: number;
}

export interface MediosCobroState {
  mediosDisponibles: (localId: number | null) => MedioCobro[];
  todosLosMedios: () => MedioCobro[];
  cuentaDestino: (nombre: string, localId: number | null) => string | null;
  refresh: () => void;
  loading: boolean;
  source: "cache" | "db" | "fallback";
}

const CACHE_KEY = "pase_medios_cobro_v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

// Fallback: los 16 medios canónicos como filas globales sintéticas.
// Conserva los IDs negativos para evitar choque con IDs reales del DB.
const FALLBACK: MedioCobro[] = _MC.map((nombre, i) => ({
  id: -(i + 1),
  nombre,
  local_id: null,
  cuenta_destino: _MAC[nombre] ?? null,
  activo: true,
  orden: i + 1,
}));

function readCache(): MedioCobro[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.ts || Date.now() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data as MedioCobro[];
  } catch { return null; }
}

function writeCache(data: MedioCobro[]) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}

function clearCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch {}
}

// Pure helpers — exportadas para testing sin entorno React.

// Filtra medios visibles en localActivo: globales (local_id NULL) +
// específicos del local. Si existe colisión por nombre (un global y un
// local-specific con el mismo nombre), el local-specific gana — el dueño
// override-eó el global para ese local. Ordena por orden ascendente.
export function pickDisponibles(medios: MedioCobro[], localId: number | null): MedioCobro[] {
  const visibles = medios.filter(m => m.activo && (m.local_id === null || m.local_id === localId));
  // Dedup por nombre, prefiriendo el que tiene local_id no nulo.
  const byNombre = new Map<string, MedioCobro>();
  for (const m of visibles) {
    const existing = byNombre.get(m.nombre);
    if (!existing) { byNombre.set(m.nombre, m); continue; }
    // Prefer local-specific sobre global
    if (existing.local_id === null && m.local_id !== null) byNombre.set(m.nombre, m);
  }
  return [...byNombre.values()].sort((a, b) => (a.orden || 0) - (b.orden || 0));
}

// Busca cuenta_destino del medio matcheado por nombre + localId.
// Misma regla de prioridad que pickDisponibles: local-specific > global.
// Devuelve null si no hay match o si el medio no impacta caja.
export function pickCuentaDestino(medios: MedioCobro[], nombre: string, localId: number | null): string | null {
  const candidatos = medios.filter(m => m.activo && m.nombre === nombre && (m.local_id === null || m.local_id === localId));
  if (candidatos.length === 0) return null;
  // Prefiere el local-specific
  const ganador = candidatos.find(m => m.local_id !== null) || candidatos[0];
  return ganador.cuenta_destino;
}

export function useMediosCobro(): MediosCobroState {
  const [medios, setMedios] = useState<MedioCobro[]>(() => readCache() || FALLBACK);
  const [loading, setLoading] = useState<boolean>(() => readCache() === null);
  const [source, setSource] = useState<"cache" | "db" | "fallback">(() => readCache() ? "cache" : "fallback");

  const fetchMedios = useCallback(async (force: boolean) => {
    if (!force && readCache()) return;
    setLoading(true);
    try {
      const { data, error } = await db.from("medios_cobro")
        .select("id, nombre, local_id, cuenta_destino, activo, orden");
      if (error || !data || data.length === 0) {
        setMedios(FALLBACK);
        setSource("fallback");
      } else {
        const rows = data as MedioCobro[];
        writeCache(rows);
        setMedios(rows);
        setSource("db");
      }
    } catch {
      setMedios(FALLBACK);
      setSource("fallback");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (source === "cache") return;
    fetchMedios(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    clearCache();
    fetchMedios(true);
  }, [fetchMedios]);

  const mediosDisponibles = useCallback((localId: number | null) => pickDisponibles(medios, localId), [medios]);
  const todosLosMedios = useCallback(() => medios, [medios]);
  const cuentaDestino = useCallback((nombre: string, localId: number | null) => pickCuentaDestino(medios, nombre, localId), [medios]);

  return { mediosDisponibles, todosLosMedios, cuentaDestino, refresh, loading, source };
}
