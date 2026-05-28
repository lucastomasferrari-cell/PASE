// PASE V2 — Compras
//
// Tabs: Facturas / Remitos / Proveedores
// KPIs: Por pagar / Vencidas / Total mes
//
// Spec: docs/superpowers/specs/2026-05-28-compras-proveedores-ap-rediseno.md

import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { useAuth, applyLocalScope } from "../../lib/auth";
import { Plus, FileText, Truck, Users, AlertCircle, Wallet } from "lucide-react";
import { Button } from "../../components/v2/Button";
import { Badge } from "../../components/v2/Badge";
import { StatCard } from "../../components/v2/StatCard";
import { PageHeader } from "../../components/v2/PageHeader";
import { Tabs } from "../../components/v2/Tabs";

interface Factura {
  id: number;
  fecha: string;
  numero: string | null;
  total: number;
  saldo: number;
  proveedor_id: number | null;
  proveedor_nombre?: string;
  fecha_vencimiento: string | null;
  estado: string;
}

interface Remito {
  id: number;
  fecha: string;
  numero: string | null;
  total: number;
  proveedor_id: number | null;
  proveedor_nombre?: string;
  estado: string;
}

interface Proveedor {
  id: number;
  nombre: string;
  cuit: string | null;
  estado: string;
  saldo_actual?: number;
}

interface Props {
  localActivo: number | null;
}

export default function ComprasV2({ localActivo }: Props) {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<"facturas" | "remitos" | "proveedores">("facturas");
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [remitos, setRemitos] = useState<Remito[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      const fQ = db.from("facturas")
        .select("id, fecha, numero, total, saldo, proveedor_id, fecha_vencimiento, estado, proveedores(nombre)")
        .order("fecha", { ascending: false })
        .limit(100);
      const rQ = db.from("remitos")
        .select("id, fecha, numero, total, proveedor_id, estado, proveedores(nombre)")
        .order("fecha", { ascending: false })
        .limit(100);
      const pQ = db.from("proveedores")
        .select("id, nombre, cuit, estado")
        .eq("estado", "Activo")
        .order("nombre");

      const [fRes, rRes, pRes] = await Promise.all([
        applyLocalScope(fQ, user, localActivo),
        applyLocalScope(rQ, user, localActivo),
        pQ,
      ]);

      // Supabase nested join devuelve array (incluso para FK one-to-many con un solo padre)
      type FacRaw = Factura & { proveedores?: { nombre: string }[] | { nombre: string } | null };
      setFacturas(((fRes.data ?? []) as unknown as FacRaw[]).map(f => {
        const prov = Array.isArray(f.proveedores) ? f.proveedores[0] : f.proveedores;
        return { ...f, proveedor_nombre: prov?.nombre ?? "—" };
      }));
      type RemRaw = Remito & { proveedores?: { nombre: string }[] | { nombre: string } | null };
      setRemitos(((rRes.data ?? []) as unknown as RemRaw[]).map(r => {
        const prov = Array.isArray(r.proveedores) ? r.proveedores[0] : r.proveedores;
        return { ...r, proveedor_nombre: prov?.nombre ?? "—" };
      }));
      setProveedores((pRes.data ?? []) as Proveedor[]);
    } finally {
      setLoading(false);
    }
  }
useEffect(() => {
    if (!user?.tenant_id) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenant_id, localActivo]);


  const facturasPendientes = facturas.filter(f => Number(f.saldo ?? 0) > 0);
  const totalPendiente = facturasPendientes.reduce((s, f) => s + Number(f.saldo ?? 0), 0);
  const hoy: string = new Date().toISOString().slice(0, 10);
  const hace30: string = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const vencidas = facturasPendientes.filter(f => f.fecha_vencimiento && f.fecha_vencimiento < hoy);
  const totalMes = facturas
    .filter(f => f.fecha >= hace30)
    .reduce((s, f) => s + Number(f.total ?? 0), 0);

  if (loading) return <div style={{ color: "var(--v2-text-muted)" }}>Cargando…</div>;

  return (
    <div>
      <PageHeader
        eyebrow="Operación / Compras"
        title="Compras"
        sub={`${facturas.length} facturas · ${remitos.length} remitos · ${proveedores.length} proveedores`}
        actions={
          <>
            <Button variant="outline" size="md" icon={<Plus size={14} />}>Nuevo proveedor</Button>
            <Button variant="primary" size="md" icon={<Plus size={14} />}>Cargar factura</Button>
          </>
        }
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "var(--v2-space-3)",
        marginBottom: "var(--v2-space-6)",
      }}>
        <StatCard hero icon={<Wallet size={14} />} label="A pagar" value={`$${formatMoney(totalPendiente)}`} sub={`${facturasPendientes.length} facturas pendientes`} />
        <StatCard
          icon={<AlertCircle size={14} />}
          label="Vencidas"
          value={vencidas.length}
          sub={`$${formatMoney(vencidas.reduce((s, f) => s + Number(f.saldo ?? 0), 0))}`}
          status={vencidas.length > 0 ? "atencion" : "ok"}
          statusText={vencidas.length > 0 ? "Requieren acción" : "Al día"}
        />
        <StatCard icon={<FileText size={14} />} label="Total mes" value={`$${formatMoney(totalMes)}`} sub="Últimos 30 días" />
      </div>

      <Tabs
        tabs={[
          { id: "facturas", label: "Facturas", icon: <FileText size={14} />, badge: <Badge variant="neutro">{facturas.length}</Badge> },
          { id: "remitos", label: "Remitos", icon: <Truck size={14} />, badge: <Badge variant="neutro">{remitos.length}</Badge> },
          { id: "proveedores", label: "Proveedores", icon: <Users size={14} />, badge: <Badge variant="neutro">{proveedores.length}</Badge> },
        ]}
        activeId={activeTab}
        onChange={id => setActiveTab(id as typeof activeTab)}
      />

      <div className="v2-surface" style={{ marginTop: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
        {activeTab === "facturas" && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Fecha</th>
                <th style={th}>Número</th>
                <th style={th}>Proveedor</th>
                <th style={th}>Estado</th>
                <th style={th}>Vence</th>
                <th style={{ ...th, textAlign: "right" }}>Total</th>
                <th style={{ ...th, textAlign: "right" }}>Saldo</th>
              </tr>
            </thead>
            <tbody>
              {facturas.length === 0 ? (
                <tr><td colSpan={7} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>Sin facturas.</td></tr>
              ) : facturas.map(f => {
                const saldoVal = Number(f.saldo ?? 0);
                const vencida = f.fecha_vencimiento && f.fecha_vencimiento < hoy && saldoVal > 0;
                return (
                  <tr key={f.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                    <td style={td}><span className="v2-mono">{fmtDate(f.fecha)}</span></td>
                    <td style={td}><span className="v2-mono">{f.numero ?? "—"}</span></td>
                    <td style={td}>{f.proveedor_nombre}</td>
                    <td style={td}>
                      {saldoVal === 0
                        ? <Badge variant="neutro">Pagada</Badge>
                        : vencida
                        ? <Badge variant="error">Vencida</Badge>
                        : <Badge variant="atencion">Pendiente</Badge>}
                    </td>
                    <td style={td}><span className="v2-mono v2-text-muted">{f.fecha_vencimiento ? fmtDate(f.fecha_vencimiento) : "—"}</span></td>
                    <td style={{ ...td, textAlign: "right" }}><span className="v2-mono">${formatMoney(f.total)}</span></td>
                    <td style={{ ...td, textAlign: "right" }}>
                      <span className="v2-mono" style={{
                        color: saldoVal > 0 ? "var(--v2-dorado)" : "var(--v2-text-subtle)",
                        fontWeight: 600,
                      }}>${formatMoney(saldoVal)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {activeTab === "remitos" && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Fecha</th>
                <th style={th}>Número</th>
                <th style={th}>Proveedor</th>
                <th style={th}>Estado</th>
                <th style={{ ...th, textAlign: "right" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {remitos.length === 0 ? (
                <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>Sin remitos.</td></tr>
              ) : remitos.map(r => (
                <tr key={r.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                  <td style={td}><span className="v2-mono">{fmtDate(r.fecha)}</span></td>
                  <td style={td}><span className="v2-mono">{r.numero ?? "—"}</span></td>
                  <td style={td}>{r.proveedor_nombre}</td>
                  <td style={td}><Badge variant="info">{r.estado}</Badge></td>
                  <td style={{ ...td, textAlign: "right" }}><span className="v2-mono">${formatMoney(r.total)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeTab === "proveedores" && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Nombre</th>
                <th style={th}>CUIT</th>
                <th style={th}>Estado</th>
              </tr>
            </thead>
            <tbody>
              {proveedores.length === 0 ? (
                <tr><td colSpan={3} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>Sin proveedores.</td></tr>
              ) : proveedores.map(p => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                  <td style={td}>
                    <div style={{ fontWeight: 600, color: "var(--v2-text-strong)" }}>{p.nombre}</div>
                  </td>
                  <td style={td}><span className="v2-mono v2-text-muted">{p.cuit ?? "—"}</span></td>
                  <td style={td}><Badge variant="info">{p.estado}</Badge></td>
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
