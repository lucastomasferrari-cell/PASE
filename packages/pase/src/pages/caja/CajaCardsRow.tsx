import { fmt_$ } from "@pase/shared/utils";
import styles from "./CajaCardsRow.module.css";

interface CajaCardSpec {
  /** Nombre canónico de la cuenta (key en saldos) */
  cuenta: string;
  /** Label visible */
  label: string;
  /** Subtítulo (ej. "3 cuentas activas", "Local Belgrano") */
  sub?: string;
  /** Saldo de la cuenta */
  saldo: number;
  /** Anchor = celeste sólido. Otras = blanca con border. */
  variant: "anchor" | "normal";
  /** Ícono SVG inline 12x12 opcional */
  icon?: React.ReactNode;
  onClick?: () => void;
}

interface Props {
  cards: CajaCardSpec[];
}

const ICON_CASH = (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="1" y="3" width="12" height="8" rx="1.5"/>
    <circle cx="7" cy="7" r="1.5"/>
  </svg>
);

const ICON_CHEVRON = (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="5,3 9,7 5,11"/>
  </svg>
);

/** Componente reutilizable de las 3 cards superiores de Caja > Movimientos.
 * Caja Efectivo va como anchor celeste, Caja Chica y Caja Mayor como cards
 * blancas con border fino. Banco se removió de esta vista (volverá cuando
 * se concilie con la pantalla MP del Commit 5 del sprint v2).
 */
export function CajaCardsRow({ cards }: Props) {
  return (
    <div className={styles.row}>
      {cards.map(c => {
        const isAnchor = c.variant === "anchor";
        const negativo = c.saldo < 0;
        return (
          <div
            key={c.cuenta}
            className={`${styles.card} ${isAnchor ? styles.cardAnchor : styles.cardNormal}`}
            onClick={c.onClick}
            role={c.onClick ? "button" : undefined}
            tabIndex={c.onClick ? 0 : undefined}
          >
            {isAnchor && <div className={styles.bgCircle} aria-hidden />}
            <div className={styles.head}>
              <span className={styles.label}>
                <span className={styles.labelIcon} aria-hidden>{c.icon ?? ICON_CASH}</span>
                {c.label}
              </span>
              <span className={styles.chevron} aria-hidden>{ICON_CHEVRON}</span>
            </div>
            <div className={`${styles.value} ${negativo ? styles.valueNegative : ""}`}>
              {fmt_$(c.saldo)}
            </div>
            {c.sub && <div className={styles.sub}>{c.sub}</div>}
          </div>
        );
      })}
    </div>
  );
}
