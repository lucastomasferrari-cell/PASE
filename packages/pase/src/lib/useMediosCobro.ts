import { useEffect, useState, useCallback } from "react";
import { db } from "./supabase";
import { useRealtimeTable } from "./useRealtimeTable";
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
  } catch { /* sessionStorage puede fallar en modo privado o quota lleno — no crítico */ }
}

function clearCache() {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* idem writeCache */ }
}

// Pure helpers — exportadas para testing sin entorno React.

// Filtra medios visibles en localActivo: globales (local_id NULL) +
// específicos del local. Si existe colisión por nombre (un global y un
// local-specific con el mismo nombre), el local-specific gana — el dueño
// override-eó el global para ese local.
//
// IMPORTANTE — orden de operaciones: PRIMERO dedup (preferir override),
// DESPUÉS filtrar por activo del ganador. Si invertimos el orden, un
// override desactivado (caso típico: "Desactivar global en Belgrano"
// crea override con activo=false) no filtraría al global porque solo
// pasaría al filter el global (que sigue activo=true) y "se colaría"
// como ganador del dedup. Resultado: Belgrano seguiría viendo el medio.
export function pickDisponibles(medios: MedioCobro[], localId: number | null): MedioCobro[] {
  // Paso 1: limitar al scope (sin importar activo).
  const enScope = medios.filter(m => m.local_id === null || m.local_id === localId);
  // Paso 2: dedup por nombre, prefiriendo el override (local_id no nulo).
  const byNombre = new Map<string, MedioCobro>();
  for (const m of enScope) {
    const existing = byNombre.get(m.nombre);
    if (!existing) { byNombre.set(m.nombre, m); continue; }
    if (existing.local_id === null && m.local_id !== null) byNombre.set(m.nombre, m);
  }
  // Paso 3: aplicar el filtro activo SOBRE el ganador del dedup.
  return [...byNombre.values()]
    .filter(m => m.activo)
    .sort((a, b) => (a.orden || 0) - (b.orden || 0));
}

// Busca cuenta_destino del medio matcheado por nombre + localId.
// Misma regla de prioridad que pickDisponibles: local-specific > global.
// Devuelve null si no hay match, si el medio no impacta caja, o si el
// override del local lo dejó inactivo (en cuyo caso el global no debe
// "colarse" — el operador desactivó ese medio en este local a propósito).
export function pickCuentaDestino(medios: MedioCobro[], nombre: string, localId: number | null): string | null {
  // Mismo patrón: scope → dedup → filtrar activo del ganador.
  const enScope = medios.filter(m => m.nombre === nombre && (m.local_id === null || m.local_id === localId));
  if (enScope.length === 0) return null;
  // Preferir local-specific (override) sobre global.
  const ganador = enScope.find(m => m.local_id !== null) || enScope[0];
  if (!ganador?.activo) return null;
  return ganador.cuenta_destino ?? null;
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
      if (error) {
        // Error duro (network/RLS): fallback defensivo transitorio.
        console.warn(
          "[useMediosCobro] usando FALLBACK hardcoded — los datos pueden estar desactualizados.",
          { cause: error.message }
        );
        setMedios(FALLBACK);
        setSource("fallback");
      } else if (!data || data.length === 0) {
        // DB respondió OK con 0 filas → tenant sin medios. Mostrar VACÍO,
        // NUNCA el FALLBACK con los medios de Neko. source='db' (la DB manda).
        // Con el seed de catálogo al crear tenant esto casi no pasa, pero es
        // la red de seguridad contra el leak de Neko en un tenant vacío.
        setMedios([]);
        setSource("db");
      } else {
        const rows = data as MedioCobro[];
        writeCache(rows);
        setMedios(rows);
        setSource("db");
      }
    } catch (e) {
      console.warn("[useMediosCobro] usando FALLBACK por excepción:", e);
      setMedios(FALLBACK);
      setSource("fallback");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (source === "cache") return;
    // fetchMedios llama setState async post-fetch. Patrón fetch-on-mount
    // (deps vacías intencionalmente para no re-fetch en cada render).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchMedios(false);
  // Deps vacías intencionales: agregar fetchMedios o source generaría
  // re-fetch infinito (fetchMedios se recrea cada render; source cambia
  // tras setState dentro del fetch).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback(() => {
    clearCache();
    fetchMedios(true);
  }, [fetchMedios]);

  // Invalidación cross-tab: cualquier cambio remoto en medios_cobro del
  // mismo tenant invalida el cache local + re-fetch. Antes solo Configuración
  // tenía useRealtimeTable; los otros módulos veían stale hasta logout/TTL.
  useRealtimeTable({ table: "medios_cobro", onChange: () => refresh() });

  const mediosDisponibles = useCallback((localId: number | null) => pickDisponibles(medios, localId), [medios]);
  const todosLosMedios = useCallback(() => medios, [medios]);
  const cuentaDestino = useCallback((nombre: string, localId: number | null) => pickCuentaDestino(medios, nombre, localId), [medios]);

  return { mediosDisponibles, todosLosMedios, cuentaDestino, refresh, loading, source };
}
