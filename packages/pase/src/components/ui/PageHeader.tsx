import type { ReactNode } from "react";

/**
 * PageHeader — header estandarizado para todas las páginas (2026-05-14).
 *
 * Pedido de Lucas: las pantallas se ven desalineadas, cada una hace su mezcla
 * de `ph-row` + `ph-title` + botones flotando, y en mobile se apila feo.
 *
 * Este componente garantiza:
 *   • Título consistente en tamaño/peso/letterSpacing.
 *   • Subtítulo/info contextual va via prop `info` (se renderiza como tooltip
 *     con icono Sol de Mayo dorado al lado del título — patrón canónico).
 *   • Acciones SIEMPRE a la derecha en desktop. En mobile (≤640px) se apilan
 *     debajo del título alineadas a la izquierda con gap consistente.
 *   • Sin "contadores sueltos" ni subtítulos textuales al costado del título —
 *     todo va a `info`.
 *
 * Uso:
 * ```tsx
 * <PageHeader
 *   title="Gastos"
 *   info={<>Listado de gastos del local seleccionado. Cargá uno con el botón a la derecha.</>}
 *   actions={<button className="btn btn-acc" onClick={...}>+ Cargar Gasto</button>}
 * />
 * ```
 */

import { InfoTooltip } from "./InfoTooltip";

interface PageHeaderProps {
  /** Título visible. */
  title: string;
  /** Sub-sección opcional separada con `·` (ej. "Compras · facturas"). */
  subtitle?: string;
  /** Contenido del tooltip ☀️ (opcional). JSX o string. */
  info?: ReactNode;
  /** Botones/acciones que van a la derecha en desktop. */
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, info, actions }: PageHeaderProps) {
  return (
    <div className="pase-page-header">
      <div className="pase-page-header__title-row">
        <div className="pase-page-header__title-wrap">
          <h1 className="pase-page-header__title">
            {title}
            {subtitle && <span className="pase-page-header__subtitle"> · {subtitle}</span>}
          </h1>
          {info && <InfoTooltip maxWidth={320}>{info}</InfoTooltip>}
        </div>
        {actions && <div className="pase-page-header__actions">{actions}</div>}
      </div>
      <style>{`
        .pase-page-header {
          margin-bottom: 20px;
          padding-bottom: 14px;
          border-bottom: 0.5px solid var(--pase-border);
        }
        .pase-page-header__title-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
        }
        .pase-page-header__title-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .pase-page-header__title {
          margin: 0;
          font-size: 22px;
          font-weight: 500;
          color: var(--pase-text);
          letter-spacing: -0.025em;
          line-height: 1.15;
          font-family: var(--pase-font);
        }
        .pase-page-header__subtitle {
          color: var(--pase-text-muted);
          font-weight: 400;
          margin-left: 2px;
        }
        .pase-page-header__actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
        }
        @media (max-width: 640px) {
          .pase-page-header {
            margin-bottom: 16px;
            padding-bottom: 12px;
          }
          .pase-page-header__title-row {
            flex-direction: column;
            align-items: stretch;
            gap: 10px;
          }
          .pase-page-header__title-wrap {
            justify-content: flex-start;
          }
          .pase-page-header__actions {
            justify-content: flex-start;
          }
        }
      `}</style>
    </div>
  );
}
