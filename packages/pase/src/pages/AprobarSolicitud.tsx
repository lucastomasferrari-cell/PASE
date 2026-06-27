// AprobarSolicitud.tsx — pantalla que se abre cuando el dueño clickea el
// push notification "X pide autorización".
//
// Mobile-first: el dueño la abre 99% desde el celu. Layout simple,
// botones grandes, sin sidebar visual cargada.
//
// Flow:
//   1. Carga datos de la solicitud (RPC fn_listar_solicitudes_pendientes
//      filtra por id; si no aparece, ya fue procesada o expiró).
//   2. Muestra: quién pidió + qué acción + detalle del contexto.
//   3. Botones Aprobar / Rechazar (con motivo opcional).
//   4. Después de aprobar/rechazar, redirige a /inicio con mensaje.

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

  // Solo dueño/admin/superadmin pueden aprobar.
  const puedeAprobar = user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";

  useEffect(() => {
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
      if (e) {
        setError(e.message);
        setLoading(false);
        return;
      }
      const rows = (data as SolicitudRow[] | null) ?? [];
      const found = rows.find((s) => String(s.id) === id);
      if (found) {
        setSolicitud(found);
      } else {
        // No está en pendientes. Puede que ya fue aprobada/rechazada o expiró.
        setEstado("ya_procesada");
      }
      setLoading(false);
    })();
    return () => { cancelado = true; };
  }, [id, puedeAprobar]);

  const aprobar = async () => {
    if (!id || !solicitud) return;
    setActuando("aprobar");
    setError(null);
    const { error: e } = await db.rpc("fn_aprobar_solicitud", { p_id: Number(id) });
    setActuando(null);
    if (e) {
      setError(e.message);
      return;
    }
    setResultado({
      tipo: "aprobada",
      msg: `Aprobaste. ${solicitud.creador_nombre} ya puede completar la operación.`,
    });
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
    if (e) {
      setError(e.message);
      return;
    }
    setResultado({
      tipo: "rechazada",
      msg: `Rechazaste la solicitud. ${solicitud.creador_nombre} va a recibir el motivo.`,
    });
  };

  if (loading) {
    return (
      <Container>
        <p style={{ color: "var(--pase-text-muted)" }}>Cargando solicitud…</p>
      </Container>
    );
  }

  if (resultado) {
    return (
      <Container>
        <div style={{
          padding: 20,
          background: resultado.tipo === "aprobada" ? "rgba(43,182,115,0.1)" : "rgba(239,68,68,0.1)",
          border: `1px solid ${resultado.tipo === "aprobada" ? "rgba(43,182,115,0.3)" : "rgba(239,68,68,0.3)"}`,
          borderRadius: 12,
          textAlign: "center",
        }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>
            {resultado.tipo === "aprobada" ? "✓" : "✕"}
          </div>
          <p style={{ margin: 0, fontSize: 15, color: "var(--pase-text)" }}>
            {resultado.msg}
          </p>
        </div>
        <button
          className="btn btn-ghost"
          style={{ width: "100%", marginTop: 16, padding: 14, fontSize: 15 }}
          onClick={() => navigate("/inicio")}
        >
          Ir al inicio
        </button>
      </Container>
    );
  }

  if (estado === "ya_procesada") {
    return (
      <Container>
        <div style={{
          padding: 20,
          background: "var(--pase-bg-elev)",
          border: "0.5px solid var(--pase-border)",
          borderRadius: 12,
          textAlign: "center",
        }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>⏱</div>
          <p style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 500 }}>
            Esta solicitud ya no está disponible
          </p>
          <p style={{ margin: 0, fontSize: 13, color: "var(--pase-text-muted)" }}>
            Puede que ya la hayas aprobado/rechazado o que haya expirado (1 hora).
          </p>
        </div>
        <button
          className="btn btn-ghost"
          style={{ width: "100%", marginTop: 16, padding: 14, fontSize: 15 }}
          onClick={() => navigate("/inicio")}
        >
          Ir al inicio
        </button>
      </Container>
    );
  }

  if (error || !solicitud) {
    return (
      <Container>
        <div className="alert alert-danger">{error || "No se pudo cargar la solicitud"}</div>
        <button
          className="btn btn-ghost"
          style={{ width: "100%", marginTop: 16, padding: 14, fontSize: 15 }}
          onClick={() => navigate("/inicio")}
        >
          Ir al inicio
        </button>
      </Container>
    );
  }

  const ctx = solicitud.context;
  const total = ctx.total ?? ctx.monto;
  const nro = ctx.factura_nro ?? ctx.nro;
  const proveedor = (ctx.proveedor_nombre ?? ctx.proveedor) as string | undefined;
  const local = (ctx.local_nombre ?? ctx.local) as string | undefined;
  const motivo = ctx.motivo as string | undefined;
  const expiraEn = Math.max(0, Math.floor((new Date(solicitud.expires_at).getTime() - Date.now()) / 60000));

  return (
    <Container>
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "var(--pase-text-muted)", textTransform: "none", letterSpacing: "0.05em", marginBottom: 4 }}>
          Solicitud de autorización
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 500, margin: 0, color: "var(--pase-text)" }}>
          {solicitud.creador_nombre} pide tu OK
        </h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--pase-text-muted)" }}>
          Expira en {expiraEn} min
        </p>
      </div>

      <div style={{
        background: "var(--pase-bg-elev)",
        border: "0.5px solid var(--pase-border)",
        borderRadius: 12,
        padding: 18,
        marginBottom: 16,
      }}>
        <div style={{ fontSize: 13, color: "var(--pase-text-muted)", marginBottom: 4 }}>Acción</div>
        <div style={{ fontSize: 18, fontWeight: 500, color: "var(--pase-text)", marginBottom: 14 }}>
          {fmtAccion(solicitud.accion)}
        </div>

        {nro != null && (
          <Row label="Comprobante" value={String(nro)} />
        )}
        {total != null && (
          <Row label="Monto" value={fmtMonto(total)} highlight />
        )}
        {proveedor && (
          <Row label="Proveedor" value={proveedor} />
        )}
        {local && (
          <Row label="Local" value={local} />
        )}
        {motivo && (
          <Row label="Motivo del empleado" value={motivo} />
        )}
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
              background: "var(--pase-bg-soft)",
              color: "var(--pase-text)",
              border: "0.5px solid var(--pase-border)",
              borderRadius: 10,
              marginBottom: 10,
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => { setMostrarRechazo(false); setMotivoRechazo(""); }}
              disabled={!!actuando}
              style={{
                flex: 1, padding: 14, fontSize: 15,
                background: "transparent",
                color: "var(--pase-text-muted)",
                border: "0.5px solid var(--pase-border)",
                borderRadius: 10, cursor: "pointer",
              }}
            >
              Cancelar
            </button>
            <button
              onClick={() => void rechazar()}
              disabled={!!actuando}
              style={{
                flex: 1, padding: 14, fontSize: 15, fontWeight: 500,
                background: "#EF4444",
                color: "white", border: "none",
                borderRadius: 10, cursor: actuando ? "wait" : "pointer",
              }}
            >
              {actuando === "rechazar" ? "Rechazando…" : "Confirmar rechazo"}
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={() => void aprobar()}
            disabled={!!actuando}
            style={{
              padding: 18, fontSize: 17, fontWeight: 500,
              background: "#2BB673",
              color: "white", border: "none",
              borderRadius: 12, cursor: actuando ? "wait" : "pointer",
            }}
          >
            {actuando === "aprobar" ? "Aprobando…" : "✓ Aprobar"}
          </button>
          <button
            onClick={() => setMostrarRechazo(true)}
            disabled={!!actuando}
            style={{
              padding: 18, fontSize: 17, fontWeight: 500,
              background: "transparent",
              color: "#EF4444",
              border: "0.5px solid #EF4444",
              borderRadius: 12, cursor: "pointer",
            }}
          >
            ✕ Rechazar
          </button>
        </div>
      )}
    </Container>
  );
}

// ─── Sub-componentes ────────────────────────────────────────────────────

function Container({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: 20,
      maxWidth: 500,
      margin: "0 auto",
      minHeight: "calc(100vh - 80px)",
    }}>
      {children}
    </div>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      padding: "8px 0",
      borderBottom: "0.5px solid var(--pase-border)",
    }}>
      <span style={{ fontSize: 13, color: "var(--pase-text-muted)" }}>{label}</span>
      <span style={{
        fontSize: highlight ? 18 : 14,
        fontWeight: highlight ? 600 : 500,
        color: "var(--pase-text)",
        fontVariantNumeric: "tabular-nums",
        textAlign: "right",
        maxWidth: "60%",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}>
        {value}
      </span>
    </div>
  );
}
