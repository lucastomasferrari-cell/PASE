import { useState, useRef, useEffect, useCallback } from "react";
import { db } from "../lib/supabase";
import { translateRpcError } from "../lib/errors";
import { Modal } from "./ui";

/**
 * Modal de Manager Override — v2 sprint 27-may noche.
 *
 * Cuando un empleado intenta una acción que no tiene autorizada, este modal
 * le ofrece DOS caminos:
 *
 *   1. **Solicitar al dueño** (recomendado, default). Click → se crea
 *      una solicitud en DB + push al celu del dueño. El modal queda en
 *      polling cada 3s. Cuando el dueño aprueba, se obtiene un token
 *      que se pasa como `p_override_code` a la RPC final.
 *
 *   2. **Tengo el código** (fallback). El dueño se lo dictó por teléfono
 *      o lo ve en /ajustes/codigos-manager. Modal vieja: tipea 6 dígitos
 *      → precheck → si OK, retorna el código como override.
 *
 * Ambos terminan en `onValidated(token_o_codigo)`. El caller usa ese
 * string como `p_override_code` en la RPC final (anular_factura, etc.).
 * La RPC server-side acepta tanto UUID (36 chars) como TOTP (6 dígitos)
 * vía `auth_tiene_permiso_o_override` (migration 202605270500).
 */

type Tab = "solicitar" | "codigo";
type EstadoSolicitud =
  | { tipo: "form" }                         // antes de pedir
  | { tipo: "esperando"; solicitudId: number }  // polling
  | { tipo: "rechazada"; motivo: string | null };

interface Props {
  open: boolean;
  /** Slug del permiso requerido para la acción (ej "compras_anular"). */
  permiso: string;
  /** Slug de la acción (ej "anular_factura"). Coincide con `p_accion` de la RPC. */
  accion: string;
  /** Datos visuales para mostrarle al dueño en la pantalla de aprobación. */
  context?: Record<string, unknown>;
  /** Descripción humana de qué se está autorizando. Aparece arriba. */
  descripcion?: string;
  /** Callback con el token o código validado. El caller debe pasarlo a la RPC final. */
  onValidated: (codigoOToken: string) => void;
  onClose: () => void;
}

const POLLING_INTERVAL_MS = 3000;

export function ManagerOverrideModal({
  open, permiso, accion, context, descripcion, onValidated, onClose,
}: Props) {
  // `permiso` no se usa hoy en el frontend (la RPC valida); se mantiene en la
  // firma para que el caller siempre lo pase y quede explícito en el código.
  void permiso;

  const [tab, setTab] = useState<Tab>("solicitar");
  const [estado, setEstado] = useState<EstadoSolicitud>({ tipo: "form" });
  const [motivo, setMotivo] = useState("");
  const [creandoSolicitud, setCreandoSolicitud] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Estado del flow "Tengo el código" (legacy).
  const [codigo, setCodigo] = useState("");
  const [validando, setValidando] = useState(false);
  const codigoInputRef = useRef<HTMLInputElement>(null);

  // Reset al abrir.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- patrón reset por prop.
      setTab("solicitar");
      setEstado({ tipo: "form" });
      setMotivo("");
      setCodigo("");
      setErr(null);
    }
  }, [open]);

  // Focus el input de código cuando se cambia a esa tab.
  useEffect(() => {
    if (open && tab === "codigo") {
      setTimeout(() => codigoInputRef.current?.focus(), 50);
    }
  }, [tab, open]);

  // ─── Flow A: Solicitar al dueño ─────────────────────────────────────
  const crearSolicitud = async () => {
    setCreandoSolicitud(true);
    setErr(null);
    const ctxConMotivo = motivo.trim()
      ? { ...(context || {}), motivo: motivo.trim() }
      : context;
    const { data, error } = await db.rpc("fn_solicitar_autorizacion", {
      p_accion: accion,
      p_context: ctxConMotivo,
    });
    setCreandoSolicitud(false);
    if (error) {
      setErr(translateRpcError(error));
      return;
    }
    const solicitudId = Number(data);
    setEstado({ tipo: "esperando", solicitudId });
  };

  // Polling cada 3s mientras estamos esperando aprobación.
  const consultarSolicitud = useCallback(async (id: number) => {
    const { data, error } = await db.rpc("fn_consultar_solicitud", { p_id: id });
    if (error) return; // silencioso — reintenta el próximo tick
    const row = (data as Array<{ estado: string; token: string | null; rechazo_motivo: string | null }> | null)?.[0];
    if (!row) return;
    if (row.estado === "aprobada" && row.token) {
      // ¡Aprobado! Pasamos el token al caller y cerramos.
      onValidated(row.token);
    } else if (row.estado === "rechazada") {
      setEstado({ tipo: "rechazada", motivo: row.rechazo_motivo });
    } else if (row.estado === "expirada") {
      setErr("La solicitud expiró (1 hora). Probá de nuevo.");
      setEstado({ tipo: "form" });
    }
  }, [onValidated]);

  useEffect(() => {
    if (estado.tipo !== "esperando") return;
    const id = estado.solicitudId;
    // Consulta inmediata + cada POLLING_INTERVAL_MS.
    const tick = () => { void consultarSolicitud(id); };
    tick();
    const interval = setInterval(tick, POLLING_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [estado, consultarSolicitud]);

  // ─── Flow B: Tengo el código (TOTP fallback) ────────────────────────
  const validarCodigo = async () => {
    if (codigo.length !== 6 || !/^[0-9]{6}$/.test(codigo)) {
      setErr("Tipeá los 6 dígitos.");
      return;
    }
    setValidando(true);
    setErr(null);
    const { error } = await db.rpc("precheck_manager_override", { p_codigo: codigo });
    setValidando(false);
    if (error) {
      setErr(translateRpcError(error));
      setCodigo("");
      setTimeout(() => codigoInputRef.current?.focus(), 50);
      return;
    }
    onValidated(codigo);
  };

  // AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido.
  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Autorización del dueño"
      maxWidth={460}
      preventCloseOnOverlay={creandoSolicitud || validando}
      footer={
        <>
          <button className="btn btn-sec" onClick={onClose} disabled={creandoSolicitud || validando}>
            {estado.tipo === "form" ? "Cancelar" : "Cerrar"}
          </button>
          {estado.tipo === "form" && tab === "solicitar" && (
            <button
              className="btn btn-acc"
              onClick={() => void crearSolicitud()}
              disabled={creandoSolicitud}
            >
              {creandoSolicitud ? "Enviando…" : "Pedir autorización"}
            </button>
          )}
          {estado.tipo === "form" && tab === "codigo" && (
            <button
              className="btn btn-acc"
              onClick={() => void validarCodigo()}
              disabled={validando || codigo.length !== 6}
            >
              {validando ? "Validando…" : "Autorizar"}
            </button>
          )}
        </>
      }
    >
          {descripcion && (
            <p style={{
              fontSize: "var(--pase-fs-sm)",
              color: "var(--pase-text-muted)",
              marginTop: 0, marginBottom: 14,
              lineHeight: 1.4,
            }}>
              {descripcion}
            </p>
          )}

          {/* Tabs solo cuando estamos en form */}
          {estado.tipo === "form" && (
            <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "0.5px solid var(--pase-border)" }}>
              <TabBtn active={tab === "solicitar"} onClick={() => setTab("solicitar")}>
                📲 Pedirle al dueño
              </TabBtn>
              <TabBtn active={tab === "codigo"} onClick={() => setTab("codigo")}>
                🔢 Tengo el código
              </TabBtn>
            </div>
          )}

          {err && (
            <div className="alert alert-danger" style={{ marginBottom: 12, fontSize: 13 }}>
              {err}
            </div>
          )}

          {/* ─── Estado: esperando aprobación ─── */}
          {estado.tipo === "esperando" && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>📲</div>
              <p style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 500, color: "var(--pase-text)" }}>
                Solicitud enviada al dueño
              </p>
              <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--pase-text-muted)" }}>
                Le llegó una notificación al celular.<br />
                Esperando respuesta…
              </p>
              <div style={{
                display: "inline-block",
                width: 24, height: 24,
                border: "3px solid var(--pase-border)",
                borderTopColor: "var(--pase-celeste)",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }} />
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              <p style={{ margin: "16px 0 0", fontSize: 11, color: "var(--pase-text-muted)" }}>
                Si tardás mucho, podés cerrar y volver a intentar después.<br />
                La solicitud expira en 1 hora.
              </p>
            </div>
          )}

          {/* ─── Estado: rechazada ─── */}
          {estado.tipo === "rechazada" && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ fontSize: 48, marginBottom: 12 }}>🚫</div>
              <p style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 500, color: "#EF4444" }}>
                El dueño rechazó la solicitud
              </p>
              {estado.motivo && (
                <p style={{
                  margin: "12px 0 0", fontSize: 13,
                  color: "var(--pase-text)",
                  padding: 12,
                  background: "var(--pase-bg-soft)",
                  borderRadius: 8,
                  fontStyle: "italic",
                }}>
                  "{estado.motivo}"
                </p>
              )}
            </div>
          )}

          {/* ─── Form: pestaña Solicitar ─── */}
          {estado.tipo === "form" && tab === "solicitar" && (
            <>
              <p style={{ fontSize: 13, color: "var(--pase-text-muted)", margin: "0 0 10px" }}>
                Le llega una notificación al celular del dueño. Cuando apruebe, esta pantalla continúa solo.
              </p>
              <label style={{ fontSize: 12, color: "var(--pase-text-muted)", display: "block", marginBottom: 4 }}>
                Motivo (opcional, ayuda al dueño a decidir):
              </label>
              <textarea
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                placeholder="ej: factura duplicada por error del lector IA"
                rows={3}
                style={{
                  width: "100%", padding: 10, fontSize: 14,
                  background: "var(--pase-bg-soft)",
                  color: "var(--pase-text)",
                  border: "0.5px solid var(--pase-border)",
                  borderRadius: 8,
                  fontFamily: "inherit",
                  resize: "vertical",
                  marginBottom: 12,
                }}
              />
            </>
          )}

          {/* ─── Form: pestaña Código ─── */}
          {estado.tipo === "form" && tab === "codigo" && (
            <>
              <p style={{ fontSize: 13, color: "var(--pase-text-muted)", margin: "0 0 10px" }}>
                Pedile al dueño el código de 6 dígitos (lo ve en <em>Ajustes → Códigos Manager</em>).
              </p>
              <input
                ref={codigoInputRef}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={codigo}
                onChange={e => setCodigo(e.target.value.replace(/[^0-9]/g, ""))}
                onKeyDown={e => { if (e.key === "Enter") void validarCodigo(); }}
                placeholder="000000"
                autoComplete="one-time-code"
                style={{
                  width: "100%",
                  fontSize: 32,
                  textAlign: "center",
                  letterSpacing: "0.3em",
                  fontFamily: "var(--pase-font-mono, monospace)",
                  padding: "12px 8px",
                  border: "0.5px solid var(--pase-border)",
                  borderRadius: 8,
                  background: "var(--pase-bg-soft)",
                  color: "var(--pase-text)",
                  fontVariantNumeric: "tabular-nums",
                }}
              />
              <p style={{
                fontSize: 11, color: "var(--pase-text-muted)",
                marginTop: 10, marginBottom: 0, textAlign: "center",
              }}>
                El código cambia cada 30 segundos. Una vez usado, no sirve de nuevo.
              </p>
            </>
          )}
    </Modal>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "10px 8px",
        fontSize: 13,
        fontWeight: active ? 600 : 400,
        color: active ? "var(--pase-celeste)" : "var(--pase-text-muted)",
        background: "transparent",
        border: "none",
        borderBottom: active ? "2px solid var(--pase-celeste)" : "2px solid transparent",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}
