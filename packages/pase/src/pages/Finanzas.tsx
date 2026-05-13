import { useMemo, useState } from "react";
import { ComparativaLocales, LocalCard, type LocalCardProps } from "../components/ui";
import { useFinanzasConsolidado, useLocalFinanzas, useVencimientos } from "../hooks/useFinanzas";
import styles from "./Finanzas.module.css";

// ─── Helpers de formato ──────────────────────────────────────────────
function fmtMoney(n: number): string {
  // $ pegado al número. NO Intl.NumberFormat con currency — mete espacios.
  return `$${n.toLocaleString("es-AR")}`;
}

function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 1_000)     return `$${(abs / 1_000).toFixed(0)}k`;
  return `$${abs}`;
}

function fmtCompactSigned(n: number): string {
  // U+2212 (signo menos Unicode, no guión común).
  const sign = n >= 0 ? "+" : "−";
  return `${sign}${fmtCompact(n)}`;
}

function localKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

// ─── Inline section bits ────────────────────────────────────────────
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

// ─── Pantalla ───────────────────────────────────────────────────────
type LocalCtx = "consolidado" | string;

export default function Finanzas() {
  const [ctx, setCtx] = useState<LocalCtx>("consolidado");
  const consolidado = useFinanzasConsolidado();
  const locales = useLocalFinanzas();
  const vencimientos = useVencimientos();

  const isConsolidado = ctx === "consolidado";

  // Local seleccionado cuando NO es consolidado
  const localSel: LocalCardProps | null = useMemo(() => {
    if (isConsolidado) return null;
    return locales.find(l => localKey(l.name) === ctx) ?? null;
  }, [ctx, locales, isConsolidado]);

  // Vencimientos: en consolidado mostramos todos, en local solo los del local
  const vencimientosVisibles = useMemo(() => {
    if (isConsolidado) return vencimientos;
    const localName = localSel?.name;
    if (!localName) return [];
    return vencimientos.filter(v => v.local.nombre === localName || v.local.nombre === "Ambos");
  }, [isConsolidado, vencimientos, localSel]);

  const switchOptions: Array<{ id: LocalCtx; label: string }> = [
    { id: "consolidado", label: "Consolidado" },
    ...locales.map(l => ({ id: localKey(l.name), label: l.name })),
  ];

  return (
    <div className={styles.page}>
      {/* Topbar: título + switch ──────────────────────────────────── */}
      <div className={styles.topbar}>
        <div className={styles.titleWrap}>
          <span className={styles.title}>Finanzas</span>
          <span className={styles.titleSub}>· Mayo 2026</span>
        </div>
        <div className={styles.switch} role="tablist" aria-label="Contexto de local">
          {switchOptions.map(opt => (
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
      </div>

      {/* Botón "Ver comparativa" solo en vista por local ──────────── */}
      {!isConsolidado && (
        <button
          type="button"
          className={styles.backToCompare}
          onClick={() => setCtx("consolidado")}
        >
          ← Ver comparativa con otros locales
        </button>
      )}

      {/* ──────────────────────────────────────────────────────────── */}
      {/* CASO A: CONSOLIDADO                                          */}
      {/* ──────────────────────────────────────────────────────────── */}
      {isConsolidado && (
        <>
          {/* Zona 1: Consolidado · KPIs globales */}
          <SectionHeader label="Consolidado · todos los locales" />
          <div className={styles.zone1}>
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

            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Cierre proyectado</div>
              <div className={styles.kpiValue}>{fmtMoney(consolidado.cierreProyectado.total)}</div>
              <div className={styles.kpiSub}>{consolidado.cierreProyectado.sub}</div>
              <div className={styles.kpiSparkWrap}>
                <SparkBars values={consolidado.cierreProyectado.spark} />
              </div>
            </div>

            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Margen bruto</div>
              <div className={styles.kpiValue}>{consolidado.margenBruto.value}</div>
              <div className={styles.kpiSub}>{consolidado.margenBruto.delta}</div>
              <div className={styles.kpiSparkWrap}>
                <SparkBars values={consolidado.margenBruto.spark} />
              </div>
            </div>
          </div>

          {/* Zona 2: Por local (cards lado a lado) */}
          <SectionHeader label={`Por local · ${locales.length} sucursales activas`} />
          <div className={styles.zone2}>
            {locales.map((l) => (
              <LocalCard key={l.name} {...l} />
            ))}
          </div>

          {/* Zona NUEVA: Comparativa de locales */}
          <SectionHeader label="Comparativa de locales · vista analítica" />
          <ComparativaLocales
            locales={locales}
            periodo={`Mayo 2026 · ${locales.length} sucursales activas`}
          />
        </>
      )}

      {/* ──────────────────────────────────────────────────────────── */}
      {/* CASO B: LOCAL ESPECÍFICO                                     */}
      {/* ──────────────────────────────────────────────────────────── */}
      {!isConsolidado && localSel && (
        <>
          {/* Zona 1 renombrada: Resumen del local · KPIs del local seleccionado */}
          <SectionHeader label={`Resumen del local · ${localSel.name}`} />
          <div className={styles.zone1}>
            <div className={styles.anchor}>
              <div className={styles.anchorBgCircle} aria-hidden />
              <div className={styles.anchorDot} aria-hidden />
              <div>
                <div className={styles.anchorLabel}>Efectivo en caja</div>
                <div className={styles.anchorValue}>{fmtMoney(localSel.efectivoCaja)}</div>
              </div>
              <div className={styles.anchorFooter}>
                <div className={styles.anchorFooterItem}>
                  <span className={styles.anchorFooterLabel}>Entró</span>
                  <span className={styles.anchorFooterValue}>{fmtCompact(localSel.flow.entro)}</span>
                </div>
                <div className={styles.anchorFooterItem}>
                  <span className={styles.anchorFooterLabel}>Salió</span>
                  <span className={styles.anchorFooterValue}>{fmtCompact(localSel.flow.salio)}</span>
                </div>
                <div className={styles.anchorFooterItem}>
                  <span className={styles.anchorFooterLabel}>Resultado</span>
                  <span className={styles.anchorFooterValue}>{fmtCompactSigned(localSel.flow.resultado)}</span>
                </div>
              </div>
            </div>

            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Por pagar esta semana</div>
              <div className={styles.kpiValue}>
                {localSel.venceSemana.amount > 0 ? fmtMoney(localSel.venceSemana.amount) : "—"}
              </div>
              <div className={styles.kpiSub}>
                {localSel.venceSemana.amount > 0 ? "Vencimientos próximos" : "Sin vencimientos"}
              </div>
            </div>

            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Facturación del mes</div>
              <div className={styles.kpiValue}>{fmtMoney(localSel.facturacionMes)}</div>
              <div className={styles.kpiSub}>{localSel.metaInfo}</div>
            </div>

            <div className={styles.kpiCard}>
              <div className={styles.kpiLabel}>Margen bruto</div>
              <div className={styles.kpiValue}>{localSel.kpis.margen.value}</div>
              <div className={styles.kpiSub}>{localSel.kpis.margen.delta}</div>
            </div>
          </div>

          {/* Zona NUEVA: Detalle del local (LocalCard full width con toda la info) */}
          <SectionHeader label={`Detalle de ${localSel.name}`} />
          <div className={styles.localDetailWrap}>
            <LocalCard {...localSel} />
          </div>
        </>
      )}

      {/* ─── Zona común: Vencimientos ──────────────────────────────── */}
      <SectionHeader
        label={
          isConsolidado
            ? "Próximos vencimientos · cruzando locales"
            : `Próximos vencimientos · ${localSel?.name ?? ""}`
        }
      />
      <div className={styles.kpiCard} style={{ padding: "16px 18px" }}>
        <div className={styles.vencList}>
          {vencimientosVisibles.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--pase-text-muted)", padding: "12px 0" }}>
              No hay vencimientos próximos para este local.
            </div>
          ) : (
            vencimientosVisibles.map((v) => (
              <div key={v.id} className={styles.vencRow}>
                <div className={`${styles.dateBox} ${v.inminente ? styles.dateBoxInminente : ""}`}>
                  <div className={styles.dateDay}>{v.dia}</div>
                  <div className={styles.dateMes}>{v.mes}</div>
                </div>
                <div className={styles.vencInfo}>
                  <div className={styles.vencName}>{v.nombre}</div>
                  <div className={styles.vencDesc}>{v.descripcion}</div>
                </div>
                {isConsolidado ? (
                  <span className={`${styles.localPill} ${v.local.tone === "primary" ? styles.localPillPrimary : styles.localPillMuted}`}>
                    {v.local.nombre}
                  </span>
                ) : (
                  <span />
                )}
                <div className={styles.vencMontoWrap}>
                  <div className={styles.vencMonto}>{fmtMoney(v.monto)}</div>
                  <div className={styles.vencMeta}>en {v.diasRestantes} {v.diasRestantes === 1 ? "día" : "días"}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
