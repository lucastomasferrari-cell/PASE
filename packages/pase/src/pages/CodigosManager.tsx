import { useEffect, useState, useCallback } from "react";
import { db } from "../lib/supabase";
import { PageHeader, InfoTooltip } from "../components/ui";
import { translateRpcError } from "../lib/errors";
import { fmt_dt_ar } from "@pase/shared/utils";
import { SolicitudesContent } from "./Solicitudes";
import type { Usuario } from "../types";

type Tab = "codigo" | "solicitudes";

/**
 * Códigos Manager — pantalla para el dueño/admin.
 *
 * Muestra el código TOTP actual + countdown 30s. Cuando un empleado pide
 * autorización para algo (anular venta, descuento grande, etc.), el dueño
 * abre esta pantalla, le dicta el código que está visible, y el empleado
 * lo tipea en el modal de override.
 *
 * Cada código rota cada 30s. Tolerancia ±30s en el server (ventana de 60s
 * útil real). UNA sola vez por code window (anti-reuse).
 *
 * Diseño 2026-05-18 (pedido Lucas).
 */

interface CodigoTOTP {
  codigo: string;
  segundos_restantes: number;
  time_step: number;
}

interface UsoOverride {
  id: number;
  usuario_id: number;
  accion: string;
  context: Record<string, unknown> | null;
  time_step: number;
  usado_at: string;
}

interface UsuarioInfo {
  id: number;
  nombre: string;
}

interface Props {
  user: Usuario;
}

export default function CodigosManager({ user }: Props) {
  const [tab, setTab] = useState<Tab>("solicitudes");
  const [actual, setActual] = useState<CodigoTOTP | null>(null);
  const [usos, setUsos] = useState<UsoOverride[]>([]);
  const [usuarios, setUsuarios] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [showConfirmRegen, setShowConfirmRegen] = useState(false);

  const cargarCodigo = useCallback(async () => {
    const { data, error } = await db.rpc("obtener_codigo_totp_actual");
    if (error) {
      setErr(translateRpcError(error));
      setActual(null);
      return;
    }
    // RPC RETURNS TABLE → data es un array de 1 fila.
    const row = Array.isArray(data) ? data[0] : data;
    if (row) {
      setActual({
        codigo: row.codigo,
        segundos_restantes: row.segundos_restantes,
        time_step: Number(row.time_step),
      });
      setErr(null);
    }
  }, []);

  const cargarUsos = useCallback(async () => {
    if (!user.tenant_id) return;
    const { data, error } = await db
      .from("manager_override_usos")
      .select("id, usuario_id, accion, context, time_step, usado_at")
      .eq("tenant_id", user.tenant_id)
      .order("usado_at", { ascending: false })
      .limit(20);
    if (!error && data) setUsos(data as UsoOverride[]);
  }, [user.tenant_id]);

  const cargarUsuarios = useCallback(async () => {
    const { data } = await db.from("usuarios").select("id, nombre");
    if (data) {
      const map = new Map<number, string>();
      for (const u of data as UsuarioInfo[]) map.set(u.id, u.nombre);
      setUsuarios(map);
    }
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps --
     carga inicial UNA vez al mount. Las funciones cargar* hacen setState al
     resolverse pero eso es lo que queremos (sync con DB). Re-cargas posteriores
     se manejan en el otro effect (poll cada segundo). */
  useEffect(() => {
    void cargarCodigo();
    void cargarUsos();
    void cargarUsuarios();
    setLoading(false);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  // Poll cada segundo para countdown + re-fetch del código cuando llega a 0.
  useEffect(() => {
    if (!actual) return;
    const id = setInterval(() => {
      setActual(prev => {
        if (!prev) return prev;
        if (prev.segundos_restantes <= 1) {
          // Llegamos a 0 — re-fetcheamos el nuevo código.
          void cargarCodigo();
          void cargarUsos(); // por si hubo un uso reciente
          return prev;
        }
        return { ...prev, segundos_restantes: prev.segundos_restantes - 1 };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [actual, cargarCodigo, cargarUsos]);

  async function handleRegenerar() {
    setRegenerating(true);
    setErr(null);
    const { error } = await db.rpc("generar_tenant_totp_secret");
    setRegenerating(false);
    setShowConfirmRegen(false);
    if (error) {
      setErr(translateRpcError(error));
      return;
    }
    await cargarCodigo();
  }

  if (loading) {
    return <div style={{ padding: 40, color: "var(--pase-text-muted)" }}>Cargando…</div>;
  }

  return (
    <div style={{ padding: "0 20px", maxWidth: 900 }}>
      <PageHeader
        title="Autorizaciones"
        subtitle="solicitudes pendientes + códigos de autorización"
        info={<>
          Cuando un empleado quiere hacer algo que no tiene autorización (anular una venta,
          descuentos grandes, etc.), tenés 2 caminos:<br /><br />
          <strong>1. Solicitud (recomendado):</strong> el empleado pide desde su pantalla, te
          llega al celu con el detalle, aprobás/rechazás con un click.<br />
          <strong>2. Código rotativo:</strong> le dictás un código de 6 dígitos que cambia
          cada 30s. Útil cuando no estás online o no tenés notificaciones.<br /><br />
          Tu password de dueño sigue funcionando como siempre.
        </>}
      />

      {/* Tabs */}
      <div style={{
        display: "flex", gap: 4, marginBottom: 18,
        borderBottom: "1px solid var(--pase-border)",
      }}>
        <TabBtn active={tab === "solicitudes"} onClick={() => setTab("solicitudes")}>
          📲 Solicitudes
        </TabBtn>
        <TabBtn active={tab === "codigo"} onClick={() => setTab("codigo")}>
          🔢 Código rotativo
        </TabBtn>
      </div>

      {tab === "solicitudes" && <SolicitudesContent user={user} withHeader={false} />}

      {tab === "codigo" && (
        <CodigoTab
          actual={actual}
          usos={usos}
          usuarios={usuarios}
          err={err}
          regenerating={regenerating}
          showConfirmRegen={showConfirmRegen}
          setShowConfirmRegen={setShowConfirmRegen}
          handleRegenerar={handleRegenerar}
        />
      )}
    </div>
  );
}

// ─── Sub-componente: tab del código rotativo ────────────────────────────
// Extraído del original CodigosManager para que los 2 tabs coexistan.
interface CodigoTabProps {
  actual: CodigoTOTP | null;
  usos: UsoOverride[];
  usuarios: Map<number, string>;
  err: string | null;
  regenerating: boolean;
  showConfirmRegen: boolean;
  setShowConfirmRegen: (v: boolean) => void;
  handleRegenerar: () => Promise<void>;
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "10px 16px",
        fontSize: 14,
        fontWeight: active ? 600 : 400,
        color: active ? "var(--pase-celeste)" : "var(--pase-text-muted)",
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid var(--pase-celeste)" : "2px solid transparent",
        cursor: "pointer",
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}

function CodigoTab({ actual, usos, usuarios, err, regenerating, showConfirmRegen, setShowConfirmRegen, handleRegenerar }: CodigoTabProps) {
  return (
    <div>
      {err && (
        <div className="alert alert-danger" style={{ marginBottom: 16 }}>{err}</div>
      )}

      {/* Card del código actual */}
      {actual && (
        <div style={{
          background: "var(--pase-bg-soft)",
          border: "0.5px solid var(--pase-border)",
          borderRadius: 12,
          padding: 32,
          textAlign: "center",
          marginBottom: 20,
        }}>
          <div style={{
            fontSize: "var(--pase-fs-xs)",
            color: "var(--pase-text-muted)",
            textTransform: "uppercase",
            letterSpacing: "var(--pase-ls-overline)",
            marginBottom: 12,
          }}>
            Código actual
          </div>
          <div style={{
            fontSize: 56,
            fontWeight: 600,
            letterSpacing: "0.15em",
            fontVariantNumeric: "tabular-nums",
            fontFamily: "var(--pase-font-mono, monospace)",
            color: "var(--pase-text)",
            marginBottom: 16,
          }}>
            {actual.codigo.slice(0, 3)} {actual.codigo.slice(3)}
          </div>

          {/* Barra de progreso del countdown */}
          <div style={{
            height: 4,
            background: "rgba(117, 170, 219, 0.15)",
            borderRadius: 999,
            overflow: "hidden",
            marginBottom: 8,
          }}>
            <div style={{
              height: "100%",
              width: `${(actual.segundos_restantes / 30) * 100}%`,
              background: actual.segundos_restantes > 5 ? "var(--pase-celeste)" : "#DC2626",
              borderRadius: 999,
              transition: "width 1s linear, background 0.2s",
            }} />
          </div>
          <div style={{
            fontSize: "var(--pase-fs-sm)",
            color: actual.segundos_restantes > 5 ? "var(--pase-text-muted)" : "#DC2626",
          }}>
            {actual.segundos_restantes}s restantes
          </div>
        </div>
      )}

      {/* Botón regenerar */}
      <div style={{ marginBottom: 24 }}>
        {!showConfirmRegen ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setShowConfirmRegen(true)}
            style={{ fontSize: "var(--pase-fs-sm)" }}
          >
            Regenerar secret
          </button>
        ) : (
          <div style={{
            background: "rgba(220, 38, 38, 0.08)",
            border: "0.5px solid rgba(220, 38, 38, 0.25)",
            borderRadius: 8,
            padding: 12,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}>
            <span style={{ fontSize: "var(--pase-fs-sm)", color: "#FCA5A5", flex: 1 }}>
              ¿Seguro? Cualquier código que tengas dictado en este momento dejará de servir.
            </span>
            <button
              type="button"
              className="btn btn-sec btn-sm"
              onClick={() => setShowConfirmRegen(false)}
              disabled={regenerating}
            >
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-acc btn-sm"
              onClick={handleRegenerar}
              disabled={regenerating}
            >
              {regenerating ? "Regenerando…" : "Sí, regenerar"}
            </button>
          </div>
        )}
      </div>

      {/* Log de últimos usos */}
      <div>
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: "var(--pase-fs-xs)",
          color: "var(--pase-text-muted)",
          textTransform: "uppercase",
          letterSpacing: "var(--pase-ls-overline)",
          marginBottom: 12,
        }}>
          <span>Últimos overrides usados</span>
          <InfoTooltip maxWidth={280}>
            Cada vez que un empleado tipea un código válido queda registrado acá con la acción,
            el usuario y el momento. Auditoría completa.
          </InfoTooltip>
        </div>

        {usos.length === 0 ? (
          <div style={{
            padding: 16,
            background: "var(--pase-bg-soft)",
            border: "0.5px solid var(--pase-border)",
            borderRadius: 8,
            textAlign: "center",
            color: "var(--pase-text-muted)",
            fontSize: "var(--pase-fs-sm)",
          }}>
            Sin overrides usados todavía.
          </div>
        ) : (
          <div className="panel">
            <table>
              <thead>
                <tr>
                  <th>Cuándo</th>
                  <th>Empleado</th>
                  <th>Acción</th>
                  <th>Contexto</th>
                </tr>
              </thead>
              <tbody>
                {usos.map(u => (
                  <tr key={u.id}>
                    <td style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", whiteSpace: "nowrap" }}>
                      {fmt_dt_ar(u.usado_at)}
                    </td>
                    <td style={{ fontWeight: 500 }}>
                      {usuarios.get(u.usuario_id) ?? `#${u.usuario_id}`}
                    </td>
                    <td>{u.accion}</td>
                    <td style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
                      {u.context ? JSON.stringify(u.context).slice(0, 80) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
