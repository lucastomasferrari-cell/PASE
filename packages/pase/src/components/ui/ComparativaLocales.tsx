import type { LocalCardProps } from "./LocalCard";
import { formatCurrency, formatDelta } from "../../lib/format";
import styles from "./ComparativaLocales.module.css";

// Alias para legibilidad — fmtMoney/fmtMoneySigned son los helpers
// centralizados en lib/format.ts.
const fmtMoney = formatCurrency;
const fmtMoneySigned = (n: number) => formatDelta(n, "$");

function fmtInt(n: number): string {
  return n.toLocaleString("es-AR");
}

// ─── Tipos de fila ─────────────────────────────────────────────────
type CellContent =
  | { type: "money"; value: number; delta?: string; deltaTone?: "up" | "down"; warn?: boolean }
  | { type: "flow"; entro: number; salio: number; resultado: number }
  | { type: "percent"; value: string; delta?: string; deltaTone?: "up" | "down" }
  | { type: "int"; value: number; delta?: string; deltaTone?: "up" | "down" }
  | { type: "empty"; label: string }
  | { type: "text"; value: string };

type Row = {
  metric: string;
  cells: CellContent[];
  /** Índice del local (0..N-1) cuyo valor es el "mejor" en esa fila (se resalta). Si no aplica, null. */
  bestIndex: number | null;
};

// ─── Lógica de "mejor valor" por métrica ───────────────────────────
function detectBest(values: number[], higherIsBetter = true): number {
  if (values.length === 0) return 0;
  let bestIdx = 0;
  for (let i = 1; i < values.length; i++) {
    const better = higherIsBetter ? values[i]! > values[bestIdx]! : values[i]! < values[bestIdx]!;
    if (better) bestIdx = i;
  }
  return bestIdx;
}

function parsePct(s: string): number {
  return parseFloat(s.replace(/[^\d.,−-]/g, "").replace(",", "."));
}

// ─── Build de filas desde el array de LocalCardProps ───────────────
function buildRows(locales: LocalCardProps[]): Row[] {
  return [
    {
      metric: "Facturación del mes",
      cells: locales.map(l => ({ type: "money" as const, value: l.facturacionMes })),
      bestIndex: detectBest(locales.map(l => l.facturacionMes), true),
    },
    {
      metric: "Entró / Salió / Resultado",
      cells: locales.map(l => ({ type: "flow" as const, ...l.flow })),
      bestIndex: detectBest(locales.map(l => l.flow.resultado), true),
    },
    {
      metric: "Margen bruto",
      cells: locales.map(l => ({
        type: "percent" as const,
        value: l.kpis.margen.value,
        delta: l.kpis.margen.delta,
        deltaTone: l.kpis.margen.tone === "warn" ? "down" : "up",
      })),
      bestIndex: detectBest(locales.map(l => parsePct(l.kpis.margen.value)), true),
    },
    {
      metric: "Ticket promedio",
      cells: locales.map(l => ({
        type: "money" as const,
        value: l.kpis.ticketProm.value,
        delta: l.kpis.ticketProm.delta,
        deltaTone: l.kpis.ticketProm.tone === "warn" ? "down" : "up",
      })),
      bestIndex: detectBest(locales.map(l => l.kpis.ticketProm.value), true),
    },
    {
      metric: "Cantidad de tickets",
      cells: locales.map(l => ({
        type: "int" as const,
        value: l.kpis.tickets.value,
        delta: l.kpis.tickets.delta,
        deltaTone: l.kpis.tickets.tone === "warn" ? "down" : "up",
      })),
      bestIndex: detectBest(locales.map(l => l.kpis.tickets.value), true),
    },
    {
      metric: "Efectivo en caja",
      cells: locales.map(l => ({ type: "money" as const, value: l.efectivoCaja })),
      bestIndex: detectBest(locales.map(l => l.efectivoCaja), true),
    },
    {
      metric: "Vence esta semana",
      cells: locales.map(l => (
        l.venceSemana.amount > 0
          ? { type: "money" as const, value: l.venceSemana.amount, warn: l.venceSemana.warn }
          : { type: "empty" as const, label: "Sin vencimientos" }
      )),
      // Mejor = menor monto a vencer (incluye Sin vencimientos = 0).
      bestIndex: detectBest(locales.map(l => l.venceSemana.amount), false),
    },
    {
      metric: "Personas operando",
      cells: locales.map(l => {
        const m = l.metaInfo.match(/(\d+)\s+personas?/);
        const n = m ? parseInt(m[1]!, 10) : 0;
        return { type: "int" as const, value: n };
      }),
      bestIndex: null, // no es competitivo
    },
    {
      metric: "Días operados",
      cells: locales.map(l => {
        const m = l.metaInfo.match(/(\d+)\s+días\s+operados/);
        const n = m ? parseInt(m[1]!, 10) : 0;
        return { type: "int" as const, value: n };
      }),
      bestIndex: null,
    },
  ];
}

// ─── Cell renderers ────────────────────────────────────────────────
function CellRender({ content }: { content: CellContent }) {
  switch (content.type) {
    case "money":
      return (
        <>
          <span className={styles.cellLocalValue}>
            {content.warn && <span className={styles.dotWarn} aria-hidden />}
            {fmtMoney(content.value)}
          </span>
          {content.delta && (
            <span className={`${styles.cellLocalDelta} ${content.deltaTone === "down" ? styles.deltaDown : styles.deltaUp}`}>
              {content.delta}
            </span>
          )}
        </>
      );
    case "percent":
      return (
        <>
          <span className={styles.cellLocalValue}>{content.value}</span>
          {content.delta && (
            <span className={`${styles.cellLocalDelta} ${content.deltaTone === "down" ? styles.deltaDown : styles.deltaUp}`}>
              {content.delta}
            </span>
          )}
        </>
      );
    case "int":
      return (
        <>
          <span className={styles.cellLocalValue}>{fmtInt(content.value)}</span>
          {content.delta && (
            <span className={`${styles.cellLocalDelta} ${content.deltaTone === "down" ? styles.deltaDown : styles.deltaUp}`}>
              {content.delta}
            </span>
          )}
        </>
      );
    case "flow":
      return (
        <div className={styles.flowMicro}>
          <span className={styles.flowMicroLine}>
            <span className={styles.flowMicroLabel}>Entró</span>{fmtMoney(content.entro)}
          </span>
          <span className={styles.flowMicroLine}>
            <span className={styles.flowMicroLabel}>Salió</span>{fmtMoney(content.salio)}
          </span>
          <span className={styles.flowMicroLine}>
            <span className={styles.flowMicroLabel}>Resultado</span>{fmtMoneySigned(content.resultado)}
          </span>
        </div>
      );
    case "empty":
      return <span className={`${styles.cellLocalValue} ${styles.empty}`}>{content.label}</span>;
    case "text":
      return <span className={styles.cellLocalValue}>{content.value}</span>;
  }
}

// ─── Componente principal ──────────────────────────────────────────
interface ComparativaLocalesProps {
  locales: LocalCardProps[];
  /** Subtítulo bajo el header (ej. "Mayo 2026 · 2 sucursales activas") */
  periodo?: string;
}

export function ComparativaLocales({ locales, periodo }: ComparativaLocalesProps) {
  if (locales.length < 2) return null;

  const rows = buildRows(locales);
  const cols = `1.4fr repeat(${locales.length}, 1fr)`;

  // Cuántas métricas ganó cada local
  const counters: Record<string, number> = {};
  locales.forEach(l => { counters[l.name] = 0; });
  rows.forEach(r => {
    if (r.bestIndex !== null) {
      const name = locales[r.bestIndex]?.name;
      if (name) counters[name] = (counters[name] || 0) + 1;
    }
  });

  const competitiveRows = rows.filter(r => r.bestIndex !== null).length;
  const ranking = Object.entries(counters).sort((a, b) => b[1] - a[1]);
  const lider = ranking[0]?.[0] || "";
  const cantidadLider = ranking[0]?.[1] || 0;

  // Mayor diferencia: tomar el ticket promedio del primer local vs el último
  const tickets = locales.map(l => l.kpis.ticketProm.value);
  const maxTicket = Math.max(...tickets);
  const minTicket = Math.min(...tickets);
  const ticketDiff = minTicket > 0 ? ((maxTicket - minTicket) / minTicket) * 100 : 0;

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <div className={styles.title}>Comparativa de locales</div>
        {periodo && <div className={styles.sub}>{periodo}</div>}
      </div>

      <div className={styles.table} style={{ gridTemplateColumns: cols }}>
        {/* Header row: nombres de locales */}
        <div className={styles.cell}>
          <span className={styles.cellLabel}>Métrica</span>
        </div>
        {locales.map(l => (
          <div key={l.name} className={styles.cell}>
            <span className={styles.cellLabel} style={{ fontSize: 12, color: "var(--pase-text)" }}>{l.name}</span>
          </div>
        ))}

        {/* Data rows */}
        {rows.map((r, idx) => {
          const isLast = idx === rows.length - 1;
          return (
            <div key={r.metric} className={`${styles.row} ${isLast ? styles.lastRow : ""}`}>
              <div className={styles.cell}>
                <span className={styles.cellLabel}>{r.metric}</span>
              </div>
              {r.cells.map((cell, i) => {
                const isBest = r.bestIndex === i;
                return (
                  <div
                    key={i}
                    className={`${styles.cell} ${styles.cellLocal} ${isBest ? styles.cellLocalBest : ""}`}
                  >
                    <CellRender content={cell} />
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {cantidadLider > 0 && (
        <div className={styles.footer}>
          <span className={styles.footerStrong}>{lider}</span> lidera en{" "}
          <span className={styles.footerStrong}>{cantidadLider} de {competitiveRows} métricas</span>.
          {ticketDiff > 0 && (
            <> Mayor diferencia: ticket promedio <span className={styles.footerStrong}>(+{ticketDiff.toFixed(1).replace(".", ",")}%)</span>.</>
          )}
        </div>
      )}
    </div>
  );
}
