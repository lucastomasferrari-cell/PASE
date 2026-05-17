import { useMemo } from "react";
import { PageHeader } from "../components/ui";
import { PuntoEquilibrioWidget } from "../dashboards/widgets/PuntoEquilibrioWidget";
import { ObjetivosMesWidget } from "../dashboards/widgets/ObjetivosMesWidget";
import { VentasSemanaWidget } from "../dashboards/widgets/VentasSemanaWidget";
import { ComparativaSucursalesWidget } from "../dashboards/widgets/ComparativaSucursalesWidget";
import { FacturasPorVencerWidget } from "../dashboards/widgets/FacturasPorVencerWidget";
import type { WidgetContext, RolPase } from "../dashboards/types";

/**
 * Negocio — vista ejecutiva del dueño/gerente.
 *
 * Reescrita 2026-05-17. Antes mostraba KPIs devengados (margen, CMV, rentabilidad)
 * a mitad de mes — números engañosos porque los gastos fijos caen los primeros
 * 15 días y distorsionan cualquier comparativa intra-mes.
 *
 * Nueva orientación: métricas HONESTAS en cualquier momento del mes:
 *   1. Punto de equilibrio (BEP) — cuánto falta facturar para cubrir fijos.
 *   2. Objetivo del mes — facturación vs meta cargada.
 *   3. Ventas última semana — tendencia + variación vs semana previa.
 *   4. Ranking sucursales — comparativa entre locales.
 *   5. Facturas por vencer en 7 días — qué se viene encima.
 *
 * El EERR mensual devengado sigue viviendo en /reportes, pero solo tiene
 * sentido mirarlo a fin de mes (no a mid-month).
 */

interface LocalRef { id: number; nombre: string }

interface Props {
  user?: { id: number; nombre: string; rol: string; tenant_id?: string | null };
  locales?: LocalRef[];
  /** Sucursal activa del sidebar — fuente única de verdad (2026-05-17).
   * Modo "Todas las sucursales" fue eliminado. */
  localActivo?: number | null;
}

export default function Negocio({ user, locales = [], localActivo = null }: Props) {
  // Construyo el ctx que esperan los widgets reutilizando los componentes
  // del dashboard. localActivo viene directo del sidebar (App.tsx).
  const ctx: WidgetContext = useMemo(() => ({
    usuario: {
      id: user?.id ?? 0,
      nombre: user?.nombre ?? "",
      rol: (user?.rol ?? "dueno") as RolPase,
      tenant_id: user?.tenant_id ?? null,
    },
    locales,
    localActivo,
  }), [user, locales, localActivo]);

  const nombreActivo = locales.find(l => l.id === localActivo)?.nombre;

  return (
    <div style={{ padding: "0 20px" }}>
      <PageHeader
        title="Negocio"
        subtitle={nombreActivo ? `vista ejecutiva · ${nombreActivo}` : "vista ejecutiva en tiempo real"}
      />

      {/* Aclaración educativa — explicar que NO es el EERR */}
      <div className="alert" style={{ marginBottom: 16 }}>
        <strong>¿Por qué no veo "ingresos vs egresos" acá?</strong>
        <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginTop: 4, lineHeight: 1.5 }}>
          A mitad de mes esos números mienten — los fijos (alquileres, sueldos, servicios) se pagan los primeros 15 días.
          Acá mostramos métricas <strong>honestas en cualquier momento</strong>: punto de equilibrio, ventas y objetivos.
          El EERR mensual completo (devengado) está en <strong>Reportes</strong>, donde sí tiene sentido mirarlo a fin de mes.
        </div>
      </div>

      <div className="neg-grid">
        <Card title="Punto de equilibrio" wide>
          <PuntoEquilibrioWidget ctx={ctx} />
        </Card>
        <Card title="Objetivo de facturación">
          <ObjetivosMesWidget ctx={ctx} />
        </Card>
        <Card title="Ventas — últimos 7 días" wide>
          <VentasSemanaWidget ctx={ctx} />
        </Card>
        {locales.length >= 2 && (
          <Card title="Ranking de sucursales" wide>
            <ComparativaSucursalesWidget ctx={ctx} />
          </Card>
        )}
        <Card title="Vencimientos próximos (7 días)">
          <FacturasPorVencerWidget ctx={ctx} />
        </Card>
      </div>

      <style>{`
        .neg-grid {
          display: grid;
          grid-template-columns: repeat(12, 1fr);
          gap: 16px;
        }
        .neg-card {
          background: var(--pase-bg);
          border: 0.5px solid var(--pase-border);
          border-radius: var(--pase-radius-card);
          padding: 18px;
          min-width: 0;
        }
        .neg-card-title {
          margin: 0 0 14px;
          font-size: var(--pase-fs-base);
          font-weight: 500;
          color: var(--pase-text);
          letter-spacing: var(--pase-ls-snug);
        }
        .neg-grid > .neg-card { grid-column: span 6; }
        .neg-grid > .neg-card.wide { grid-column: span 6; }
        @media (min-width: 1100px) {
          .neg-grid > .neg-card { grid-column: span 4; }
          .neg-grid > .neg-card.wide { grid-column: span 6; }
        }
        @media (max-width: 700px) {
          .neg-grid > .neg-card { grid-column: span 12; }
        }
      `}</style>
    </div>
  );
}

function Card({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`neg-card${wide ? " wide" : ""}`}>
      <h3 className="neg-card-title">{title}</h3>
      <div>{children}</div>
    </section>
  );
}
