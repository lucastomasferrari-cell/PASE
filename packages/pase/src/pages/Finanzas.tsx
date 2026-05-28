import { useEffect, useMemo, useState } from "react";
import { db } from "../lib/supabase";
import { PageHeader } from "../components/ui";
import { formatCurrency, formatCurrencyCompact } from "../lib/format";
import { VentasSemanaWidget } from "../dashboards/widgets/VentasSemanaWidget";
import { ComparativaSucursalesWidget } from "../dashboards/widgets/ComparativaSucursalesWidget";
import { toLocalISO } from "@pase/shared/utils";
// SaldoCajaWidget eliminado 24-may noche (leak Caja Efectivo). En Finanzas
// reemplazamos esa card por algo más analítico — el saldo de caja vive en
// /caja, no en Finanzas (vista analítica para dueño).
import { FacturasPorVencerWidget } from "../dashboards/widgets/FacturasPorVencerWidget";
import type { WidgetContext, RolPase } from "../dashboards/types";

/**
 * Finanzas — vista analítica del flujo de plata.
 *
 * Reescrita 2026-05-17. Antes era mock puro con margen/CMV/cashflow inventados.
 * Ahora muestra datos reales con foco en lo que se puede mirar mid-month
 * sin distorsión:
 *
 *   - Ventas mes a mes (últimos 6 meses, sparkline)
 *   - Días de la semana que más se venden (últimos 90 días)
 *   - Ventas última semana + variación
 *   - Comparativa entre sucursales
 *   - Saldos en caja en tiempo real
 *   - Próximos vencimientos
 *
 * Lo que estaba mock (margen bruto, CMV) NO va más en finanzas mid-month:
 * vive en /reportes (EERR a fin de mes).
 *
 * Pendiente cuando conectemos COMANDA: top productos, horas pico, ticket
 * promedio por banda horaria.
 */

interface LocalRef { id: number; nombre: string }

interface Props {
  user?: { id: number; nombre: string; rol: string; tenant_id?: string | null; cuentas_visibles?: string[] | null };
  locales?: LocalRef[];
  /** Sucursal activa del sidebar — fuente única de verdad (2026-05-17). */
  localActivo?: number | null;
}

export default function Finanzas({ user, locales = [], localActivo = null }: Props) {
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
        title="Análisis"
        subtitle={nombreActivo ? `tendencia + comparativas · ${nombreActivo}` : "tendencia + comparativas en tiempo real"}
      />

      <div className="fin-grid">
        <Card title="Ventas — últimos 7 días" wide>
          <VentasSemanaWidget ctx={ctx} />
        </Card>
        {/* Card "Saldos en caja" eliminada 24-may junto con SaldoCajaWidget.
            Si necesitás ver saldos, andá a /caja directamente. */}

        <Card title="Ventas mes a mes" wide>
          <VentasMensualesChart localActivo={localActivo} />
        </Card>
        <Card title="Días que más se vende">
          <DiasMasVendidos localActivo={localActivo} />
        </Card>

        {locales.length >= 2 && (
          <Card title="Ranking de sucursales" wide>
            <ComparativaSucursalesWidget ctx={ctx} />
          </Card>
        )}
        <Card title="Próximos vencimientos">
          <FacturasPorVencerWidget ctx={ctx} />
        </Card>
      </div>

      <div className="alert" style={{ marginTop: 16, fontSize: "var(--pase-fs-sm)" }}>
        <strong>Pendiente para cuando COMANDA esté integrado:</strong>{" "}
        <span style={{ color: "var(--pase-text-muted)" }}>
          top productos vendidos, productos más rentables, horas pico de venta, ticket promedio por banda horaria.
          Hoy esa data no llega a PASE (solo total por día desde Maxirest).
        </span>
      </div>

      <style>{`
        .fin-grid {
          display: grid;
          grid-template-columns: repeat(12, 1fr);
          gap: 16px;
        }
        .fin-card {
          background: var(--pase-bg);
          border: 0.5px solid var(--pase-border);
          border-radius: var(--pase-radius-card);
          padding: 18px;
          min-width: 0;
        }
        .fin-card-title {
          margin: 0 0 14px;
          font-size: var(--pase-fs-base);
          font-weight: 500;
          color: var(--pase-text);
          letter-spacing: var(--pase-ls-snug);
        }
        .fin-grid > .fin-card { grid-column: span 6; }
        .fin-grid > .fin-card.wide { grid-column: span 6; }
        @media (min-width: 1100px) {
          .fin-grid > .fin-card { grid-column: span 4; }
          .fin-grid > .fin-card.wide { grid-column: span 8; }
        }
        @media (max-width: 700px) {
          .fin-grid > .fin-card { grid-column: span 12; }
        }
      `}</style>
    </div>
  );
}

function Card({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`fin-card${wide ? " wide" : ""}`}>
      <h3 className="fin-card-title">{title}</h3>
      <div>{children}</div>
    </section>
  );
}

// ─── VENTAS MENSUALES (últimos 6 meses) ──────────────────────────────────
interface MesData { mesLabel: string; total: number }

function VentasMensualesChart({ localActivo }: { localActivo: number | null }) {
  const [data, setData] = useState<MesData[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const today = new Date();
      // 6 meses atrás (primer día) → hoy
      const desde = new Date(today.getFullYear(), today.getMonth() - 5, 1);
      const desdeIso = toLocalISO(desde);
      const hastaIso = toLocalISO(today);
      let q = db
        .from("ventas")
        .select("fecha, monto")
        .gte("fecha", desdeIso)
        .lte("fecha", hastaIso);
      if (localActivo !== null) q = q.eq("local_id", localActivo);
      const { data: rows, error } = await q;
      if (cancelled || error) { setLoading(false); return; }
      const porMes = new Map<string, number>();
      for (const r of rows ?? []) {
        const row = r as { fecha: string; monto: number };
        const mesKey = row.fecha.slice(0, 7); // YYYY-MM
        porMes.set(mesKey, (porMes.get(mesKey) ?? 0) + Number(row.monto ?? 0));
      }
      const meses: MesData[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const mesKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        meses.push({
          mesLabel: d.toLocaleDateString("es-AR", { month: "short" }),
          total: porMes.get(mesKey) ?? 0,
        });
      }
      setData(meses);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [localActivo]);

  if (loading) return <div style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", textAlign: "center", padding: 16 }}>Cargando…</div>;
  if (!data || data.every(m => m.total === 0)) {
    return <div style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", textAlign: "center", padding: 16, fontStyle: "italic" }}>Sin ventas en los últimos 6 meses</div>;
  }
  const max = Math.max(1, ...data.map(m => m.total));
  const mesActualIdx = data.length - 1;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 120 }}>
        {data.map((m, i) => {
          const pct = Math.max(4, Math.round((m.total / max) * 100));
          return (
            <div key={m.mesLabel + i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }} title={`${m.mesLabel} — ${formatCurrencyCompact(m.total)}`}>
              <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                {formatCurrencyCompact(m.total)}
              </span>
              <div style={{
                width: "100%",
                height: `${pct}%`,
                background: i === mesActualIdx ? "var(--pase-celeste)" : "var(--pase-celeste-200)",
                borderRadius: "4px 4px 0 0",
              }} />
              <span style={{ fontSize: 10, color: "var(--pase-text-muted)", textTransform: "capitalize" }}>{m.mesLabel}</span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: 8, textAlign: "center" }}>
        Mes actual va parcial · barras anteriores son meses completos
      </div>
    </div>
  );
}

// ─── DÍAS MÁS VENDIDOS (últimos 90 días) ─────────────────────────────────
interface DiaSemana { dia: string; total: number }

const DOW_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

function DiasMasVendidos({ localActivo }: { localActivo: number | null }) {
  const [data, setData] = useState<DiaSemana[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const today = new Date();
      const desde = toLocalISO(new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000));
      const hasta = toLocalISO(today);
      let q = db
        .from("ventas")
        .select("fecha, monto")
        .gte("fecha", desde)
        .lte("fecha", hasta)
        .neq("estado", "anulada");
      if (localActivo !== null) q = q.eq("local_id", localActivo);
      const { data: rows, error } = await q;
      if (cancelled || error) { setLoading(false); return; }
      const porDow = Array(7).fill(0);
      for (const r of rows ?? []) {
        const row = r as { fecha: string; monto: number };
        // Parse fecha (YYYY-MM-DD) preservando local day-of-week. usar T12:00 para evitar TZ shifts.
        const dow = new Date(`${row.fecha}T12:00:00`).getDay();
        porDow[dow] += Number(row.monto ?? 0);
      }
      const arr: DiaSemana[] = porDow.map((total, idx) => ({ dia: DOW_LABELS[idx] ?? "?", total }));
      // Ordenar de mayor a menor
      arr.sort((a, b) => b.total - a.total);
      setData(arr);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [localActivo]);

  if (loading) return <div style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", textAlign: "center", padding: 16 }}>Cargando…</div>;
  if (!data || data.every(d => d.total === 0)) {
    return <div style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", textAlign: "center", padding: 16, fontStyle: "italic" }}>Sin ventas en 90 días</div>;
  }

  const max = Math.max(1, ...data.map(d => d.total));
  return (
    <div>
      <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginBottom: 10 }}>
        Últimos 90 días
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {data.map(d => {
          const pct = Math.max(2, Math.round((d.total / max) * 100));
          return (
            <div key={d.dia}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 2 }}>
                <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text)", minWidth: 36 }}>{d.dia}</span>
                <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                  {formatCurrency(d.total)}
                </span>
              </div>
              <div style={{ width: "100%", height: 4, background: "var(--pase-bg-soft)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: "var(--pase-celeste-300)" }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
