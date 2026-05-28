import { useEffect } from "react";
import type { Proveedor, Factura, PagoFactura } from "../../types/finanzas";
import { fmt_d } from "@pase/shared/utils";
import { estadoFactura } from "../../lib/utils";
import { formatCurrency } from "../../lib/format";
import styles from "./EstadoCuentaDrawer.module.css";

interface Props {
  proveedor: Proveedor;
  facturas: Factura[];
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
