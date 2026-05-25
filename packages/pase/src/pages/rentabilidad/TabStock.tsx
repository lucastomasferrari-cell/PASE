// Tab Stock: dashboard valorizado del inventario.
//
// Lo que muestra:
//   - KPIs arriba: valor total inventario (multi-local), insumos por debajo
//     de mínimo, insumos sin categorizar.
//   - Tabla de insumos con: stock_actual, unidad, costo, valor, categoría,
//     alerta si está bajo el mínimo.
//   - Filtros: por categoría P&L (alimentos/bebidas/limpieza/etc.) y por
//     local activo (respeta el del sidebar).
//
// Como la operación (cargar/ajustar stock) vive en COMANDA, esta pantalla
// es read-only. Solo análisis.

import { useState, useEffect, useMemo } from "react";
import { db } from "../../lib/supabase";
import { applyLocalScope } from "../../lib/auth";
import { fmt_$ } from "../../lib/utils";
import { EmptyState } from "../../components/ui";
import type { Usuario, Local } from "../../types";

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

interface InsumoRow {
  id: number;
  nombre: string;
  unidad: string;
  local_id: number | null;
  categoria_pl: string | null;
  stock_actual: number | null;
  stock_minimo: number | null;
  costo_actual: number | null;
  ubicacion: string | null;
  // Nuevas columnas de la vista v_insumos_alertas_stock (25-may):
  dias_estimados_restantes: number | null;
  alerta_nivel: 'agotado' | 'bajo' | 'sobrestock' | 'ok';
}

const CATEGORIAS_PL: Array<{ id: string; label: string; emoji: string }> = [
  { id: "alimentos",     label: "Alimentos",     emoji: "🥬" },
  { id: "bebidas",       label: "Bebidas",       emoji: "🥤" },
  { id: "limpieza",      label: "Limpieza",      emoji: "🧹" },
  { id: "descartables",  label: "Descartables",  emoji: "📦" },
  { id: "condimentos",   label: "Condimentos",   emoji: "🧂" },
  { id: "otros",         label: "Otros",         emoji: "❓" },
];

export function TabStock({ user, locales, localActivo }: Props) {
  const [insumos, setInsumos] = useState<InsumoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtCategoria, setFiltCategoria] = useState<string>("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      // Lee de la vista v_insumos_alertas_stock que ya trae calculados
      // `dias_estimados_restantes` y `alerta_nivel` (consumo promedio
      // últimos 30d basado en movs salida_venta).
      let q = db.from("v_insumos_alertas_stock")
        .select("id, nombre, unidad, local_id, categoria_pl, stock_actual, stock_minimo, costo_actual, ubicacion, dias_estimados_restantes, alerta_nivel")
        .order("nombre");
      q = applyLocalScope(q, user, localActivo);
      const { data } = await q;
      setInsumos((data as InsumoRow[]) || []);
      setLoading(false);
    })();
  }, [user, localActivo]);

  // Filtrado client-side
  const insumosFiltrados = useMemo(() => {
    return insumos.filter(i => {
      if (filtCategoria && i.categoria_pl !== filtCategoria) return false;
      if (search && !i.nombre.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [insumos, filtCategoria, search]);

  // KPIs
  const valorTotal = insumosFiltrados.reduce(
    (s, i) => s + (Number(i.stock_actual) || 0) * (Number(i.costo_actual) || 0),
    0
  );
  const insumosBajoMinimo = insumosFiltrados.filter(
    i => i.stock_minimo != null && Number(i.stock_actual ?? 0) < Number(i.stock_minimo)
  ).length;
  const insumosSinCategoria = insumos.filter(i => !i.categoria_pl).length;

  // Breakdown por categoría P&L
  const porCategoria = useMemo(() => {
    const map = new Map<string, { count: number; valor: number }>();
    for (const i of insumos) {
      const cat = i.categoria_pl || "sin_categoria";
      const cur = map.get(cat) || { count: 0, valor: 0 };
      cur.count++;
      cur.valor += (Number(i.stock_actual) || 0) * (Number(i.costo_actual) || 0);
      map.set(cat, cur);
    }
    return map;
  }, [insumos]);

  if (loading) return <div className="loading">Cargando inventario...</div>;

  if (insumos.length === 0) {
    return (
      <EmptyState
        icon="📦"
        title="Sin insumos cargados"
        description="Los insumos se cargan desde COMANDA → Menú → Insumos. Acá ves el stock valorizado y las alertas."
      />
    );
  }

  return (
    <div>
      {/* ─── KPIs ─── */}
      <div className="grid3" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="kpi-label">Valor total inventario</div>
          <div className="kpi-value kpi-acc" style={{ fontSize: 22 }}>{fmt_$(valorTotal)}</div>
          <div className="kpi-sub">{insumosFiltrados.length} insumos</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Por debajo del mínimo</div>
          <div className="kpi-value" style={{ fontSize: 22, color: insumosBajoMinimo > 0 ? "var(--warn)" : "var(--success)" }}>
            {insumosBajoMinimo}
          </div>
          <div className="kpi-sub">requieren reposición</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Sin categorizar</div>
          <div className="kpi-value" style={{ fontSize: 22, color: insumosSinCategoria > 0 ? "var(--muted2)" : "var(--success)" }}>
            {insumosSinCategoria}
          </div>
          <div className="kpi-sub">categorizá desde COMANDA</div>
        </div>
      </div>

      {/* ─── Breakdown por categoría ─── */}
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-hd">
          <span className="panel-title">Por categoría P&L</span>
        </div>
        <div style={{ display: "flex", gap: 8, padding: 14, flexWrap: "wrap" }}>
          <button
            onClick={() => setFiltCategoria("")}
            className={`btn ${filtCategoria === "" ? "btn-acc" : "btn-ghost"} btn-sm`}
          >
            Todas ({insumos.length}) · {fmt_$(Array.from(porCategoria.values()).reduce((s, c) => s + c.valor, 0))}
          </button>
          {CATEGORIAS_PL.map(c => {
            const data = porCategoria.get(c.id) || { count: 0, valor: 0 };
            if (data.count === 0) return null;
            return (
              <button
                key={c.id}
                onClick={() => setFiltCategoria(c.id)}
                className={`btn ${filtCategoria === c.id ? "btn-acc" : "btn-ghost"} btn-sm`}
              >
                {c.emoji} {c.label} ({data.count}) · {fmt_$(data.valor)}
              </button>
            );
          })}
          {(porCategoria.get("sin_categoria")?.count ?? 0) > 0 && (
            <button
              onClick={() => setFiltCategoria("sin_categoria")}
              className={`btn ${filtCategoria === "sin_categoria" ? "btn-acc" : "btn-ghost"} btn-sm`}
              style={{ opacity: 0.6 }}
            >
              ❓ Sin categoría ({porCategoria.get("sin_categoria")?.count})
            </button>
          )}
        </div>
      </div>

      {/* ─── Tabla ─── */}
      <div className="panel">
        <div className="panel-hd" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="panel-title">Insumos ({insumosFiltrados.length})</span>
          <input
            className="search"
            placeholder="Buscar..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 200 }}
          />
        </div>
        <div className="table-scroll-wrap">
          <table style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Insumo</th>
                <th>Cat.</th>
                <th>Local</th>
                <th>Ubicación</th>
                <th className="num-right">Stock</th>
                <th className="num-right">Mínimo</th>
                <th className="num-right">Costo/u</th>
                <th className="num-right">Valor</th>
                <th className="num-right" title="Días que aguanta el stock al ritmo de venta de los últimos 30 días">Aguanta</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {insumosFiltrados.map(i => {
                const valor = (Number(i.stock_actual) || 0) * (Number(i.costo_actual) || 0);
                const bajoMin = i.stock_minimo != null && Number(i.stock_actual ?? 0) < Number(i.stock_minimo);
                const cat = CATEGORIAS_PL.find(c => c.id === i.categoria_pl);
                const localNombre = locales.find(l => l.id === i.local_id)?.nombre || "—";
                return (
                  <tr key={i.id}>
                    <td style={{ fontWeight: 500 }}>{i.nombre}</td>
                    <td style={{ fontSize: 11 }}>{cat ? `${cat.emoji} ${cat.label}` : <span style={{ color: "var(--muted2)" }}>—</span>}</td>
                    <td style={{ fontSize: 11, color: "var(--muted2)" }}>{localNombre}</td>
                    <td style={{ fontSize: 11, color: "var(--muted2)" }}>{i.ubicacion || "—"}</td>
                    <td className="num-right mono">
                      {Number(i.stock_actual ?? 0).toFixed(2)} {i.unidad}
                    </td>
                    <td className="num-right mono" style={{ fontSize: 11, color: "var(--muted2)" }}>
                      {i.stock_minimo != null ? `${Number(i.stock_minimo).toFixed(2)}` : "—"}
                    </td>
                    <td className="num-right mono">{fmt_$(Number(i.costo_actual) || 0)}</td>
                    <td className="num-right mono" style={{ fontWeight: 500 }}>{fmt_$(valor)}</td>
                    {/* "Aguanta": días estimados al ritmo de venta de los últimos 30d.
                        Verde >7d / Amarillo 3-7d / Rojo <3d. Gris si sin datos. */}
                    <td className="num-right mono" style={{ fontSize: 11 }}>
                      {(() => {
                        const d = Number(i.dias_estimados_restantes ?? 0);
                        if (Number(i.stock_actual ?? 0) <= 0) return <span style={{ color: "var(--muted2)" }}>—</span>;
                        if (d <= 0) return <span style={{ color: "var(--muted2)" }} title="Sin ventas en últimos 30d">∞</span>;
                        const color = d < 3 ? "var(--danger)" : d < 7 ? "var(--warn)" : "var(--success)";
                        return <span style={{ color, fontWeight: 500 }}>{d.toFixed(1)}d</span>;
                      })()}
                    </td>
                    <td>
                      {bajoMin ? (
                        <span className="badge b-warn" style={{ fontSize: 10 }}>↓ bajo mínimo</span>
                      ) : (Number(i.stock_actual ?? 0) === 0) ? (
                        <span className="badge b-danger" style={{ fontSize: 10 }}>agotado</span>
                      ) : (
                        <span className="badge b-success" style={{ fontSize: 10 }}>OK</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Nota: link a COMANDA para acciones operativas */}
      <div style={{ marginTop: 16, fontSize: 12, color: "var(--muted2)" }}>
        Para cargar conteos, mermas, ajustes o configurar stock mínimo →
        <a href="https://comanda-jet.vercel.app/inventario/alertas" target="_blank" rel="noreferrer"
           style={{ marginLeft: 6, color: "var(--acc)" }}>
          abrir COMANDA → Inventario ↗
        </a>
      </div>
    </div>
  );
}
