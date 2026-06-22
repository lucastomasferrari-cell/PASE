// AguinaldoModal — pago masivo de aguinaldos (Lucas 22-jun).
// Lista los empleados activos del local activo con su aguinaldo = sueldo
// mensual / 2 (editable), permite tildar a quiénes pagar, elegir UNA cuenta de
// egreso + la fecha, y paga cada uno con la RPC atómica `pagar_aguinaldo`
// (descuenta de la caja + queda en los movimientos del empleado).
// Marca los que YA cobraron aguinaldo este semestre para no pagar dos veces.

import { useState, useEffect } from "react";
import { Modal } from "../../components/ui";
import { db } from "../../lib/supabase";
import { translateRpcError } from "../../lib/errors";
import { toISO } from "@pase/shared/utils";
import { today } from "../../lib/utils";
import type { Empleado } from "../../types/rrhh";

interface Props {
  onClose: () => void;
  /** Empleados ACTIVOS del local activo (ya scopeados por applyLocalScope). */
  empleados: Empleado[];
  cuentasUsables: string[];
  localNombre: string;
  showToast: (m: string) => void;
  showError: (m: string) => void;
  /** Se llama después de pagar (para refrescar dashboard/pagos si hace falta). */
  onPagado: () => void;
}

const fmt$ = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");

// El modal se monta sólo cuando se abre (render condicional en RRHH), así el
// estado arranca fresco cada vez: aguinaldo = sueldo/2, todos tildados.
export function AguinaldoModal({
  onClose, empleados, cuentasUsables, localNombre, showToast, showError, onPagado,
}: Props) {
  const [cuenta, setCuenta] = useState("");
  const [fecha, setFecha] = useState(toISO(today));
  const [montos, setMontos] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const e of empleados) m[e.id] = String(Math.round((e.sueldo_mensual || 0) / 2));
    return m;
  });
  const [incluir, setIncluir] = useState<Record<string, boolean>>(() => {
    const inc: Record<string, boolean> = {};
    for (const e of empleados) inc[e.id] = true;
    return inc;
  });
  const [yaPagado, setYaPagado] = useState<Set<string>>(new Set());
  const [pagando, setPagando] = useState(false);
  const [resultado, setResultado] = useState<{ ok: string[]; fail: { nombre: string; error: string }[] } | null>(null);

  // Detectar quién ya cobró aguinaldo este semestre (para destildarlos y no
  // pagar dos veces). El setState va dentro del callback async, no en el cuerpo
  // del efecto.
  useEffect(() => {
    const sem1 = today.getMonth() <= 5;          // 0-5 = ene-jun
    const anio = today.getFullYear();
    const semIni = sem1 ? `${anio}-01-01` : `${anio}-07-01`;
    const semFin = sem1 ? `${anio}-06-30T23:59:59` : `${anio}-12-31T23:59:59`;
    const ids = empleados.map(e => e.id);
    if (ids.length === 0) return;
    let cancel = false;
    void (async () => {
      const { data } = await db.from("rrhh_pagos_especiales")
        .select("empleado_id")
        .eq("tipo", "aguinaldo")
        .in("empleado_id", ids)
        .gte("pagado_at", semIni)
        .lte("pagado_at", semFin);
      if (cancel) return;
      const set = new Set<string>((data || []).map((r: { empleado_id: string }) => r.empleado_id));
      if (set.size === 0) return;
      setYaPagado(set);
      setIncluir(prev => {
        const next = { ...prev };
        for (const id of set) next[id] = false;
        return next;
      });
    })();
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seleccionados = empleados.filter(e => incluir[e.id] && Number(montos[e.id]) > 0);
  const total = seleccionados.reduce((s, e) => s + Number(montos[e.id] || 0), 0);
  const todosTildados = empleados.length > 0 && empleados.every(e => yaPagado.has(e.id) || incluir[e.id]);

  function toggleTodos() {
    setIncluir(() => {
      const next: Record<string, boolean> = {};
      for (const e of empleados) next[e.id] = !todosTildados && !yaPagado.has(e.id);
      return next;
    });
  }

  async function pagar() {
    if (!cuenta) { showError("Elegí la cuenta de egreso"); return; }
    if (seleccionados.length === 0) { showError("No hay empleados seleccionados con monto"); return; }
    setPagando(true);
    const ok: string[] = [];
    const fail: { nombre: string; error: string }[] = [];
    const pagadosIds = new Set<string>();
    for (const e of seleccionados) {
      const monto = Math.round(Number(montos[e.id]));
      const nombre = `${e.apellido} ${e.nombre}`;
      const { error } = await db.rpc("pagar_aguinaldo", {
        p_empleado_id: e.id,
        p_lineas: [{ cuenta, monto }],
        p_monto_esperado: monto,
        p_fecha: fecha,
      });
      if (error) fail.push({ nombre, error: translateRpcError(error) });
      else { ok.push(nombre); pagadosIds.add(e.id); }
    }
    setPagando(false);
    setResultado({ ok, fail });
    if (pagadosIds.size > 0) {
      setYaPagado(prev => new Set([...prev, ...pagadosIds]));
      setIncluir(prev => { const n = { ...prev }; for (const id of pagadosIds) n[id] = false; return n; });
      showToast(`Aguinaldo pagado a ${ok.length} empleado(s)`);
      onPagado();
    }
    if (fail.length > 0 && ok.length === 0) showError(`No se pudo pagar (${fail.length} con error)`);
  }

  const th: React.CSSProperties = { fontSize: 11, color: "var(--muted2)", textAlign: "left", padding: "6px 8px", fontWeight: 600 };
  const td: React.CSSProperties = { fontSize: 13, padding: "6px 8px", borderTop: "1px solid var(--pase-border)" };

  return (
    <Modal isOpen onClose={onClose} title={`Pagar aguinaldos · ${localNombre}`} maxWidth={700}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 0" }}>
        <p style={{ fontSize: 12, color: "var(--muted2)", margin: 0 }}>
          El aguinaldo se calcula como <b>medio sueldo mensual</b> de cada empleado. Podés editar el monto de cada uno. Los que ya cobraron este semestre aparecen marcados.
        </p>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label style={{ fontSize: 12, flex: 1, minWidth: 160 }}>Cuenta de egreso *
            <select className="search" value={cuenta} onChange={e => setCuenta(e.target.value)} style={{ width: "100%", marginTop: 4 }}>
              <option value="">— Elegí cuenta —</option>
              {cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12, minWidth: 150 }}>Fecha
            <input type="date" className="search" value={fecha} onChange={e => setFecha(e.target.value)} style={{ width: "100%", marginTop: 4 }} />
          </label>
        </div>

        <div style={{ maxHeight: 360, overflowY: "auto", border: "1px solid var(--pase-border)", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 32 }}>
                  <input type="checkbox" checked={todosTildados} onChange={toggleTodos} title="Tildar/destildar todos" />
                </th>
                <th style={th}>EMPLEADO</th>
                <th style={{ ...th, textAlign: "right" }}>SUELDO</th>
                <th style={{ ...th, textAlign: "right", width: 150 }}>AGUINALDO</th>
              </tr>
            </thead>
            <tbody>
              {empleados.length === 0 && (
                <tr><td style={td} colSpan={4}>No hay empleados activos en este local.</td></tr>
              )}
              {empleados.map(e => {
                const pagado = yaPagado.has(e.id);
                return (
                  <tr key={e.id} style={pagado ? { opacity: 0.55 } : undefined}>
                    <td style={td}>
                      <input
                        type="checkbox"
                        checked={!!incluir[e.id]}
                        disabled={pagado}
                        onChange={ev => setIncluir(prev => ({ ...prev, [e.id]: ev.target.checked }))}
                      />
                    </td>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{e.apellido}, {e.nombre}</div>
                      <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                        {e.puesto}{pagado ? " · ✓ ya cobró este semestre" : ""}
                      </div>
                    </td>
                    <td style={{ ...td, textAlign: "right", color: "var(--muted2)" }}>{fmt$(e.sueldo_mensual || 0)}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <input
                        type="number"
                        className="search"
                        value={montos[e.id] ?? ""}
                        disabled={pagado}
                        onChange={ev => setMontos(prev => ({ ...prev, [e.id]: ev.target.value }))}
                        style={{ width: 130, textAlign: "right" }}
                        min="0"
                        step="1"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {resultado && (
          <div style={{ fontSize: 12, background: "var(--pase-bg-soft, rgba(255,255,255,0.04))", borderRadius: 8, padding: 10 }}>
            {resultado.ok.length > 0 && <div style={{ color: "var(--success)" }}>✓ Pagados: {resultado.ok.length}</div>}
            {resultado.fail.length > 0 && (
              <div style={{ color: "var(--danger)", marginTop: 4 }}>
                ✗ Con error: {resultado.fail.map(f => `${f.nombre} (${f.error})`).join(" · ")}
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 4 }}>
          <div style={{ fontSize: 13 }}>
            <span style={{ color: "var(--muted2)" }}>Total a pagar: </span>
            <b>{fmt$(total)}</b> <span style={{ color: "var(--muted2)" }}>· {seleccionados.length} empleado(s)</span>
          </div>
          <button className="btn btn-primary" onClick={pagar} disabled={pagando || seleccionados.length === 0 || !cuenta}>
            {pagando ? "Pagando…" : `Pagar ${fmt$(total)}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
