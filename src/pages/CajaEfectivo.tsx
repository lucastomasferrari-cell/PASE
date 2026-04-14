import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { toISO, today, fmt_d, fmt_$ } from "../lib/utils";

export default function CajaEfectivo({ user, locales, localActivo }) {
  const [movimientos, setMovimientos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [filtLocal, setFiltLocal] = useState(localActivo || "");
  const [filtDesde, setFiltDesde] = useState("");
  const [filtHasta, setFiltHasta] = useState("");
  const [form, setForm] = useState({ fecha: toISO(today), descripcion: "", monto: "", local_id: "", esIngreso: true });

  const load = async () => {
    setLoading(true);
    let q = db.from("caja_efectivo").select("*").order("fecha", { ascending: false }).order("created_at", { ascending: false });
    if (filtLocal) q = q.eq("local_id", filtLocal);
    if (filtDesde) q = q.gte("fecha", filtDesde);
    if (filtHasta) q = q.lte("fecha", filtHasta);
    const { data } = await q;
    setMovimientos(data || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, [filtLocal, filtDesde, filtHasta]);

  const total = movimientos.reduce((s, m) => s + Number(m.monto), 0);

  // Saldo por local (sobre los movimientos filtrados por fecha, pero todos los locales)
  const saldoPorLocal = {};
  movimientos.forEach(m => {
    saldoPorLocal[m.local_id] = (saldoPorLocal[m.local_id] || 0) + Number(m.monto);
  });

  // Saldo acumulado total (cronológico ASC para calcular, luego mostramos DESC)
  const sorted = [...movimientos].sort((a, b) => {
    const df = a.fecha.localeCompare(b.fecha);
    return df !== 0 ? df : (a.created_at || "").localeCompare(b.created_at || "");
  });
  const acum = {};
  let runningTotal = 0;
  // Necesitamos el total de TODOS los movimientos para el acumulado, no solo los filtrados
  // Calculamos acumulado sobre los movimientos visibles
  sorted.forEach(m => {
    runningTotal += Number(m.monto);
    acum[m.id] = runningTotal;
  });

  const guardar = async () => {
    if (!form.monto || !form.local_id || !form.descripcion) return;
    const monto = parseFloat(form.monto) * (form.esIngreso ? 1 : -1);
    await db.from("caja_efectivo").insert([{
      fecha: form.fecha,
      descripcion: form.descripcion,
      monto,
      local_id: parseInt(form.local_id),
      creado_por: user?.nombre || "—",
    }]);
    setForm({ fecha: toISO(today), descripcion: "", monto: "", local_id: "", esIngreso: true });
    setModal(false);
    load();
  };

  const localNombre = (id) => locales.find(l => l.id === id)?.nombre || "—";

  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Caja Efectivo</div>
          <div className="ph-sub">Control de ingresos y egresos en efectivo por local</div>
        </div>
        <button className="btn btn-acc" onClick={() => setModal(true)}>+ Nuevo movimiento</button>
      </div>

      {/* Total general */}
      <div className="kpi" style={{ marginBottom: 16, textAlign: "center" }}>
        <div className="kpi-label">Total Caja Efectivo</div>
        <div className="kpi-value" style={{ fontSize: 32, color: total < 0 ? "var(--danger)" : "var(--success)" }}>{fmt_$(total)}</div>
      </div>

      {/* Saldo por local */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(locales.length, 4)}, 1fr)`, gap: 12, marginBottom: 20 }}>
        {locales.map(l => {
          const s = saldoPorLocal[l.id] || 0;
          return (
            <div key={l.id} className="kpi">
              <div className="kpi-label">{l.nombre}</div>
              <div className="kpi-value" style={{ fontSize: 20, color: s < 0 ? "var(--danger)" : s > 0 ? "var(--success)" : "var(--muted2)" }}>{fmt_$(s)}</div>
            </div>
          );
        })}
      </div>

      {/* Filtros */}
      <div className="panel">
        <div className="panel-hd" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="panel-title">Movimientos</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select className="search" style={{ width: 150 }} value={filtLocal} onChange={e => setFiltLocal(e.target.value ? parseInt(e.target.value) : "")}>
              <option value="">Todos los locales</option>
              {locales.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
            <input type="date" className="search" value={filtDesde} onChange={e => setFiltDesde(e.target.value)} title="Desde" />
            <input type="date" className="search" value={filtHasta} onChange={e => setFiltHasta(e.target.value)} title="Hasta" />
            {(filtDesde || filtHasta || filtLocal) && (
              <button className="btn btn-ghost btn-sm" onClick={() => { setFiltDesde(""); setFiltHasta(""); setFiltLocal(""); }}>Limpiar</button>
            )}
          </div>
        </div>
        {loading ? <div className="loading">Cargando...</div> : movimientos.length === 0 ? <div className="empty">Sin movimientos</div> : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Fecha</th><th>Local</th><th>Descripción</th><th style={{ textAlign: "right" }}>Monto</th><th style={{ textAlign: "right" }}>Saldo Acum.</th></tr>
              </thead>
              <tbody>
                {movimientos.map(m => (
                  <tr key={m.id}>
                    <td className="mono">{fmt_d(m.fecha)}</td>
                    <td><span className="badge b-info">{localNombre(m.local_id)}</span></td>
                    <td style={{ fontSize: 11, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.descripcion}</td>
                    <td style={{ textAlign: "right" }}><span className="num" style={{ color: Number(m.monto) < 0 ? "var(--danger)" : "var(--success)" }}>{fmt_$(Number(m.monto))}</span></td>
                    <td style={{ textAlign: "right" }}><span className="num" style={{ color: (acum[m.id] || 0) < 0 ? "var(--danger)" : "var(--muted2)" }}>{fmt_$(acum[m.id] || 0)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal nuevo movimiento */}
      {modal && (
        <div className="overlay" onClick={() => setModal(false)}>
          <div className="modal" style={{ width: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Nuevo Movimiento</div>
              <button className="close-btn" onClick={() => setModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Tipo</label>
                <div style={{ display: "flex", gap: 0 }}>
                  <button
                    className="btn"
                    style={{
                      flex: 1, borderRadius: "var(--r) 0 0 var(--r)",
                      background: form.esIngreso ? "var(--success)" : "var(--s3)",
                      color: form.esIngreso ? "#000" : "var(--muted2)",
                      border: `1px solid ${form.esIngreso ? "var(--success)" : "var(--bd)"}`,
                    }}
                    onClick={() => setForm({ ...form, esIngreso: true })}
                  >Ingreso</button>
                  <button
                    className="btn"
                    style={{
                      flex: 1, borderRadius: "0 var(--r) var(--r) 0",
                      background: !form.esIngreso ? "var(--danger)" : "var(--s3)",
                      color: !form.esIngreso ? "#fff" : "var(--muted2)",
                      border: `1px solid ${!form.esIngreso ? "var(--danger)" : "var(--bd)"}`,
                    }}
                    onClick={() => setForm({ ...form, esIngreso: false })}
                  >Egreso</button>
                </div>
              </div>
              <div className="form2">
                <div className="field">
                  <label>Monto $</label>
                  <input type="number" min="0" step="0.01" value={form.monto} onChange={e => setForm({ ...form, monto: e.target.value })} placeholder="0" />
                </div>
                <div className="field">
                  <label>Fecha</label>
                  <input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} />
                </div>
              </div>
              <div className="field">
                <label>Local *</label>
                <select value={form.local_id} onChange={e => setForm({ ...form, local_id: e.target.value })}>
                  <option value="">Seleccionar local...</option>
                  {locales.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Descripción *</label>
                <input value={form.descripcion} onChange={e => setForm({ ...form, descripcion: e.target.value })} placeholder="Ej: Retiro para compras, ingreso de venta..." />
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setModal(false)}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardar} disabled={!form.monto || !form.local_id || !form.descripcion}>Guardar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
