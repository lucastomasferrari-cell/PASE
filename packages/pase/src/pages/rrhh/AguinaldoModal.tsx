// AguinaldoModal — pago masivo de aguinaldos (Lucas 22-jun).
// Base del cálculo = el MEJOR mes del semestre (mayor bruto) de cada empleado,
// traído por la RPC aguinaldo_preview_local. Aguinaldo = bruto/2 * proporción
// (días trabajados / días del semestre). Muestra el desglose del mejor mes,
// es editable, marca los que ya cobraron este semestre, y permite imprimir.
// Si el empleado no tiene liquidaciones todavía → se usa el sueldo declarado.

import { useState, useEffect, Fragment } from "react";
import { Modal } from "../../components/ui";
import { db } from "../../lib/supabase";
import { translateRpcError } from "../../lib/errors";
import { toISO } from "@pase/shared/utils";
import { today } from "../../lib/utils";
import { calcularAguinaldo } from "./aguinaldo";

interface Desglose {
  sueldo_base: number; presentismo: number; horas_extras: number; dobles: number;
  feriados: number; vacaciones: number; bono: number; ausencias: number;
}
interface PreviewRow {
  empleado_id: string; apellido: string; nombre: string; puesto: string;
  fecha_inicio: string | null; sueldo_mensual: number;
  mejor_mes: number | null; bruto: number; desglose: Desglose | null;
  /** true = trabaja en varios locales → no se paga inline acá (se reparte
   *  desde el legajo). */
  multi_local?: boolean;
}

interface Props {
  localId: number | null;
  cuentasUsables: string[];
  localNombre: string;
  showToast: (m: string) => void;
  showError: (m: string) => void;
  onPagado: () => void;
  onClose: () => void;
  /** Abre el legajo del empleado (en la pestaña de aguinaldo) para repartir
   *  el aguinaldo entre locales. */
  onIrAlLegajo: (empleadoId: string) => void;
}

const fmt$ = (n: number) => "$" + Math.round(n).toLocaleString("es-AR");
const fechaCorta = (s: string | null): string => {
  if (!s) return "";
  const p = s.slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}` : s;
};
const MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

/** Base mensual del cálculo: bruto del mejor mes; si no hay liquidaciones, el
 *  sueldo declarado del legajo (respaldo, para no dejar en cero al recién entrado). */
function baseDe(r: PreviewRow): number {
  return r.bruto > 0 ? r.bruto : (r.sueldo_mensual || 0);
}

/** Líneas del desglose del mejor mes (solo las que tienen valor). */
function lineasDesglose(r: PreviewRow): Array<{ label: string; monto: number; neg?: boolean }> {
  const d = r.desglose;
  if (!d || r.mejor_mes == null) return [];
  const out: Array<{ label: string; monto: number; neg?: boolean }> = [];
  const add = (label: string, v: number, neg = false) => { if (v) out.push({ label, monto: v, neg }); };
  add("Sueldo base", d.sueldo_base);
  add("Presentismo", d.presentismo);
  add("Horas extra", d.horas_extras);
  add("Horas dobles", d.dobles);
  add("Feriados", d.feriados);
  add("Vacaciones", d.vacaciones);
  add("Bono", d.bono);
  if (d.ausencias) out.push({ label: "Ausencias", monto: d.ausencias, neg: true });
  return out;
}

export function AguinaldoModal({ localId, cuentasUsables, localNombre, showToast, showError, onPagado, onClose, onIrAlLegajo }: Props) {
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [cuenta, setCuenta] = useState("");
  const [fecha, setFecha] = useState(toISO(today));
  const [montos, setMontos] = useState<Record<string, string>>({});
  const [incluir, setIncluir] = useState<Record<string, boolean>>({});
  const [yaPagado, setYaPagado] = useState<Set<string>>(new Set());
  const [expandido, setExpandido] = useState<Set<string>>(new Set());
  const [pagando, setPagando] = useState(false);
  const [resultado, setResultado] = useState<{ ok: string[]; fail: { nombre: string; error: string }[] } | null>(null);

  // Trae el preview (mejor mes + desglose) y arma montos/incluir + ya pagados.
  useEffect(() => {
    let cancel = false;
    void (async () => {
      const { data, error } = await db.rpc("aguinaldo_preview_local", { p_local_id: localId });
      if (cancel) return;
      if (error) { showError(translateRpcError(error)); setPreview([]); return; }
      const rows = (data as PreviewRow[]) || [];
      const m: Record<string, string> = {};
      const inc: Record<string, boolean> = {};
      for (const r of rows) {
        m[r.empleado_id] = String(calcularAguinaldo(baseDe(r), r.fecha_inicio, today).monto);
        inc[r.empleado_id] = !r.multi_local; // multi-local: no se paga inline acá
      }
      setMontos(m);
      setIncluir(inc);
      setPreview(rows);

      const sem1 = today.getMonth() <= 5;
      const anio = today.getFullYear();
      const semIni = sem1 ? `${anio}-01-01` : `${anio}-07-01`;
      const semFin = sem1 ? `${anio}-06-30T23:59:59` : `${anio}-12-31T23:59:59`;
      const ids = rows.map(r => r.empleado_id);
      if (ids.length === 0) return;
      const { data: pe } = await db.from("rrhh_pagos_especiales")
        .select("empleado_id").eq("tipo", "aguinaldo").in("empleado_id", ids)
        .gte("pagado_at", semIni).lte("pagado_at", semFin);
      if (cancel) return;
      const set = new Set<string>((pe || []).map((x: { empleado_id: string }) => x.empleado_id));
      if (set.size === 0) return;
      setYaPagado(set);
      setIncluir(prev => { const n = { ...prev }; for (const id of set) n[id] = false; return n; });
    })();
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = preview || [];
  // Los multi-local no se pagan inline (se reparten desde el legajo).
  const seleccionados = rows.filter(r => !r.multi_local && incluir[r.empleado_id] && Number(montos[r.empleado_id]) > 0);
  const total = seleccionados.reduce((s, r) => s + Number(montos[r.empleado_id] || 0), 0);
  const noPagables = (r: PreviewRow) => yaPagado.has(r.empleado_id) || !!r.multi_local;
  const todosTildados = rows.length > 0 && rows.every(r => noPagables(r) || incluir[r.empleado_id]);

  function toggleTodos() {
    setIncluir(() => {
      const next: Record<string, boolean> = {};
      for (const r of rows) next[r.empleado_id] = !todosTildados && !noPagables(r);
      return next;
    });
  }
  function toggleExpand(id: string) {
    setExpandido(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function pagar() {
    if (!cuenta) { showError("Elegí la cuenta de egreso"); return; }
    if (seleccionados.length === 0) { showError("No hay empleados seleccionados con monto"); return; }
    setPagando(true);
    const ok: string[] = [];
    const fail: { nombre: string; error: string }[] = [];
    const pagadosIds = new Set<string>();
    for (const r of seleccionados) {
      const monto = Math.round(Number(montos[r.empleado_id]));
      const nombre = `${r.apellido} ${r.nombre}`;
      const { error } = await db.rpc("pagar_aguinaldo", {
        p_empleado_id: r.empleado_id,
        p_lineas: [{ cuenta, monto }],
        p_monto_esperado: monto,
        p_fecha: fecha,
      });
      if (error) fail.push({ nombre, error: translateRpcError(error) });
      else { ok.push(nombre); pagadosIds.add(r.empleado_id); }
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

  function imprimir() {
    const sel = seleccionados;
    if (sel.length === 0) { showError("Tildá al menos un empleado para imprimir"); return; }
    const win = window.open("", "_blank", "width=860,height=680");
    if (!win) { showError("El navegador bloqueó la ventana de impresión"); return; }
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
    const p = fecha.split("-");
    const fdmy = p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : fecha;
    const totalSel = sel.reduce((s, r) => s + Number(montos[r.empleado_id] || 0), 0);
    const desgloseTxt = (r: PreviewRow) => {
      if (r.mejor_mes == null) return `Sin liquidaciones — base: sueldo declarado ${fmt$(r.sueldo_mensual)}`;
      const parts = lineasDesglose(r).map(l => `${l.label} ${l.neg ? "−" : ""}${fmt$(Math.abs(l.monto))}`);
      return `Mejor mes (${MESES[r.mejor_mes]}): ${parts.join(" + ")} = bruto ${fmt$(r.bruto)} → ÷2`;
    };
    const filas = sel.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(r.apellido)}, ${esc(r.nombre)}</td>
        <td class="num">${fmt$(Number(montos[r.empleado_id] || 0))}</td>
        <td class="firma"></td>
      </tr>
      <tr class="desg"><td></td><td colspan="3">${esc(desgloseTxt(r))}</td></tr>`).join("");
    win.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8">
      <title>Aguinaldos ${esc(localNombre)} ${fdmy}</title>
      <style>
        body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:28px;}
        h1{font-size:18px;margin:0 0 2px;}
        .sub{font-size:12px;color:#444;margin-bottom:16px;}
        table{width:100%;border-collapse:collapse;font-size:12px;}
        th,td{border:1px solid #999;padding:6px 8px;text-align:left;vertical-align:top;}
        th{background:#eee;}
        td.num,th.num{text-align:right;white-space:nowrap;}
        td.firma{width:220px;}
        tr.desg td{border-top:none;font-size:10px;color:#555;background:#fafafa;}
        tfoot td{font-weight:bold;background:#f5f5f5;}
        @media print{body{margin:12mm;}}
      </style></head><body>
      <h1>Liquidación de aguinaldos</h1>
      <div class="sub">${esc(localNombre)} · Fecha: ${fdmy}${cuenta ? " · Cuenta: " + esc(cuenta) : ""} · Base: mejor sueldo del semestre ÷ 2 (proporcional)</div>
      <table>
        <thead><tr><th>#</th><th>Empleado</th><th class="num">Aguinaldo</th><th>Firma y aclaración</th></tr></thead>
        <tbody>${filas}</tbody>
        <tfoot><tr><td colspan="2">Total · ${sel.length} empleados</td><td class="num">${fmt$(totalSel)}</td><td></td></tr></tfoot>
      </table>
      </body></html>`);
    win.document.close();
    win.focus();
    setTimeout(() => { win.print(); }, 250);
  }

  const th: React.CSSProperties = { fontSize: 11, color: "var(--muted2)", textAlign: "left", padding: "6px 8px", fontWeight: 600 };
  const td: React.CSSProperties = { fontSize: 13, padding: "6px 8px", borderTop: "1px solid var(--pase-border)" };

  return (
    <Modal isOpen onClose={onClose} title={`Pagar aguinaldos · ${localNombre}`} maxWidth={740}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: "8px 0" }}>
        <p style={{ fontSize: 12, color: "var(--muted2)", margin: 0 }}>
          El aguinaldo se calcula sobre el <b>mejor sueldo del semestre ÷ 2</b>, <b>proporcional</b> al tiempo trabajado. Tocá <b>"ver desglose"</b> para ver cómo se compone ese mes. Editable; los que ya cobraron este semestre aparecen marcados.
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

        {preview === null ? (
          <div style={{ padding: 24, textAlign: "center", color: "var(--muted2)", fontSize: 13 }}>Cargando empleados y sueldos…</div>
        ) : (
          <div style={{ maxHeight: 380, overflowY: "auto", border: "1px solid var(--pase-border)", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...th, width: 32 }}>
                    <input type="checkbox" checked={todosTildados} onChange={toggleTodos} title="Tildar/destildar todos" />
                  </th>
                  <th style={th}>EMPLEADO</th>
                  <th style={{ ...th, textAlign: "right" }}>MEJOR SUELDO</th>
                  <th style={{ ...th, textAlign: "right", width: 150 }}>AGUINALDO</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td style={td} colSpan={4}>No hay empleados activos en este local.</td></tr>
                )}
                {rows.map(r => {
                  const pagado = yaPagado.has(r.empleado_id);
                  const calc = calcularAguinaldo(baseDe(r), r.fecha_inicio, today);
                  const abierto = expandido.has(r.empleado_id);
                  const lineas = lineasDesglose(r);
                  const multi = !!r.multi_local;
                  return (
                    <Fragment key={r.empleado_id}>
                      <tr style={pagado ? { opacity: 0.55 } : undefined}>
                        <td style={td}>
                          {!multi && <input type="checkbox" checked={!!incluir[r.empleado_id]} disabled={pagado}
                            onChange={ev => setIncluir(prev => ({ ...prev, [r.empleado_id]: ev.target.checked }))} />}
                        </td>
                        <td style={td}>
                          <div style={{ fontWeight: 600 }}>{r.apellido}, {r.nombre}</div>
                          <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                            {r.puesto}
                            {multi
                              ? <span style={{ color: "var(--warn, #d8a200)" }}> · ⚠️ trabaja en varios locales — pagalo desde el legajo para repartirlo</span>
                              : pagado ? " · ✓ ya cobró este semestre" : calc.parcial ? ` · proporcional (entró ${fechaCorta(r.fecha_inicio)})` : ""}
                            {!multi && r.mejor_mes == null ? " · sin liquidaciones (sueldo declarado)" : ""}
                            {!multi && <>
                              {" · "}
                              <button onClick={() => toggleExpand(r.empleado_id)}
                                style={{ background: "none", border: "none", color: "var(--acc, #6aa3ff)", cursor: "pointer", fontSize: 11, padding: 0 }}>
                                {abierto ? "ocultar desglose" : "ver desglose"}
                              </button>
                            </>}
                          </div>
                        </td>
                        <td style={{ ...td, textAlign: "right", color: "var(--muted2)" }}>
                          {fmt$(baseDe(r))}
                          {r.mejor_mes != null && <div style={{ fontSize: 10 }}>{MESES[r.mejor_mes]}</div>}
                        </td>
                        <td style={{ ...td, textAlign: "right" }}>
                          {multi ? (
                            <button className="btn btn-outline btn-sm" onClick={() => onIrAlLegajo(r.empleado_id)}>
                              Pagar en legajo →
                            </button>
                          ) : (
                            <input type="number" className="search" value={montos[r.empleado_id] ?? ""} disabled={pagado}
                              onChange={ev => setMontos(prev => ({ ...prev, [r.empleado_id]: ev.target.value }))}
                              style={{ width: 130, textAlign: "right" }} min="0" step="1" />
                          )}
                        </td>
                      </tr>
                      {abierto && !multi && (
                        <tr>
                          <td style={{ ...td, borderTop: "none" }}></td>
                          <td style={{ ...td, borderTop: "none", fontSize: 11, color: "var(--muted2)" }} colSpan={3}>
                            {r.mejor_mes == null ? (
                              <span>Sin liquidaciones cargadas este semestre — se usa el sueldo declarado del legajo ({fmt$(r.sueldo_mensual)}).</span>
                            ) : (
                              <div>
                                <div style={{ marginBottom: 2 }}><b>Mejor mes: {MESES[r.mejor_mes]}</b></div>
                                {lineas.map((l, i) => (
                                  <div key={i} style={{ display: "flex", justifyContent: "space-between", maxWidth: 320 }}>
                                    <span>{l.label}</span>
                                    <span style={{ color: l.neg ? "var(--danger)" : undefined }}>{l.neg ? "−" : ""}{fmt$(Math.abs(l.monto))}</span>
                                  </div>
                                ))}
                                <div style={{ display: "flex", justifyContent: "space-between", maxWidth: 320, borderTop: "1px solid var(--pase-border)", marginTop: 2, paddingTop: 2, fontWeight: 600 }}>
                                  <span>Bruto del mes</span><span>{fmt$(r.bruto)}</span>
                                </div>
                                <div style={{ marginTop: 2 }}>
                                  Aguinaldo = {fmt$(r.bruto)} ÷ 2 {calc.parcial ? `× ${calc.diasTrabajados}/${calc.diasSemestre} días` : ""} = <b>{fmt$(calc.monto)}</b>
                                </div>
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

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
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-outline" onClick={imprimir} disabled={seleccionados.length === 0}>Imprimir</button>
            <button className="btn btn-primary" onClick={pagar} disabled={pagando || seleccionados.length === 0 || !cuenta}>
              {pagando ? "Pagando…" : `Pagar ${fmt$(total)}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
