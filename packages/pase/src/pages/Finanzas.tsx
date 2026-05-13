import { LocalCard } from "../components/ui";
import { useFinanzasConsolidado, useLocalFinanzas, useVencimientos } from "../hooks/useFinanzas";
import styles from "./Finanzas.module.css";

function fmtMoney(n: number): string {
  return `$ ${n.toLocaleString("es-AR")}`;
}

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 1_000)     return `$${(abs / 1_000).toFixed(0)}k`;
  return `$${abs}`;
}

function fmtCompactSigned(n: number): string {
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${fmtCompact(n)}`;
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className={styles.sectionHeader}>
      <span className={styles.sectionTitle}>{label}</span>
      <span className={styles.sectionDivider} aria-hidden />
    </div>
  );
}

function SparkBars({ values }: { values: number[] }) {
  if (!values.length) return null;
  const max = Math.max(1, ...values);
  const last = values.length - 1;
  const penultimate = last - 1;
  return (
    <div className={styles.sparkBars} aria-hidden>
      {values.map((v, i) => {
        const pct = Math.max(8, Math.round((v / max) * 100));
        const cls =
          i === last ? `${styles.sparkBar} ${styles.sparkBarHi}` :
          i === penultimate ? `${styles.sparkBar} ${styles.sparkBarMid}` :
          styles.sparkBar;
        return <div key={i} className={cls} style={{ height: `${pct}%` }} />;
      })}
    </div>
  );
}

export default function Finanzas() {
  const consolidado = useFinanzasConsolidado();
  const locales = useLocalFinanzas();
  const vencimientos = useVencimientos();

  return (
    <div className={styles.page}>
      <div className="ph-row" style={{ marginBottom: 20 }}>
        <div>
          <div className="ph-title">Finanzas</div>
          <div className="ph-sub">Visión ejecutiva multi-local. Solo efectivo en caja por ahora.</div>
        </div>
      </div>

      {/* ─── Zona 1: Consolidado ───────────────────────────────────── */}
      <SectionHeader label="Consolidado · todos los locales" />
      <div className={styles.zone1}>
        {/* Anchor: efectivo total + flow del mes */}
        <div className={styles.anchor}>
          <div className={styles.anchorBgCircle} aria-hidden />
          <div className={styles.anchorDot} aria-hidden />
          <div>
            <div className={styles.anchorLabel}>Efectivo total en caja</div>
            <div className={styles.anchorValue}>{fmtMoney(consolidado.efectivoTotal)}</div>
          </div>
          <div className={styles.anchorFooter}>
            <div className={styles.anchorFooterItem}>
              <span className={styles.anchorFooterLabel}>Entró</span>
              <span className={styles.anchorFooterValue}>{fmtCompact(consolidado.flow.entro)}</span>
            </div>
            <div className={styles.anchorFooterItem}>
              <span className={styles.anchorFooterLabel}>Salió</span>
              <span className={styles.anchorFooterValue}>{fmtCompact(consolidado.flow.salio)}</span>
            </div>
            <div className={styles.anchorFooterItem}>
              <span className={styles.anchorFooterLabel}>Resultado</span>
              <span className={styles.anchorFooterValue}>{fmtCompactSigned(consolidado.flow.resultado)}</span>
            </div>
          </div>
        </div>

        {/* KPI: Por pagar (30d) — warn dorado */}
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Por pagar (30d)</div>
          <div className={styles.kpiValue}>{fmtMoney(consolidado.porPagar30d.total)}</div>
          <div className={`${styles.kpiSub} ${styles.kpiSubWarn}`}>
            <span className={styles.kpiDotWarn} aria-hidden />
            {fmtCompact(consolidado.porPagar30d.estaSemana)} esta semana
          </div>
          <div className={styles.kpiSparkWrap}>
            <SparkBars values={consolidado.porPagar30d.spark} />
          </div>
        </div>

        {/* KPI: Cierre proyectado */}
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Cierre proyectado</div>
          <div className={styles.kpiValue}>{fmtMoney(consolidado.cierreProyectado.total)}</div>
          <div className={styles.kpiSub}>{consolidado.cierreProyectado.sub}</div>
          <div className={styles.kpiSparkWrap}>
            <SparkBars values={consolidado.cierreProyectado.spark} />
          </div>
        </div>

        {/* KPI: Margen bruto */}
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Margen bruto</div>
          <div className={styles.kpiValue}>{consolidado.margenBruto.value}</div>
          <div className={styles.kpiSub}>{consolidado.margenBruto.delta}</div>
          <div className={styles.kpiSparkWrap}>
            <SparkBars values={consolidado.margenBruto.spark} />
          </div>
        </div>
      </div>

      {/* ─── Zona 2: Por local ─────────────────────────────────────── */}
      <SectionHeader label={`Por local · ${locales.length} sucursales activas`} />
      <div className={styles.zone2}>
        {locales.map((l) => (
          <LocalCard key={l.name} {...l} />
        ))}
      </div>

      {/* ─── Zona 3: Vencimientos ──────────────────────────────────── */}
      <SectionHeader label="Próximos vencimientos · cruzando locales" />
      <div className={styles.kpiCard} style={{ padding: "16px 18px" }}>
        <div className={styles.vencList}>
          {vencimientos.map((v) => (
            <div key={v.id} className={styles.vencRow}>
              <div className={`${styles.dateBox} ${v.inminente ? styles.dateBoxInminente : ""}`}>
                <div className={styles.dateDay}>{v.dia}</div>
                <div className={styles.dateMes}>{v.mes}</div>
              </div>
              <div className={styles.vencInfo}>
                <div className={styles.vencName}>{v.nombre}</div>
                <div className={styles.vencDesc}>{v.descripcion}</div>
              </div>
              <span className={`${styles.localPill} ${v.local.tone === "primary" ? styles.localPillPrimary : styles.localPillMuted}`}>
                {v.local.nombre}
              </span>
              <div className={styles.vencMontoWrap}>
                <div className={styles.vencMonto}>{fmtMoney(v.monto)}</div>
                <div className={styles.vencMeta}>en {v.diasRestantes} {v.diasRestantes === 1 ? "día" : "días"}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
