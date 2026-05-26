// Solicitudes.tsx — pantalla central donde el dueño ve TODAS las solicitudes
// de autorización (pendientes + histórico).
//
// Accesible desde:
//   - Sidebar (vía Ajustes o un link directo, ver entrada nueva).
//   - Push notification (click → /aprobar-solicitud/:id va al detalle).
//
// Tabs:
//   - Pendientes: las que esperan tu decisión. Click → /aprobar-solicitud/:id
//   - Aprobadas / Rechazadas / Expiradas / Usadas: histórico read-only.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../lib/supabase";
import { PageHeader } from "../components/ui";
import type { Usuario } from "../types";

interface Props { user: Usuario; }

type Estado = "pendiente" | "aprobada" | "rechazada" | "expirada" | "usada";

interface SolicitudRow {
  id: number;
  accion: string;
  context: Record<string, unknown>;
  estado: Estado;
  creador_nombre: string | null;
  aprobador_nombre: string | null;
  rechazo_motivo: string | null;
  created_at: string;
  aprobada_at: string | null;
  usada_at: string | null;
  expires_at: string;
}

const ACCION_LABEL: Record<string, string> = {
  anular_factura: "Anular factura",
  anular_remito: "Anular remito",
  anular_gasto: "Anular gasto",
  anular_movimiento: "Anular movimiento",
  eliminar_venta: "Eliminar venta",
  eliminar_cierre: "Eliminar cierre",
  editar_venta: "Editar venta",
  editar_gasto: "Editar gasto",
  editar_movimiento: "Editar movimiento",
  descuento_pos: "Descuento en POS",
  merma_robo: "Merma / robo",
  cortesia: "Cortesía",
};

const ESTADO_BADGE: Record<Estado, { label: string; color: string; bg: string }> = {
  pendiente: { label: "Pendiente", color: "#A8893A", bg: "rgba(168,137,58,0.15)" },
  aprobada:  { label: "Aprobada",  color: "#2BB673", bg: "rgba(43,182,115,0.15)" },
  usada:     { label: "Usada",     color: "#2BB673", bg: "rgba(43,182,115,0.1)" },
  rechazada: { label: "Rechazada", color: "#EF4444", bg: "rgba(239,68,68,0.15)" },
  expirada:  { label: "Expirada",  color: "#93A8C2", bg: "rgba(147,168,194,0.15)" },
};

export default function Solicitudes({ user }: Props) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<SolicitudRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<Estado | "todas">("pendiente");

  const puedeVer = user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";

  useEffect(() => {
    if (!puedeVer) {
      setError("Solo el dueño puede ver esta pantalla.");
      setLoading(false);
      return;
    }
    let cancelado = false;
    void (async () => {
      setLoading(true);
      // Traer histórico completo del tenant (últimos 200, ordenadas DESC).
      // RLS filtra por tenant + rol automáticamente.
      // eslint-disable-next-line pase-local/require-apply-local-scope -- tabla por tenant, sin local_id
      const { data, error: e } = await db.from("manager_solicitudes")
        .select(`
          id, accion, context, estado, rechazo_motivo,
          created_at, aprobada_at, usada_at, expires_at,
          creador:creada_por_usuario_id(nombre),
          aprobador:aprobada_por_usuario_id(nombre)
        `)
        .order("created_at", { ascending: false })
        .limit(200);
      if (cancelado) return;
      if (e) {
        setError(e.message);
        setLoading(false);
        return;
      }
      // Supabase devuelve los joins como array (o single si se setea
      // `!inner` / FK to-one), por defecto: array. Tomamos el primero.
      type Raw = {
        id: number; accion: string; context: Record<string, unknown>; estado: Estado;
        rechazo_motivo: string | null;
        created_at: string; aprobada_at: string | null;
        usada_at: string | null; expires_at: string;
        creador: { nombre: string } | Array<{ nombre: string }> | null;
        aprobador: { nombre: string } | Array<{ nombre: string }> | null;
      };
      const pickNombre = (v: Raw["creador"]): string | null => {
        if (!v) return null;
        if (Array.isArray(v)) return v[0]?.nombre ?? null;
        return v.nombre ?? null;
      };
      const mapped: SolicitudRow[] = ((data as unknown as Raw[] | null) ?? []).map(r => ({
        id: r.id,
        accion: r.accion,
        context: r.context,
        estado: r.estado,
        rechazo_motivo: r.rechazo_motivo,
        creador_nombre: pickNombre(r.creador),
        aprobador_nombre: pickNombre(r.aprobador),
        created_at: r.created_at,
        aprobada_at: r.aprobada_at,
        usada_at: r.usada_at,
        expires_at: r.expires_at,
      }));
      setRows(mapped);
      setLoading(false);
    })();
    return () => { cancelado = true; };
  }, [puedeVer]);

  const filtradas = useMemo(() => {
    if (filtroEstado === "todas") return rows;
    return rows.filter((r) => r.estado === filtroEstado);
  }, [rows, filtroEstado]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { todas: rows.length };
    for (const r of rows) c[r.estado] = (c[r.estado] || 0) + 1;
    return c;
  }, [rows]);

  if (!puedeVer) {
    return (
      <div style={{ padding: 24 }}>
        <PageHeader title="Solicitudes" />
        <p style={{ color: "var(--pase-text-muted)" }}>Solo el dueño puede ver esta pantalla.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
      <PageHeader
        title="Solicitudes de autorización"
        info={<>
          Acá ves todas las veces que tus empleados pidieron permiso para hacer
          algo que normalmente requiere tu autorización. Click en una pendiente
          para aprobarla o rechazarla.
        </>}
      />

      {/* Tabs filtro */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {([
          ["pendiente", "Pendientes"],
          ["aprobada", "Aprobadas"],
          ["usada", "Usadas"],
          ["rechazada", "Rechazadas"],
          ["expirada", "Expiradas"],
          ["todas", "Todas"],
        ] as Array<[Estado | "todas", string]>).map(([key, label]) => (
          <button
            key={key}
            className={"btn btn-sm " + (filtroEstado === key ? "btn-acc" : "btn-ghost")}
            onClick={() => setFiltroEstado(key)}
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            {label} {counts[key] != null && counts[key] > 0 && `(${counts[key]})`}
          </button>
        ))}
      </div>

      {loading && <p style={{ color: "var(--pase-text-muted)" }}>Cargando…</p>}
      {error && <div className="alert alert-danger">{error}</div>}

      {!loading && filtradas.length === 0 && (
        <div style={{
          padding: 40, textAlign: "center",
          background: "var(--pase-bg-elev)",
          border: "0.5px dashed var(--pase-border)",
          borderRadius: 12,
          color: "var(--pase-text-muted)",
          fontSize: 14,
        }}>
          {filtroEstado === "pendiente"
            ? "No tenés solicitudes pendientes 🎉"
            : "Nada en este filtro."}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtradas.map((r) => {
          const badge = ESTADO_BADGE[r.estado];
          const accionTxt = ACCION_LABEL[r.accion] ?? r.accion;
          const total = r.context?.total ?? r.context?.monto;
          const nro = r.context?.factura_nro ?? r.context?.nro ?? r.context?.remito_nro;
          const motivo = r.context?.motivo as string | undefined;
          const esClickeable = r.estado === "pendiente";
          return (
            <div
              key={r.id}
              onClick={esClickeable ? () => navigate(`/aprobar-solicitud/${r.id}`) : undefined}
              style={{
                background: "var(--pase-bg-elev)",
                border: "0.5px solid var(--pase-border)",
                borderRadius: 10,
                padding: 14,
                cursor: esClickeable ? "pointer" : "default",
                transition: "background 0.15s",
              }}
              onMouseEnter={esClickeable ? (e) => { e.currentTarget.style.background = "rgba(117,170,219,0.08)"; } : undefined}
              onMouseLeave={esClickeable ? (e) => { e.currentTarget.style.background = "var(--pase-bg-elev)"; } : undefined}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, fontSize: 14, color: "var(--pase-text)" }}>
                      {r.creador_nombre ?? "?"}
                    </span>
                    <span style={{ fontSize: 13, color: "var(--pase-text-muted)" }}>
                      pidió: <strong style={{ color: "var(--pase-text)" }}>{accionTxt}</strong>
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--pase-text-muted)", display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {nro != null && <span>Nº {String(nro)}</span>}
                    {total != null && <span style={{ color: "var(--pase-text)", fontWeight: 500 }}>${Math.round(Number(total)).toLocaleString("es-AR")}</span>}
                    <span>{new Date(r.created_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}</span>
                  </div>
                  {motivo && (
                    <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--pase-text-muted)", fontStyle: "italic" }}>
                      "{motivo}"
                    </p>
                  )}
                  {r.estado === "rechazada" && r.rechazo_motivo && (
                    <p style={{ margin: "6px 0 0", fontSize: 12, color: "#EF4444" }}>
                      Tu motivo de rechazo: "{r.rechazo_motivo}"
                    </p>
                  )}
                  {(r.estado === "aprobada" || r.estado === "usada" || r.estado === "rechazada") && r.aprobador_nombre && (
                    <p style={{ margin: "6px 0 0", fontSize: 11, color: "var(--pase-text-muted)" }}>
                      Por {r.aprobador_nombre} · {r.aprobada_at && new Date(r.aprobada_at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" })}
                    </p>
                  )}
                </div>
                <span style={{
                  fontSize: 11, padding: "3px 8px", borderRadius: 999,
                  background: badge.bg, color: badge.color,
                  fontWeight: 600, whiteSpace: "nowrap",
                }}>
                  {badge.label}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
