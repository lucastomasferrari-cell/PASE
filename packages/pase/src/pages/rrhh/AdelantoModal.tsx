// AdelantoModal — modal para cargar un adelanto al empleado.
// Vive en RRHH.tsx (nivel padre) para que sea accesible desde cualquier
// tab (Novedades, Pagos, Empleados). Antes vivía dentro de TabPagos —
// con eso era inaccesible cuando el usuario estaba en otro tab.

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
}

export function AdelantoModal({
  open, onClose, allEmps, filtroLocalId,
  adelForm, setAdelForm, cuentasUsables, guardarAdelanto, guardando,
}: Props) {
  if (!open) return null;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <div className="modal-title">Adelanto a empleado</div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Empleado</label>
            <select
              value={adelForm.empleado_id}
              onChange={(e) => setAdelForm({ ...adelForm, empleado_id: e.target.value })}
            >
              <option value="">Seleccionar...</option>
              {(allEmps || [])
                .filter((e) => e.activo !== false)
                .filter((e) => filtroLocalId == null || e.local_id === filtroLocalId)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.apellido}, {e.nombre}
                  </option>
                ))}
            </select>
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
          <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4 }}>
            Se registra como movimiento (cat SUELDOS), afecta saldos de caja y queda como adelanto descontable a futuro.
          </div>
        </div>
        <div className="modal-ft">
          <button className="btn btn-sec" onClick={onClose} disabled={guardando}>Cancelar</button>
          <button
            className="btn btn-acc"
            onClick={guardarAdelanto}
            disabled={guardando || !adelForm.empleado_id || !adelForm.monto || parseFloat(adelForm.monto) <= 0}
          >
            {guardando ? "Registrando…" : "Registrar adelanto"}
          </button>
        </div>
      </div>
    </div>
  );
}
