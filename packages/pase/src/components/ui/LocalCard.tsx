import { formatCurrency, formatDelta } from "../../lib/format";
import styles from "./LocalCard.module.css";

export type LocalCardProps = {
  name: string;
  badge?: { text: string; variant: "default" | "warn" };
  variant: "leading" | "behind";
  metaInfo: string;
  facturacionMes: number;
  flow: { entro: number; salio: number; resultado: number };
  kpis: {
    margen: { value: string; delta: string; tone: "up" | "warn" };
    ticketProm: { value: number; delta: string; tone: "up" | "warn" };
    tickets: { value: number; delta: string; tone: "up" | "warn" };
  };
  spark7d: number[];
  spark7dLastAmount: number;
  efectivoCaja: number;
  venceSemana: { amount: number; warn: boolean };
};

// Helpers centralizados en lib/format.ts. fmtMoney = formatCurrency,
// fmtMoneySigned = formatDelta con unit '$'. fmtInt local.
const fmtMoney = formatCurrency;
const fmtMoneySigned = (n: number) => formatDelta(n, "$");

function fmtInt(n: number): string {
  return n.toLocaleString("es-AR");
}

export function LocalCard(props: LocalCardProps) {
  const {
    name,
    badge,
    variant,
    metaInfo,
    facturacionMes,
    flow,
    kpis,
    spark7d,
    spark7dLastAmount,
    efectivoCaja,
    venceSemana,
  } = props;

  const stripeCls = variant === "leading" ? styles.stripeLeading : styles.stripeBehind;
  const last = spark7d.length - 1;
  const penultimate = last - 1;
  const maxSpark = Math.max(1, ...spark7d);

  return (
    <div className={styles.card}>
      <div className={`${styles.stripe} ${stripeCls}`} aria-hidden />

      {/* Header */}
      <div className={styles.header}>
        <div>
          <div className={styles.name}>
            <span>{name}</span>
            {badge && (
              <span className={`${styles.badge} ${badge.variant === "warn" ? styles.badgeWarn : styles.badgeDefault}`}>
                {badge.text}
              </span>
            )}
          </div>
          <div className={styles.meta}>{metaInfo}</div>
        </div>
        <div className={styles.facturacionWrap}>
          <div className={styles.facturacionMonto}>{fmtMoney(facturacionMes)}</div>
          <div className={styles.facturacionLabel}>Facturación del mes</div>
        </div>
      </div>

      {/* Flow pill */}
      <div className={styles.flow}>
        <div className={styles.flowItem}>
          <div className={styles.flowLabel}>Entró</div>
          <div className={styles.flowValue}>{fmtMoney(flow.entro)}</div>
        </div>
        <span className={styles.flowSep} aria-hidden>{"→"}</span>
        <div className={styles.flowItem}>
          <div className={styles.flowLabel}>Salió</div>
          <div className={styles.flowValue}>{fmtMoney(flow.salio)}</div>
        </div>
        <span className={styles.flowSep} aria-hidden>{"="}</span>
        <div className={styles.flowItem}>
          <div className={styles.flowLabel}>Resultado</div>
          <div className={styles.flowValue}>{fmtMoneySigned(flow.resultado)}</div>
        </div>
      </div>

      {/* KPIs internos */}
      <div className={styles.kpis}>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Margen</div>
          <div className={styles.kpiValue}>{kpis.margen.value}</div>
          <div className={`${styles.kpiDelta} ${kpis.margen.tone === "warn" ? styles.kpiDeltaWarn : styles.kpiDeltaUp}`}>
            {kpis.margen.tone === "warn" && <span className={styles.dotWarn} aria-hidden />}
            {kpis.margen.delta}
          </div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Ticket prom.</div>
          <div className={styles.kpiValue}>{fmtMoney(kpis.ticketProm.value)}</div>
          <div className={`${styles.kpiDelta} ${kpis.ticketProm.tone === "warn" ? styles.kpiDeltaWarn : styles.kpiDeltaUp}`}>
            {kpis.ticketProm.tone === "warn" && <span className={styles.dotWarn} aria-hidden />}
            {kpis.ticketProm.delta}
          </div>
        </div>
        <div className={styles.kpi}>
          <div className={styles.kpiLabel}>Tickets</div>
          <div className={styles.kpiValue}>{fmtInt(kpis.tickets.value)}</div>
          <div className={`${styles.kpiDelta} ${kpis.tickets.tone === "warn" ? styles.kpiDeltaWarn : styles.kpiDeltaUp}`}>
            {kpis.tickets.tone === "warn" && <span className={styles.dotWarn} aria-hidden />}
            {kpis.tickets.delta}
          </div>
        </div>
      </div>

      {/* Spark row */}
      <div className={styles.sparkRow}>
        <span className={styles.sparkLabel}>Últimos 7 días</span>
        <div className={styles.sparkBars} aria-hidden>
          {spark7d.map((v, i) => {
            const pct = Math.max(8, Math.round((v / maxSpark) * 100));
            const cls =
              i === last ? `${styles.sparkBar} ${styles.sparkBarHi}` :
              i === penultimate ? `${styles.sparkBar} ${styles.sparkBarMid}` :
              styles.sparkBar;
            return <div key={i} className={cls} style={{ height: `${pct}%` }} />;
          })}
        </div>
        <span className={styles.sparkLastAmount}>{fmtMoney(spark7dLastAmount)}</span>
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <div className={styles.footerItem}>
          <span className={styles.footerLabel}>Efectivo en caja</span>
          <span className={styles.footerValue}>{fmtMoney(efectivoCaja)}</span>
        </div>
        <div className={styles.footerItem}>
          <span className={styles.footerLabel}>Vence esta semana</span>
          {venceSemana.amount > 0 ? (
            <span className={`${styles.footerValue} ${venceSemana.warn ? styles.footerValueWarn : ""}`}>
              {venceSemana.warn && <span className={styles.dotWarn} aria-hidden />}
              {fmtMoney(venceSemana.amount)}
            </span>
          ) : (
            <span className={styles.footerEmpty}>Sin vencimientos</span>
          )}
        </div>
      </div>
    </div>
  );
}
