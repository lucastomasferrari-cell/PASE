import { useMemo } from "react";
import { PageHeader } from "../components/ui";
import { PuntoEquilibrioWidget } from "../dashboards/widgets/PuntoEquilibrioWidget";
import { ObjetivosMesWidget } from "../dashboards/widgets/ObjetivosMesWidget";
import { VentasSemanaWidget } from "../dashboards/widgets/VentasSemanaWidget";
import { ComparativaSucursalesWidget } from "../dashboards/widgets/ComparativaSucursalesWidget";
import { FacturasPorVencerWidget } from "../dashboards/widgets/FacturasPorVencerWidget";
import { VentasMesAMesWidget } from "../dashboards/widgets/VentasMesAMesWidget";
import { DiasMasVendidosWidget } from "../dashboards/widgets/DiasMasVendidosWidget";
import type { WidgetContext, RolPase } from "../dashboards/types";

/**
 * Negocio — LA vista de dirección. Fusión de las ex-pantallas Negocio +
 * Finanzas (rediseño 11-jun, pedido Lucas: "me tiran exactamente la misma
 * información, muy repetitivo, quiero unificar").
 *
 * Reparto de responsabilidades post-fusión:
 *   - /inicio  → "qué pasa HOY y qué tengo que hacer" (tareas, ventas hoy,
 *                facturas vencidas/por vencer, efectivo). Personalizable.
 *   - /negocio → "cómo viene el NEGOCIO" (esta pantalla, fija):
 *       1. La semana   — ventas 7 días + objetivo del mes.
 *       2. El mes      — punto de equilibrio + vencimientos próximos.
 *       3. Tendencia   — mes a mes + días que más se vende.
 *       4. Sucursales  — ranking (solo si hay ≥2 locales).
 *
 * Sigue la regla de métricas HONESTAS mid-month (2026-05-17): nada de
 * margen/CMV/ingresos-vs-egresos acá — los fijos caen los primeros 15 días
 * y distorsionan. El EERR devengado vive en /reportes (fin de mes).
 */

interface LocalRef { id: number; nombre: string }

interface Props {
  user?: { id: number; nombre: string; rol: string; tenant_id?: string | null; cuentas_visibles?: string[] | null };
  locales?: LocalRef[];
  /** Sucursal activa del sidebar — fuente única de verdad (2026-05-17).
   * Modo "Todas las sucursales" fue eliminado. */
  localActivo?: number | null;
}

export default function Negocio({ user, locales = [], localActivo = null }: Props) {
  const ctx: WidgetContext = useMemo(() => ({
    usuario: {
      id: user?.id ?? 0,
      nombre: user?.nombre ?? "",
      rol: (user?.rol ?? "dueno") as RolPase,
      tenant_id: user?.tenant_id ?? null,
      cuentas_visibles: user?.cuentas_visibles ?? null,
    },
    locales,
    localActivo,
  }), [user, locales, localActivo]);

  const nombreActivo = locales.find(l => l.id === localActivo)?.nombre;

  return (
    <div style={{ padding: "0 20px" }}>
      <PageHeader
        title="Negocio"
        subtitle={nombreActivo ? `cómo viene el negocio · ${nombreActivo}` : "cómo viene el negocio, en tiempo real"}
      />

      <div className="neg-grid">
        {/* ─── 1. La semana ─────────────────────────────────────────── */}
        <Card title="Ventas — últimos 7 días" span={7}>
          <VentasSemanaWidget ctx={ctx} />
        </Card>
        <Card title="Objetivo del mes" span={5}>
          <ObjetivosMesWidget ctx={ctx} />
        </Card>

        {/* ─── 2. El mes ────────────────────────────────────────────── */}
        <Card title="Punto de equilibrio" span={7}>
          <PuntoEquilibrioWidget ctx={ctx} />
        </Card>
        <Card title="Vencimientos próximos (7 días)" span={5}>
          <FacturasPorVencerWidget ctx={ctx} />
        </Card>

        {/* ─── 3. Tendencia ─────────────────────────────────────────── */}
        <Card title="Ventas mes a mes" span={7}>
          <VentasMesAMesWidget ctx={ctx} />
        </Card>
        <Card title="Días que más se vende" span={5}>
          <DiasMasVendidosWidget ctx={ctx} />
        </Card>

        {/* ─── 4. Sucursales ────────────────────────────────────────── */}
        {locales.length >= 2 && (
          <Card title="Ranking de sucursales" span={12}>
            <ComparativaSucursalesWidget ctx={ctx} />
          </Card>
        )}
      </div>

      {/* Notas al pie, compactas — antes eran 2 alerts grandes que comían
          media pantalla entre las dos páginas. */}
      <div style={{ marginTop: 20, fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", lineHeight: 1.6, opacity: 0.8 }}>
        El resultado del mes completo (ingresos vs egresos devengados) está en <strong>Reportes</strong> —
        tiene sentido mirarlo a fin de mes, no a mitad: los fijos se pagan los primeros 15 días y distorsionan.
        <br />
        Cuando COMANDA esté integrado se suman: top productos vendidos, productos más rentables, horas pico y ticket promedio por banda horaria.
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
          padding: 20px;
          min-width: 0;
          box-shadow: var(--pase-shadow-sm);
          transition: border-color var(--pase-duration-fast) var(--pase-ease-out),
                      box-shadow var(--pase-duration-normal) var(--pase-ease-out);
        }
        .neg-card:hover {
          border-color: var(--pase-border-strong);
          box-shadow: var(--pase-shadow-md);
        }
        .neg-card-title {
          margin: 0 0 14px;
          font-size: var(--pase-fs-xs);
          font-weight: 500;
          color: var(--pase-text-muted);
          letter-spacing: 0.04em;
          text-transform: none;
        }
        @media (max-width: 900px) {
          .neg-grid > .neg-card { grid-column: span 12 !important; }
        }
        [data-theme="dark"] .neg-card { background: var(--pase-bg-soft); }
      `}</style>
    </div>
  );
}

function Card({ title, children, span }: { title: string; children: React.ReactNode; span: number }) {
  return (
    <section className="neg-card" style={{ gridColumn: `span ${span}` }}>
      <h3 className="neg-card-title">{title}</h3>
      <div>{children}</div>
    </section>
  );
}
