import { useEffect, useMemo } from "react";
import type { Proveedor, Factura, PagoFactura } from "../../types/finanzas";
import { fmt_d } from "@pase/shared/utils";
import { estadoFactura } from "../../lib/utils";
import { formatCurrency } from "../../lib/format";
import styles from "./EstadoCuentaDrawer.module.css";

/** Movimiento del ledger de saldo a favor / en contra (F03-jun).
 *  Importable desde el padre que pasa `saldoMovimientos`. */
export interface SaldoMov {
  id: number;
  fecha: string;
  tipo: 'a_favor' | 'en_contra' | 'ajuste_a_favor' | 'ajuste_en_contra';
  monto: number | string;
  motivo: string | null;
  factura_id: string | null;
  movimiento_id: string | null;
  created_at: string;
}

interface Props {
  proveedor: Proveedor;
  facturas: Factura[];
  /** Movimientos del ledger de saldo a favor / en contra. Default [] si la
   *  migration aún no se aplicó o el proveedor no tiene movimientos. */
  saldoMovimientos?: SaldoMov[];
  loading: boolean;
  mes: string;                       // 'YYYY-MM'
  onMesChange: (mes: string) => void;
  onClose: () => void;
  onEditar?: () => void;
  onPagar?: () => void;
  onPDF?: () => void;
}

/** Drawer Estado de Cuenta — sprint mayo 2026 v2 Commit 4.
 *  Reemplaza el modal viejo de Proveedores con números 28-30px desbalanceados.
 *  Layout: panel lateral 480px desde la derecha con slide-in 0.22s.
 *
 *  Estructura:
 *  - Header: nombre 17px + meta (CUIT · categoría · Activo) + close btn.
 *  - Selector de período: pill clickeable con input month nativo.
 *  - 4 KPIs en grid 2x2 (16px tabular-nums) — Total comprado, Pagado, Deuda
 *    bruta, Vencido (este último con background bg-soft y color #8B6F0A).
 *  - Facturas impagas: filas con número + vencimiento, pill estado, monto.
 *  - Notas de crédito disponibles: solo si hay. Monto en celeste con signo
 *    negativo.
 *  - Footer: PDF / Editar / Pagar (flex 1, mismo ancho).
 */
export function EstadoCuentaDrawer({
  proveedor,
  facturas,
  saldoMovimientos = [],
  loading,
  mes,
  onMesChange,
  onClose,
  onEditar,
  onPagar,
  onPDF,
}: Props) {
  // Cerrar con Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Cálculos derivados del array de facturas + el mes seleccionado.
  const pendientes = facturas.filter(f => estadoFactura(f) === "pendiente" && (f.tipo || "factura") === "factura");
  const vencidas   = facturas.filter(f => estadoFactura(f) === "vencida"   && (f.tipo || "factura") === "factura");
  const ncs        = facturas.filter(f => (f.tipo || "factura") === "nota_credito" && f.estado !== "anulada");

  const totalAPagar     = pendientes.reduce((s, f) => s + (f.total || 0), 0)
                        + vencidas.reduce((s, f) => s + (f.total || 0), 0);
  const totalVencido    = vencidas.reduce((s, f) => s + (f.total || 0), 0);

  // Cálculos del mes
  const [yr, mo] = mes.split("-").map(Number) as [number, number];
  const desde = `${mes}-01`;
  const hasta = `${mes}-${String(new Date(yr, mo, 0).getDate()).padStart(2, "0")}`;

  const facturasDelMes = facturas.filter(f =>
    (f.tipo || "factura") === "factura" && f.fecha >= desde && f.fecha <= hasta,
  );
  const totalFacturadoMes = facturasDelMes.reduce((s, f) => s + Number(f.total || 0), 0);

  const totalPagadoMes = facturas.reduce((s, f) => {
    const pagosDelMes = (f.pagos || []).filter((p: PagoFactura) => p.fecha >= desde && p.fecha <= hasta);
    return s + pagosDelMes.reduce((sp, p) => sp + Number(p.monto || 0), 0);
  }, 0);

  const impagas = [...vencidas, ...pendientes].sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));

  const esActivo = proveedor.estado !== "Inactivo";

  // F03-jun: saldo a favor / en contra del proveedor.
  const saldoFavor = Number(proveedor.saldo_a_favor ?? 0);
  const tieneSaldoFavor = saldoFavor > 0;
  const tieneSaldoContra = saldoFavor < 0;

  // F03-jun: timeline completo del proveedor — facturas + pagos + NCs +
  // movimientos de saldo, todo en orden cronológico descendente. Permite
  // a Anto ver TODA la historia con un proveedor sin saltar pantallas.
  interface HistItem {
    id: string;
    fecha: string;
    tipo: 'factura' | 'nota_credito' | 'pago' | 'saldo_a_favor' | 'saldo_en_contra';
    label: string;
    detalle?: string;
    monto: number;
    signo: 'positivo' | 'negativo' | 'neutral';
  }
  const historial = useMemo((): HistItem[] => {
    const items: HistItem[] = [];
    // 1. Facturas (deuda) y NCs (a favor)
    for (const f of facturas) {
      if (f.estado === 'anulada') continue;
      const esNC = (f.tipo || 'factura') === 'nota_credito';
      items.push({
        id: `fac-${f.id}`,
        fecha: f.fecha || '',
        tipo: esNC ? 'nota_credito' : 'factura',
        label: esNC ? `NC #${f.nro || f.id}` : `Fact #${f.nro || f.id}`,
        detalle: f.cat || undefined,
        monto: Math.abs(Number(f.total || 0)),
        signo: esNC ? 'positivo' : 'negativo',
      });
      // 2. Pagos de la factura (cada línea del array pagos)
      for (const [i, p] of (f.pagos || []).entries()) {
        const pAny = p as PagoFactura & { tipo?: string; cuenta?: string };
        const esSaldoFavor = pAny.tipo === 'saldo_a_favor';
        items.push({
          id: `pago-${f.id}-${i}`,
          fecha: pAny.fecha || f.fecha || '',
          tipo: 'pago',
          label: esSaldoFavor
            ? `Saldo a favor aplicado a Fact #${f.nro || f.id}`
            : `Pago Fact #${f.nro || f.id}`,
          detalle: pAny.cuenta || undefined,
          monto: Math.abs(Number(pAny.monto || 0)),
          signo: 'positivo',
        });
      }
    }
    // 3. Movimientos de saldo (los que NO son consumo de aplicación a factura,
    //    ya los mostramos arriba como "Saldo a favor aplicado"). Para no
    //    duplicar, mostramos solo los que NO tienen factura_id linkeada O
    //    son del tipo 'a_favor' (generan crédito desde pago de más).
    for (const m of saldoMovimientos) {
      const monto = Math.abs(Number(m.monto));
      const esAFavor = m.tipo === 'a_favor' || m.tipo === 'ajuste_a_favor';
      // 'en_contra' con factura_id ya se mostró como "Saldo a favor aplicado"
      // arriba (línea de pagos). Skipear para no duplicar.
      if (!esAFavor && m.factura_id) continue;
      items.push({
        id: `mov-${m.id}`,
        fecha: m.fecha || '',
        tipo: esAFavor ? 'saldo_a_favor' : 'saldo_en_contra',
        label: esAFavor ? 'Saldo a favor generado' : 'Saldo en contra generado',
        detalle: m.motivo || undefined,
        monto,
        signo: esAFavor ? 'positivo' : 'negativo',
      });
    }
    // Ordenar por fecha descendente (más recientes primero).
    return items.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  }, [facturas, saldoMovimientos]);

  return (
    <>
      <div className={styles.overlay} onClick={onClose} aria-hidden />
      <aside className={styles.drawer} role="dialog" aria-label="Estado de cuenta">
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerInfo}>
            <div className={styles.name}>{proveedor.nombre}</div>
            <div className={styles.meta}>
              {proveedor.cuit && <>
                <span>CUIT {proveedor.cuit}</span>
                <span className={styles.metaDot} aria-hidden />
              </>}
              {proveedor.cat && <>
                <span>{proveedor.cat}</span>
                <span className={styles.metaDot} aria-hidden />
              </>}
              <span className={esActivo ? styles.statusActivo : ""}>
                {esActivo ? "Activo" : "Inactivo"}
              </span>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title="Cerrar" aria-label="Cerrar drawer">✕</button>
        </div>

        {loading ? (
          <div className={styles.empty}>Cargando...</div>
        ) : (
          <>
            {/* Selector de período */}
            <div className={styles.periodSection}>
              <div className={styles.periodLabel}>Resumen del mes</div>
              <input
                type="month"
                className={styles.periodPill}
                value={mes}
                onChange={e => onMesChange(e.target.value)}
              />
            </div>

            {/* KPIs 2x2 */}
            <div className={styles.kpiGrid}>
              <div className={styles.kpi}>
                <div className={styles.kpiLabel}>Total comprado</div>
                <div className={styles.kpiValue}>{formatCurrency(totalFacturadoMes)}</div>
              </div>
              <div className={styles.kpi}>
                <div className={styles.kpiLabel}>Pagado este mes</div>
                <div className={styles.kpiValue}>{formatCurrency(totalPagadoMes)}</div>
              </div>
              <div className={styles.kpi}>
                <div className={styles.kpiLabel}>Deuda bruta</div>
                <div className={styles.kpiValue}>{formatCurrency(totalAPagar)}</div>
              </div>
              <div className={`${styles.kpi} ${styles.kpiWarn}`}>
                <div className={styles.kpiLabel}>Vencido</div>
                <div className={`${styles.kpiValue} ${totalVencido > 0 ? styles.kpiValueWarn : ""}`}>
                  {formatCurrency(totalVencido)}
                </div>
              </div>
            </div>

            {/* Saldo a favor / en contra (F03-jun) */}
            {(tieneSaldoFavor || tieneSaldoContra) && (
              <div style={{
                margin: "0 16px 16px",
                padding: "12px 14px",
                borderRadius: 8,
                background: tieneSaldoFavor ? "rgba(34,197,94,0.10)" : "rgba(245,158,11,0.10)",
                border: `1px solid ${tieneSaldoFavor ? "rgba(34,197,94,0.30)" : "rgba(245,158,11,0.30)"}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}>
                <div>
                  <div style={{ fontSize: 10, textTransform: "none", letterSpacing: 0.5, color: "var(--muted2)", fontWeight: 500, marginBottom: 2 }}>
                    {tieneSaldoFavor ? "💰 Saldo a favor (nos debe)" : "⚠ Saldo en contra (le debemos)"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                    {tieneSaldoFavor ? "Lo podés aplicar como crédito al pagar otra factura." : "Aparte del saldo de facturas impagas."}
                  </div>
                </div>
                <div style={{
                  fontSize: 18,
                  fontWeight: 500,
                  color: tieneSaldoFavor ? "var(--success)" : "var(--warn)",
                  fontVariantNumeric: "tabular-nums",
                }}>
                  {formatCurrency(Math.abs(saldoFavor))}
                </div>
              </div>
            )}

            {/* Facturas impagas */}
            {impagas.length > 0 && (
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <div className={styles.sectionTitle}>Facturas impagas</div>
                  <div className={styles.sectionCount}>{impagas.length}</div>
                </div>
                {impagas.map(f => {
                  const esV = estadoFactura(f) === "vencida";
                  return (
                    <div key={f.id} className={styles.row}>
                      <div>
                        <div className={styles.rowNro}>{f.nro}</div>
                        <div className={styles.rowSub}>{f.venc ? `Vence ${fmt_d(f.venc)}` : `Fecha ${fmt_d(f.fecha)}`}</div>
                      </div>
                      <div className={`${styles.rowPill} ${styles.rowPillWarn}`}>
                        <span className={styles.dotWarn} aria-hidden />
                        {esV ? "Vencida" : "Pendiente"}
                      </div>
                      <div className={styles.rowAmount}>{formatCurrency(Number(f.total || 0))}</div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Notas de crédito disponibles */}
            {ncs.length > 0 && (
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <div className={styles.sectionTitle}>Notas de crédito disponibles</div>
                  <div className={styles.sectionCount}>{ncs.length}</div>
                </div>
                {ncs.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")).map(f => (
                  <div key={f.id} className={styles.row}>
                    <div>
                      <div className={styles.rowNro}>{f.nro}</div>
                      <div className={styles.rowSub}>Fecha {fmt_d(f.fecha)}</div>
                    </div>
                    <div className={styles.rowPill}>
                      Disponible
                    </div>
                    <div className={`${styles.rowAmount} ${styles.rowAmountNc}`}>
                      −{formatCurrency(Math.abs(Number(f.total || 0)))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {impagas.length === 0 && ncs.length === 0 && (
              <div className={styles.empty}>Sin facturas impagas ni notas disponibles</div>
            )}

            {/* Historial completo de movimientos (F03-jun) — Lucas: "ver
                todos los movimientos del proveedor en orden cronológico". */}
            {historial.length > 0 && (
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <div className={styles.sectionTitle}>Historial de movimientos</div>
                  <div className={styles.sectionCount}>{historial.length}</div>
                </div>
                {historial.map(h => {
                  const colorMonto =
                    h.signo === 'positivo' ? "var(--success)" :
                    h.signo === 'negativo' ? "var(--warn)" :
                    "var(--text)";
                  const iconoTipo =
                    h.tipo === 'factura' ? '📄' :
                    h.tipo === 'nota_credito' ? '↩️' :
                    h.tipo === 'pago' ? '💸' :
                    h.tipo === 'saldo_a_favor' ? '💰' :
                    h.tipo === 'saldo_en_contra' ? '⚠️' : '·';
                  const signoStr = h.signo === 'negativo' ? '−' : h.signo === 'positivo' ? '+' : '';
                  return (
                    <div key={h.id} className={styles.row}>
                      <div>
                        <div className={styles.rowNro}>
                          <span style={{ marginRight: 6 }}>{iconoTipo}</span>
                          {h.label}
                        </div>
                        <div className={styles.rowSub}>
                          {fmt_d(h.fecha)}
                          {h.detalle ? ` · ${h.detalle}` : ''}
                        </div>
                      </div>
                      <div style={{
                        textAlign: "right",
                        fontWeight: 500,
                        fontVariantNumeric: "tabular-nums",
                        color: colorMonto,
                        whiteSpace: "nowrap",
                      }}>
                        {signoStr}{formatCurrency(h.monto)}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Footer con acciones */}
            <div className={styles.footer}>
              {onPDF && (
                <button className={`btn btn-ghost ${styles.footerBtn}`} onClick={onPDF}>
                  PDF
                </button>
              )}
              {onEditar && (
                <button className={`btn btn-sec ${styles.footerBtn}`} onClick={onEditar}>
                  Editar
                </button>
              )}
              {onPagar && (
                <button className={`btn btn-acc ${styles.footerBtn}`} onClick={onPagar}>
                  Pagar
                </button>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
