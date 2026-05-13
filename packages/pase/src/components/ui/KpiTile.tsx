import { Sparkline } from "./Sparkline";
import styles from "./KpiTile.module.css";

type KpiTileProps = {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "default" | "muted";
  sparkline?: number[];
  className?: string;
};

export function KpiTile({ label, value, delta, deltaTone = "default", sparkline, className }: KpiTileProps) {
  const cls = className ? `${styles.tile} ${className}` : styles.tile;
  const deltaCls = deltaTone === "muted" ? `${styles.delta} ${styles.deltaMuted}` : styles.delta;
  return (
    <div className={cls}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{value}</div>
      {delta && <div className={deltaCls}>{delta}</div>}
      {sparkline && sparkline.length > 0 && (
        <div className={styles.sparkWrap}>
          <Sparkline values={sparkline} />
        </div>
      )}
    </div>
  );
}
