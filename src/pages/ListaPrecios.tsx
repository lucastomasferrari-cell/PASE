import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { fmt_$ } from "../lib/utils";

export default function ListaPrecios({ locales, localActivo }) {
  const [recetas, setRecetas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const { data } = await db.from("recetas").select("*, receta_items(cantidad, insumo_id, insumos(precio_prom))").order("nombre");
      setRecetas(data || []);
      setLoading(false);
    };
    load();
  }, []);

  const updatePrecio = async (id: number, precio: number) => {
    await db.from("recetas").update({ precio_venta: precio }).eq("id", id);
    setRecetas(prev => prev.map(r => r.id === id ? { ...r, precio_venta: precio } : r));
  };

  return (
    <div>
      <div className="panel">
        <div className="panel-hd"><span className="panel-title">Lista de Precios</span></div>
        {loading ? <div className="loading">Cargando...</div> : recetas.length === 0 ? <div className="empty">No hay recetas</div> : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Receta</th><th>Categoría</th><th style={{ textAlign: "right" }}>Costo</th><th style={{ textAlign: "right" }}>Precio Venta</th><th style={{ textAlign: "right" }}>Margen %</th><th>Estado</th></tr></thead>
              <tbody>{recetas.map(r => {
                const items = r.receta_items || [];
                const costo = items.reduce((s: number, it: any) => s + (it.cantidad || 0) * (it.insumos?.precio_prom || 0), 0);
                const precio = Number(r.precio_venta) || 0;
                const margen = precio > 0 ? ((precio - costo) / precio * 100) : 0;
                const margenColor = margen >= 70 ? "var(--success)" : margen >= 30 ? "var(--txt)" : "var(--danger)";
                return (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 500 }}>{r.nombre}</td>
                    <td><span className="badge b-muted">{r.categoria}</span></td>
                    <td style={{ textAlign: "right" }}><span className="num">{fmt_$(costo)}</span></td>
                    <td style={{ textAlign: "right" }}>
                      <input type="number" style={{ width: 100, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--acc)", padding: "4px 6px", fontFamily: "'DM Mono',monospace", fontSize: 12, borderRadius: "var(--r)", textAlign: "right" }}
                        value={precio || ""} onChange={e => updatePrecio(r.id, parseFloat(e.target.value) || 0)} placeholder="0" />
                    </td>
                    <td style={{ textAlign: "right", color: margenColor, fontWeight: 600 }}>
                      {precio > 0 ? margen.toFixed(1) + "%" : "—"}
                    </td>
                    <td>
                      {precio > 0 && margen < 30 && <span className="badge b-warn">BAJO MARGEN</span>}
                      {precio > 0 && margen >= 70 && <span className="badge b-success">ALTA RENTABILIDAD</span>}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
