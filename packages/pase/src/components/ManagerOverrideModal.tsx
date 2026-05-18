import { useState, useRef, useEffect } from "react";
import { db } from "../lib/supabase";
import { translateRpcError } from "../lib/errors";

/**
 * Modal de Manager Override.
 *
 * Cuando un empleado intenta una acción que no tiene autorizada, el caller
 * abre este modal en vez de bloquear directo. El empleado tipea un código de
 * 6 dígitos que el dueño le dicta (ver pantalla /ajustes/codigos-manager).
 *
 * Flow:
 *   1. Modal pre-chequea el código via precheck_manager_override (sin consumir).
 *   2. Si OK, llama `onValidated(codigo)` con el código tipeado.
 *   3. El caller usa ese código como p_override_code al llamar la RPC final
 *      (anular_factura, anular_gasto, etc.). El consumo del código sucede
 *      atómicamente en esa RPC vía auth_tiene_permiso_o_override.
 *
 * Si el código es inválido o ya fue usado, muestra error en línea y deja
 * tipear de nuevo. Si dos empleados validan el mismo código en paralelo,
 * ambos pasan el pre-chequeo pero solo el primero en ejecutar la acción
 * gana — el segundo recibe CODIGO_YA_USADO al llamar la RPC.
 *
 * Diseño 2026-05-18.
 */

interface Props {
  open: boolean;
  /** Descripción humana de qué se está autorizando. Aparece arriba del input. */
  descripcion?: string;
  /** Callback con el código validado. El caller debe pasarlo a la RPC final. */
  onValidated: (codigo: string) => void;
  onClose: () => void;
}

export function ManagerOverrideModal({ open, descripcion, onValidated, onClose }: Props) {
  const [codigo, setCodigo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset al abrir el modal, patron correcto (sync de estado interno con prop `open`).
      setCodigo("");
      setErr(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  async function handleValidar() {
    if (codigo.length !== 6 || !/^[0-9]{6}$/.test(codigo)) {
      setErr("Tipeá los 6 dígitos.");
      return;
    }
    setValidating(true);
    setErr(null);
    const { error } = await db.rpc("precheck_manager_override", { p_codigo: codigo });
    setValidating(false);
    if (error) {
      setErr(translateRpcError(error));
      setCodigo("");
      setTimeout(() => inputRef.current?.focus(), 50);
      return;
    }
    onValidated(codigo);
  }

  if (!open) return null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 420 }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <div className="modal-title">Autorización del dueño</div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{
            fontSize: "var(--pase-fs-sm)",
            color: "var(--pase-text-muted)",
            marginTop: 0,
            marginBottom: 16,
            lineHeight: 1.5,
          }}>
            {descripcion ?? "Esta acción requiere autorización del dueño."}<br />
            Pedile el código de 6 dígitos al dueño y tipealo abajo.
          </p>

          {err && (
            <div className="alert alert-danger" style={{ marginBottom: 12, fontSize: "var(--pase-fs-sm)" }}>
              {err}
            </div>
          )}

          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={codigo}
            onChange={e => setCodigo(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={e => { if (e.key === "Enter") void handleValidar(); }}
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
            fontSize: "var(--pase-fs-xs)",
            color: "var(--pase-text-muted)",
            marginTop: 12,
            marginBottom: 0,
            textAlign: "center",
          }}>
            El código cambia cada 30 segundos. Una vez usado, no sirve de nuevo.
          </p>
        </div>
        <div className="modal-ft">
          <button className="btn btn-sec" onClick={onClose} disabled={validating}>
            Cancelar
          </button>
          <button
            className="btn btn-acc"
            onClick={handleValidar}
            disabled={validating || codigo.length !== 6}
          >
            {validating ? "Validando…" : "Autorizar"}
          </button>
        </div>
      </div>
    </div>
  );
}
