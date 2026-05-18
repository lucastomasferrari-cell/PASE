import { useCallback, useEffect, useState } from "react";
import type { Local } from "../types";

/**
 * Hook unificado para decidir qué sucursal está activa en una pantalla/modal.
 *
 * Modelo (definido por Lucas 2026-05-17):
 *
 *   - Sidebar = "Todas las sucursales" (localActivo === null)
 *       → en cada pantalla/modal, el usuario debe elegir EXPLÍCITAMENTE la
 *         sucursal sobre la que va a operar. Para listados, "todas" puede
 *         ser un valor válido. Para CARGAS (modales de creación), elegir
 *         una sucursal es OBLIGATORIO — no se puede ambiguo.
 *
 *   - Sidebar = una sucursal específica (localActivo !== null)
 *       → todo viene LOCKED a esa sucursal. El usuario ve un chip 🔒
 *         indicando que el lock viene del sidebar. Para cambiar de sucursal,
 *         tiene que volver al sidebar y poner "Todas" o elegir otra.
 *
 * Devuelve:
 *   - `sucursalActiva` — id efectivo (null si no se eligió en modo "todas")
 *   - `bloqueado` — true cuando viene del sidebar (UI debe mostrar chip lock)
 *   - `setSucursalUI` — para que el usuario elija en modo "todas" (no-op si bloqueado)
 *   - `nombreSucursal` — string del local activo (o "Todas las sucursales")
 *   - `requiereSeleccion` — true si modo carga + bloqueado=false + sucursalActiva=null
 *
 * Uso típico en pantallas de VISTA:
 *
 *   const { sucursalActiva, bloqueado, setSucursalUI, nombreSucursal } =
 *     useLocalContextoUI({ localActivo, locales, modo: "vista" });
 *
 * Uso típico en modales de CARGA:
 *
 *   const { sucursalActiva, bloqueado, setSucursalUI, requiereSeleccion } =
 *     useLocalContextoUI({ localActivo, locales, modo: "carga" });
 *
 *   if (requiereSeleccion) { mostrar selector obligatorio + bloquear submit }
 */

export type ModoContextoUI = "vista" | "carga";

interface Args {
  /** localActivo del sidebar (App.tsx state). null = "Todas las sucursales" */
  localActivo: number | null;
  /** Locales visibles para el user (App.tsx state) */
  locales: Local[];
  /** "vista" permite el modo "todas"; "carga" exige una sucursal */
  modo: ModoContextoUI;
  /** Para modo "carga": qué hacer si no hay sucursal elegida en "todas".
   * "primera" (default) → caer al primer local visible.
   * "vacio" → quedar en null y exigir que el usuario elija. */
  defaultEnTodas?: "primera" | "vacio";
}

interface Resultado {
  /** Sucursal activa efectiva. null solo si modo=vista + sidebar=todas + user no eligió. */
  sucursalActiva: number | null;
  /** True cuando viene del sidebar (mostrar chip lock 🔒 en la UI). */
  bloqueado: boolean;
  /** Para modo "todas": deja al user elegir. No-op si bloqueado. */
  setSucursalUI: (id: number | null) => void;
  /** Nombre del local activo (o "Todas las sucursales" / "Sin elegir"). */
  nombreSucursal: string;
  /** Solo en modo "carga": true si no hay sucursal y la pantalla debería bloquear submit. */
  requiereSeleccion: boolean;
}

export function useLocalContextoUI({
  localActivo,
  locales,
  modo,
  defaultEnTodas = "primera",
}: Args): Resultado {
  // Sucursal "interna" — se usa solo cuando sidebar=null (modo "todas").
  const [sucursalUI, setSucursalUI] = useState<number | null>(() => {
    if (localActivo !== null) return localActivo;
    if (modo === "carga" && defaultEnTodas === "primera" && locales.length > 0) {
      return locales[0]!.id;
    }
    return null;
  });

  // Si el sidebar cambia, sincronizamos.
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps --
     sync de estado UI con prop externa (sidebar). Pre-rellena la sucursal
     elegida cuando cambia localActivo. setState en effect es el patron
     correcto aca: el effect es la sincronizacion con un sistema externo
     (el localActivo viene del parent). exhaustive-deps omite sucursalUI/
     modo/defaultEnTodas a proposito para no re-correr al editar el form. */
  useEffect(() => {
    if (localActivo !== null) {
      setSucursalUI(localActivo);
    } else if (modo === "carga" && defaultEnTodas === "primera" && sucursalUI === null && locales.length > 0) {
      setSucursalUI(locales[0]!.id);
    }
  }, [localActivo, locales]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const bloqueado = localActivo !== null;
  const sucursalActiva = bloqueado ? localActivo : sucursalUI;
  const nombreSucursal = (() => {
    if (sucursalActiva === null) {
      return modo === "vista" ? "Todas las sucursales" : "Sin elegir";
    }
    return locales.find(l => l.id === sucursalActiva)?.nombre ?? "—";
  })();
  const requiereSeleccion = modo === "carga" && !bloqueado && sucursalActiva === null;

  const setter = useCallback((id: number | null) => {
    if (bloqueado) return;
    setSucursalUI(id);
  }, [bloqueado]);

  return {
    sucursalActiva,
    bloqueado,
    setSucursalUI: setter,
    nombreSucursal,
    requiereSeleccion,
  };
}
