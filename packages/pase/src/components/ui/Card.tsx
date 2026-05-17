import type { ReactNode } from "react";
import styles from "./Card.module.css";

/**
 * Card — contenedor base del sistema de diseño PASE.
 *
 * Variantes:
 *   - default: fondo blanco, borde fino. Uso general.
 *   - soft:    fondo bg-soft. Para secciones secundarias.
 *   - anchor:  fondo celeste sólido, texto blanco. Para KPI primario.
 *
 * Padding:
 *   - md (default): 14px 16px — uso general.
 *   - lg:            18px 20px — KPIs principales.
 *   - none:           0          — cuando el contenido maneja su padding.
 *
 * Interactivo (opcional): si pasás `onClick`, hover lift + cursor pointer.
 */

type CardVariant = "default" | "soft" | "anchor";
type CardPadding = "none" | "md" | "lg";

interface CardProps {
  children: ReactNode;
  variant?: CardVariant;
  padding?: CardPadding;
  className?: string;
  onClick?: () => void;
  ariaLabel?: string;
  /** Etiqueta arriba a la izquierda (overline). Opcional. */
  label?: ReactNode;
  /** Acción a la derecha del label (botón, link). Opcional. */
  action?: ReactNode;
}

export function Card({
  children,
  variant = "default",
  padding = "md",
  className,
  onClick,
  ariaLabel,
  label,
  action,
}: CardProps) {
  const cls = [
    styles.card,
    styles[`variant_${variant}`],
    styles[`padding_${padding}`],
    onClick ? styles.clickable : "",
    className ?? "",
  ].filter(Boolean).join(" ");

  const content = (
    <>
      {(label || action) && (
        <header className={styles.header}>
          {label && <div className={styles.label}>{label}</div>}
          {action && <div className={styles.action}>{action}</div>}
        </header>
      )}
      {children}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        onClick={onClick}
        aria-label={ariaLabel}
      >
        {content}
      </button>
    );
  }

  return <div className={cls} aria-label={ariaLabel}>{content}</div>;
}
