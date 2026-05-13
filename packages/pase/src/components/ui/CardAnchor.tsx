import styles from "./CardAnchor.module.css";

type CardAnchorProps = {
  label: string;
  value: string;
  delta?: string;
  meta?: string;
  pillText?: string;
  className?: string;
};

export function CardAnchor({ label, value, delta, meta, pillText, className }: CardAnchorProps) {
  const cls = className ? `${styles.anchor} ${className}` : styles.anchor;
  return (
    <div className={cls}>
      <div className={styles.bgCircle} aria-hidden />
      <div className={styles.dot} aria-hidden />
      <div>
        <div className={styles.label}>{label}</div>
        <div className={styles.value}>{value}</div>
        {delta && <div className={styles.delta}>{delta}</div>}
      </div>
      {(meta || pillText) && (
        <div className={styles.footer}>
          {meta && <span className={styles.meta}>{meta}</span>}
          {pillText && <span className={styles.pill}>{pillText}</span>}
        </div>
      )}
    </div>
  );
}
