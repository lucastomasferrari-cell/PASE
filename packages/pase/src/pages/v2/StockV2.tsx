// PASE V2 — Stock
//
// Tabs: Insumos / Items / Recetas / Mermas
// KPIs: Valor stock / Insumos críticos / CMV mensual
//
// Specs:
//   - docs/superpowers/specs/2026-05-28-catalogo-recetas-rediseno.md
//   - docs/superpowers/specs/2026-05-28-stock-cmv-avt-rediseno.md

import { useEffect, useState } from "react";
import { db } from "../../lib/supabase";
import { useAuth } from "../../lib/auth";
import { Plus, Package, ChefHat, Layers, AlertCircle, TrendingDown } from "lucide-react";
import { Button } from "../../components/v2/Button";
import { Badge } from "../../components/v2/Badge";
import { StatCard } from "../../components/v2/StatCard";
import { PageHeader } from "../../components/v2/PageHeader";
import { Tabs } from "../../components/v2/Tabs";

interface Insumo {
  id: number;
  nombre: string;
  unidad: string | null;
  precio_actual: number | null;
  stock_minimo: number | null;
  stock_actual: number | null;
  categoria: string | null;
}

interface Item {
  id: number;
  nombre: string;
  precio_venta: number | null;
  estado: string;
  categoria: string | null;
}

interface Receta {
  id: number;
  item_id: number;
  cmv_total: number | null;
  item_nombre?: string;
  margen_pct?: number | null;
}

interface Props {
  localActivo: number | null;
}

export default function StockV2({ localActivo }: Props) {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<"insumos" | "items" | "recetas">("insumos");
  const [insumos, setInsumos] = useState<Insumo[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [recetas, setRecetas] = useState<Receta[]>([]);
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    try {
      const iQ = db.from("insumos").select("id, nombre, unidad, precio_actual, stock_minimo, stock_actual, categoria").order("nombre");
      const itQ = db.from("items").select("id, nombre, precio_venta, estado, categoria").eq("estado", "disponible").order("nombre");
      const rQ = db.from("recetas").select("id, item_id, cmv_total, items(nombre, precio_venta)").limit(200);

      const [iRes, itRes, rRes] = await Promise.all([iQ, itQ, rQ]);

      setInsumos((iRes.data ?? []) as Insumo[]);
      setItems((itRes.data ?? []) as Item[]);
      type RecetaRaw = Receta & { items?: { nombre: string; precio_venta: number | null }[] | { nombre: string; precio_venta: number | null } | null };
      setRecetas(((rRes.data ?? []) as unknown as RecetaRaw[]).map(r => {
        const item = Array.isArray(r.items) ? r.items[0] : r.items;
        const precio = item?.precio_venta ?? 0;
        const cmv = r.cmv_total ?? 0;
        const margenPct = precio > 0 ? ((precio - cmv) / precio) * 100 : null;
        return {
          ...r,
          item_nombre: item?.nombre ?? "—",
          margen_pct: margenPct,
        };
      }));
    } finally {
      setLoading(false);
    }
  }
useEffect(() => {
    if (!user?.tenant_id) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.tenant_id, localActivo]);


  const valorStock = insumos.reduce((s, i) => s + Number(i.precio_actual ?? 0) * Number(i.stock_actual ?? 0), 0);
  const criticos = insumos.filter(i => i.stock_minimo != null && i.stock_actual != null && Number(i.stock_actual) < Number(i.stock_minimo));

  if (loading) return <div style={{ color: "var(--v2-text-muted)" }}>Cargando…</div>;

  return (
    <div>
      <PageHeader
        eyebrow="Operación / Stock"
        title="Stock & Recetas"
        sub={`${insumos.length} insumos · ${items.length} items · ${recetas.length} recetas`}
        actions={
          <>
            <Button variant="outline" size="md" icon={<Plus size={14} />}>Nuevo insumo</Button>
            <Button variant="primary" size="md" icon={<Plus size={14} />}>Nuevo item</Button>
          </>
        }
      />

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "var(--v2-space-3)",
        marginBottom: "var(--v2-space-6)",
      }}>
        <StatCard hero icon={<Package size={14} />} label="Valor stock estimado" value={`$${formatMoney(valorStock)}`} sub={`${insumos.length} insumos`} />
        <StatCard
          icon={<AlertCircle size={14} />}
          label="Insumos críticos"
          value={criticos.length}
          status={criticos.length > 0 ? "atencion" : "ok"}
          statusText={criticos.length > 0 ? "Reponer pronto" : "Todo al día"}
        />
        <StatCard icon={<TrendingDown size={14} />} label="CMV promedio" value={
          recetas.length > 0
            ? `${(recetas.reduce((s, r) => s + Number(r.cmv_total ?? 0), 0) / recetas.length).toFixed(0)}`
            : "—"
        } sub="Por receta" />
      </div>

      <Tabs
        tabs={[
          { id: "insumos", label: "Insumos", icon: <Package size={14} />, badge: <Badge variant="neutro">{insumos.length}</Badge> },
          { id: "items", label: "Items", icon: <Layers size={14} />, badge: <Badge variant="neutro">{items.length}</Badge> },
          { id: "recetas", label: "Recetas", icon: <ChefHat size={14} />, badge: <Badge variant="neutro">{recetas.length}</Badge> },
        ]}
        activeId={activeTab}
        onChange={id => setActiveTab(id as typeof activeTab)}
      />

      <div className="v2-surface" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
        {activeTab === "insumos" && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Nombre</th>
                <th style={th}>Categoría</th>
                <th style={th}>Unidad</th>
                <th style={{ ...th, textAlign: "right" }}>Stock</th>
                <th style={{ ...th, textAlign: "right" }}>Mínimo</th>
                <th style={{ ...th, textAlign: "right" }}>Precio</th>
                <th style={th}>Estado</th>
              </tr>
            </thead>
            <tbody>
              {insumos.length === 0 ? (
                <tr><td colSpan={7} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>Sin insumos.</td></tr>
              ) : insumos.map(i => {
                const stock = Number(i.stock_actual ?? 0);
                const min = Number(i.stock_minimo ?? 0);
                const critico = min > 0 && stock < min;
                return (
                  <tr key={i.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                    <td style={td}><span style={{ fontWeight: 600, color: "var(--v2-text-strong)" }}>{i.nombre}</span></td>
                    <td style={td}><span className="v2-text-subtle">{i.categoria ?? "—"}</span></td>
                    <td style={td}><span className="v2-text-subtle">{i.unidad ?? "—"}</span></td>
                    <td style={{ ...td, textAlign: "right" }}><span className="v2-mono">{stock}</span></td>
                    <td style={{ ...td, textAlign: "right" }}><span className="v2-mono v2-text-subtle">{min || "—"}</span></td>
                    <td style={{ ...td, textAlign: "right" }}><span className="v2-mono">${formatMoney(i.precio_actual ?? 0)}</span></td>
                    <td style={td}>
                      {critico
                        ? <Badge variant="atencion" dot>Reponer</Badge>
                        : <Badge variant="neutro">OK</Badge>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {activeTab === "items" && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Nombre</th>
                <th style={th}>Categoría</th>
                <th style={{ ...th, textAlign: "right" }}>Precio venta</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan={3} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>Sin items.</td></tr>
              ) : items.map(i => (
                <tr key={i.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                  <td style={td}><span style={{ fontWeight: 600, color: "var(--v2-text-strong)" }}>{i.nombre}</span></td>
                  <td style={td}><span className="v2-text-subtle">{i.categoria ?? "—"}</span></td>
                  <td style={{ ...td, textAlign: "right" }}><span className="v2-mono">${formatMoney(i.precio_venta ?? 0)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {activeTab === "recetas" && (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Item</th>
                <th style={{ ...th, textAlign: "right" }}>CMV</th>
                <th style={{ ...th, textAlign: "right" }}>Margen %</th>
              </tr>
            </thead>
            <tbody>
              {recetas.length === 0 ? (
                <tr><td colSpan={3} style={{ ...td, textAlign: "center", color: "var(--v2-text-muted)", padding: "var(--v2-space-8)" }}>Sin recetas.</td></tr>
              ) : recetas.map(r => (
                <tr key={r.id} style={{ borderTop: "1px solid var(--v2-border)" }}>
                  <td style={td}>{r.item_nombre}</td>
                  <td style={{ ...td, textAlign: "right" }}><span className="v2-mono">${formatMoney(r.cmv_total ?? 0)}</span></td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {r.margen_pct != null ? (
                      <span className="v2-mono" style={{
                        color: r.margen_pct > 60 ? "var(--v2-celeste)" : r.margen_pct > 30 ? "var(--v2-text)" : "var(--v2-dorado)",
                        fontWeight: 600,
                      }}>{r.margen_pct.toFixed(1)}%</span>
                    ) : <span className="v2-text-subtle">—</span>}
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
