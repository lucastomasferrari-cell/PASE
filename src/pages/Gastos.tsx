import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { CUENTAS, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, GASTOS_IMPUESTOS, COMISIONES_CATS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

const TIPOS = [
  { id: "todos", label: "Todos" },
  { id: "fijo", label: "Fijos" },
  { id: "variable", label: "Variables" },
  { id: "publicidad", label: "Publicidad" },
  { id: "impuesto", label: "Impuestos" },
  { id: "comision", label: "Comisiones" },
];
const ALL_CATS = [...GASTOS_FIJOS, ...GASTOS_VARIABLES, ...GASTOS_PUBLICIDAD, ...GASTOS_IMPUESTOS, ...COMISIONES_CATS];
const catsByTipo = (t: string) =>
  t === "fijo" ? GASTOS_FIJOS :
  t === "variable" ? GASTOS_VARIABLES :
  t === "publicidad" ? GASTOS_PUBLICIDAD :
  t === "impuesto" ? GASTOS_IMPUESTOS :
  t === "comision" ? COMISIONES_CATS :
  ALL_CATS;

export default function Gastos({ user, locales, localActivo }) {
  const [search, setSearch] = useState("");
  const [desde, setDesde] = useState(toISO(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [hasta, setHasta] = useState(toISO(today));
  const [tipoFiltro, setTipoFiltro] = useState("todos");
  const [gastos, setGastos] = useState<any[]>([]);
  const [plantillas, setPlantillas] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [pagarModal, setPagarModal] = useState<any>(null);
  const [gestionarModal, setGestionarModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pagandoPlant, setPagandoPlant] = useState(false);

  const emptyForm = { fecha: toISO(today), local_id: localActivo ? String(localActivo) : "", categoria: "", tipo: "fijo", monto: "", detalle: "", cuenta: "MercadoPago", plantilla_id: null as number | null };
  const [form, setForm] = useState(emptyForm);

  const emptyPagoPlant = { monto: "", fecha: toISO(today), cuenta: "MercadoPago" };
  const [pagoPlantForm, setPagoPlantForm] = useState(emptyPagoPlant);

  const emptyPlantForm = { nombre: "", categoria: "", tipo: "fijo", local_id: "" };
  const [plantForm, setPlantForm] = useState(emptyPlantForm);

  const load = async () => {
    setLoading(true);
    let q = db.from("gastos").select("*").gte("fecha", desde).lte("fecha", hasta).order("fecha", { ascending: false });
    if (localActivo) q = q.eq("local_id", localActivo);
    const { data: g } = await q;
    const { data: p } = await db.from("gastos_plantillas").select("*").eq("activo", true).order("nombre");
    setGastos(g || []);
    setPlantillas(p || []);
    setLoading(false);
  };
  useEffect(() => { load(); }, [desde, hasta, localActivo]);

  const histFiltrado = gastos.filter(g => {
    const matchTipo = tipoFiltro === "todos" || g.tipo === tipoFiltro;
    const matchSearch = !search ||
      g.categoria?.toLowerCase().includes(search.toLowerCase()) ||
      g.detalle?.toLowerCase().includes(search.toLowerCase());
    return matchTipo && matchSearch;
  });

  const totalPeriodo = histFiltrado.reduce((s, g) => s + (g.monto || 0), 0);

  const getEstadoPlantilla = (plantilla: any) => {
    const pago = gastos.find(g => g.plantilla_id === plantilla.id);
    return pago ? { pagado: true, monto: pago.monto, fecha: pago.fecha } : { pagado: false };
  };

  const plantillasFiltradas = plantillas.filter(p => tipoFiltro === "todos" || p.tipo === tipoFiltro);
  const esPasado = hasta < toISO(today);

  const getTipo = () => tipoFiltro === "todos" ? form.tipo : tipoFiltro;

  // ─── ACCIONES ──────────────────────────────────────────────────────────────
  const guardar = async () => {
    if (saving || !form.monto || !form.categoria) return;
    setSaving(true);
    try {
      const tipo = getTipo();
      const nuevo = { ...form, id: genId("GASTO"), tipo, local_id: form.local_id ? parseInt(form.local_id) : null, monto: parseFloat(form.monto), plantilla_id: form.plantilla_id || null };
      const { error: gErr } = await db.from("gastos").insert([nuevo]);
      if (gErr) throw new Error("Error guardando gasto: " + gErr.message);

      const { data: caja } = await db.from("saldos_caja").select("saldo").eq("cuenta", form.cuenta).maybeSingle();
      if (caja) await db.from("saldos_caja").update({ saldo: (caja.saldo || 0) - parseFloat(form.monto) }).eq("cuenta", form.cuenta);

      const { error: mErr } = await db.from("movimientos").insert([{ id: genId("MOV"), fecha: form.fecha, cuenta: form.cuenta, tipo: "Gasto " + tipo, cat: form.categoria, importe: -parseFloat(form.monto), detalle: form.detalle || form.categoria, fact_id: null }]);
      if (mErr) console.error("movimientos error (no crítico):", mErr);

      setModal(false); setForm(emptyForm); load();
    } catch (err: any) {
      console.error("Error guardando gasto:", err);
      alert("Error al guardar: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  const abrirPagarPlantilla = (p: any) => {
    setPagarModal(p);
    setPagoPlantForm({ ...emptyPagoPlant, fecha: toISO(today) });
  };

  const confirmarPagoPlantilla = async () => {
    if (pagandoPlant || !pagarModal || !pagoPlantForm.monto) return;
    setPagandoPlant(true);
    try {
      const monto = parseFloat(pagoPlantForm.monto);
      const nuevo = {
        id: genId("GASTO"), fecha: pagoPlantForm.fecha,
        local_id: pagarModal.local_id || null,
        categoria: pagarModal.categoria, tipo: pagarModal.tipo,
        monto, detalle: pagarModal.nombre,
        cuenta: pagoPlantForm.cuenta, plantilla_id: pagarModal.id,
      };
      const { error: gErr } = await db.from("gastos").insert([nuevo]);
      if (gErr) throw new Error("Error guardando: " + gErr.message);

      const { data: caja } = await db.from("saldos_caja").select("saldo").eq("cuenta", pagoPlantForm.cuenta).maybeSingle();
      if (caja) await db.from("saldos_caja").update({ saldo: (caja.saldo || 0) - monto }).eq("cuenta", pagoPlantForm.cuenta);

      const { error: mErr } = await db.from("movimientos").insert([{ id: genId("MOV"), fecha: pagoPlantForm.fecha, cuenta: pagoPlantForm.cuenta, tipo: "Gasto " + pagarModal.tipo, cat: pagarModal.categoria, importe: -monto, detalle: pagarModal.nombre, fact_id: null }]);
      if (mErr) console.error("movimientos error (no crítico):", mErr);

      setPagarModal(null); setPagoPlantForm(emptyPagoPlant); load();
    } catch (err: any) {
      console.error("Error pago plantilla:", err);
      alert("Error: " + err.message);
    } finally {
      setPagandoPlant(false);
    }
  };

  const guardarPlantilla = async () => {
    if (!plantForm.nombre || !plantForm.categoria) return;
    const payload: any = { nombre: plantForm.nombre, tipo: plantForm.tipo, categoria: plantForm.categoria, local_id: plantForm.local_id ? parseInt(plantForm.local_id) : null, activo: true };
    await db.from("gastos_plantillas").insert([payload]);
    setPlantForm(emptyPlantForm); load();
  };

  const eliminarPlantilla = async (id: number) => {
    if (!confirm("¿Eliminar esta plantilla recurrente?")) return;
    await db.from("gastos_plantillas").update({ activo: false }).eq("id", id);
    load();
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Gastos</div></div>
        <button className="btn btn-acc" onClick={() => { setForm(emptyForm); setModal(true); }}>+ Cargar Gasto</button>
      </div>

      {/* Filtros + Pills unificados */}
      <div style={{display:"flex",gap:8,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
        <input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)} style={{width:140}}/>
        <input type="date" className="search" value={desde} onChange={e=>setDesde(e.target.value)} style={{width:120}}/>
        <span style={{fontSize:11,color:"var(--muted)"}}>→</span>
        <input type="date" className="search" value={hasta} onChange={e=>setHasta(e.target.value)} style={{width:120}}/>
        <div style={{width:1,height:14,background:"var(--bd)",margin:"0 4px"}}/>
        {[["todos","Todos"],["fijo","Fijos"],["variable","Variables"],["publicidad","Publicidad"],["impuesto","Impuestos"],["comision","Comisiones"]].map(([id,l])=>(
          <div key={id} className={`pill ${tipoFiltro===id?"active":""}`} onClick={()=>setTipoFiltro(id)}>{l}</div>
        ))}
      </div>

      {/* Recurrentes del período */}
      {!search && plantillasFiltradas.length > 0 && (
        <div className="section">
          <div className="section-hd">
            <span className="section-title">Recurrentes del período</span>
            <span className="section-total">{plantillasFiltradas.filter(p => getEstadoPlantilla(p).pagado).length} de {plantillasFiltradas.length} pagados</span>
          </div>
          <div className="panel">
            {plantillasFiltradas.map(p => {
              const estado = getEstadoPlantilla(p);
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 14px", borderBottom: "1px solid var(--bd)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 15, height: 15, borderRadius: 4, border: "1px solid var(--bd2)", background: estado.pagado ? "var(--s3)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {estado.pagado && <div style={{ width: 7, height: 7, borderRadius: 2, background: "var(--acc)" }} />}
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: estado.pagado ? "var(--muted2)" : esPasado && !estado.pagado ? "var(--danger)" : "var(--txt)", textDecoration: estado.pagado ? "line-through" : "none" }}>{p.nombre}</div>
                      <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 1 }}>{p.categoria}{p.local_id ? " · " + locales.find(l => l.id === p.local_id)?.nombre : " · Todos"}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {estado.pagado && <span style={{ fontSize: 12, fontWeight: 500, color: "var(--muted2)" }}>{fmt_$(estado.monto)}</span>}
                    {!estado.pagado && esPasado && <span style={{ fontSize: 11, color: "var(--danger)" }}>No registrado</span>}
                    {!estado.pagado && !esPasado && <button className="btn btn-ghost btn-sm" onClick={() => abrirPagarPlantilla(p)}>Pagar</button>}
                  </div>
                </div>
              );
            })}
            <div style={{ padding: "9px 14px", fontSize: 11, color: "var(--muted2)", cursor: "pointer", borderTop: "1px solid var(--bd)" }} onClick={() => setGestionarModal(true)}>
              + Gestionar recurrentes
            </div>
          </div>
        </div>
      )}

      {/* Historial */}
      <div className="section">
        <div className="section-hd">
          <span className="section-title">Historial</span>
          <span className="section-total">{histFiltrado.length} movimientos · {fmt_$(totalPeriodo)}</span>
        </div>
        <div className="panel">
          {loading ? <div className="loading">Cargando...</div> : histFiltrado.length === 0 ? <div className="empty">Sin movimientos en el período</div> : (
            <table>
              <thead><tr><th>Fecha</th><th>Tipo</th><th>Categoría</th><th>Detalle</th><th>Local</th><th>Cuenta</th><th style={{ textAlign: "right" }}>Monto</th></tr></thead>
              <tbody>{histFiltrado.map(g => (
                <tr key={g.id}>
                  <td className="mono">{fmt_d(g.fecha)}</td>
                  <td><span className="badge b-muted">{g.tipo}</span></td>
                  <td style={{ fontSize: 11 }}>{g.categoria}</td>
                  <td style={{ fontSize: 11, color: "var(--muted2)" }}>{g.detalle || "—"}</td>
                  <td style={{ fontSize: 11, color: "var(--muted2)" }}>{locales.find(l => l.id === g.local_id)?.nombre || "Todos"}</td>
                  <td style={{ fontSize: 11, color: "var(--muted2)" }}>{g.cuenta || "—"}</td>
                  <td style={{ textAlign: "right" }}><span className="num">{fmt_$(g.monto)}</span></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      </div>

      {/* Modal cargar gasto manual */}
      {modal && (
        <div className="overlay" onClick={() => setModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Cargar Gasto</div><button className="close-btn" onClick={() => setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                {tipoFiltro === "todos" && (
                  <div className="field"><label>Tipo *</label>
                    <select value={form.tipo} onChange={e => setForm({ ...form, tipo: e.target.value, categoria: "" })}>
                      {TIPOS.filter(t => t.id !== "todos").map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                )}
                <div className="field"><label>Categoría *</label>
                  <select value={form.categoria} onChange={e => setForm({ ...form, categoria: e.target.value })}>
                    <option value="">Seleccioná...</option>
                    {catsByTipo(tipoFiltro === "todos" ? form.tipo : tipoFiltro).map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field"><label>Local</label>
                  <select value={form.local_id} onChange={e => setForm({ ...form, local_id: e.target.value })}>
                    <option value="">Todos</option>
                    {locales.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                  </select>
                </div>
              </div>
              <div className="form2">
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} /></div>
                <div className="field"><label>Cuenta de egreso</label>
                  <select value={form.cuenta} onChange={e => setForm({ ...form, cuenta: e.target.value })}>
                    {CUENTAS.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div className="field"><label>Monto $</label><input type="number" value={form.monto} onChange={e => setForm({ ...form, monto: e.target.value })} placeholder="0" /></div>
              <div className="field"><label>Detalle (opcional)</label><input value={form.detalle} onChange={e => setForm({ ...form, detalle: e.target.value })} placeholder="Descripción..." /></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar} disabled={saving}>{saving ? "Guardando..." : "Guardar"}</button></div>
          </div>
        </div>
      )}

      {/* Modal pagar recurrente */}
      {pagarModal && (
        <div className="overlay" onClick={() => setPagarModal(null)}>
          <div className="modal" style={{ width: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Pagar — {pagarModal.nombre}</div><button className="close-btn" onClick={() => setPagarModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-info" style={{ marginBottom: 14 }}>
                {pagarModal.categoria} · {pagarModal.tipo} · {pagarModal.local_id ? locales.find(l => l.id === pagarModal.local_id)?.nombre : "Todos los locales"}
              </div>
              <div className="form2">
                <div className="field"><label>Monto $ *</label><input type="number" value={pagoPlantForm.monto} onChange={e => setPagoPlantForm({ ...pagoPlantForm, monto: e.target.value })} placeholder="0" /></div>
                <div className="field"><label>Fecha</label><input type="date" value={pagoPlantForm.fecha} onChange={e => setPagoPlantForm({ ...pagoPlantForm, fecha: e.target.value })} /></div>
              </div>
              <div className="field"><label>Cuenta de egreso</label>
                <select value={pagoPlantForm.cuenta} onChange={e => setPagoPlantForm({ ...pagoPlantForm, cuenta: e.target.value })}>
                  {CUENTAS.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setPagarModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={confirmarPagoPlantilla} disabled={pagandoPlant}>{pagandoPlant ? "Procesando..." : "Confirmar pago"}</button></div>
          </div>
        </div>
      )}

      {/* Modal gestionar recurrentes */}
      {gestionarModal && (
        <div className="overlay" onClick={() => setGestionarModal(false)}>
          <div className="modal" style={{ width: 620 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Gestionar recurrentes</div><button className="close-btn" onClick={() => setGestionarModal(false)}>✕</button></div>
            <div className="modal-body">
              {plantillas.length > 0 && (
                <table style={{ marginBottom: 16 }}>
                  <thead><tr><th>Nombre</th><th>Tipo</th><th>Categoría</th><th>Local</th><th></th></tr></thead>
                  <tbody>{plantillas.map(p => (
                    <tr key={p.id}>
                      <td style={{ fontSize: 12 }}>{p.nombre}</td>
                      <td><span className="badge b-muted">{p.tipo}</span></td>
                      <td style={{ fontSize: 11, color: "var(--muted2)" }}>{p.categoria}</td>
                      <td style={{ fontSize: 11, color: "var(--muted2)" }}>{locales.find(l => l.id === p.local_id)?.nombre || "Todos"}</td>
                      <td><button className="btn btn-danger btn-sm" onClick={() => eliminarPlantilla(p.id)}>X</button></td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              <div style={{ borderTop: "1px solid var(--bd)", paddingTop: 14 }}>
                <div className="section-title" style={{ marginBottom: 10 }}>Nueva plantilla</div>
                <div className="form2">
                  <div className="field"><label>Nombre *</label><input value={plantForm.nombre} onChange={e => setPlantForm({ ...plantForm, nombre: e.target.value })} placeholder="Ej: Alquiler local" /></div>
                  <div className="field"><label>Tipo *</label>
                    <select value={plantForm.tipo} onChange={e => setPlantForm({ ...plantForm, tipo: e.target.value, categoria: "" })}>
                      {TIPOS.filter(t => t.id !== "todos").map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                </div>
                <div className="form2">
                  <div className="field"><label>Categoría *</label>
                    <select value={plantForm.categoria} onChange={e => setPlantForm({ ...plantForm, categoria: e.target.value })}>
                      <option value="">Seleccioná...</option>
                      {catsByTipo(plantForm.tipo).map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="field"><label>Local</label>
                    <select value={plantForm.local_id} onChange={e => setPlantForm({ ...plantForm, local_id: e.target.value })}>
                      <option value="">Todos</option>
                      {locales.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button className="btn btn-acc btn-sm" onClick={guardarPlantilla}>Agregar</button>
                </div>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setGestionarModal(false)}>Cerrar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
