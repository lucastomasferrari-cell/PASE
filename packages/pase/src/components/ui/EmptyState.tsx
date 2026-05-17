import type { ReactNode } from "react";

/**
 * EmptyState — pantalla/sección vacía con CTA.
 *
 * Pedido del polish del sistema PASE: cuando una tabla, lista, o card no
 * tiene datos, mostrar algo más elegante que un texto solo. Patrón:
 *   - Ícono grande (opcional, emoji o SVG)
 *   - Título corto
 *   - Descripción (1-2 líneas)
 *   - CTA opcional
 *
 * Uso:
 * ```tsx
 * <EmptyState
 *   icon="📭"
 *   title="Sin facturas pendientes"
 *   description="Cuando cargues facturas con vencimiento, las vas a ver acá."
 *   cta={<Link to="/compras/facturas/nueva" className="btn btn-acc">+ Cargar factura</Link>}
 * />
 * ```
 */

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  cta?: ReactNode;
  /** Padding interno. compact = 24px, normal = 48px */
  size?: "compact" | "normal";
}

export function EmptyState({ icon, title, description, cta, size = "normal" }: Props) {
  const padY = size === "compact" ? 24 : 48;
  return (
    <div style={{
      padding: `${padY}px 24px`,
      textAlign: "center",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 8,
    }}>
      {icon && (
        <div style={{
          fontSize: size === "compact" ? 28 : 40,
          lineHeight: 1,
          opacity: 0.7,
          marginBottom: 4,
        }}>
          {icon}
        </div>
      )}
      <div style={{
        fontSize: "var(--pase-fs-md)",
        fontWeight: 500,
        color: "var(--pase-text)",
        letterSpacing: "var(--pase-ls-snug)",
      }}>
        {title}
      </div>
      {description && (
        <p style={{
          margin: 0,
          fontSize: "var(--pase-fs-sm)",
          color: "var(--pase-text-muted)",
          lineHeight: 1.5,
          maxWidth: 400,
        }}>
          {description}
        </p>
      )}
      {cta && <div style={{ marginTop: 8 }}>{cta}</div>}
    </div>
  );
}
