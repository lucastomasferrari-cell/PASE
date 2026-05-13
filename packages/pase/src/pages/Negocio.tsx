import { useState } from "react";
import { useNegocioConsolidado, useObjetivos, type LocalCtx } from "../hooks/useNegocio";
import styles from "./Negocio.module.css";

// ─── Helpers de formato ──────────────────────────────────────────────
function fmtMoney(n: number): string {
  return `$ ${n.toLocaleString("es-AR")}`;
}

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 1_000)     return `$${(abs / 1_000).toFixed(0)}k`;
  return `$${abs}`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// ─── Inline section bits ────────────────────────────────────────────
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

// ─── Pantalla ───────────────────────────────────────────────────────
const SWITCH_OPTIONS: Array<{ id: LocalCtx; label: string }> = [
  { id: "consolidado",  label: "Consolidado" },
  { id: "belgrano",     label: "Belgrano" },
  { id: "villa-crespo", label: "Villa Crespo" },
];

interface NegocioProps {
  user?: { nombre?: string };
}

export default function Negocio({ user }: NegocioProps) {
  const [ctx, setCtx] = useState<LocalCtx>("consolidado");
  const kpis = useNegocioConsolidado(ctx);
  const objetivos = useObjetivos(ctx);

  const userName = user?.nombre || "Lucas Ferrari";
  const userInitials = initials(userName);

  const progressPct = Math.min(kpis.pctObjetivo, 100);
  const markPct = (kpis.diaActual / kpis.diasDelMes) * 100;

  return (
    <div className={styles.page}>
      {/* Topbar */}
      <div className={styles.topbar}>
        <div className={styles.titleWrap}>
          <span className={styles.title}>Negocio</span>
          <span className={styles.titleSub}>· Mayo 2026</span>
        </div>
        <div className={styles.topbarRight}>
          <div className={styles.switch} role="tablist" aria-label="Contexto de local">
            {SWITCH_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`${styles.switchItem} ${ctx === opt.id ? styles.switchItemActive : ""}`}
                onClick={() => setCtx(opt.id)}
                role="tab"
                aria-selected={ctx === opt.id}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className={styles.avatar} title={userName}>{userInitials}</span>
        </div>
      </div>

      {/* Bento: anchor + 4 KPIs */}
      <div className={styles.bento}>
        {/* Anchor */}
        <div className={styles.anchor}>
          <div className={styles.anchorBgCircle} aria-hidden />
          <div className={styles.anchorTopDecoration} aria-hidden />

          <div className={styles.anchorHeader}>
            <div>
              <div className={styles.anchorLabel}>Facturación del mes</div>
              <div className={styles.anchorValue}>{fmtMoney(kpis.facturacionMes)}</div>
              <div className={styles.anchorSub}>
                Proyectado a fin de mes: {fmtMoney(kpis.proyectadoFinMes)}
              </div>
            </div>
            <span className={styles.anchorPill}>día {kpis.diaActual} / {kpis.diasDelMes}</span>
          </div>

          <div className={styles.progressWrap}>
            <div className={styles.progressHeader}>
              <span>{kpis.pctObjetivo}% del objetivo</span>
              <span>{fmtCompact(kpis.facturacionMes)} / {fmtCompact(kpis.objetivoFacturacion)}</span>
            </div>
            <div className={styles.progressBar} aria-label={`${kpis.pctObjetivo}% completado del objetivo`}>
              <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
              <div
                className={styles.progressMark}
                style={{ left: `${markPct}%` }}
                title={`Día ${kpis.diaActual} de ${kpis.diasDelMes}`}
              />
            </div>
            <div className={styles.progressLegend}>
              <span>{kpis.ritmo.toLowerCase()}</span>
              <span className={styles.progressDelta}>
                <span className={styles.progressDeltaStrong}>+ {kpis.deltaMesAnterior.toFixed(1).replace(".", ",")}%</span> vs. mes anterior
              </span>
            </div>
          </div>
        </div>

        {/* 4 KPIs */}
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Margen bruto</div>
          <div className={styles.kpiValue}>{kpis.margenBruto.value}</div>
          <div className={`${styles.kpiDelta} ${kpis.margenBruto.tone === "muted" ? styles.kpiDeltaMuted : ""}`}>
            {kpis.margenBruto.delta}
          </div>
          <div className={styles.kpiSparkWrap}><SparkBars values={kpis.margenBruto.spark} /></div>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Costo de mercadería</div>
          <div className={styles.kpiValue}>{kpis.costoMercaderia.value}</div>
          <div className={`${styles.kpiDelta} ${styles.kpiDeltaMuted}`}>
            {kpis.costoMercaderia.delta}
          </div>
          <div className={styles.kpiSparkWrap}><SparkBars values={kpis.costoMercaderia.spark} /></div>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Rentabilidad neta</div>
          <div className={styles.kpiValue}>{fmtMoney(kpis.rentabilidadNeta.value)}</div>
          <div className={styles.kpiDelta}>{kpis.rentabilidadNeta.delta}</div>
          <div className={styles.kpiSparkWrap}><SparkBars values={kpis.rentabilidadNeta.spark} /></div>
        </div>

        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Ticket promedio</div>
          <div className={styles.kpiValue}>{fmtMoney(kpis.ticketPromedio.value)}</div>
          <div className={styles.kpiDelta}>{kpis.ticketPromedio.delta}</div>
          <div className={styles.kpiSparkWrap}><SparkBars values={kpis.ticketPromedio.spark} /></div>
        </div>
      </div>

      {/* Proyección cierre de mes */}
      <div className={styles.proyeccion}>
        <div className={styles.proyeccionHeader}>
          <span className={styles.proyeccionTitle}>Proyección cierre de mes</span>
          <span className={styles.proyeccionSub}>Basado en ritmo actual de los últimos {kpis.diaActual} días</span>
        </div>
        <div className={styles.proyeccionGrid}>
          <div className={styles.proyeccionCol}>
            <span className={styles.proyeccionColLabel}>Facturación proyectada</span>
            <span className={styles.proyeccionColValue}>{fmtMoney(kpis.proyeccion.facturacion.value)}</span>
            <span className={styles.proyeccionColSub}>{kpis.proyeccion.facturacion.sub}</span>
          </div>
          <div className={styles.proyeccionCol}>
            <span className={styles.proyeccionColLabel}>Costos proyectados</span>
            <span className={styles.proyeccionColValue}>{fmtMoney(kpis.proyeccion.costos.value)}</span>
            <span className={styles.proyeccionColSub}>{kpis.proyeccion.costos.sub}</span>
          </div>
          <div className={styles.proyeccionCol}>
            <span className={styles.proyeccionTrim} aria-hidden />
            <span className={styles.proyeccionColLabel}>Rentabilidad estimada</span>
            <span className={styles.proyeccionColValue}>{fmtMoney(kpis.proyeccion.rentabilidad.value)}</span>
            <span className={styles.proyeccionColSub}>
              <span className={styles.proyeccionColSubStrong}>{kpis.proyeccion.rentabilidad.sub}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Row inferior */}
      <div className={styles.rowInferior}>
        {/* Performance por local */}
        <div className={styles.rowCard}>
          <div className={styles.rowCardHeader}>
            <div className={styles.rowCardTitle}>Performance por local</div>
            <div className={styles.rowCardSub}>Mayo 2026 · ranking</div>
          </div>
          {kpis.performanceLocales.map((l) => (
            <div key={l.nombre} className={styles.perfRow}>
              <span className={styles.perfName}>{l.nombre}</span>
              <div className={styles.perfBarTrack}>
                <div className={styles.perfBarFill} style={{ width: `${l.pctBar}%` }} />
              </div>
              <span className={styles.perfAmount}>{fmtMoney(l.facturacion)}</span>
            </div>
          ))}
          <div className={styles.perfFooter}>
            {(() => {
              const parts = kpis.performanceFooter.texto.split(/(__\d__)/g);
              return parts.map((p, i) => {
                const m = p.match(/^__(\d+)__$/);
                if (m) {
                  const idx = parseInt(m[1]!, 10) - 1;
                  return (
                    <span key={i} className={styles.perfFooterStrong}>
                      {kpis.performanceFooter.valoresDestacados[idx]}
                    </span>
                  );
                }
                return <span key={i}>{p}</span>;
              });
            })()}
          </div>
        </div>

        {/* Objetivos */}
        <div className={styles.rowCard}>
          <div className={styles.rowCardHeader}>
            <div className={styles.rowCardTitle}>Objetivos del mes</div>
            <div className={styles.rowCardSub}>{objetivos.length} metas activas</div>
          </div>
          {objetivos.map((o) => {
            const dotCls =
              o.tone === "ok"    ? styles.objDotOk :
              o.tone === "warn"  ? styles.objDotWarn :
              styles.objDotLejos;
            return (
              <div key={o.id} className={styles.objRow}>
                <span className={`${styles.objDot} ${dotCls}`} aria-hidden />
                <div className={styles.objInfo}>
                  <div className={styles.objName}>{o.nombre}</div>
                  <div className={styles.objSub}>{o.detalle}</div>
                </div>
                <div className={styles.objVal}>
                  {o.valorActual} <span className={styles.objValTarget}>/ {o.valorObjetivo}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
