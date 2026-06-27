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
 * Actualización 2026-06-27 (bolder sweep):
 *   • Título más grande (clamp 26-34px) con jerarquía editorial.
 *   • Línea ancla dorada vertical a la izquierda del bloque (la misma idea
 *     del dot dorado del logo, escalada).
 *   • `title` ahora acepta string | ReactNode — para casos como el Dashboard
 *     que quiere "Buenos días, <i>Dueño</i>" con una palabra en serif italic.
 *     Las 24 pantallas que pasan string siguen funcionando igual.
 *   • Fraunces italic disponible vía className "ph-italic" para palabras
 *     puntuales dentro del title.
 *
 * Uso:
 * ```tsx
 * <PageHeader
 *   title="Gastos"
 *   info={<>Listado de gastos del local seleccionado.</>}
 *   actions={<button className="btn btn-acc" onClick={...}>+ Cargar Gasto</button>}
 * />
 *
 * <PageHeader
 *   title={<>Buenos días, <span className="ph-italic">Anto</span></>}
 *   overline="Sábado 27 de junio · Neko Villa Crespo"
 * />
 * ```
 */

import { InfoTooltip } from "./InfoTooltip";

interface PageHeaderProps {
  /** Título visible. String o JSX (para palabras puntuales en serif italic con `<span className="ph-italic">`). */
  title: string | ReactNode;
  /** Sub-sección opcional separada con `·` (ej. "Compras · facturas"). */
  subtitle?: string;
  /** Línea pequeña que aparece arriba del título (ej. "Sábado 27 de junio · Local"). Opcional. */
  overline?: string;
  /** Contenido del tooltip ☀️ (opcional). JSX o string. */
  info?: ReactNode;
  /** Botones/acciones que van a la derecha en desktop. */
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, overline, info, actions }: PageHeaderProps) {
  return (
    <div className="pase-page-header">
      <div className="pase-page-header__anchor" aria-hidden="true" />
      <div className="pase-page-header__body">
        {overline && <div className="pase-page-header__overline">{overline}</div>}
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
      </div>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@1,400;1,500&display=swap');

        .pase-page-header {
          display: grid;
          grid-template-columns: 2px 1fr;
          gap: 16px;
          margin: 4px 0 24px;
          padding-bottom: 14px;
          border-bottom: 0.5px solid var(--pase-border);
        }
        .pase-page-header__anchor {
          width: 2px;
          background: linear-gradient(
            to bottom,
            transparent,
            var(--pase-gold) 25%,
            var(--pase-gold) 75%,
            transparent
          );
          align-self: stretch;
          min-height: 36px;
        }
        .pase-page-header__body { min-width: 0; }
        .pase-page-header__overline {
          font-size: 10px;
          color: var(--pase-text-muted);
          letter-spacing: 0.04em;
          margin-bottom: 6px;
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
          font-size: clamp(22px, 2.6vw, 30px);
          font-weight: 500;
          color: var(--pase-text);
          letter-spacing: -0.025em;
          line-height: 1.1;
          font-family: var(--pase-font);
        }
        .pase-page-header__title .ph-italic,
        .pase-page-header__title .ph-italic * {
          font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
          font-style: italic;
          font-weight: 400;
        }
        .pase-page-header__subtitle {
          color: var(--pase-text-muted);
          font-weight: 400;
          font-size: 0.65em;
          margin-left: 4px;
          letter-spacing: -0.01em;
        }
        .pase-page-header__actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
        }
        @media (max-width: 640px) {
          .pase-page-header {
            margin: 2px 0 16px;
            padding-bottom: 12px;
            grid-template-columns: 2px 1fr;
            gap: 12px;
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
