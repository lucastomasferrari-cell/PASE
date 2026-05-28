// PASE V2 — Caja
//
// Pantalla "ruta del dinero": saldos por cuenta + movimientos del período
// + acciones rápidas (nuevo movimiento / transferencia).
//
// Spec: docs/superpowers/specs/2026-05-28-caja-finanzas-pl-rediseno.md

import { useEffect, useState, useMemo } from "react";
import { db } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { applyLocalScope } from "../../lib/auth";
import { Plus, ArrowLeftRight, Filter, Download } from "lucide-react";
import { Button } from "../../components/v2/Button";
import { Badge } from "../../components/v2/Badge";
import { PageHeader } from "../../components/v2/PageHeader";
import { Select } from "../../components/v2/Select";

interface Saldo {
  cuenta: string;
  saldo: number;
}

interface Mov {
  id: number;
  fecha: string;
  importe: number;
  tipo: string;
  detalle: string | null;
  cuenta: string;
  local_id: number;
}

interface Props {
  localActivo: number | null;
}

export default function CajaV2({ localActivo }: Props) {
  const { user } = useAuth();
  const [saldos, setSaldos] = useState<Saldo[]>([]);
  const [movs, setMovs] = useState<Mov[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroCuenta, setFiltroCuenta] = useState<string>("__all");
  async function load() {
    setLoading(true);
    try {
      const saldosQ = db.from("saldos_caja").select("cuenta, saldo");
      const movsQ = db.from("movimientos")
        .select("id, fecha, importe, tipo, detalle, cuenta, local_id")
        .eq("anulado", false)
        .order("fecha", { ascending: false })
        .limit(30);

      const [saldosRes, movsRes] = await Promise.all([
        applyLocalScope(saldosQ, user, localActivo),
        applyLocalScope(movsQ, user, localActivo),
      ]);

      // Agregar por cuenta (suma de todos los locales activos)
      const byCuenta = new Map<string, number>();
      (saldosRes.data ?? []).forEach((s: { cuenta: string; saldo: number }) => {
        byCuenta.set(s.cuenta, (byCuenta.get(s.cuenta) ?? 0) + Number(s.saldo ?? 0));
      });
      setSaldos(Array.from(byCuenta.entries()).map(([cuenta, saldo]) => ({ cuenta, saldo })).sort((a, b) => b.saldo - a.saldo));

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


  const total = saldos.reduce((s, c) => s + c.saldo, 0);

  const movsFiltrados = useMemo(() => {
    if (filtroCuenta === "__all") return movs;
    return movs.filter(m => m.cuenta === filtroCuenta);
  }, [movs, filtroCuenta]);

  if (loading) {
    return <div style={{ color: "var(--v2-text-muted)" }}>Cargando…</div>;
  }

  return (
    <div>
      <PageHeader
        eyebrow="Operación / Caja"
        title="Caja"
        sub={`${saldos.length} cuentas activas · Total $${formatMoney(total)}`}
        actions={
          <>
            <Button variant="outline" size="md" icon={<ArrowLeftRight size={14} />}>
              Transferir
            </Button>
            <Button variant="primary" size="md" icon={<Plus size={14} />}>
              Nuevo movimiento
            </Button>
          </>
        }
      />

      {/* === SALDOS POR CUENTA === */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
        gap: "var(--v2-space-3)",
        marginBottom: "var(--v2-space-6)",
      }}>
        {saldos.map(s => (
          <div key={s.cuenta} className="v2-surface" style={{
            padding: "var(--v2-space-4)",
            cursor: "pointer",
            transition: "border-color var(--v2-tr-fast)",
          }}
          onClick={() => setFiltroCuenta(s.cuenta)}
          >
            <div className="v2-eyebrow" style={{ marginBottom: "var(--v2-space-2)" }}>
              {s.cuenta}
            </div>
            <div className="v2-mono" style={{
              fontSize: "var(--v2-fs-xl)",
              fontWeight: 700,
              color: s.saldo < 0 ? "var(--v2-rojo)" : "var(--v2-text-strong)",
              letterSpacing: "var(--v2-tracking-tight)",
            }}>
              ${formatMoney(s.saldo)}
            </div>
          </div>
        ))}
      </div>

      {/* === MOVIMIENTOS === */}
      <div className="v2-surface">
        <div style={{
          padding: "var(--v2-space-4) var(--v2-space-5)",
          borderBottom: "1px solid var(--v2-border)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "var(--v2-space-3)",
          flexWrap: "wrap",
        }}>
          <div>
            <h2 className="v2-h2">Últimos movimientos</h2>
            <div className="v2-text-muted" style={{ fontSize: "var(--v2-fs-sm)", marginTop: 2 }}>
              {movsFiltrados.length} de {movs.length} registros
            </div>
          </div>
          <div style={{ display: "flex", gap: "var(--v2-space-2)", alignItems: "flex-end" }}>
            <Select
              value={filtroCuenta}
              onChange={e => setFiltroCuenta(e.target.value)}
              containerStyle={{ minWidth: 200 }}
            >
              <option value="__all">Todas las cuentas</option>
              {saldos.map(s => (
                <option key={s.cuenta} value={s.cuenta}>{s.cuenta}</option>
              ))}
            </Select>
            <Button variant="ghost" size="md" icon={<Filter size={14} />}>Filtros</Button>
            <Button variant="ghost" size="md" icon={<Download size={14} />}>Exportar</Button>
          </div>
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
            {movsFiltrados.length === 0 ? (
              <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>
                Sin movimientos para los filtros aplicados.
              </td></tr>
            ) : movsFiltrados.map(m => (
              <tr key={m.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                <td style={td}><span className="v2-mono">{fmtDate(m.fecha)}</span></td>
                <td style={td}>
                  <Badge variant={m.importe >= 0 ? "info" : "neutro"}>{m.tipo}</Badge>
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

function formatMoney(n: number) {
  return new Intl.NumberFormat("es-AR").format(Math.round(n ?? 0));
}

function fmtDate(s: string) {
  return new Date(s).toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit" });
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
