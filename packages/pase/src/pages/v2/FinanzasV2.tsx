// PASE V2 — Finanzas
//
// Pantalla "tesorería + conciliación bancaria/MP":
// - KPIs: Saldo total, MP por conciliar, Cheques pendientes
// - Tabs: Saldos / Conciliación MP / Conciliación bancaria
//
// Spec: docs/superpowers/specs/2026-05-28-caja-finanzas-pl-rediseno.md

import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { useAuth, applyLocalScope } from "../../lib/auth";
import { Wallet, Banknote, AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "../../components/v2/Button";
import { StatCard } from "../../components/v2/StatCard";
import { PageHeader } from "../../components/v2/PageHeader";
import { Tabs } from "../../components/v2/Tabs";
import { Badge } from "../../components/v2/Badge";

interface Saldo {
  cuenta: string;
  saldo: number;
}

interface MPMov {
  id: string;
  fecha: string;
  monto: number;
  descripcion: string | null;
  tipo: string | null;
}

interface Props {
  localActivo: number | null;
}

export default function FinanzasV2({ localActivo }: Props) {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<"saldos" | "mp">("saldos");
  const [saldos, setSaldos] = useState<Saldo[]>([]);
  const [mpPendientes, setMpPendientes] = useState<MPMov[]>([]);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      const saldosQ = db.from("saldos_caja").select("cuenta, saldo");
      const mpQ = db.from("mp_movimientos")
        .select("id, fecha, monto, descripcion, tipo")
        .order("fecha", { ascending: false })
        .limit(50);

      const [saldosRes, mpRes] = await Promise.all([
        applyLocalScope(saldosQ, user, localActivo),
        applyLocalScope(mpQ, user, localActivo),
      ]);

      const byCuenta = new Map<string, number>();
      (saldosRes.data ?? []).forEach((s: { cuenta: string; saldo: number }) => {
        byCuenta.set(s.cuenta, (byCuenta.get(s.cuenta) ?? 0) + Number(s.saldo ?? 0));
      });
      setSaldos(Array.from(byCuenta.entries()).map(([cuenta, saldo]) => ({ cuenta, saldo })).sort((a, b) => b.saldo - a.saldo));
      setMpPendientes((mpRes.data ?? []) as MPMov[]);
    } finally {
      setLoading(false);
    }
  }
useEffect(() => {
    if (!user?.tenant_id) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenant_id, localActivo]);


  const totalSaldos = saldos.reduce((s, c) => s + c.saldo, 0);

  if (loading) return <div style={{ color: "var(--v2-text-muted)" }}>Cargando…</div>;

  return (
    <div>
      <PageHeader
        eyebrow="Dirección / Finanzas"
        title="Finanzas"
        sub={`${saldos.length} cuentas · ${mpPendientes.length} mov MP recientes`}
        actions={
          <Button variant="outline" size="md" icon={<RefreshCw size={14} />}>
            Sincronizar MP
          </Button>
        }
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "var(--v2-space-3)",
        marginBottom: "var(--v2-space-6)",
      }}>
        <StatCard hero icon={<Wallet size={14} />} label="Saldo total" value={`$${formatMoney(totalSaldos)}`} sub={`${saldos.length} cuentas`} />
        <StatCard icon={<Banknote size={14} />} label="Movimientos MP" value={mpPendientes.length} sub="Últimos 50" />
        <StatCard
          icon={<AlertCircle size={14} />}
          label="Por conciliar"
          value={Math.max(0, mpPendientes.length - 20)}
          status={mpPendientes.length > 20 ? "atencion" : "ok"}
          statusText={mpPendientes.length > 20 ? "Revisar" : "Al día"}
        />
      </div>

      <Tabs
        tabs={[
          { id: "saldos", label: "Saldos por cuenta", icon: <Wallet size={14} /> },
          { id: "mp", label: "Mercado Pago", icon: <Banknote size={14} /> },
        ]}
        activeId={activeTab}
        onChange={id => setActiveTab(id as typeof activeTab)}
      />

      <div className="v2-surface" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
        {activeTab === "saldos" && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Cuenta</th>
                <th style={{ ...th, textAlign: "right" }}>Saldo</th>
                <th style={{ ...th, textAlign: "right" }}>% del total</th>
              </tr>
            </thead>
            <tbody>
              {saldos.length === 0 ? (
                <tr><td colSpan={3} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>Sin saldos.</td></tr>
              ) : saldos.map(s => {
                const pct = totalSaldos > 0 ? (s.saldo / totalSaldos) * 100 : 0;
                return (
                  <tr key={s.cuenta} style={{ borderTop: "1px solid var(--v2-border)" }}>
                    <td style={td}><span style={{ fontWeight: 600, color: "var(--v2-text-strong)" }}>{s.cuenta}</span></td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <span className="v2-mono" style={{ color: s.saldo < 0 ? "var(--v2-rojo)" : "var(--v2-text-strong)", fontWeight: 600 }}>
                        ${formatMoney(s.saldo)}
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <span className="v2-mono v2-text-subtle">{pct.toFixed(1)}%</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {activeTab === "mp" && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Fecha</th>
                <th style={th}>Tipo</th>
                <th style={th}>Descripción</th>
                <th style={{ ...th, textAlign: "right" }}>Monto</th>
              </tr>
            </thead>
            <tbody>
              {mpPendientes.length === 0 ? (
                <tr><td colSpan={4} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>Sin movimientos MP recientes.</td></tr>
              ) : mpPendientes.map(m => (
                <tr key={m.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                  <td style={td}><span className="v2-mono">{fmtDate(m.fecha)}</span></td>
                  <td style={td}>{m.tipo ? <Badge variant="info">{m.tipo}</Badge> : "—"}</td>
                  <td style={td}><span style={{ fontSize: "var(--v2-fs-xs)" }}>{m.descripcion ?? "—"}</span></td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <span className="v2-mono" style={{
                      color: m.monto >= 0 ? "var(--v2-celeste)" : "var(--v2-text)",
                      fontWeight: 600,
                    }}>
                      {m.monto >= 0 ? "+" : ""}${formatMoney(Math.abs(m.monto))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function formatMoney(n: number) { return new Intl.NumberFormat("es-AR").format(Math.round(n ?? 0)); }
function fmtDate(s: string) { return new Date(s).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit" }); }

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
