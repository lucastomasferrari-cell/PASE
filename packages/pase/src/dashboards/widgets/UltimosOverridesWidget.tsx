import { useEffect, useState, useCallback, useRef } from "react";
import { db } from "../../lib/supabase";
import { useRealtimeTable } from "../../lib/useRealtimeTable";
import { fmt_dt_ar } from "@pase/shared/utils";
import { EmptyState, KeyIcon } from "../../components/ui";
import type { WidgetContext } from "../types";

/**
 * UltimosOverridesWidget — log live de códigos de manager override usados.
 *
 * Visible solo para dueño/admin/superadmin (filtro vía permisosRequeridos
 * en el registry). Se suscribe a `manager_override_usos` via Realtime y
 * actualiza al instante cuando un empleado consume un código.
 *
 * Cuando llega un INSERT nuevo mientras el widget está montado, se
 * highlightea la fila por unos segundos para que el dueño se entere
 * aunque esté mirando otra parte del dashboard.
 *
 * Diseño 2026-05-18 (pedido Lucas: "notificación al dueño cuando se usa
 * un override").
 */

interface UsoOverride {
  id: number;
  usuario_id: number;
  accion: string;
  context: Record<string, unknown> | null;
  time_step: number;
  usado_at: string;
}

interface UsuarioRow {
  id: number;
  nombre: string;
}

const ACCION_LABELS: Record<string, string> = {
  anular_factura: "Anular factura",
  anular_remito: "Anular remito",
  anular_gasto: "Anular gasto",
  anular_movimiento: "Anular movimiento",
};

function fmtAccion(accion: string): string {
  return ACCION_LABELS[accion] ?? accion;
}

function fmtRelativo(iso: string): string {
  const d = new Date(iso).getTime();
  const now = Date.now();
  const secs = Math.floor((now - d) / 1000);
  if (secs < 60) return "Recién";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `Hace ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `Hace ${hrs}h`;
  return fmt_dt_ar(iso);
}

export function UltimosOverridesWidget({ ctx }: { ctx: WidgetContext }) {
  const [usos, setUsos] = useState<UsoOverride[]>([]);
  const [usuarios, setUsuarios] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  // ID del último uso que llegó vía Realtime — se highlightea unos segundos.
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    if (!ctx.usuario.tenant_id) { setLoading(false); return; }
    // Primero traer los 5 usos. Después solo los usuarios de esos 5 ids.
    // Fix auditoría 2026-05-21 ALTO-7: antes hacía SELECT * FROM usuarios
    // sin filtro (tenant con 80 empleados descargaba 80 filas para mapear 5).
    const { data: usosData } = await db.from("manager_override_usos")
      .select("id, usuario_id, accion, context, time_step, usado_at")
      .eq("tenant_id", ctx.usuario.tenant_id)
      .order("usado_at", { ascending: false })
      .limit(5);

    const prevMaxId = Math.max(0, ...usos.map(u => u.id));
    const nuevos = (usosData as UsoOverride[] | null) ?? [];
    setUsos(nuevos);

    // Si llegó uno nuevo (id mayor al anterior max), lo highlightaeamos.
    const recienLlegado = nuevos.find(u => u.id > prevMaxId);
    if (recienLlegado && prevMaxId > 0) {
      setHighlightedId(recienLlegado.id);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 8000);
    }

    // Lookup solo de los usuarios que aparecen en los 5 usos.
    const uniqueUserIds = Array.from(new Set(nuevos.map(u => u.usuario_id).filter((id): id is number => id != null)));
    if (uniqueUserIds.length > 0) {
      const { data: usrData } = await db.from("usuarios")
        .select("id, nombre")
        .in("id", uniqueUserIds);
      if (usrData) {
        const map = new Map<number, string>();
        for (const u of usrData as UsuarioRow[]) map.set(u.id, u.nombre);
        setUsuarios(map);
      }
    } else {
      setUsuarios(new Map());
    }
    setLoading(false);
  // ctx.usuario.tenant_id está en deps. `usos` se evita en deps para no
  // re-crear reload en cada update (sino se cae el realtime subscribe).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.usuario.tenant_id]);

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- reload async, patron sync con DB.
  useEffect(() => { void reload(); }, []);

  // Realtime: re-fetch cuando INSERT a manager_override_usos.
  useRealtimeTable({
    table: "manager_override_usos",
    onChange: reload,
    events: ["INSERT"],
    debounceMs: 200,
  });

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  if (loading) {
    return <div style={{ padding: "16px 0", textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>Cargando…</div>;
  }

  if (usos.length === 0) {
    return (
      <EmptyState
        icon={<KeyIcon size={32} tone="muted" />}
        title="Sin overrides usados"
        description="Cuando un empleado autorice algo con un código, va a aparecer acá."
      />
    );
  }

  return (
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {usos.map(u => {
          const ctx_short = (() => {
            if (!u.context) return null;
            const c = u.context as Record<string, unknown>;
            if (c.factura_id) return `Fact #${c.factura_id}`;
            if (c.remito_id) return `Rem #${c.remito_id}`;
            if (c.gasto_id) return `Gasto #${c.gasto_id}`;
            if (c.mov_id) return `Mov #${c.mov_id}`;
            return null;
          })();
          const isHighlighted = u.id === highlightedId;

          return (
            <div
              key={u.id}
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 6,
                background: isHighlighted ? "rgba(245, 197, 24, 0.18)" : "var(--pase-bg-soft)",
                border: isHighlighted ? "0.5px solid var(--pase-gold)" : "0.5px solid transparent",
                fontSize: "var(--pase-fs-sm)",
                transition: "background 0.4s, border-color 0.4s",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: "var(--pase-text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {usuarios.get(u.usuario_id) ?? `Usuario #${u.usuario_id}`}
                  <span style={{ color: "var(--pase-text-muted)", fontWeight: 400 }}> · {fmtAccion(u.accion)}</span>
                </div>
                {ctx_short && (
                  <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
                    {ctx_short}
                  </div>
                )}
              </div>
              <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", whiteSpace: "nowrap", flexShrink: 0 }}>
                {fmtRelativo(u.usado_at)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
