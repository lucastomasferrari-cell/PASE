import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { tienePermiso } from "../lib/auth";

const TIPOS = [
  { id: "gasto_fijo", label: "Gastos Fijos" },
  { id: "gasto_variable", label: "Gastos Variables" },
  { id: "gasto_publicidad", label: "Publicidad y MKT" },
  { id: "gasto_impuesto", label: "Impuestos" },
  { id: "gasto_comision", label: "Comisiones" },
  { id: "medio_cobro", label: "Medios de Cobro" },
  { id: "cat_compra", label: "Categorías de Compra" },
];

export default function Configuracion({ user }: { user: any }) {
  const [tab, setTab] = useState("gasto_fijo");
  const [items, setItems] = useState<any[]>([]);
  const [nuevo, setNuevo] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data } = await db.from("config_categorias")
      .select("*").eq("tipo", tab).eq("activo", true).order("orden");
    setItems(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [tab]);

  const agregar = async () => {
    if (!nuevo.trim()) return;
    const nombre = nuevo.trim().toUpperCase();
    const maxOrden = items.length > 0 ? Math.max(...items.map(i => i.orden)) + 1 : 1;
    await db.from("config_categorias").insert([{ tipo: tab, nombre, orden: maxOrden, activo: true }]);
    setNuevo("");
    load();
  };

  const eliminar = async (item: any) => {
    const tipoGasto = tab.startsWith("gasto_") ? tab.replace("gasto_", "") : null;
    if (tipoGasto) {
      const { count } = await db.from("gastos").select("*", { count: "exact", head: true }).eq("categoria", item.nombre);
      if (count && count > 0) {
        if (!confirm(`"${item.nombre}" tiene ${count} movimientos registrados. ¿Igual eliminás?`)) return;
      }
    }
    await db.from("config_categorias").update({ activo: false }).eq("id", item.id);
    load();
  };

  // Gate granular: el slug del módulo (MODULOS en auth.ts) es "configuracion".
  // Dueño siempre entra. Otros roles necesitan el permiso asignado en
  // usuario_permisos. El App-level guardedNav ya aplica esto por el switch
  // de section; este chequeo defensivo queda por si el componente se monta
  // por otra vía.
  if (!tienePermiso(user, "configuracion")) {
    return <div className="empty">No tenés permisos para acceder a esta sección.</div>;
  }

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Configuración</div></div>
      </div>
      <div className="tabs">
        {TIPOS.map(t => (
          <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</div>
        ))}
      </div>
      <div className="panel">
        <div className="panel-hd">
          <span className="panel-title">{TIPOS.find(t => t.id === tab)?.label}</span>
        </div>
        <div style={{ padding: "12px 16px" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <input
              className="search"
              style={{ flex: 1 }}
              value={nuevo}
              onChange={e => setNuevo(e.target.value)}
              onKeyDown={e => e.key === "Enter" && agregar()}
              placeholder="Nuevo concepto..."
            />
            <button className="btn btn-acc" onClick={agregar}>+ Agregar</button>
          </div>
          {loading ? <div className="loading">Cargando...</div> : (
            <table>
              <thead><tr><th>Nombre</th><th></th></tr></thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id}>
                    <td>{item.nombre}</td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn-danger btn-sm" onClick={() => eliminar(item)}>Eliminar</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
