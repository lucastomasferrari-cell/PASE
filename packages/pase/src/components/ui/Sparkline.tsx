import styles from "./Sparkline.module.css";

type SparklineProps = {
  values: number[];
  className?: string;
};

export function Sparkline({ values, className }: SparklineProps) {
  if (!values || values.length === 0) return null;
  const max = Math.max(...values, 1);
  const last = values.length - 1;
  const penultimate = last - 1;
  const cls = className ? `${styles.sparkline} ${className}` : styles.sparkline;

  return (
    <div className={cls} aria-hidden>
      {values.map((v, i) => {
        const pct = Math.max(1, Math.round((v / max) * 100));
        const barCls =
          i === last ? `${styles.bar} ${styles.hi}` :
          i === penultimate ? `${styles.bar} ${styles.mid}` :
          styles.bar;
        return <div key={i} className={barCls} style={{ height: `${pct}%` }} />;
      })}
    </div>
  );
}
