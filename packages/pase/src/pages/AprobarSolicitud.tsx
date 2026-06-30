// AprobarSolicitud.tsx — pantalla que se abre cuando el dueño clickea el
// push notification "X pide autorización".
//
// Mobile-first: el dueño la abre 99% desde el celu. Card centrada, botones
// grandes. Después de aprobar/rechazar, si quedan MÁS solicitudes pendientes,
// ofrece saltar a la siguiente (no tirar al inicio) — así el dueño puede
// procesar varias seguidas.

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { db } from "../lib/supabase";
import type { Usuario } from "../types";

interface Props { user: Usuario; }

interface SolicitudRow {
  id: number;
  accion: string;
  context: Record<string, unknown>;
  creador_nombre: string;
  creador_id: number;
  created_at: string;
  expires_at: string;
}

const ACCION_LABEL: Record<string, string> = {
  anular_factura: "Anular factura",
  anular_gasto: "Anular gasto",
  anular_movimiento: "Anular movimiento",
  editar_movimiento: "Editar movimiento",
  descuento_pos: "Aplicar descuento",
  merma_robo: "Registrar merma / robo",
  cortesia: "Dar cortesía",
};

function fmtAccion(accion: string): string {
  return ACCION_LABEL[accion] || accion.replace(/_/g, " ");
}

function fmtMonto(n: unknown): string {
  if (n == null) return "—";
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return "$" + num.toLocaleString("es-AR", { maximumFractionDigits: 0 });
}

export default function AprobarSolicitud({ user }: Props) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [solicitud, setSolicitud] = useState<SolicitudRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [estado, setEstado] = useState<"pendiente" | "ya_procesada" | "no_existe">("pendiente");
  const [actuando, setActuando] = useState<"aprobar" | "rechazar" | null>(null);
  const [motivoRechazo, setMotivoRechazo] = useState("");
  const [mostrarRechazo, setMostrarRechazo] = useState(false);
  const [resultado, setResultado] = useState<{ tipo: "aprobada" | "rechazada"; msg: string } | null>(null);
  // Solicitudes que SIGUEN pendientes después de actuar (para saltar a la próxima).
  const [restantes, setRestantes] = useState<SolicitudRow[]>([]);

  // Solo dueño/admin/superadmin pueden aprobar.
  const puedeAprobar = user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";

  useEffect(() => {
    // Reset al cambiar de id (al saltar a la siguiente solicitud).
    setResultado(null); setSolicitud(null); setError(null);
    setEstado("pendiente"); setMostrarRechazo(false); setMotivoRechazo("");
    setLoading(true);
    if (!id) return;
    if (!puedeAprobar) {
      setError("Solo el dueño puede aprobar solicitudes.");
      setLoading(false);
      return;
    }
    let cancelado = false;
    void (async () => {
      const { data, error: e } = await db.rpc("fn_listar_solicitudes_pendientes");
      if (cancelado) return;
      if (e) { setError(e.message); setLoading(false); return; }
      const rows = (data as SolicitudRow[] | null) ?? [];
      const found = rows.find((s) => String(s.id) === id);
      if (found) setSolicitud(found);
      else setEstado("ya_procesada");
      setLoading(false);
    })();
    return () => { cancelado = true; };
  }, [id, puedeAprobar]);

  // Tras aprobar/rechazar, recargamos las pendientes para ofrecer la próxima.
  const cargarRestantes = async () => {
    const { data } = await db.rpc("fn_listar_solicitudes_pendientes");
    const rows = (data as SolicitudRow[] | null) ?? [];
    setRestantes(rows.filter((s) => String(s.id) !== id));
  };

  const aprobar = async () => {
    if (!id || !solicitud) return;
    setActuando("aprobar");
    setError(null);
    const { error: e } = await db.rpc("fn_aprobar_solicitud", { p_id: Number(id) });
    setActuando(null);
    if (e) { setError(e.message); return; }
    setResultado({ tipo: "aprobada", msg: `${solicitud.creador_nombre} ya puede completar la operación.` });
    void cargarRestantes();
  };

  const rechazar = async () => {
    if (!id || !solicitud) return;
    setActuando("rechazar");
    setError(null);
    const { error: e } = await db.rpc("fn_rechazar_solicitud", {
      p_id: Number(id),
      p_motivo: motivoRechazo.trim() || null,
    });
    setActuando(null);
    if (e) { setError(e.message); return; }
    setResultado({ tipo: "rechazada", msg: `${solicitud.creador_nombre} va a recibir el motivo.` });
    void cargarRestantes();
  };

  // ─── Estados de pantalla ──────────────────────────────────────────────

  if (loading) {
    return <Center><p style={{ color: "var(--pase-text-muted)" }}>Cargando solicitud…</p></Center>;
  }

  // Resultado: aprobada / rechazada → con salto a la próxima si quedan.
  if (resultado) {
    const ok = resultado.tipo === "aprobada";
    const prox = restantes[0];
    return (
      <Center>
        <Card>
          <div style={{
            width: 56, height: 56, borderRadius: "50%", margin: "0 auto 14px",
            display: "grid", placeItems: "center", fontSize: 28, fontWeight: 600,
            background: ok ? "rgba(43,182,115,0.14)" : "rgba(239,68,68,0.12)",
            color: ok ? "#2BB673" : "#EF4444",
          }}>
            {ok ? "✓" : "✕"}
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 500, margin: "0 0 6px", textAlign: "center", color: "var(--pase-text)" }}>
            {ok ? "Aprobado" : "Rechazado"}
          </h2>
          <p style={{ margin: 0, fontSize: 14, color: "var(--pase-text-muted)", textAlign: "center", lineHeight: 1.5 }}>
            {resultado.msg}
          </p>

          <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
            {prox ? (
              <button
                onClick={() => navigate(`/aprobar-solicitud/${prox.id}`)}
                style={primaryBtn}
              >
                Siguiente solicitud{restantes.length > 1 ? ` (${restantes.length})` : ""} →
              </button>
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: "var(--pase-text-muted)", textAlign: "center" }}>
                No quedan más solicitudes pendientes.
              </p>
            )}
            <button onClick={() => navigate("/inicio")} style={ghostBtn}>
              Ir al inicio
            </button>
          </div>
        </Card>
      </Center>
    );
  }

  if (estado === "ya_procesada") {
    return (
      <Center>
        <Card>
          <div style={{ fontSize: 36, marginBottom: 8, textAlign: "center" }}>⏱</div>
          <h2 style={{ margin: "0 0 6px", fontSize: 17, fontWeight: 500, textAlign: "center", color: "var(--pase-text)" }}>
            Esta solicitud ya no está disponible
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: "var(--pase-text-muted)", textAlign: "center", lineHeight: 1.5 }}>
            Puede que ya la hayas aprobado/rechazado o que haya expirado (1 hora).
          </p>
          <button onClick={() => navigate("/inicio")} style={{ ...ghostBtn, marginTop: 18 }}>
            Ir al inicio
          </button>
        </Card>
      </Center>
    );
  }

  if (error || !solicitud) {
    return (
      <Center>
        <Card>
          <div className="alert alert-danger" style={{ marginBottom: 14 }}>{error || "No se pudo cargar la solicitud"}</div>
          <button onClick={() => navigate("/inicio")} style={ghostBtn}>Ir al inicio</button>
        </Card>
      </Center>
    );
  }

  const ctx = solicitud.context;
  const total = ctx.total ?? ctx.monto;
  const nro = ctx.factura_nro ?? ctx.nro;
  const proveedor = (ctx.proveedor_nombre ?? ctx.proveedor) as string | undefined;
  const local = (ctx.local_nombre ?? ctx.local) as string | undefined;
  const motivo = ctx.motivo as string | undefined;
  const expiraEn = Math.max(0, Math.floor((new Date(solicitud.expires_at).getTime() - Date.now()) / 60000));
  const inicial = (solicitud.creador_nombre?.[0] ?? "?").toUpperCase();

  return (
    <Center>
      <Card>
        {/* Encabezado: avatar + quién pide */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
          <div style={{
            width: 44, height: 44, borderRadius: "50%", flexShrink: 0,
            display: "grid", placeItems: "center", fontSize: 16, fontWeight: 600,
            background: "var(--pase-celeste-100)", color: "var(--pase-celeste)",
          }}>
            {inicial}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: "var(--pase-text-muted)", letterSpacing: "0.04em" }}>
              Solicitud de autorización · expira en {expiraEn} min
            </div>
            <h1 style={{ fontSize: 19, fontWeight: 500, margin: "1px 0 0", color: "var(--pase-text)" }}>
              {solicitud.creador_nombre} pide tu OK
            </h1>
          </div>
        </div>

        {/* Detalle de la acción */}
        <div style={{
          background: "var(--pase-bg-soft)",
          border: "0.5px solid var(--pase-border)",
          borderRadius: 12,
          padding: 16,
          marginBottom: 18,
        }}>
          <div style={{ fontSize: 12, color: "var(--pase-text-muted)", marginBottom: 2 }}>Acción</div>
          <div style={{ fontSize: 17, fontWeight: 500, color: "var(--pase-text)", marginBottom: total != null || nro != null ? 12 : 0, textTransform: "capitalize" }}>
            {fmtAccion(solicitud.accion)}
          </div>
          {nro != null && <Row label="Comprobante" value={String(nro)} />}
          {total != null && <Row label="Monto" value={fmtMonto(total)} highlight />}
          {proveedor && <Row label="Proveedor" value={proveedor} />}
          {local && <Row label="Local" value={local} />}
          {motivo && <Row label="Motivo del empleado" value={motivo} />}
        </div>

        {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}

        {mostrarRechazo ? (
          <>
            <textarea
              value={motivoRechazo}
              onChange={(e) => setMotivoRechazo(e.target.value)}
              placeholder="Decile a tu empleado por qué rechazás (opcional)"
              rows={3}
              style={{
                width: "100%", padding: 12, fontSize: 14,
                background: "var(--pase-bg-soft)", color: "var(--pase-text)",
                border: "0.5px solid var(--pase-border)", borderRadius: 10,
                marginBottom: 10, fontFamily: "inherit", resize: "vertical",
                boxSizing: "border-box",
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => { setMostrarRechazo(false); setMotivoRechazo(""); }} disabled={!!actuando}
                style={{ ...ghostBtn, flex: 1 }}>
                Cancelar
              </button>
              <button onClick={() => void rechazar()} disabled={!!actuando}
                style={{ ...dangerSolidBtn, flex: 1 }}>
                {actuando === "rechazar" ? "Rechazando…" : "Confirmar rechazo"}
              </button>
            </div>
          </>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button onClick={() => void aprobar()} disabled={!!actuando} style={approveBtn}>
              {actuando === "aprobar" ? "Aprobando…" : "✓ Aprobar"}
            </button>
            <button onClick={() => setMostrarRechazo(true)} disabled={!!actuando} style={dangerGhostBtn}>
              ✕ Rechazar
            </button>
          </div>
        )}
      </Card>
    </Center>
  );
}

// ─── Estilos compartidos ────────────────────────────────────────────────

const approveBtn: React.CSSProperties = {
  padding: 16, fontSize: 16, fontWeight: 500,
  background: "#2BB673", color: "white", border: "none",
  borderRadius: 12, cursor: "pointer",
};
const dangerGhostBtn: React.CSSProperties = {
  padding: 16, fontSize: 16, fontWeight: 500,
  background: "transparent", color: "#EF4444",
  border: "0.5px solid rgba(239,68,68,0.5)", borderRadius: 12, cursor: "pointer",
};
const dangerSolidBtn: React.CSSProperties = {
  padding: 14, fontSize: 15, fontWeight: 500,
  background: "#EF4444", color: "white", border: "none",
  borderRadius: 10, cursor: "pointer",
};
const primaryBtn: React.CSSProperties = {
  padding: 14, fontSize: 15, fontWeight: 500,
  background: "var(--pase-celeste)", color: "#fff", border: "none",
  borderRadius: 10, cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: 13, fontSize: 14, fontWeight: 500,
  background: "transparent", color: "var(--pase-text-muted)",
  border: "0.5px solid var(--pase-border)", borderRadius: 10, cursor: "pointer", width: "100%",
};

// ─── Sub-componentes ────────────────────────────────────────────────────

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: "calc(100vh - 80px)", padding: 20,
    }}>
      <div style={{ width: "100%", maxWidth: 420 }}>{children}</div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--pase-bg-elev)",
      border: "0.5px solid var(--pase-border)",
      borderRadius: 16,
      padding: 22,
      boxShadow: "var(--pase-shadow-lg)",
    }}>
      {children}
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "8px 0", borderBottom: "0.5px solid var(--pase-border)",
    }}>
      <span style={{ fontSize: 13, color: "var(--pase-text-muted)" }}>{label}</span>
      <span style={{
        fontSize: highlight ? 18 : 14,
        fontWeight: highlight ? 600 : 500,
        color: "var(--pase-text)",
        fontVariantNumeric: "tabular-nums",
        textAlign: "right", maxWidth: "60%",
        overflow: "hidden", textOverflow: "ellipsis",
      }}>
        {value}
      </span>
    </div>
  );
}
