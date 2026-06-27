// AdelantoModal — modal para cargar un adelanto al empleado.
// Vive en RRHH.tsx (nivel padre) para que sea accesible desde cualquier
// tab (Novedades, Pagos, Empleados). Antes vivía dentro de TabPagos —
// con eso era inaccesible cuando el usuario estaba en otro tab.
//
// AUDIT F4B#1 / sprint #5 post-audit grande: migrado de overlay manual a
// <Modal> compartido. Beneficios: focus trap, Escape para cerrar,
// body-scroll lock, role=dialog + aria-modal automáticos.

import { Modal } from "../../components/ui";
import type { Empleado } from "../../types/rrhh";
import type { AdelantoForm } from "./types";

interface Props {
  open: boolean;
  onClose: () => void;
  allEmps: Empleado[];
  /** Local activo para filtrar el dropdown de empleados. null = todos. */
  filtroLocalId: number | null;
  adelForm: AdelantoForm;
  setAdelForm: React.Dispatch<React.SetStateAction<AdelantoForm>>;
  cuentasUsables: string[];
  guardarAdelanto: () => Promise<void | undefined>;
  guardando: boolean;
  /** Empleados adicionales para mergear con allEmps. Cubre el caso del
   *  modal abierto desde TabNovedades con novLocal distinto del sidebar. */
  empleadosExtra?: Empleado[];
}

export function AdelantoModal({
  open, onClose, allEmps, filtroLocalId,
  adelForm, setAdelForm, cuentasUsables, guardarAdelanto, guardando,
  empleadosExtra,
}: Props) {
  // Merge allEmps + empleadosExtra (dedupe por id). Sin esto, abrir el
  // modal desde una card del tab Novedades cuando allEmps está filtrado
  // por sidebar dejaba el dropdown vacío (bug Lucas 2026-05-19).
  const empleadosVisibles = (() => {
    const map = new Map<string, Empleado>();
    for (const e of allEmps || []) map.set(String(e.id), e);
    for (const e of empleadosExtra || []) {
      if (!map.has(String(e.id))) map.set(String(e.id), e);
    }
    let list = Array.from(map.values()).filter((e) => e.activo !== false);
    if (filtroLocalId != null && !adelForm.empleado_id) {
      list = list.filter((e) => e.local_id === filtroLocalId);
    }
    if (adelForm.empleado_id && !list.some((e) => String(e.id) === String(adelForm.empleado_id))) {
      const fromAny = (empleadosExtra || []).find((e) => String(e.id) === String(adelForm.empleado_id))
                   ?? (allEmps || []).find((e) => String(e.id) === String(adelForm.empleado_id));
      if (fromAny) list = [fromAny, ...list];
    }
    return list.sort((a, b) => a.apellido.localeCompare(b.apellido));
  })();

  const empPreSeleccionado = adelForm.empleado_id
    ? empleadosVisibles.find((e) => String(e.id) === String(adelForm.empleado_id))
    : undefined;

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title="Adelanto a empleado"
      maxWidth={480}
      preventCloseOnOverlay={guardando}
      footer={
        <>
          <button className="btn btn-sec" onClick={onClose} disabled={guardando}>Cancelar</button>
          <button
            className="btn btn-acc"
            onClick={guardarAdelanto}
            disabled={guardando || !adelForm.empleado_id || !adelForm.monto || parseFloat(adelForm.monto) <= 0}
          >
            {guardando ? "Registrando…" : "Registrar adelanto"}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Empleado</label>
        {empPreSeleccionado ? (
          // Pre-seleccionado (vino del botón "+ Adelanto" en una card):
          // mostramos chip readonly con opción de "Cambiar". Más claro
          // que un dropdown lleno donde no se sabe cuál está elegido.
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            padding: "8px 10px", background: "var(--s2)",
            border: "0.5px solid var(--bd)", borderRadius: "var(--r)",
            fontSize: 13,
          }}>
            <span style={{ fontWeight: 500 }}>
              {empPreSeleccionado.apellido}, {empPreSeleccionado.nombre}
            </span>
            <button
              type="button"
              onClick={() => setAdelForm({ ...adelForm, empleado_id: "" })}
              style={{
                marginLeft: "auto", padding: "2px 8px", fontSize: 10,
                background: "transparent", border: "0.5px solid var(--bd)",
                borderRadius: "var(--r)", color: "var(--muted2)", cursor: "pointer",
              }}
              title="Elegir otro empleado"
            >
              Cambiar
            </button>
          </div>
        ) : (
          <select
            value={adelForm.empleado_id}
            onChange={(e) => setAdelForm({ ...adelForm, empleado_id: e.target.value })}
          >
            <option value="">Seleccionar...</option>
            {empleadosVisibles.map((e) => (
              <option key={e.id} value={e.id}>
                {e.apellido}, {e.nombre}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="form2">
        <div className="field">
          <label>Monto $</label>
          <input
            type="number"
            value={adelForm.monto}
            onChange={(e) => setAdelForm({ ...adelForm, monto: e.target.value })}
            placeholder="0"
          />
        </div>
        <div className="field">
          <label>Fecha</label>
          <input
            type="date"
            value={adelForm.fecha}
            onChange={(e) => setAdelForm({ ...adelForm, fecha: e.target.value })}
          />
        </div>
      </div>
      <div className="field">
        <label>Cuenta de egreso</label>
        <select
          value={adelForm.cuenta}
          onChange={(e) => setAdelForm({ ...adelForm, cuenta: e.target.value })}
        >
          <option value="">Seleccioná una cuenta…</option>
          {cuentasUsables.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Descripción (opcional)</label>
        <input
          value={adelForm.descripcion}
          onChange={(e) => setAdelForm({ ...adelForm, descripcion: e.target.value })}
          placeholder="Ej: Adelanto solicitado por urgencia..."
        />
      </div>
      {/* Saldo flexible (Lucas 2026-05-30): si destildado, el adelanto queda
          como "saldo a favor del empleador" y NO se descuenta automáticamente
          en el próximo pago. Sirve para casos como: el empleado pide $X a fin
          de mes, pero queremos descontarlo en la próxima quincena (no en
          la actual que ya está cerrando). En el modal de pago aparece
          como un checkbox extra que Anto puede tildar manualmente. */}
      <div className="field" style={{ marginTop: 6 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none" }}>
          <input
            type="checkbox"
            checked={adelForm.auto_aplicar !== false}
            onChange={(e) => setAdelForm({ ...adelForm, auto_aplicar: e.target.checked })}
            style={{ cursor: "pointer" }}
          />
          <span style={{ fontSize: 12 }}>
            Descontar automáticamente en el próximo sueldo
          </span>
        </label>
        <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4, paddingLeft: 24 }}>
          {adelForm.auto_aplicar !== false
            ? "Default: viene pre-tildado en el modal de pago para descontarlo."
            : "Quedará como saldo pendiente — solo se descuenta si lo tildás manualmente al pagar."}
        </div>
      </div>
      <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 8 }}>
        Se registra como movimiento (cat SUELDOS), afecta saldos de caja y queda como adelanto descontable a futuro.
      </div>
    </Modal>
  );
}
