import type { ReactNode } from "react";
import styles from "./RightSubNav.module.css";

// ─────────────────────────────────────────────────────────────────────
// RightSubNav — sub-navegación lateral derecha reutilizable.
// Pensada para módulos madre (Compras, Caja) que tienen sub-secciones
// + filtros contextuales. Vive dentro del main, no es full-width.
// ─────────────────────────────────────────────────────────────────────

export interface SubNavItem {
  /** ID interno de la sub-sección/filtro */
  id: string;
  /** Texto visible */
  label: string;
  /** Cantidad de elementos (contador a la derecha). Omitible. */
  count?: number;
  /** Ícono SVG inline opcional (13x13). Si se omite, no se muestra ícono. */
  icon?: ReactNode;
}

export interface SubNavSection {
  /** Header de la sección (overline 9.5px uppercase). */
  header: string;
  /** Items dentro de la sección. */
  items: SubNavItem[];
  /** ID del item activo. Si no aplica, undefined. */
  activeId?: string;
  /** Handler de click. */
  onSelect: (id: string) => void;
}

interface RightSubNavProps {
  sections: SubNavSection[];
}

export function RightSubNav({ sections }: RightSubNavProps) {
  return (
    <aside className={styles.aside} aria-label="Sub-navegación">
      {sections.map((section, sIdx) => (
        <div key={`${section.header}-${sIdx}`}>
          <div className={styles.sectionHeader}>{section.header}</div>
          {section.items.map(item => {
            const isActive = item.id === section.activeId;
            return (
              <button
                key={item.id}
                type="button"
                className={`${styles.item} ${isActive ? styles.itemActive : ""}`}
                onClick={() => section.onSelect(item.id)}
                aria-pressed={isActive}
              >
                <span className={styles.itemLabel}>
                  {item.icon && <span className={styles.itemIcon}>{item.icon}</span>}
                  {item.label}
                </span>
                {typeof item.count === "number" && (
                  <span className={styles.itemCount}>{item.count}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </aside>
  );
}
