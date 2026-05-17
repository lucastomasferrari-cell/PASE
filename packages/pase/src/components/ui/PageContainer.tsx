import type { ReactNode } from "react";

/**
 * PageContainer — wrapper estandarizado del contenido de cada pantalla.
 *
 * Resuelve el problema "cada pantalla tiene su propio padding y se ven
 * inconsistentes". Reglas:
 *   - Padding lateral: 24px desktop, 16px mobile
 *   - Padding vertical: 24px desktop, 16px mobile
 *   - Max-width: por default sin límite (full). `wide` y `narrow` opcionales.
 *
 * Uso:
 * ```tsx
 * <PageContainer>
 *   <PageHeader title="..." />
 *   {... contenido ...}
 * </PageContainer>
 * ```
 */

interface Props {
  children: ReactNode;
  /** full (default) | wide (1280px max) | narrow (640px max) */
  width?: "full" | "wide" | "narrow";
}

const WIDTHS = {
  full: "100%",
  wide: 1280,
  narrow: 640,
};

export function PageContainer({ children, width = "full" }: Props) {
  return (
    <div
      style={{
        maxWidth: WIDTHS[width],
        margin: width === "full" ? undefined : "0 auto",
        padding: "24px 24px 32px",
      }}
      className="pase-page-container"
    >
      {children}
      <style>{`
        @media (max-width: 640px) {
          .pase-page-container {
            padding: 16px !important;
          }
        }
      `}</style>
    </div>
  );
}
