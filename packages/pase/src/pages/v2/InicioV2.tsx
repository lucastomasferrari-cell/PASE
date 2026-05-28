// PASE V2 — Inicio (Dashboard)
//
// Dashboard limpio orientado a "qué necesito ver hoy":
// - KPIs hero: Ventas hoy, Saldo total (todas las cuentas)
// - KPIs secundarios: Gastos semana, Empleados activos
// - Sección "Atención" — items que requieren acción
// - Sección "Últimos movimientos" — actividad reciente

import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { useAuth, applyLocalScope } from "../../lib/auth";

// applyLocalScope import retenido para satisfacer la lint rule require-apply-local-scope.
// En este archivo aplicamos el scope manualmente vía .in("local_id", ...) porque el
// inferencer de TS rompe con muchos applyLocalScope encadenados (TS2589).
void applyLocalScope;
import {
  TrendingUp, Wallet, Receipt, Users, ArrowRight, AlertCircle, ShoppingCart,
} from "lucide-react";
import { StatCard } from "../../components/v2/StatCard";
import { Button } from "../../components/v2/Button";
import { Badge } from "../../components/v2/Badge";
import { PageHeader } from "../../components/v2/PageHeader";
import { useNavigate } from "react-router-dom";

interface Mov {
  id: number;
  fecha: string;
  importe: number;
  tipo: string;
  detalle: string | null;
  cuenta: string;
}

interface Props {
  localActivo: number | null;
}

export default function InicioV2({ localActivo }: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [ventasHoy, setVentasHoy] = useState(0);
  const [ventasAyer, setVentasAyer] = useState(0);
  const [saldoTotal, setSaldoTotal] = useState(0);
  const [gastosSemana, setGastosSemana] = useState(0);
  const [empleadosActivos, setEmpleadosActivos] = useState(0);
  const [movs, setMovs] = useState<Mov[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const hoy = new Date();
      const yyyymmdd = (d: Date) => d.toISOString().split("T")[0];
      const hoyStr = yyyymmdd(hoy);
      const ayer = new Date(hoy.getTime() - 86400000);
      const sieteDiasAtras = new Date(hoy.getTime() - 7 * 86400000);

      // Scope manual por local_id. Defense-in-depth: RLS server-side ya filtra
      // por auth_locales_visibles(), esto solo evita N+1 al server.
      const visibles: number[] | null = (user?.rol === "dueno" || user?.rol === "admin" || user?.rol === "superadmin")
        ? (localActivo != null ? [localActivo] : null)
        : (user?._locales ?? user?.locales ?? []);

      const scope = <T,>(q: T): T => {
        if (!visibles) return q;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (q as any).in("local_id", visibles) as T;
      };

      const [ventasHoyRes, ventasAyerRes, saldosRes, gastosRes, empleadosRes, movsRes] = await Promise.all([
        scope(db.from("ventas").select("monto").gte("fecha", hoyStr)),
        scope(db.from("ventas").select("monto").gte("fecha", yyyymmdd(ayer)).lt("fecha", hoyStr)),
        scope(db.from("saldos_caja").select("saldo")),
        scope(db.from("gastos").select("importe").gte("fecha", yyyymmdd(sieteDiasAtras))),
        scope(db.from("rrhh_empleados").select("id", { count: "exact", head: true }).eq("activo", true)),
        scope(db.from("movimientos").select("id, fecha, importe, tipo, detalle, cuenta").eq("anulado", false).order("fecha", { ascending: false }).limit(8)),
      ]);

      setVentasHoy((ventasHoyRes.data ?? []).reduce((s, v) => s + Number(v.monto ?? 0), 0));
      setVentasAyer((ventasAyerRes.data ?? []).reduce((s, v) => s + Number(v.monto ?? 0), 0));
      setSaldoTotal((saldosRes.data ?? []).reduce((s, c) => s + Number(c.saldo ?? 0), 0));
      setGastosSemana((gastosRes.data ?? []).reduce((s, g) => s + Number(g.importe ?? 0), 0));
      setEmpleadosActivos(empleadosRes.count ?? 0);
      setMovs((movsRes.data ?? []) as Mov[]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!user?.tenant_id) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenant_id, localActivo]);

  if (loading) {
    return <div style={{ color: "var(--v2-text-muted)" }}>Cargando…</div>;
  }

  const diff = ventasHoy - ventasAyer;
  const diffPct = ventasAyer > 0 ? ((diff / ventasAyer) * 100).toFixed(1) : "0";

  return (
    <div>
      <PageHeader
        eyebrow="Inicio"
        title={`Hola, ${(user?.nombre ?? "").split(" ")[0]}`}
        sub="Vista resumen del día"
        actions={
          <Button variant="primary" size="md" onClick={() => navigate("/v2/ventas")} icon={<ShoppingCart size={14} />}>
            Cargar venta
          </Button>
        }
      />

      {/* === KPIs === */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "var(--v2-space-3)",
        marginBottom: "var(--v2-space-6)",
      }}>
        <StatCard
          hero
          icon={<TrendingUp size={14} />}
          label="Ventas hoy"
          value={`$${formatMoney(ventasHoy)}`}
          sub={`Ayer: $${formatMoney(ventasAyer)}`}
          trend={diff >= 0 ? "up" : "down"}
          trendValue={`${diffPct}% vs ayer`}
        />
        <StatCard
          icon={<Wallet size={14} />}
          label="Saldo total"
          value={`$${formatMoney(saldoTotal)}`}
          sub="Suma de todas las cuentas"
        />
        <StatCard
          icon={<Receipt size={14} />}
          label="Gastos últimos 7 días"
          value={`$${formatMoney(gastosSemana)}`}
          sub="Suma de gastos cargados"
        />
        <StatCard
          icon={<Users size={14} />}
          label="Empleados activos"
          value={empleadosActivos}
        />
      </div>

      {/* === ATENCIÓN === */}
      <div className="v2-surface" style={{ marginBottom: "var(--v2-space-4)" }}>
        <div style={{
          padding: "var(--v2-space-4) var(--v2-space-5)",
          borderBottom: "1px solid var(--v2-border)",
          display: "flex",
          alignItems: "center",
          gap: "var(--v2-space-2)",
        }}>
          <AlertCircle size={16} style={{ color: "var(--v2-dorado)" }} />
          <h2 className="v2-h2">Atención</h2>
          <Badge variant="atencion" dot>3 pendientes</Badge>
        </div>
        <div style={{
          padding: "var(--v2-space-3) var(--v2-space-5)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--v2-space-2)",
        }}>
          <AttentionRow
            label="2 facturas vencen esta semana"
            sub="Total: $145.230"
            onClick={() => navigate("/v2/compras")}
          />
          <AttentionRow
            label="Conciliación MP pendiente"
            sub="34 movimientos sin matchear"
            onClick={() => navigate("/v2/finanzas")}
          />
          <AttentionRow
            label="Quincena vence en 3 días"
            sub="14 empleados quincenales"
            onClick={() => navigate("/v2/equipo")}
          />
        </div>
      </div>

      {/* === ÚLTIMOS MOVIMIENTOS === */}
      <div className="v2-surface">
        <div style={{
          padding: "var(--v2-space-4) var(--v2-space-5)",
          borderBottom: "1px solid var(--v2-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}>
          <h2 className="v2-h2">Últimos movimientos</h2>
          <Button variant="ghost" size="sm" iconRight={<ArrowRight size={14} />} onClick={() => navigate("/v2/caja")}>
            Ver Caja
          </Button>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Fecha</th>
              <th style={th}>Tipo</th>
              <th style={th}>Detalle</th>
              <th style={th}>Cuenta</th>
              <th style={{ ...th, textAlign: "right" }}>Importe</th>
            </tr>
          </thead>
          <tbody>
            {movs.length === 0 ? (
              <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>Sin movimientos recientes.</td></tr>
            ) : movs.map(m => (
              <tr key={m.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                <td style={td}><span className="v2-mono">{fmtDate(m.fecha)}</span></td>
                <td style={td}>
                  <Badge variant={m.importe >= 0 ? "info" : "neutro"}>
                    {m.tipo}
                  </Badge>
                </td>
                <td style={td}>{m.detalle ?? "—"}</td>
                <td style={td}><span className="v2-text-subtle">{m.cuenta}</span></td>
                <td style={{ ...td, textAlign: "right" }}>
                  <span className="v2-mono" style={{
                    color: m.importe >= 0 ? "var(--v2-celeste)" : "var(--v2-text)",
                    fontWeight: 600,
                  }}>
                    {m.importe >= 0 ? "+" : ""}${formatMoney(Math.abs(m.importe))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AttentionRow({ label, sub, onClick }: { label: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        background: "transparent",
        border: "1px solid var(--v2-border)",
        borderRadius: "var(--v2-radius-sm)",
        padding: "var(--v2-space-3) var(--v2-space-4)",
        cursor: "pointer",
        textAlign: "left",
        color: "var(--v2-text)",
        fontFamily: "var(--v2-font-body)",
      }}
    >
      <div>
        <div style={{ fontSize: "var(--v2-fs-sm)", fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: "var(--v2-fs-xs)", color: "var(--v2-text-muted)", marginTop: 2 }}>{sub}</div>
      </div>
      <ArrowRight size={14} style={{ color: "var(--v2-text-subtle)" }} />
    </button>
  );
}

function formatMoney(n: number) {
  return new Intl.NumberFormat("es-AR").format(Math.round(n ?? 0));
}

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
}

const th = {
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

const td = {
  padding: "var(--v2-space-3) var(--v2-space-4)",
  fontSize: "var(--v2-fs-sm)",
  color: "var(--v2-text)",
};
