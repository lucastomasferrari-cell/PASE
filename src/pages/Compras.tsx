import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasVisibles } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { useCategorias } from "../lib/useCategorias";
import { CUENTAS, UNIDADES } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";
import LectorFacturasIA from "./LectorFacturasIA";

const estadoDot = (estado: string) => {
  const colors: Record<string,string> = { pendiente: "var(--muted2)", vencida: "var(--acc)", pagada: "var(--success)", revision: "var(--warn)" };
  const labels: Record<string,string> = { pendiente: "Pendiente", vencida: "Vencida", pagada: "Pagada", anulada: "Anulada", revision: "⚠ Revisión" };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: estado === "revision" ? "var(--warn)" : "var(--muted2)" }}>
      <div style={{ width: 5, height: 5, borderRadius: "50%", background: colors[estado] || "var(--bd2)", flexShrink: 0 }} />
      {labels[estado] || estado}
    </div>
  );
};

export default function Compras({ user, locales, localActivo }) {
  const { CATEGORIAS_COMPRA } = useCategorias();
  const visCuentas = cuentasVisibles(user);
  const cuentasUsables = visCuentas === null ? CUENTAS : CUENTAS.filter(c => visCuentas.includes(c));
  const [facturas, setFacturas] = useState<any[]>([]);
  const [proveedores, setProveedores] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [desde, setDesde] = useState(toISO(new Date(today.getFullYear(), today.getMonth(), 1)));
  const [hasta, setHasta] = useState(toISO(today));
  const [provFiltro, setProvFiltro] = useState("");
  const [pillEstado, setPillEstado] = useState("todas");
  const [lectorModal, setLectorModal] = useState(false);
  const [modal, setModal] = useState(false);
  const [pagarModal, setPagarModal] = useState<any>(null);
  const [verModal, setVerModal] = useState<any>(null);
  // Signed URL cargada on-demand cuando el modal ver se abre con imagen_url.
  // Se reinicia cuando el modal se cierra.
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  useEffect(() => {
    if (!verModal?.imagen_url) { setImgUrl(null); return; }
    let cancelled = false;
    setImgLoading(true);
    db.storage.from("facturas").createSignedUrl(verModal.imagen_url, 3600)
      .then(({ data, error }) => {
        if (cancelled) return;
        setImgLoading(false);
        if (error || !data) { setImgUrl(null); return; }
        setImgUrl(data.signedUrl);
      });
    return () => { cancelled = true; };
  }, [verModal?.imagen_url]);
  const [loading, setLoading] = useState(true);
  const [pagando, setPagando] = useState(false);
  const [saving, setSaving] = useState(false);

  const emptyForm = { prov_id: "", local_id: localActivo ? String(localActivo) : "", nro: "", fecha: toISO(today), venc: "", neto: "", iva21: "", iva105: "", iibb: "", perc_iva: "", otros_cargos: "", descuentos: "", cat: "", detalle: "", tipo: "factura" };
  const [form, setForm] = useState<any>(emptyForm);
  const [items, setItems] = useState<any[]>([]);
  const [pagoForm, setPagoForm] = useState({ cuenta: "MercadoPago", monto: "", fecha: toISO(today) });
  const localesDisp = user.rol === "dueno" ? locales : locales.filter(l => (user.locales || []).includes(l.id));
  const calcTotal = () =>
    (parseFloat(form.neto) || 0) +
    (parseFloat(form.iva21) || 0) +
    (parseFloat(form.iva105) || 0) +
    (parseFloat(form.iibb) || 0) +
    (parseFloat(form.perc_iva) || 0) +
    (parseFloat(form.otros_cargos) || 0) -
    (parseFloat(form.descuentos) || 0);

  const load = async () => {
    setLoading(true);
    let fq = db.from("facturas").select("*").order("fecha", { ascending: false });
    fq = applyLocalScope(fq, user, localActivo);
    const [{ data: f }, { data: p }] = await Promise.all([
      fq,
      db.from("proveedores").select("*").eq("estado", "Activo").order("nombre"),
    ]);
    setFacturas(f || []); setProveedores(p || []); setLoading(false);
  };
  useEffect(() => { load(); }, [localActivo]);

  const fFilt = facturas.filter(f => {
    if (f.estado === "anulada") return false;
    if ((f.tipo || "factura") === "nota_credito") return false;
    if (pillEstado !== "todas" && f.estado !== pillEstado) return false;
    if (localActivo && String(f.local_id) !== String(localActivo)) return false;
    if (provFiltro && String(f.prov_id) !== String(provFiltro)) return false;
    if (desde && f.fecha < desde) return false;
    if (hasta && f.fecha > hasta) return false;
    if (search) {
      const prov = proveedores.find(p => p.id === f.prov_id);
      const matchProv = prov?.nombre.toLowerCase().includes(search.toLowerCase());
      const matchNro = (f.nro || "").toLowerCase().includes(search.toLowerCase());
      if (!matchProv && !matchNro) return false;
    }
    return true;
  });

  const fActivas = facturas.filter(f => f.estado !== "pagada" && f.estado !== "anulada" && (f.tipo || "factura") !== "nota_credito" && (!localActivo || String(f.local_id) === String(localActivo)));

  const onProvChange = (prov_id: string) => {
    const prov = proveedores.find(p => p.id === parseInt(prov_id));
    setForm((f: any) => ({ ...f, prov_id, cat: prov?.cat || f.cat }));
  };

  const addItem = () => setItems([...items, { producto: "", cantidad: "", unidad: "kg", precio_unitario: "", subtotal: 0 }]);
  const updateItem = (i: number, field: string, val: any) => {
    const newItems = [...items];
    newItems[i] = { ...newItems[i], [field]: val };
    if (field === "cantidad" || field === "precio_unitario") {
      const q = parseFloat(field === "cantidad" ? val : newItems[i].cantidad) || 0;
      const p = parseFloat(field === "precio_unitario" ? val : newItems[i].precio_unitario) || 0;
      newItems[i].subtotal = q * p;
    }
    setItems(newItems);
  };
  const removeItem = (i: number) => setItems(items.filter((_, idx) => idx !== i));

  const guardar = async () => {
    if (saving) return;
    if (!form.prov_id) { alert("Seleccioná un proveedor"); return; }
    if (!form.nro) { alert("Ingresá el número de factura"); return; }
    if (!form.neto) { alert("Ingresá el neto gravado"); return; }
    if (!form.local_id) { alert("Seleccioná un local"); return; }
    setSaving(true);
    try {
      const isNC = form.tipo === "nota_credito";
      const totalAbs = calcTotal();
      const total = isNC ? -Math.abs(totalAbs) : totalAbs;
      const id = genId(isNC ? "NC" : "FACT");
      const nueva = { ...form, id, prov_id: parseInt(form.prov_id), local_id: parseInt(form.local_id), neto: parseFloat(form.neto), iva21: parseFloat(form.iva21) || 0, iva105: parseFloat(form.iva105) || 0, iibb: parseFloat(form.iibb) || 0, perc_iva: parseFloat(form.perc_iva) || 0, otros_cargos: parseFloat(form.otros_cargos) || 0, descuentos: parseFloat(form.descuentos) || 0, total, estado: isNC ? "pagada" : "pendiente", pagos: [], tipo: form.tipo };
      const { error: factErr } = await db.from("facturas").insert([nueva]);
      if (factErr) throw new Error("Error guardando factura: " + factErr.message);

      if (items.length > 0) {
        const itemsToInsert = items.filter(it => it.producto).map(it => ({ ...it, factura_id: id, cantidad: parseFloat(it.cantidad) || 0, precio_unitario: parseFloat(it.precio_unitario) || 0, subtotal: it.subtotal }));
        if (itemsToInsert.length > 0) await db.from("factura_items").insert(itemsToInsert);
      }
      const prov = proveedores.find(p => p.id === nueva.prov_id);
      if (prov) {
        const saldoDelta = isNC ? -Math.abs(totalAbs) : totalAbs;
        await db.from("proveedores").update({ saldo: Math.max(0, (prov.saldo || 0) + saldoDelta) }).eq("id", prov.id);
      }
      setModal(false); setForm(emptyForm); setItems([]); load();
    } catch (err: any) {
      console.error("Error guardando factura:", err);
      alert("Error al guardar: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  const pagar = async () => {
    if (pagando) return;
    setPagando(true);
    try {
      const f = pagarModal;
      const monto = parseFloat(pagoForm.monto) || f.total;
      const prov = proveedores.find(p => p.id === f.prov_id);
      const detalle = `Pago ${prov?.nombre || ""} - Fact ${f.nro}`;
      const { error } = await db.rpc("pagar_factura", {
        p_factura_id: f.id,
        p_monto: monto,
        p_cuenta: pagoForm.cuenta,
        p_fecha: pagoForm.fecha,
        p_detalle: detalle,
      });
      if (error) throw error;
      setPagarModal(null);
      load();
    } catch (err: any) {
      console.error("Error en pagar:", err);
      alert(translateRpcError(err));
    } finally {
      setPagando(false);
    }
  };

  const anular = async (f: any) => {
    if (!confirm(`¿Anular factura ${f.nro}? Esta acción queda registrada.`)) return;
    const motivo = prompt("Motivo (opcional):") || "Anulada desde UI";
    const { error } = await db.rpc("anular_factura", { p_factura_id: f.id, p_motivo: motivo });
    if (error) { alert(translateRpcError(error)); return; }
    load();
  };

  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Facturas</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-sec" onClick={() => setLectorModal(true)}>Lector IA</button>
          <button className="btn btn-acc" onClick={() => { setForm({ ...emptyForm, local_id: localActivo ? String(localActivo) : "" }); setItems([]); setModal(true); }}>+ Cargar Factura</button>
        </div>
      </div>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <input className="search" placeholder="Buscar proveedor o Nº..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} />
        <div style={{ width: 1, height: 22, background: "var(--bd)" }} />
        <input type="date" className="search" value={desde} onChange={e => setDesde(e.target.value)} style={{ width: 145 }} />
        <span style={{ fontSize: 12, color: "var(--muted2)" }}>→</span>
        <input type="date" className="search" value={hasta} onChange={e => setHasta(e.target.value)} style={{ width: 145 }} />
        <div style={{ width: 1, height: 22, background: "var(--bd)" }} />
        <select className="search" value={provFiltro} onChange={e => setProvFiltro(e.target.value)} style={{ width: 200 }}>
          <option value="">Todos los proveedores</option>
          {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </div>

      {/* Pills */}
      <div className="pills">
        {[["todas", "Todas"], ["pendiente", "Pendientes"], ["vencida", "Vencidas"], ["pagada", "Pagadas"]].map(([id, l]) => (
          <div key={id} className={`pill ${pillEstado === id ? "active" : ""}`} onClick={() => setPillEstado(id)}>{l}</div>
        ))}
      </div>

      {/* Tabla */}
      <div className="panel">
        {loading ? <div className="loading">Cargando...</div> : fFilt.length === 0 ? <div className="empty">No hay facturas con esos filtros</div> : (
          <table>
            <thead><tr>
              <th>Proveedor · Nº</th>
              <th>Fecha · Vence</th>
              <th>Categoría</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th>Estado</th>
              <th></th>
            </tr></thead>
            <tbody>{fFilt.map(f => {
              const prov = proveedores.find(p => p.id === f.prov_id);
              return (
                <tr key={f.id}>
                  <td>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "var(--txt)" }}>{prov?.nombre || "—"}</div>
                    <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 1 }}>{f.nro}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: 11, color: "var(--txt)" }}>{fmt_d(f.fecha)}</div>
                    <div style={{ fontSize: 10, color: f.estado === "vencida" ? "var(--acc)" : "var(--muted2)", marginTop: 1 }}>
                      {f.venc ? "Vence " + fmt_d(f.venc) : "—"}
                    </div>
                  </td>
                  <td><span className="badge b-muted">{f.cat || "—"}</span></td>
                  <td style={{ textAlign: "right" }}><span className="num">{fmt_$(f.total)}</span></td>
                  <td>{estadoDot(f.estado)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setVerModal(f)}>Ver</button>
                      {f.estado !== "pagada" && <button className="btn btn-success btn-sm" onClick={() => { setPagarModal(f); setPagoForm({ cuenta: "MercadoPago", monto: f.total, fecha: toISO(today) }); }}>Pagar</button>}
                      <button className="btn btn-danger btn-sm" onClick={() => anular(f)}>Anular</button>
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>

      {/* MODAL LECTOR IA */}
      {lectorModal && (
        <div className="overlay" onClick={() => setLectorModal(false)}>
          <div className="modal" style={{ width: 720 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Lector Facturas IA</div>
              <button className="close-btn" onClick={() => setLectorModal(false)}>✕</button>
            </div>
            <div className="modal-body">
              <LectorFacturasIA user={user} locales={locales} localActivo={localActivo} />
            </div>
          </div>
        </div>
      )}

      {/* MODAL CARGAR FACTURA */}
      {modal && (
        <div className="overlay" onClick={() => setModal(false)}>
          <div className="modal" style={{ width: 680 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">{form.tipo === "nota_credito" ? "Cargar Nota de Crédito" : "Cargar Factura"}</div><button className="close-btn" onClick={() => setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Tipo de comprobante</label><select value={form.tipo} onChange={e => setForm({ ...form, tipo: e.target.value })}><option value="factura">Factura</option><option value="nota_credito">Nota de Crédito</option></select></div>
                <div className="field"><label>Local *</label><select value={form.local_id} onChange={e => setForm({ ...form, local_id: e.target.value })}><option value="">Seleccioná...</option>{localesDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Proveedor *</label><select value={form.prov_id} onChange={e => onProvChange(e.target.value)}><option value="">Seleccioná...</option>{proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></div>
                <div className="field"><label>Nº Factura *</label><input value={form.nro} onChange={e => setForm({ ...form, nro: e.target.value })} placeholder="A-0001-00001234" /></div>
              </div>
              <div className="form2">
                <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e => setForm({ ...form, cat: e.target.value })}><option value="">Seleccioná...</option>{CATEGORIAS_COMPRA.map(c => <option key={c}>{c}</option>)}</select></div>
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} /></div>
              </div>
              <div className="form2">
                <div className="field"><label>Vencimiento</label><input type="date" value={form.venc} onChange={e => setForm({ ...form, venc: e.target.value })} /></div>
                <div className="field"><label>Neto Gravado *</label><input type="number" value={form.neto} onChange={e => setForm({ ...form, neto: e.target.value })} placeholder="0" /></div>
              </div>
              <div className="form3">
                <div className="field"><label>IVA 21%</label><input type="number" value={form.iva21} onChange={e => setForm({ ...form, iva21: e.target.value })} placeholder="0" /></div>
                <div className="field"><label>IVA 10.5%</label><input type="number" value={form.iva105} onChange={e => setForm({ ...form, iva105: e.target.value })} placeholder="0" /></div>
                <div className="field"><label>Perc. IIBB</label><input type="number" value={form.iibb} onChange={e => setForm({ ...form, iibb: e.target.value })} placeholder="0" /></div>
              </div>
              <div className="form3">
                <div className="field"><label>Perc. IVA</label><input type="number" value={form.perc_iva} onChange={e => setForm({ ...form, perc_iva: e.target.value })} placeholder="0" /></div>
                <div className="field"><label>Otros Cargos</label><input type="number" value={form.otros_cargos} onChange={e => setForm({ ...form, otros_cargos: e.target.value })} placeholder="0" /></div>
                <div className="field"><label>Descuentos (−)</label><input type="number" value={form.descuentos} onChange={e => setForm({ ...form, descuentos: e.target.value })} placeholder="0" /></div>
              </div>
              <div className="field"><label>Total calculado</label><input readOnly value={fmt_$(calcTotal())} style={{ color: "var(--acc)", fontFamily: "'Inter',sans-serif", fontWeight: 500 }} /></div>
              <div className="field"><label>Descripción</label><input value={form.detalle} onChange={e => setForm({ ...form, detalle: e.target.value })} placeholder="Detalle general..." /></div>

              {/* DETALLE DE INSUMOS */}
              <div style={{ marginTop: 16, borderTop: "1px solid var(--bd)", paddingTop: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 10, letterSpacing: .8, textTransform: "uppercase", color: "var(--muted2)" }}>Detalle de Insumos (opcional)</span>
                  <button className="btn btn-ghost btn-sm" onClick={addItem}>+ Agregar ítem</button>
                </div>
                {items.length > 0 && (
                  <table className="items-table">
                    <thead><tr><th>Producto</th><th>Cantidad</th><th>Unidad</th><th>Precio unit.</th><th>Subtotal</th><th></th></tr></thead>
                    <tbody>{items.map((it, i) => (
                      <tr key={i}>
                        <td><input style={{ width: "100%", background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.producto} onChange={e => updateItem(i, "producto", e.target.value)} placeholder="Ej: Salmón" /></td>
                        <td><input type="number" style={{ width: 70, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.cantidad} onChange={e => updateItem(i, "cantidad", e.target.value)} /></td>
                        <td><select style={{ background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.unidad} onChange={e => updateItem(i, "unidad", e.target.value)}>{UNIDADES.map(u => <option key={u}>{u}</option>)}</select></td>
                        <td><input type="number" style={{ width: 90, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--txt)", padding: "4px 6px", fontFamily: "'Inter',sans-serif", fontSize: 11, borderRadius: "var(--r)" }} value={it.precio_unitario} onChange={e => updateItem(i, "precio_unitario", e.target.value)} /></td>
                        <td style={{ color: "var(--acc)", fontFamily: "'Inter',sans-serif", fontSize: 13, fontWeight: 500 }}>{fmt_$(it.subtotal)}</td>
                        <td><button className="btn btn-danger btn-sm" onClick={() => removeItem(i)}>✕</button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar} disabled={saving}>{saving ? "Guardando..." : "Guardar"}</button></div>
          </div>
        </div>
      )}

      {/* MODAL VER FACTURA */}
      {verModal && (
        <div className="overlay" onClick={() => setVerModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Factura {verModal.nro}</div><button className="close-btn" onClick={() => setVerModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div><span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase" }}>Proveedor</span><div style={{ marginTop: 4 }}>{proveedores.find(p => p.id === verModal.prov_id)?.nombre}</div></div>
                <div><span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase" }}>Local</span><div style={{ marginTop: 4 }}>{locales.find(l => l.id === verModal.local_id)?.nombre}</div></div>
              </div>
              <div className="form3" style={{ marginTop: 12 }}>
                <div><span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase" }}>Fecha</span><div style={{ marginTop: 4 }}>{fmt_d(verModal.fecha)}</div></div>
                <div><span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase" }}>Vencimiento</span><div style={{ marginTop: 4 }}>{fmt_d(verModal.venc)}</div></div>
                <div><span style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase" }}>Categoría</span><div style={{ marginTop: 4 }}>{verModal.cat}</div></div>
              </div>
              <div style={{ marginTop: 16, background: "var(--s2)", padding: 12, borderRadius: "var(--r)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>Neto Gravado</span><span>{fmt_$(verModal.neto)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>IVA 21%</span><span>{fmt_$(verModal.iva21)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>IVA 10.5%</span><span>{fmt_$(verModal.iva105)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>Perc. IIBB</span><span>{fmt_$(verModal.iibb)}</span></div>
                {Number(verModal.perc_iva) > 0 && <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>Perc. IVA</span><span>{fmt_$(verModal.perc_iva)}</span></div>}
                {Number(verModal.otros_cargos) > 0 && <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12 }}><span>Otros Cargos</span><span>{fmt_$(verModal.otros_cargos)}</span></div>}
                {Number(verModal.descuentos) > 0 && <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 12, color: "var(--danger)" }}><span>Descuentos</span><span>− {fmt_$(verModal.descuentos)}</span></div>}
                <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--bd)", paddingTop: 8, fontFamily: "'Inter',sans-serif", fontSize: 16, fontWeight: 500 }}><span>TOTAL</span><span style={{ color: "var(--acc)" }}>{fmt_$(verModal.total)}</span></div>
              </div>
              {(verModal.pagos || []).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase", marginBottom: 8 }}>Pagos registrados</div>
                  {verModal.pagos.map((p: any, i: number) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--bd)", fontSize: 12 }}>
                      <span>{fmt_d(p.fecha)} · {p.cuenta}</span><span style={{ color: "var(--muted2)" }}>{fmt_$(p.monto)}</span>
                    </div>
                  ))}
                </div>
              )}
              {verModal.imagen_url && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: .8, textTransform: "uppercase", marginBottom: 8 }}>Comprobante</div>
                  {imgLoading && <div className="loading">Cargando comprobante...</div>}
                  {!imgLoading && imgUrl && (() => {
                    const isPdf = /\.pdf$/i.test(verModal.imagen_url);
                    return isPdf ? (
                      <div>
                        <iframe src={imgUrl} style={{ width: "100%", height: 500, border: "1px solid var(--bd)", borderRadius: "var(--r)", background: "#fff" }} />
                        <div style={{ marginTop: 6, fontSize: 11 }}>
                          <a href={imgUrl} target="_blank" rel="noreferrer" style={{ color: "var(--acc)" }}>Abrir en nueva pestaña →</a>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <a href={imgUrl} target="_blank" rel="noreferrer">
                          <img src={imgUrl} alt="Comprobante" style={{ width: "100%", maxHeight: 500, objectFit: "contain", borderRadius: "var(--r)", border: "1px solid var(--bd)", background: "#fff" }} />
                        </a>
                      </div>
                    );
                  })()}
                  {!imgLoading && !imgUrl && (
                    <div className="alert alert-warn" style={{ fontSize: 11 }}>No se pudo cargar el comprobante. El archivo puede haber sido eliminado.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL PAGAR */}
      {pagarModal && (
        <div className="overlay" onClick={() => setPagarModal(null)}>
          <div className="modal" style={{ width: 420 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Registrar Pago</div><button className="close-btn" onClick={() => setPagarModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-info">{pagarModal.nro} · Total: {fmt_$(pagarModal.total)}</div>
              <div className="field"><label>Cuenta de egreso</label><select value={pagoForm.cuenta} onChange={e => setPagoForm({ ...pagoForm, cuenta: e.target.value })}>{cuentasUsables.map(c => <option key={c}>{c}</option>)}</select></div>
              <div className="field"><label>Monto</label><input type="number" value={pagoForm.monto} onChange={e => setPagoForm({ ...pagoForm, monto: e.target.value })} /></div>
              <div className="field"><label>Fecha</label><input type="date" value={pagoForm.fecha} onChange={e => setPagoForm({ ...pagoForm, fecha: e.target.value })} /></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setPagarModal(null)}>Cancelar</button><button className="btn btn-success" onClick={pagar} disabled={pagando}>{pagando ? "Procesando..." : "Confirmar Pago"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
