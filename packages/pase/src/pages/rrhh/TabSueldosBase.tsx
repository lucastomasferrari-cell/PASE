// ─────────────────────────────────────────────────────────────────────────
// TAB SUELDOS BASE — planilla tipo Excel + aumentos masivos (Lucas 04-jun)
//
//   - 1 fila por empleado activo del local. Sueldo editable inline.
//   - Aumento masivo por % o por monto fijo, a seleccionados o a todos, con
//     redondeo a $100 (toggle). Cae como preview en la columna "Sueldo nuevo".
//   - "Revisar y aplicar" → modal resumen + motivo → RPC atómica
//     cambiar_sueldos_masivo (historial + update en una transacción).
//
// El sueldo_mensual es la base única (mensual/quincenal/semanal derivan de él).
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from "react";
import { db } from "../../lib/supabase";
import { fmt_$ } from "@pase/shared/utils";
import { Modal } from "../../components/ui";
import { translateRpcError } from "../../lib/errors";
import { aplicarAumento, type TipoAumento } from "../../lib/calculos/rrhh";
import { useToast } from "../../hooks/useToast";
import { ToastComponent } from "../../components/Toast";
import type { Local } from "../../types";
import type { Usuario } from "../../types/auth";

interface Emp {
  id: string;
  nombre: string;
  apellido: string;
  puesto: string;
  sueldo_mensual: number;
  modo_pago: "MENSUAL" | "QUINCENAL" | "SEMANAL";
  local_id: number | null;
}

interface Props {
  user: Usuario;
  esEnc: boolean;
  locsDisp: Local[];
  localActivo: number | null;
}

function modoLabel(m: string): string {
  return m === "QUINCENAL" ? "Quincenal" : m === "SEMANAL" ? "Semanal" : "Mensual";
}

export function TabSueldosBase({ user: _user, esEnc, locsDisp, localActivo }: Props) {
  const [localId, setLocalId] = useState<number | null>(localActivo);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- sync prop → state intencional
  useEffect(() => { if (localActivo != null) setLocalId(localActivo); }, [localActivo]);

  const [empleados, setEmpleados] = useState<Emp[]>([]);
  const [loading, setLoading] = useState(true);
  const [nuevos, setNuevos] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { toast, showToast, showError } = useToast();

  // Aumento masivo
  const [tipoAumento, setTipoAumento] = useState<TipoAumento>("pct");
  const [valorAumento, setValorAumento] = useState("");
  const [redondear, setRedondear] = useState(true); // a $100

  // Modal aplicar
  const [revisar, setRevisar] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [guardando, setGuardando] = useState(false);

  const recargar = useCallback(async () => {
    if (!localId) { setEmpleados([]); setNuevos({}); setSelected(new Set()); setLoading(false); return; }
    setLoading(true);
    const { data } = await db.from("rrhh_empleados")
      .select("id, nombre, apellido, puesto, sueldo_mensual, modo_pago, local_id")
      .eq("activo", true).eq("local_id", localId).order("apellido");
    const emps = (data || []) as Emp[];
    setEmpleados(emps);
    setNuevos(Object.fromEntries(emps.map(e => [e.id, String(Math.round(Number(e.sueldo_mensual || 0)))])));
    setSelected(new Set());
    setLoading(false);
  }, [localId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount/change
  useEffect(() => { void recargar(); }, [recargar]);

  const setNuevo = (id: string, v: string) => setNuevos(prev => ({ ...prev, [id]: v }));
  const toggleSel = (id: string) => setSelected(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });
  const allSelected = empleados.length > 0 && selected.size === empleados.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(empleados.map(e => e.id)));

  const aplicarMasivo = () => {
    const v = parseFloat(valorAumento);
    if (!isFinite(v) || v === 0) { showError("Poné un valor de aumento distinto de 0."); return; }
    const targets = selected.size > 0 ? empleados.filter(e => selected.has(e.id)) : empleados;
    setNuevos(prev => {
      const next = { ...prev };
      for (const e of targets) {
        next[e.id] = String(aplicarAumento(Number(e.sueldo_mensual || 0), {
          tipo: tipoAumento, valor: v, redondeo: redondear ? 100 : null,
        }));
      }
      return next;
    });
  };

  const cambios = useMemo(() => empleados
    .map(e => ({
      emp: e,
      actual: Math.round(Number(e.sueldo_mensual || 0)),
      nuevo: Math.round(parseFloat(nuevos[e.id] || "0") || 0),
    }))
    .filter(c => c.nuevo > 0 && c.nuevo !== c.actual), [empleados, nuevos]);

  const masaActual = useMemo(() => empleados.reduce((s, e) => s + Number(e.sueldo_mensual || 0), 0), [empleados]);
  const masaNueva = useMemo(() => empleados.reduce((s, e) => s + (Math.round(parseFloat(nuevos[e.id] || "0") || 0)), 0), [empleados, nuevos]);
  const difMasa = masaNueva - masaActual;

  const confirmarAplicar = async () => {
    if (cambios.length === 0) { showError("No hay cambios para aplicar."); return; }
    setGuardando(true);
    try {
      const { error } = await db.rpc("cambiar_sueldos_masivo", {
        p_cambios: cambios.map(c => ({ emp_id: c.emp.id, nuevo_sueldo: c.nuevo })),
        p_motivo: motivo.trim() || null,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) { showError(translateRpcError(error)); return; }
      showToast(`${cambios.length} sueldo${cambios.length !== 1 ? "s" : ""} actualizado${cambios.length !== 1 ? "s" : ""}`);
      setRevisar(false); setMotivo("");
      await recargar();
    } finally { setGuardando(false); }
  };

  const targetCount = selected.size > 0 ? selected.size : empleados.length;

  return (
    <div>
      {toast && <ToastComponent toast={toast} />}

      {/* Toolbar: local + aumento masivo */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <select className="search" style={{ width: 180 }} value={localId ?? ""} onChange={e => setLocalId(parseInt(e.target.value))}>
          {!esEnc && <option value="">Seleccionar local…</option>}
          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>

        <div style={{ width: 1, height: 24, background: "var(--bd)", margin: "0 2px" }} />

        {/* Aumento masivo */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <select className="search" style={{ width: 110 }} value={tipoAumento} onChange={e => setTipoAumento(e.target.value as TipoAumento)}>
            <option value="pct">Por %</option>
            <option value="fijo">Monto fijo $</option>
          </select>
          <input
            type="number"
            className="search"
            style={{ width: 110 }}
            value={valorAumento}
            onChange={e => setValorAumento(e.target.value)}
            placeholder={tipoAumento === "pct" ? "ej. 30" : "ej. 50000"}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--muted2)", cursor: "pointer" }}>
            <input type="checkbox" checked={redondear} onChange={e => setRedondear(e.target.checked)} />
            Redondear a $100
          </label>
          <button className="btn btn-sec btn-sm" onClick={aplicarMasivo} style={{ padding: "5px 14px" }}>
            Aplicar a {selected.size > 0 ? `seleccionados (${targetCount})` : `todos (${targetCount})`}
          </button>
        </div>
      </div>

      {/* Lista */}
      {!localId ? (
        <div className="alert alert-info">Elegí un local.</div>
      ) : loading ? (
        <div className="loading">Cargando…</div>
      ) : empleados.length === 0 ? (
        <div className="empty">No hay empleados activos en este local</div>
      ) : (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: "34px 1fr 130px 150px 150px",
            gap: 10, padding: "8px 14px", borderBottom: "0.5px solid var(--bd)",
            fontSize: 10, color: "var(--muted)", textTransform: "none", letterSpacing: 0.5, fontWeight: 500,
            alignItems: "center",
          }}>
            <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Seleccionar todos" />
            <span>Empleado</span>
            <span>Modo</span>
            <span style={{ textAlign: "right" }}>Sueldo actual</span>
            <span style={{ textAlign: "right" }}>Sueldo nuevo</span>
          </div>

          {empleados.map(e => {
            const actual = Math.round(Number(e.sueldo_mensual || 0));
            const nuevo = Math.round(parseFloat(nuevos[e.id] || "0") || 0);
            const cambia = nuevo > 0 && nuevo !== actual;
            return (
              <div key={e.id} style={{
                display: "grid", gridTemplateColumns: "34px 1fr 130px 150px 150px",
                gap: 10, padding: "8px 14px", borderTop: "0.5px solid var(--bd)", alignItems: "center",
                background: selected.has(e.id) ? "rgba(34,127,255,0.05)" : "transparent",
              }}>
                <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSel(e.id)} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{e.apellido}, {e.nombre}</div>
                  <div style={{ fontSize: 10, color: "var(--muted2)" }}>{e.puesto}</div>
                </div>
                <span style={{ fontSize: 11, color: "var(--muted2)" }}>{modoLabel(e.modo_pago)}</span>
                <span style={{ textAlign: "right", fontSize: 13, fontVariantNumeric: "tabular-nums", color: "var(--muted2)" }}>
                  {fmt_$(actual)}
                </span>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <input
                    type="number"
                    value={nuevos[e.id] ?? ""}
                    onChange={ev => setNuevo(e.id, ev.target.value)}
                    style={{
                      width: 140, padding: "5px 8px", textAlign: "right", fontSize: 13,
                      fontVariantNumeric: "tabular-nums", borderRadius: 6,
                      background: "var(--bg)", color: cambia ? "var(--acc)" : "var(--text)",
                      border: `1px solid ${cambia ? "var(--acc)" : "var(--bd)"}`,
                      fontWeight: cambia ? 600 : 400, outline: "none",
                    }}
                  />
                </div>
              </div>
            );
          })}

          {/* Footer masa salarial */}
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12,
            padding: "10px 14px", borderTop: "2px solid var(--bd)", background: "var(--s2)",
          }}>
            <div style={{ fontSize: 12, color: "var(--muted2)" }}>
              Masa salarial: <strong style={{ color: "var(--text)" }}>{fmt_$(masaActual)}</strong>
              {" → "}
              <strong style={{ color: difMasa !== 0 ? "var(--acc)" : "var(--text)" }}>{fmt_$(masaNueva)}</strong>
              {difMasa !== 0 && (
                <span style={{ marginLeft: 8, color: difMasa > 0 ? "var(--success)" : "var(--danger)", fontWeight: 500 }}>
                  ({difMasa > 0 ? "+" : "−"}{fmt_$(Math.abs(difMasa))})
                </span>
              )}
            </div>
            <button
              className="btn btn-acc"
              disabled={cambios.length === 0}
              onClick={() => setRevisar(true)}
              title={cambios.length === 0 ? "No hay cambios para aplicar" : ""}
            >
              Revisar y aplicar{cambios.length > 0 ? ` (${cambios.length})` : ""}
            </button>
          </div>
        </div>
      )}

      {/* Modal revisar y aplicar */}
      <Modal
        isOpen={revisar}
        onClose={() => !guardando && setRevisar(false)}
        title="Revisar aumento de sueldos"
        maxWidth={560}
        preventCloseOnOverlay={guardando}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setRevisar(false)} disabled={guardando}>Cancelar</button>
            <button className="btn btn-acc" onClick={confirmarAplicar} disabled={guardando || cambios.length === 0}>
              {guardando ? "Aplicando…" : `Confirmar ${cambios.length} cambio${cambios.length !== 1 ? "s" : ""}`}
            </button>
          </>
        }
      >
        <div style={{
          padding: "10px 12px", background: "var(--s2)", borderRadius: 8, marginBottom: 12,
          display: "flex", justifyContent: "space-between", fontSize: 13,
        }}>
          <span style={{ color: "var(--muted2)" }}>Masa salarial</span>
          <span>
            {fmt_$(masaActual)} → <strong style={{ color: "var(--acc)" }}>{fmt_$(masaNueva)}</strong>
            <span style={{ marginLeft: 6, color: difMasa > 0 ? "var(--success)" : "var(--danger)", fontWeight: 500 }}>
              ({difMasa > 0 ? "+" : "−"}{fmt_$(Math.abs(difMasa))})
            </span>
          </span>
        </div>

        <div style={{ maxHeight: 280, overflowY: "auto", border: "0.5px solid var(--bd)", borderRadius: 8, marginBottom: 12 }}>
          {cambios.map(c => (
            <div key={c.emp.id} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "6px 10px", borderBottom: "0.5px solid var(--bd)", fontSize: 12,
            }}>
              <span>{c.emp.apellido}, {c.emp.nombre}</span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                <span style={{ color: "var(--muted2)" }}>{fmt_$(c.actual)}</span>
                {" → "}
                <strong style={{ color: "var(--acc)" }}>{fmt_$(c.nuevo)}</strong>
              </span>
            </div>
          ))}
        </div>

        <div className="field">
          <label>Motivo (opcional)</label>
          <input value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="Ej: Aumento marzo 2026" />
        </div>
      </Modal>
    </div>
  );
}
