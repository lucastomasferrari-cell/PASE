/* Modal de detalle de una línea del EERR.
 *
 * Dos modos (discriminados por `state.tipo`):
 *  - "cat":    una categoría del desglose (BEBIDAS, ALQUILER, ENVIOS, ...).
 *              Trae los gastos + facturas que la componen EN EL MOMENTO de abrir
 *              (no al cargar el reporte), respetando el período y el local activo.
 *              El reporte está optimizado para traer poco (egress, may-2026); el
 *              costo del detalle se paga solo cuando el usuario lo abre.
 *  - "sueldo": un empleado de la sección Sueldos. Muestra el resumen de novedades
 *              (sueldo base, extras, − ausencias, − adelantos, total, pagado).
 *              Los datos ya están en memoria → no hace fetch.
 */
import { useState, useEffect } from "react";
import { Modal } from "../components/ui";
import { db } from "../lib/supabase";
import { applyLocalScope } from "../lib/auth";
import { fmt_$ } from "@pase/shared/utils";
import type { Usuario } from "../types/auth";
import type { LiquidacionConEmpleado } from "../types/rrhh";

// Tipos de gasto "canónicos" — todo lo que NO cae acá va a "Otros Gastos".
// Debe quedar en sync con la lista de EERR.tsx (porCatOtros / totalOtrosGastos).
const TIPOS_CANONICOS = ["fijo", "variable", "publicidad", "comision", "impuesto", "retiro_socio", "empleado", "mano_obra"];

/** Cómo encontrar los movimientos que componen una categoría según su sección. */
export interface DetalleDescriptor {
  /** tipo a filtrar en `gastos`; null = la sección no toma gastos (CMV). */
  gastoTipo: string | null;
  /** bucket a filtrar en `facturas`; null = no toma facturas normales. */
  facturaBucket: string | null;
  /** Modo CMV: facturas con cat=categoria y bucket null o "cat_compra". */
  cmv?: boolean;
  /** Modo Otros: gastos por categoría cuyo tipo NO es canónico. */
  otros?: boolean;
}

export interface BreakdownRow {
  label: string;
  monto: number;
  /** Resta (se muestra en rojo con signo −). */
  neg?: boolean;
  /** Línea de total/subtotal (separador arriba, peso 600). */
  big?: boolean;
}

/** Resumen de novedades de un empleado: suma de sus liquidaciones del mes.
 *  Solo incluye las líneas con valor (≠0), salvo "Total a pagar" que siempre va. */
export function buildSueldoBreakdown(liqs: LiquidacionConEmpleado[]): BreakdownRow[] {
  const sum = (f: (l: LiquidacionConEmpleado) => number | undefined) =>
    liqs.reduce((s, l) => s + (f(l) || 0), 0);
  const rows: BreakdownRow[] = [];
  const push = (label: string, val: number, opts?: Partial<BreakdownRow>) => {
    if (val) rows.push({ label, monto: val, ...opts });
  };
  push("Sueldo base", sum(l => l.sueldo_base));
  push("Presentismo", sum(l => l.monto_presentismo));
  push("Horas extras", sum(l => l.total_horas_extras));
  push("Horas dobles", sum(l => l.total_dobles));
  push("Feriados", sum(l => l.total_feriados));
  push("Vacaciones", sum(l => l.total_vacaciones));
  push("Bono", sum(l => (l as { bono?: number }).bono));
  push("Ausencias", sum(l => l.descuento_ausencias), { neg: true });
  push("Adelantos", sum(l => l.adelantos), { neg: true });
  push("Otros descuentos", sum(l => (l as { otros_descuentos?: number }).otros_descuentos), { neg: true });
  rows.push({ label: "Total a pagar", monto: sum(l => l.total_a_pagar), big: true });
  push("Pagado", sum(l => l.pagos_realizados));
  return rows;
}

export type DetalleState =
  | { tipo: "cat"; titulo: string; descriptor: DetalleDescriptor; categoria: string }
  | { tipo: "sueldo"; titulo: string; subtitulo: string; breakdown: BreakdownRow[]; total: number };

interface MovRow {
  fecha: string;
  label: string;
  sublabel?: string;
  monto: number;
  origen: "Gasto" | "Compra";
}

interface Props {
  state: DetalleState;
  mes: string;            // "YYYY-MM"
  localActivo: number | null;
  user: Usuario;
  onClose: () => void;
}

const provNombre = (p: unknown): string => {
  if (!p) return "Proveedor";
  if (Array.isArray(p)) return (p[0] as { nombre?: string } | undefined)?.nombre || "Proveedor";
  return (p as { nombre?: string }).nombre || "Proveedor";
};

export default function EERRDetalleModal({ state, mes, localActivo, user, onClose }: Props) {
  const [loading, setLoading] = useState(state.tipo === "cat");
  const [rows, setRows] = useState<MovRow[]>([]);

  useEffect(() => {
    if (state.tipo !== "cat") return;
    let cancel = false;
    const cargar = async () => {
      setLoading(true);
      const { descriptor, categoria } = state;
      const [yr, mo] = mes.split("-").map(Number) as [number, number];
      const lastDay = new Date(yr, mo, 0).getDate();
      const desde = mes + "-01", hasta = mes + "-" + String(lastDay).padStart(2, "0");
      const lid = localActivo ? parseInt(String(localActivo)) : null;

      const tareas: PromiseLike<MovRow[]>[] = [];

      // Gastos
      if (descriptor.gastoTipo || descriptor.otros) {
        let gq = db.from("gastos")
          .select("id, fecha, monto, categoria, subcategoria, detalle, tipo")
          .eq("categoria", categoria)
          .gte("fecha", desde).lte("fecha", hasta)
          .or("estado.neq.anulado,estado.is.null");
        if (descriptor.gastoTipo) gq = gq.eq("tipo", descriptor.gastoTipo);
        gq = applyLocalScope(gq, user, lid);
        tareas.push(gq.then(({ data }) => {
          const gs = (data as { fecha: string; monto: number; categoria: string; subcategoria: string | null; detalle: string | null; tipo: string }[]) || [];
          return gs
            .filter(g => descriptor.gastoTipo ? true : !TIPOS_CANONICOS.includes(g.tipo))
            .map<MovRow>(g => ({
              fecha: g.fecha,
              label: g.detalle?.trim() || g.subcategoria?.trim() || g.categoria || "(sin detalle)",
              sublabel: g.detalle?.trim() && g.subcategoria?.trim() ? g.subcategoria! : undefined,
              monto: Number(g.monto || 0),
              origen: "Gasto",
            }));
        }));
      }

      // Facturas (Compras)
      if (descriptor.facturaBucket || descriptor.cmv) {
        let fq = db.from("facturas")
          .select("id, fecha, total, nro, detalle, prov_id, bucket, proveedores(nombre)")
          .eq("cat", categoria)
          .gte("fecha", desde).lte("fecha", hasta)
          .or("estado.neq.anulada,estado.is.null");
        if (descriptor.facturaBucket) fq = fq.eq("bucket", descriptor.facturaBucket);
        if (descriptor.cmv) fq = fq.or("bucket.is.null,bucket.eq.cat_compra");
        fq = applyLocalScope(fq, user, lid);
        tareas.push(fq.then(({ data }) => {
          const fs = (data as { fecha: string; total: number; nro: string | null; detalle: string | null; proveedores: unknown }[]) || [];
          return fs.map<MovRow>(f => ({
            fecha: f.fecha,
            label: `${provNombre(f.proveedores)}${f.nro ? ` · N° ${f.nro}` : ""}`,
            sublabel: f.detalle?.trim() || undefined,
            monto: Number(f.total || 0),
            origen: "Compra",
          }));
        }));
      }

      const partes = await Promise.all(tareas);
      if (cancel) return;
      const todas = partes.flat().sort((a, b) => a.fecha.localeCompare(b.fecha));
      setRows(todas);
      setLoading(false);
    };
    cargar();
    return () => { cancel = true; };
  // mes/localActivo/user no cambian mientras el modal está abierto (se cierra
  // y reabre). state.categoria define qué traer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.tipo === "cat" ? state.categoria : null]);

  const fechaCorta = (f: string) => {
    const [, m, d] = f.split("-");
    return `${d}/${m}`;
  };

  if (state.tipo === "sueldo") {
    return (
      <Modal isOpen onClose={onClose} title={state.titulo} subtitle={state.subtitulo} maxWidth={460}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {state.breakdown.map((r, i) => (
            <div
              key={i}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "7px 2px",
                borderTop: r.big ? "1px solid var(--pase-border)" : undefined,
                marginTop: r.big ? 2 : undefined,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: r.big ? 600 : 400, color: r.neg ? "var(--muted2)" : "var(--pase-text)" }}>
                {r.label}
              </span>
              <span
                className="num"
                style={{ fontSize: 13, fontWeight: r.big ? 600 : 500, color: r.neg ? "var(--danger)" : "var(--pase-text)" }}
              >
                {r.neg ? "− " : ""}{fmt_$(Math.abs(r.monto))}
              </span>
            </div>
          ))}
        </div>
      </Modal>
    );
  }

  const total = rows.reduce((s, r) => s + r.monto, 0);
  const subtitulo = loading ? "Cargando…" : `${rows.length} movimiento${rows.length === 1 ? "" : "s"} · ${fmt_$(total)}`;

  return (
    <Modal isOpen onClose={onClose} title={state.titulo} subtitle={subtitulo} maxWidth={560}>
      {loading ? (
        <div style={{ height: 100, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 12 }}>
          Cargando detalle…
        </div>
      ) : rows.length === 0 ? (
        <div style={{ height: 80, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted2)", fontSize: 12 }}>
          Sin movimientos en este mes.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((r, i) => (
            <div
              key={i}
              style={{
                display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10,
                padding: "8px 2px",
                borderBottom: i < rows.length - 1 ? "0.5px solid var(--pase-border)" : undefined,
              }}
            >
              <div style={{ display: "flex", gap: 8, minWidth: 0 }}>
                <span style={{ fontSize: 11, color: "var(--muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0, width: 38 }}>
                  {fechaCorta(r.fecha)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "var(--pase-text)", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
                    <span style={{
                      fontSize: 9, color: "var(--muted)", border: "0.5px solid var(--pase-border)",
                      borderRadius: 4, padding: "1px 4px", flexShrink: 0,
                    }}>{r.origen}</span>
                  </div>
                  {r.sublabel && <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 1 }}>{r.sublabel}</div>}
                </div>
              </div>
              <span className="num" style={{ fontSize: 13, fontWeight: 500, color: "var(--pase-text)", flexShrink: 0 }}>
                {fmt_$(r.monto)}
              </span>
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "9px 2px 2px", borderTop: "1.5px solid var(--pase-border)", marginTop: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--pase-text)" }}>Total</span>
            <span className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--pase-text)" }}>{fmt_$(total)}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
