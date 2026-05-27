import { useEffect, useState, useCallback } from "react";
import { db } from "./supabase";
import { useRealtimeTable } from "./useRealtimeTable";
import { tienePermiso } from "./auth";
import { todayAR_ISO, toLocalISO } from './utils';
import type { Usuario } from "../types";

/**
 * Hook que unifica las fuentes de notificaciones de la app en un único feed.
 *
 * MVP (2026-05-18, pedido Lucas): consolida lo que YA EXISTE en widgets
 * separados sin agregar migraciones nuevas. Cada notif es derivada de una
 * fila de DB (tarea pineada, override usado, factura vencida, etc.) y el
 * "leído" se trackea en localStorage del browser.
 *
 * Cuando se agreguen notifs en tiempo real (pago llegado, venta cerrada),
 * vamos a migrar a una tabla `notificaciones` polimórfica. El shape del
 * tipo Notif es estable — los call-sites no se rompen.
 */

export type NotifSource = "tarea" | "override" | "factura_vencida" | "factura_por_vencer" | "mp_sin_conciliar" | "solicitud_pendiente";

export interface Notif {
  /** Clave única: `${source}:${originalId}`. Se usa para read tracking. */
  id: string;
  source: NotifSource;
  titulo: string;
  descripcion: string;
  /** Fecha ISO de la notif (para sort + display relativo). */
  fecha: string;
  /** Ruta a navegar al clickear. */
  href?: string;
  /** Marcado leído (computado contra localStorage). */
  leido: boolean;
}

const STORAGE_KEY = "pase_inbox_read";

// ─── Read tracking (localStorage) ─────────────────────────────────────────

function leerReadMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed != null ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

function guardarReadMap(map: Record<string, string>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch { /* quota */ }
}

export function marcarComoLeida(notifId: string): void {
  const map = leerReadMap();
  map[notifId] = new Date().toISOString();
  guardarReadMap(map);
}

export function marcarTodasComoLeidas(notifs: Notif[]): void {
  const map = leerReadMap();
  const now = new Date().toISOString();
  for (const n of notifs) {
    if (!map[n.id]) map[n.id] = now;
  }
  guardarReadMap(map);
}

// ─── Fetchers por fuente ──────────────────────────────────────────────────

async function fetchTareas(user: Usuario): Promise<Notif[]> {
  const nowIso = new Date().toISOString();
  const { data } = await db.from("dashboard_pinned_notes")
    .select("id, titulo, cuerpo, created_at, prioridad, es_tarea, completada_at, expires_at, target_usuario_id, target_rol")
    .or(`target_usuario_id.eq.${user.id},target_rol.eq.${user.rol}`)
    .is("completada_at", null)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []).map(row => {
    const r = row as { id: number; titulo: string; cuerpo: string | null; created_at: string; prioridad: string };
    return {
      id: `tarea:${r.id}`,
      source: "tarea" as const,
      titulo: r.titulo,
      descripcion: r.cuerpo ?? (r.prioridad === "urgente" ? "URGENTE" : ""),
      fecha: r.created_at,
      href: "/inicio",
      leido: false,
    };
  });
}

async function fetchOverrides(user: Usuario): Promise<Notif[]> {
  if (!tienePermiso(user, "codigos_manager")) return [];
  const { data } = await db.from("manager_override_usos")
    .select("id, usuario_id, accion, context, usado_at")
    .order("usado_at", { ascending: false })
    .limit(20);
  // Resolver nombre del usuario que usó el código
  const ids = Array.from(new Set((data ?? []).map(r => (r as { usuario_id: number }).usuario_id)));
  const usuariosMap = new Map<number, string>();
  if (ids.length > 0) {
    const { data: usrs } = await db.from("usuarios").select("id, nombre").in("id", ids);
    for (const u of usrs ?? []) {
      const ur = u as { id: number; nombre: string };
      usuariosMap.set(ur.id, ur.nombre);
    }
  }
  const ACCION_LABEL: Record<string, string> = {
    anular_factura: "anuló una factura",
    anular_remito: "anuló un remito",
    anular_gasto: "anuló un gasto",
    anular_movimiento: "anuló un movimiento",
  };
  return (data ?? []).map(row => {
    const r = row as { id: number; usuario_id: number; accion: string; context: Record<string, unknown> | null; usado_at: string };
    const nombre = usuariosMap.get(r.usuario_id) ?? `Empleado #${r.usuario_id}`;
    const accion = ACCION_LABEL[r.accion] ?? r.accion;
    const ctx = r.context;
    let detalle = "";
    if (ctx) {
      if (ctx.factura_id) detalle = ` · Factura #${ctx.factura_id}`;
      else if (ctx.remito_id) detalle = ` · Remito #${ctx.remito_id}`;
      else if (ctx.gasto_id) detalle = ` · Gasto #${ctx.gasto_id}`;
    }
    return {
      id: `override:${r.id}`,
      source: "override" as const,
      titulo: `${nombre} ${accion}`,
      descripcion: `Usó un código de autorización${detalle}.`,
      fecha: r.usado_at,
      href: "/herramientas",
      leido: false,
    };
  });
}

async function fetchFacturasVencidas(): Promise<Notif[]> {
  // AUDIT F4C #2: usar todayAR_ISO en vez de toISOString().slice(0,10).
  // El último devuelve fecha UTC; entre 21:00-23:59 AR la "fecha de hoy"
  // queda desplazada al día siguiente UTC → facturas que vencen hoy
  // aparecen como "vencidas" falsamente, y al día siguiente desaparecen.
  const hoyIso = todayAR_ISO();
  // eslint-disable-next-line pase-local/require-apply-local-scope -- bandeja de entrada: muestra resumen GLOBAL del user across los locales que ve. RLS ya scopea por tenant + auth_locales_visibles.
  const { data, error } = await db.from("facturas")
    .select("id, nro, total, venc")
    .eq("estado", "pendiente")
    .lt("venc", hoyIso)
    .order("venc", { ascending: true })
    .limit(20);
  if (error || !data) return [];

  // Una sola "notif resumen" por día con conteo. El detalle se ve clickeando.
  if (data.length === 0) return [];
  const totalVencido = data.reduce((s, r) => s + Number((r as { total: number | string }).total || 0), 0);
  const primeraFecha = (data[0] as { venc: string }).venc;
  return [{
    id: `factura_vencida:${hoyIso}`,
    source: "factura_vencida",
    titulo: `${data.length} ${data.length === 1 ? "factura vencida" : "facturas vencidas"}`,
    descripcion: `Total $${Math.round(totalVencido).toLocaleString("es-AR")}. Más antigua: vencía ${primeraFecha}.`,
    fecha: new Date().toISOString(),
    href: "/compras?filtro=vencidas",
    leido: false,
  }];
}

async function fetchMpSinConciliar(user: Usuario): Promise<Notif[]> {
  // Solo a quienes les compete la conciliación MP.
  if (!tienePermiso(user, "mp")) return [];

  const hace7d = toLocalISO(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  // eslint-disable-next-line pase-local/require-apply-local-scope -- bandeja de entrada: scope cross-local intencional, RLS ya filtra por tenant + locales visibles.
  const { data, error } = await db.from("mp_movimientos")
    .select("id, fecha, monto")
    .eq("conciliado", false)
    .eq("ignorado", false)
    .eq("anulado", false)
    .lt("fecha", hace7d)
    .limit(50);
  if (error || !data || data.length === 0) return [];

  const total = data.reduce((s, r) => s + Math.abs(Number((r as { monto: number | string }).monto || 0)), 0);
  const masViejo = (data[0] as { fecha: string }).fecha;
  return [{
    id: `mp_sin_conciliar:${hace7d}`,
    source: "mp_sin_conciliar",
    titulo: `${data.length} ${data.length === 1 ? "mov MP sin conciliar" : "movs MP sin conciliar"} de hace +7 días`,
    descripcion: `Total $${Math.round(total).toLocaleString("es-AR")}. Más viejo: ${masViejo}.`,
    fecha: new Date().toISOString(),
    href: "/caja/conciliacion",
    leido: false,
  }];
}

// Solicitudes de autorización pendientes (sprint 27-may noche).
// Solo dueño/admin las ven — son las que esperan su aprobación.
async function fetchSolicitudesPendientes(user: Usuario): Promise<Notif[]> {
  if (!(user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin")) return [];
  const { data, error } = await db.rpc("fn_listar_solicitudes_pendientes");
  if (error || !data) return [];
  const rows = data as Array<{
    id: number; accion: string; context: Record<string, unknown>;
    creador_nombre: string; created_at: string;
  }>;
  const ACCION_LABEL: Record<string, string> = {
    anular_factura: "anular una factura",
    anular_remito: "anular un remito",
    anular_gasto: "anular un gasto",
    anular_movimiento: "anular un movimiento",
    eliminar_venta: "eliminar una venta",
    eliminar_cierre: "eliminar un cierre",
    editar_venta: "editar una venta",
    editar_gasto: "editar un gasto",
    editar_movimiento: "editar un movimiento",
  };
  return rows.map((r) => {
    const accionTxt = ACCION_LABEL[r.accion] ?? r.accion.replace(/_/g, " ");
    const total = r.context?.total ?? r.context?.monto;
    const detalle = total != null
      ? ` $${Math.round(Number(total)).toLocaleString("es-AR")}`
      : "";
    return {
      id: `solicitud_pendiente:${r.id}`,
      source: "solicitud_pendiente" as const,
      titulo: `${r.creador_nombre} pide autorización`,
      descripcion: `Quiere ${accionTxt}${detalle}. Click para aprobar/rechazar.`,
      fecha: r.created_at,
      href: `/aprobar-solicitud/${r.id}`,
      leido: false,
    };
  });
}

async function fetchFacturasPorVencer(): Promise<Notif[]> {
  // AUDIT F4C #2: fecha de "hoy" en zona AR, fresh por cada call.
  const hoyIso = todayAR_ISO();
  const en7Date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 - 3 * 60 * 60 * 1000);
  const en7 = toLocalISO(en7Date);
  // eslint-disable-next-line pase-local/require-apply-local-scope -- bandeja de entrada: idem fetchFacturasVencidas, scope cross-local intencional.
  const { data, error } = await db.from("facturas")
    .select("id, total, venc")
    .eq("estado", "pendiente")
    .gte("venc", hoyIso)
    .lte("venc", en7)
    .order("venc", { ascending: true })
    .limit(20);
  if (error || !data || data.length === 0) return [];
  const totalPorVencer = data.reduce((s, r) => s + Number((r as { total: number | string }).total || 0), 0);
  return [{
    id: `factura_por_vencer:${hoyIso}`,
    source: "factura_por_vencer",
    titulo: `${data.length} ${data.length === 1 ? "factura vence en 7 días" : "facturas vencen en 7 días"}`,
    descripcion: `Total $${Math.round(totalPorVencer).toLocaleString("es-AR")}. Planificá pagos.`,
    fecha: new Date().toISOString(),
    href: "/compras?filtro=por_vencer",
    leido: false,
  }];
}

// ─── Hook ─────────────────────────────────────────────────────────────────

interface BandejaState {
  notifs: Notif[];
  loading: boolean;
  countNoLeidas: number;
  reload: () => void;
  marcarLeida: (id: string) => void;
  marcarTodasLeidas: () => void;
}

export function useBandejaEntrada(user: Usuario | null | undefined): BandejaState {
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!user) { setNotifs([]); setLoading(false); return; }
    const [tareas, overrides, solicitudes, vencidas, porVencer, mpSinConc] = await Promise.all([
      fetchTareas(user).catch(() => [] as Notif[]),
      fetchOverrides(user).catch(() => [] as Notif[]),
      fetchSolicitudesPendientes(user).catch(() => [] as Notif[]),
      fetchFacturasVencidas().catch(() => [] as Notif[]),
      fetchFacturasPorVencer().catch(() => [] as Notif[]),
      fetchMpSinConciliar(user).catch(() => [] as Notif[]),
    ]);
    const readMap = leerReadMap();
    // Solicitudes pendientes NUNCA se marcan como leídas (siempre actionables).
    const all = [...tareas, ...overrides, ...solicitudes, ...vencidas, ...porVencer, ...mpSinConc]
      .map(n => ({
        ...n,
        leido: n.source === "solicitud_pendiente" ? false : !!readMap[n.id],
      }))
      .sort((a, b) => b.fecha.localeCompare(a.fecha));
    setNotifs(all);
    setLoading(false);
  }, [user]);

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- reload async (sync con DB).
  useEffect(() => { void reload(); }, [user?.id, user?.rol]);

  // Realtime: cuando aparece una tarea pineada o un override usado, re-fetch.
  useRealtimeTable({
    table: "dashboard_pinned_notes",
    onChange: reload,
    events: ["INSERT", "UPDATE"],
    enabled: !!user,
  });
  useRealtimeTable({
    table: "manager_override_usos",
    onChange: reload,
    events: ["INSERT"],
    enabled: !!user && tienePermiso(user, "codigos_manager"),
  });
  // Solicitudes nuevas en tiempo real para el dueño/admin.
  useRealtimeTable({
    table: "manager_solicitudes",
    onChange: reload,
    events: ["INSERT", "UPDATE"],
    enabled: !!user && (user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin"),
  });

  const countNoLeidas = notifs.filter(n => !n.leido).length;

  return {
    notifs,
    loading,
    countNoLeidas,
    reload,
    marcarLeida: (id: string) => {
      marcarComoLeida(id);
      setNotifs(prev => prev.map(n => n.id === id ? { ...n, leido: true } : n));
    },
    marcarTodasLeidas: () => {
      marcarTodasComoLeidas(notifs);
      setNotifs(prev => prev.map(n => ({ ...n, leido: true })));
    },
  };
}
