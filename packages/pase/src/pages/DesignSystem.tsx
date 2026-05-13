import { Bento, Card, CardAnchor, KpiTile, Sparkline } from "../components/ui";
import styles from "./DesignSystem.module.css";

const SWATCHES = [
  { name: "celeste",        hex: "#75AADB", token: "--pase-celeste" },
  { name: "celeste-100",    hex: "#EAF3FB", token: "--pase-celeste-100" },
  { name: "celeste-200",    hex: "#D7E8F5", token: "--pase-celeste-200" },
  { name: "celeste-300",    hex: "#9DC3E2", token: "--pase-celeste-300" },
  { name: "text",           hex: "#1A3A5E", token: "--pase-text" },
  { name: "text-muted",     hex: "#6E8CAB", token: "--pase-text-muted" },
  { name: "border",         hex: "#EAF3FB", token: "--pase-border" },
  { name: "border-strong",  hex: "#DCE8F4", token: "--pase-border-strong" },
  { name: "bg",             hex: "#FFFFFF", token: "--pase-bg" },
  { name: "bg-soft",        hex: "#F4F9FD", token: "--pase-bg-soft" },
  { name: "bg-out",         hex: "#F2F5F8", token: "--pase-bg-out" },
  { name: "gold",           hex: "#F5C518", token: "--pase-gold" },
];

const SAMPLE_SPARK_A = [22, 31, 18, 44, 36, 58, 71];
const SAMPLE_SPARK_B = [40, 28, 36, 32, 48, 42, 55];
const SAMPLE_SPARK_C = [18, 24, 30, 26, 38, 44, 62];
const SAMPLE_SPARK_D = [50, 45, 52, 48, 55, 58, 64];

export default function DesignSystem() {
  return (
    <div className={styles.page}>
      <div className={styles.titlebar}>
        <div className={styles.dots}>
          <span className={styles.dot} />
          <span className={styles.dot} />
          <span className={styles.dot} />
        </div>
        <div className={styles.url}>pase-yndx.vercel.app / design-system</div>
      </div>

      <div className={styles.logo}>
        pase<span className={styles.logoDot}>.</span>
      </div>

      <h1 className={styles.h1}>Sistema de diseño v1.0 — preview</h1>
      <div className={styles.subtitle}>
        Página de desarrollo (no migrada). Cada componente aquí mostrado se importa de{" "}
        <code>components/ui</code>. Los tokens vienen de <code>styles/tokens.css</code>.
      </div>

      {/* Bento principal ──────────────────────────────────────────────── */}
      <div className={styles.section}>Bento layout · CardAnchor + KpiTile + Sparkline</div>
      <div className={styles.sectionMeta}>
        Grid asimétrico 3 columnas × 2 filas. La card celeste ocupa span 2.
      </div>
      <Bento>
        <CardAnchor
          label="Ingresos hoy"
          value="$ 1.842.530"
          delta="+ 12.4% vs ayer"
          meta="Local Palermo · actualizado 15:42"
          pillText="en vivo"
        />
        <KpiTile
          label="Ventas semana"
          value="$ 9.215.400"
          delta="+ 4.8%"
          sparkline={SAMPLE_SPARK_A}
        />
        <KpiTile
          label="Ticket promedio"
          value="$ 4.820"
          delta="+ 1.2%"
          sparkline={SAMPLE_SPARK_B}
        />
        <KpiTile
          label="Compras mes"
          value="$ 2.604.110"
          delta="- 3.1%"
          deltaTone="muted"
          sparkline={SAMPLE_SPARK_C}
        />
        <KpiTile
          label="Caja"
          value="$ 384.220"
          delta="3 cuentas activas"
          deltaTone="muted"
          sparkline={SAMPLE_SPARK_D}
        />
      </Bento>

      {/* Row inferior: Chart + Movimientos ────────────────────────────── */}
      <div className={styles.row}>
        <Card>
          <div className={styles.tabs}>
            <span className={`${styles.tab} ${styles.tabActive}`}>7d</span>
            <span className={styles.tab}>30d</span>
            <span className={styles.tab}>90d</span>
          </div>
          <Sparkline values={[28, 42, 36, 58, 49, 71, 85]} />
        </Card>
        <Card>
          <div className={styles.txList}>
            <div className={styles.txRow}>
              <div className={styles.txLeft}>
                <div className={styles.txIconIn}>↓</div>
                <div>
                  <div className={styles.txLabel}>Venta efectivo</div>
                  <div className={styles.txSub}>15:32 · Palermo</div>
                </div>
              </div>
              <div className={styles.txAmount}>+ $ 24.500</div>
            </div>
            <div className={styles.txRow}>
              <div className={styles.txLeft}>
                <div className={styles.txIconOut}>↑</div>
                <div>
                  <div className={styles.txLabel}>Pago factura</div>
                  <div className={styles.txSub}>14:08 · Don Carmelo</div>
                </div>
              </div>
              <div className={styles.txAmount}>- $ 182.300</div>
            </div>
            <div className={styles.txRow}>
              <div className={styles.txLeft}>
                <div className={styles.txIconIn}>↓</div>
                <div>
                  <div className={styles.txLabel}>Liquidación MP</div>
                  <div className={styles.txSub}>09:14 · MercadoPago</div>
                </div>
              </div>
              <div className={styles.txAmount}>+ $ 412.870</div>
            </div>
            <div className={styles.txRow}>
              <div className={styles.txLeft}>
                <div className={styles.txIconOut}>↑</div>
                <div>
                  <div className={styles.txLabel}>Gasto fijo</div>
                  <div className={styles.txSub}>08:00 · Servicios</div>
                </div>
              </div>
              <div className={styles.txAmount}>- $ 38.900</div>
            </div>
          </div>
          <div className={styles.verTodo}>VER TODO</div>
        </Card>
      </div>

      {/* Avatares ─────────────────────────────────────────────────────── */}
      <div className={styles.section}>Avatares (sin distinción por rol)</div>
      <div className={styles.sectionMeta}>
        Todos en --pase-celeste. El rol se comunica solo con texto (decisión 2026-05-13).
      </div>
      <div>
        <span className={styles.avatar}>LF</span>
        <span className={styles.avatar}>JM</span>
        <span className={styles.avatar}>AP</span>
        <span className={styles.avatar}>RC</span>
      </div>

      {/* Paleta ───────────────────────────────────────────────────────── */}
      <div className={styles.section}>Paleta — tokens.css</div>
      <div className={styles.sectionMeta}>
        Único celeste de marca es --pase-celeste. Dorado solo en logo dot y "en vivo".
      </div>
      <div className={styles.swatchGrid}>
        {SWATCHES.map((s) => (
          <div key={s.name} className={styles.swatch}>
            <div className={styles.swatchBox} style={{ background: s.hex }} />
            <div className={styles.swatchName}>{s.name}</div>
            <div className={styles.swatchHex}>{s.hex}</div>
            <div className={styles.swatchHex}>{s.token}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
