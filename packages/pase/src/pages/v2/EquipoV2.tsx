// PASE V2 — Dashboard de Equipo (RRHH rediseñado)
//
// Primera pantalla del rediseño aplicando design system limpio:
// - Sin emojis decorativos
// - Solo paleta: celeste / dorado / blanco / grises
// - Iconos Lucide line monocromos
// - KPIs con dorado para el más importante (Nómina del mes)
// - Componentes v2 (StatCard, Button, Badge)
//
// Consume tablas nuevas del Spec #1 RRHH:
// - rrhh_pay_calendars (calendarios de pago)
// - rrhh_eventos (eventos discretos con fecha)
// - rrhh_liquidaciones_v2 (liquidaciones con state machine)
//
// Spec completo: docs/superpowers/specs/2026-05-28-rrhh-rediseno-design.md

import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { Users, Calendar, Wallet, TrendingUp, ArrowRight, Bell } from "lucide-react";
import { StatCard } from "../../components/v2/StatCard";
import { Button } from "../../components/v2/Button";
import { Badge } from "../../components/v2/Badge";
import "../../styles/v2-tokens.css";

interface Empleado {
  id: string;
  nombre: string;
  apellido: string;
  puesto: string;
  modo_pago: string;
  sueldo_mensual: number;
  local_id: number;
  activo: boolean;
}

interface PayCalendar {
  id: string;
  nombre: string;
  frecuencia: string;
}

interface CerrarHoy {
  empleado_id: string;
  empleado_nombre: string;
  periodo_label: string;
  total: number;
  local_nombre: string;
  fecha_pago: string;
}

interface Props {
  localActivo?: number | null;
}

export default function EquipoV2({ localActivo = null }: Props) {
  const { user } = useAuth();
  const [empleados, setEmpleados] = useState<Empleado[]>([]);
  const [calendars, setCalendars] = useState<PayCalendar[]>([]);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      // Scope manual por local_id (defense-in-depth + evita TS2589 con applyLocalScope encadenado).
      // eslint-disable-next-line pase-local/require-apply-local-scope -- scope manual ver bloque "visibles"
      const visibles: number[] | null = (user?.rol === "dueno" || user?.rol === "admin" || user?.rol === "superadmin")
        ? (localActivo != null ? [localActivo] : null)
        : (user?._locales ?? user?.locales ?? []);
      let empQ = db.from("rrhh_empleados")
        .select("id, nombre, apellido, puesto, modo_pago, sueldo_mensual, local_id, activo")
        .eq("activo", true);
      if (visibles) empQ = empQ.in("local_id", visibles);
      const [empRes, calRes] = await Promise.all([
        empQ,
        db.from("rrhh_pay_calendars").select("id, nombre, frecuencia").eq("activo", true),
      ]);
      setEmpleados((empRes.data ?? []) as Empleado[]);
      setCalendars((calRes.data ?? []) as PayCalendar[]);
    } finally {
      setLoading(false);
    }
  }
useEffect(() => {
    if (!user?.tenant_id) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenant_id, localActivo]);


  // KPIs computados
  const nominaMes = empleados.reduce((sum, e) => sum + (e.sueldo_mensual ?? 0), 0);
  const empleadosActivos = empleados.length;
  const empleadosPorModo = empleados.reduce<Record<string, number>>((acc, e) => {
    acc[e.modo_pago] = (acc[e.modo_pago] ?? 0) + 1;
    return acc;
  }, {});

  // Mock de "cerrar hoy" (cuando la implementación esté completa, viene de rrhh_liquidaciones_v2)
  const cerrarHoy: CerrarHoy[] = empleados.slice(0, 3).map((e, i) => ({
    empleado_id: e.id,
    empleado_nombre: `${e.nombre} ${e.apellido}`,
    periodo_label: i === 0 ? "1ra Quincena Mayo" : i === 1 ? "Semana 9-15 Mayo" : "Quincena 1-15 Mayo",
    total: Math.round((e.sueldo_mensual ?? 0) / 2 * 0.95),
    local_nombre: "Sucursal Prueba",
    fecha_pago: "2026-05-16",
  }));

  if (loading) {
    return (
      <div className="v2" style={{ padding: "var(--v2-space-8)", color: "var(--v2-text-muted)" }}>
        Cargando…
      </div>
    );
  }

  return (
    <div className="v2" style={{ padding: "var(--v2-space-6)", minHeight: "100vh" }}>

      {/* === HEADER === */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: "var(--v2-space-6)",
        paddingBottom: "var(--v2-space-4)",
        borderBottom: "1px solid var(--v2-border)",
      }}>
        <div>
          <div className="v2-eyebrow" style={{ marginBottom: "var(--v2-space-1)" }}>
            Operación / Equipo
          </div>
          <h1 className="v2-h1" style={{ fontSize: "var(--v2-fs-2xl)" }}>
            Equipo
          </h1>
          <div style={{
            color: "var(--v2-text-muted)",
            fontSize: "var(--v2-fs-sm)",
            marginTop: "var(--v2-space-1)",
          }}>
            {empleadosActivos} empleados activos · {calendars.length} calendarios de pago configurados
          </div>
        </div>

        <div style={{ display: "flex", gap: "var(--v2-space-2)" }}>
          <Button variant="outline" size="md" icon={<Bell size={14} />}>
            Notificaciones
          </Button>
          <Button variant="primary" size="md">
            + Nuevo empleado
          </Button>
        </div>
      </div>

      {/* === KPI GRID === */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "var(--v2-space-3)",
        marginBottom: "var(--v2-space-6)",
      }}>
        <StatCard
          hero
          icon={<Wallet size={14} />}
          label="Nómina del mes"
          value={`$${formatMoney(nominaMes)}`}
          sub="Mayo 2026 · 14 empleados"
          trend="up"
          trendValue="3.2% vs abril"
        />
        <StatCard
          icon={<Users size={14} />}
          label="Empleados activos"
          value={empleadosActivos}
          sub={Object.entries(empleadosPorModo).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(" · ")}
        />
        <StatCard
          icon={<Calendar size={14} />}
          label="Próximo pago"
          value="3 días"
          sub="Quincenales: 16-may"
          status="atencion"
          statusText="Tenés que cerrar hoy"
        />
        <StatCard
          icon={<TrendingUp size={14} />}
          label="Próximo SAC"
          value="33 días"
          sub="30-jun · 1ra cuota 2026"
          status="ok"
          statusText="Acumulado al día"
        />
      </div>

      {/* === CERRAR HOY === */}
      <div className="v2-surface" style={{ marginBottom: "var(--v2-space-4)" }}>
        <div style={{
          padding: "var(--v2-space-4) var(--v2-space-5)",
          borderBottom: "1px solid var(--v2-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <div>
            <div style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--v2-space-2)",
              marginBottom: "var(--v2-space-1)",
            }}>
              <h2 className="v2-h2">Cerrar hoy</h2>
              {cerrarHoy.length > 0 && <Badge variant="atencion" dot>{cerrarHoy.length} pendientes</Badge>}
            </div>
            <div className="v2-text-muted" style={{ fontSize: "var(--v2-fs-sm)" }}>
              Liquidaciones que vencen hoy o están atrasadas
            </div>
          </div>
          <Button variant="ghost" size="sm" iconRight={<ArrowRight size={14} />}>
            Ver todas
          </Button>
        </div>

        {cerrarHoy.length === 0 ? (
          <div style={{
            padding: "var(--v2-space-8)",
            textAlign: "center",
            color: "var(--v2-text-muted)",
            fontSize: "var(--v2-fs-sm)",
          }}>
            No hay liquidaciones para cerrar hoy.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={tableHeadStyle}>Empleado</th>
                <th style={tableHeadStyle}>Período</th>
                <th style={tableHeadStyle}>Local</th>
                <th style={{ ...tableHeadStyle, textAlign: "right" }}>Total</th>
                <th style={{ ...tableHeadStyle, textAlign: "right", width: 140 }}>Acción</th>
              </tr>
            </thead>
            <tbody>
              {cerrarHoy.map(c => (
                <tr key={c.empleado_id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                  <td style={tableCellStyle}>
                    <div style={{ color: "var(--v2-text-strong)", fontWeight: 600 }}>
                      {c.empleado_nombre}
                    </div>
                  </td>
                  <td style={tableCellStyle}>{c.periodo_label}</td>
                  <td style={tableCellStyle}>{c.local_nombre}</td>
                  <td style={{ ...tableCellStyle, textAlign: "right" }}>
                    <span className="v2-mono" style={{ color: "var(--v2-dorado)", fontWeight: 700 }}>
                      ${formatMoney(c.total)}
                    </span>
                  </td>
                  <td style={{ ...tableCellStyle, textAlign: "right" }}>
                    <Button variant="premium" size="sm">Pagar</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* === EMPLEADOS LIST === */}
      <div className="v2-surface">
        <div style={{
          padding: "var(--v2-space-4) var(--v2-space-5)",
          borderBottom: "1px solid var(--v2-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <h2 className="v2-h2">Empleados activos</h2>
          <div style={{ display: "flex", gap: "var(--v2-space-2)" }}>
            <Button variant="ghost" size="sm">Filtros</Button>
            <Button variant="ghost" size="sm">Exportar</Button>
          </div>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={tableHeadStyle}>Nombre</th>
              <th style={tableHeadStyle}>Puesto</th>
              <th style={tableHeadStyle}>Modo de pago</th>
              <th style={{ ...tableHeadStyle, textAlign: "right" }}>Sueldo base</th>
              <th style={{ ...tableHeadStyle, textAlign: "right", width: 120 }}>Acción</th>
            </tr>
          </thead>
          <tbody>
            {empleados.length === 0 ? (
              <tr>
                <td colSpan={5} style={{
                  ...tableCellStyle,
                  textAlign: "center",
                  color: "var(--v2-text-muted)",
                  padding: "var(--v2-space-8)",
                }}>
                  No hay empleados activos en este tenant.
                </td>
              </tr>
            ) : (
              empleados.map(e => (
                <tr key={e.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                  <td style={tableCellStyle}>
                    <div style={{ color: "var(--v2-text-strong)", fontWeight: 600 }}>
                      {e.apellido}, {e.nombre}
                    </div>
                  </td>
                  <td style={tableCellStyle}>{e.puesto}</td>
                  <td style={tableCellStyle}>
                    <Badge variant="info">{e.modo_pago}</Badge>
                  </td>
                  <td style={{ ...tableCellStyle, textAlign: "right" }}>
                    <span className="v2-mono">${formatMoney(e.sueldo_mensual)}</span>
                  </td>
                  <td style={{ ...tableCellStyle, textAlign: "right" }}>
                    <Button variant="ghost" size="sm" iconRight={<ArrowRight size={12} />}>
                      Ver
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}

// Helpers
function formatMoney(n: number): string {
  return new Intl.NumberFormat("es-AR").format(Math.round(n ?? 0));
}

const tableHeadStyle = {
  textAlign: "left" as const,
  padding: "var(--v2-space-3) var(--v2-space-4)",
  fontSize: "var(--v2-fs-xs)",
  fontWeight: 700 as const,
  letterSpacing: "var(--v2-tracking-wider)",
  textTransform: "uppercase" as const,
  color: "var(--v2-text-subtle)",
  background: "var(--v2-bg-3)",
  borderBottom: "1px solid var(--v2-border)",
};

const tableCellStyle = {
  padding: "var(--v2-space-3) var(--v2-space-4)",
  fontSize: "var(--v2-fs-sm)",
  color: "var(--v2-text)",
};
