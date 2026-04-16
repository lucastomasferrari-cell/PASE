import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { CATEGORIAS_COMPRA, CUENTAS, UNIDADES } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";
import LectorFacturasIA from "./LectorFacturasIA";

export default function Compras({ user, locales, localActivo }) {
  const [facturas, setFacturas] = useState([]);
  const [proveedores, setProveedores] = useState([]);
  const [tab, setTab] = useState("todas");
  const [modal, setModal] = useState(false);
  const [pagarModal, setPagarModal] = useState(null);
  const [editModal, setEditModal] = useState(null);
  const [verModal, setVerModal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const emptyForm = {prov_id:"",local_id:localActivo||"",nro:"",fecha:toISO(today),venc:"",neto:"",iva21:"",iva105:"",iibb:"",cat:"",detalle:"",tipo:"factura"};
  const [form, setForm] = useState(emptyForm);
  const [items, setItems] = useState([]);
  const [pagoForm, setPagoForm] = useState({cuenta:"MercadoPago",monto:"",fecha:toISO(today)});
  const localesDisp = user.rol==="dueno"?locales:locales.filter(l=>(user.locales||[]).includes(l.id));
  const calcTotal = () => (parseFloat(form.neto)||0)+(parseFloat(form.iva21)||0)+(parseFloat(form.iva105)||0)+(parseFloat(form.iibb)||0);

  const load = async () => {
    setLoading(true);
    const [{data:f},{data:p}] = await Promise.all([
      db.from("facturas").select("*").order("fecha",{ascending:false}),
      db.from("proveedores").select("*").eq("estado","Activo").order("nombre"),
    ]);
    setFacturas(f||[]); setProveedores(p||[]); setLoading(false);
  };
  useEffect(()=>{load();},[]);

  const fFilt = facturas.filter(f=>{
    if(localActivo&&f.local_id!==localActivo) return false;
    if(tab==="pendientes") return f.estado==="pendiente"&&(f.tipo||"factura")!=="nota_credito";
    if(tab==="vencidas") return f.estado==="vencida"&&(f.tipo||"factura")!=="nota_credito";
    if(tab==="pagadas") return f.estado==="pagada";
    if(tab==="anuladas") return f.estado==="anulada";
    if(tab==="nc") return (f.tipo||"factura")==="nota_credito";
    return f.estado!=="anulada";
  }).filter(f=>!search||proveedores.find(p=>p.id===f.prov_id)?.nombre.toLowerCase().includes(search.toLowerCase())||(f.nro||"").includes(search));

  const fActivas = facturas.filter(f=>f.estado!=="pagada"&&f.estado!=="anulada"&&(!localActivo||f.local_id===localActivo));

  const onProvChange = (prov_id) => {
    const prov = proveedores.find(p=>p.id===parseInt(prov_id));
    setForm(f=>({...f,prov_id,cat:prov?.cat||f.cat}));
  };

  const addItem = () => setItems([...items,{producto:"",cantidad:"",unidad:"kg",precio_unitario:"",subtotal:0}]);
  const updateItem = (i,field,val) => {
    const newItems = [...items];
    newItems[i] = {...newItems[i],[field]:val};
    if(field==="cantidad"||field==="precio_unitario") {
      const q = parseFloat(field==="cantidad"?val:newItems[i].cantidad)||0;
      const p = parseFloat(field==="precio_unitario"?val:newItems[i].precio_unitario)||0;
      newItems[i].subtotal = q*p;
    }
    setItems(newItems);
  };
  const removeItem = (i) => setItems(items.filter((_,idx)=>idx!==i));

  const guardar = async () => {
    if(!form.prov_id||!form.nro||!form.neto||!form.local_id) return;
    const isNC = form.tipo === "nota_credito";
    const totalAbs = calcTotal();
    const total = isNC ? -Math.abs(totalAbs) : totalAbs;
    const id = genId(isNC ? "NC" : "FACT");
    const nueva = {...form,id,prov_id:parseInt(form.prov_id),local_id:parseInt(form.local_id),neto:parseFloat(form.neto),iva21:parseFloat(form.iva21)||0,iva105:parseFloat(form.iva105)||0,iibb:parseFloat(form.iibb)||0,total,estado:isNC?"pagada":"pendiente",pagos:[],tipo:form.tipo};
    await db.from("facturas").insert([nueva]);
    if(items.length>0) {
      const itemsToInsert = items.filter(it=>it.producto).map(it=>({...it,factura_id:id,cantidad:parseFloat(it.cantidad)||0,precio_unitario:parseFloat(it.precio_unitario)||0,subtotal:it.subtotal}));
      if(itemsToInsert.length>0) await db.from("factura_items").insert(itemsToInsert);
    }
    const prov = proveedores.find(p=>p.id===nueva.prov_id);
    if(prov) {
      const saldoDelta = isNC ? -Math.abs(totalAbs) : totalAbs;
      await db.from("proveedores").update({saldo:Math.max(0,(prov.saldo||0)+saldoDelta)}).eq("id",prov.id);
    }
    setModal(false); setForm(emptyForm); setItems([]); load();
  };

  const [pagando,setPagando]=useState(false);
  const pagar = async () => {
    if (pagando) return;
    setPagando(true);
    try {
      const f = pagarModal;
      const monto = parseFloat(pagoForm.monto) || f.total;
      const nuevosPagos = [...(f.pagos || []), { cuenta: pagoForm.cuenta, monto, fecha: pagoForm.fecha }];
      const totalPagado = nuevosPagos.reduce((s, p) => s + p.monto, 0);
      const nuevoEstado = totalPagado >= f.total ? "pagada" : "pendiente";

      const { error: factErr } = await db.from("facturas")
        .update({ estado: nuevoEstado, pagos: nuevosPagos }).eq("id", f.id);
      if (factErr) throw new Error("Error actualizando factura: " + factErr.message);

      const prov = proveedores.find(p => p.id === f.prov_id);
      if (prov) await db.from("proveedores")
        .update({ saldo: Math.max(0, (prov.saldo || 0) - monto) }).eq("id", f.prov_id);

      const { data: caja } = await db.from("saldos_caja")
        .select("saldo").eq("cuenta", pagoForm.cuenta).maybeSingle();
      if (caja) await db.from("saldos_caja")
        .update({ saldo: (caja.saldo || 0) - monto }).eq("cuenta", pagoForm.cuenta);

      const { error: movErr } = await db.from("movimientos").insert([{
        id: genId("MOV"), fecha: pagoForm.fecha, cuenta: pagoForm.cuenta,
        tipo: "Pago Proveedor", cat: f.cat, importe: -monto,
        detalle: `Pago ${prov?.nombre || ""} - Fact ${f.nro}`, fact_id: f.id
      }]);
      if (movErr) console.error("movimientos insert error (no crítico):", movErr);

      setPagarModal(null);
      load();
    } catch (err: any) {
      console.error("Error en pagar:", err);
      alert("Error al registrar el pago: " + err.message);
    } finally {
      setPagando(false);
    }
  };

  const anular = async (f) => {
    if(!confirm(`¿Anular factura ${f.nro}? Esta acción queda registrada.`)) return;
    await db.from("facturas").update({estado:"anulada"}).eq("id",f.id);
    const prov = proveedores.find(p=>p.id===f.prov_id);
    if(prov&&f.estado!=="pagada") await db.from("proveedores").update({saldo:Math.max(0,(prov.saldo||0)-f.total)}).eq("id",f.prov_id);
    load();
  };

  const eb = (e, tipo?) => {
    if((tipo||"factura")==="nota_credito") return <span className="badge b-info">NC</span>;
    if(e==="vencida") return <span className="badge b-danger">Vencida</span>;
    if(e==="pagada") return <span className="badge b-success">Pagada</span>;
    if(e==="anulada") return <span className="badge b-anulada">Anulada</span>;
    return <span className="badge b-warn">Pendiente</span>;
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Facturas</div><div className="ph-sub">{fActivas.length} activas · {fmt_$(fActivas.reduce((s,f)=>s+(f.total||0),0))} por pagar</div></div>
        <button className="btn btn-acc" onClick={()=>{setForm(emptyForm);setItems([]);setModal(true)}}>+ Cargar Factura</button>
      </div>
      <div className="tabs">
        {[["todas","Todas"],["pendientes","Pendientes"],["vencidas","Vencidas"],["pagadas","Pagadas"],["nc","Notas de Crédito"],["anuladas","Anuladas"],["lector_ia","Lector IA"]].map(([id,l])=>(
          <div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}</div>
        ))}
        <div style={{flex:1}}/>
        <input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)} style={{margin:"0 0 -1px",width:180}}/>
      </div>
      {tab==="lector_ia"?<LectorFacturasIA user={user} locales={locales} localActivo={localActivo}/>:
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:fFilt.length===0?<div className="empty">No hay facturas</div>:(
          <table><thead><tr><th>Proveedor</th><th>Nº Factura</th><th>Fecha</th><th>Vencimiento</th><th>Categoría</th><th>Total</th><th>Estado</th><th></th></tr></thead>
          <tbody>{fFilt.map(f=>{
            const prov=proveedores.find(p=>p.id===f.prov_id);
            return (
              <tr key={f.id} className={f.estado==="anulada"?"anulada-row":""}>
                <td style={{fontWeight:500,maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{prov?.nombre}</td>
                <td className="mono">{f.nro}</td>
                <td className="mono" style={{fontSize:11}}>{fmt_d(f.fecha)}</td>
                <td className="mono" style={{fontSize:11,color:f.estado==="vencida"?"var(--danger)":"var(--muted2)"}}>{fmt_d(f.venc)}</td>
                <td><span className="badge b-muted">{f.cat}</span></td>
                <td><span className="num kpi-warn">{fmt_$(f.total)}</span></td>
                <td>{eb(f.estado, f.tipo)}</td>
                <td>
                  <div style={{display:"flex",gap:4}}>
                    <button className="btn btn-ghost btn-sm" onClick={()=>setVerModal(f)}>Ver</button>
                    {f.estado!=="pagada"&&f.estado!=="anulada"&&<button className="btn btn-success btn-sm" onClick={()=>{setPagarModal(f);setPagoForm({cuenta:"MercadoPago",monto:f.total,fecha:toISO(today)})}}>Pagar</button>}
                    {f.estado!=="anulada"&&<button className="btn btn-danger btn-sm" onClick={()=>anular(f)}>Anular</button>}
                  </div>
                </td>
              </tr>
            );
          })}</tbody></table>
        )}
      </div>}

      {/* MODAL CARGAR FACTURA */}
      {modal && (
        <div className="overlay" onClick={()=>setModal(false)}>
          <div className="modal" style={{width:680}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">{form.tipo==="nota_credito"?"Cargar Nota de Crédito":"Cargar Factura"}</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Tipo de comprobante</label><select value={form.tipo} onChange={e=>setForm({...form,tipo:e.target.value})}><option value="factura">Factura</option><option value="nota_credito">Nota de Crédito</option></select></div>
                <div className="field"><label>Local *</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Seleccioná...</option>{localesDisp.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Proveedor *</label><select value={form.prov_id} onChange={e=>onProvChange(e.target.value)}><option value="">Seleccioná...</option>{proveedores.map(p=><option key={p.id} value={p.id}>{p.nombre}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Nº Factura *</label><input value={form.nro} onChange={e=>setForm({...form,nro:e.target.value})} placeholder="A-0001-00001234"/></div>
                <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}><option value="">Seleccioná...</option>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
                <div className="field"><label>Vencimiento</label><input type="date" value={form.venc} onChange={e=>setForm({...form,venc:e.target.value})}/></div>
              </div>
              <div className="form3">
                <div className="field"><label>Neto Gravado *</label><input type="number" value={form.neto} onChange={e=>setForm({...form,neto:e.target.value})} placeholder="0"/></div>
                <div className="field"><label>IVA 21%</label><input type="number" value={form.iva21} onChange={e=>setForm({...form,iva21:e.target.value})} placeholder="0"/></div>
                <div className="field"><label>IVA 10.5%</label><input type="number" value={form.iva105} onChange={e=>setForm({...form,iva105:e.target.value})} placeholder="0"/></div>
              </div>
              <div className="form2">
                <div className="field"><label>Perc. IIBB</label><input type="number" value={form.iibb} onChange={e=>setForm({...form,iibb:e.target.value})} placeholder="0"/></div>
                <div className="field"><label>Total calculado</label><input readOnly value={fmt_$(calcTotal())} style={{color:"var(--acc)",fontFamily:"'Syne',sans-serif",fontWeight:700}}/></div>
              </div>
              <div className="field"><label>Descripción</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Detalle general..."/></div>

              {/* DETALLE DE INSUMOS */}
              <div style={{marginTop:16,borderTop:"1px solid var(--bd)",paddingTop:16}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <span style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"var(--muted2)"}}>Detalle de Insumos (opcional)</span>
                  <button className="btn btn-ghost btn-sm" onClick={addItem}>+ Agregar ítem</button>
                </div>
                {items.length>0 && (
                  <table className="items-table">
                    <thead><tr><th>Producto</th><th>Cantidad</th><th>Unidad</th><th>Precio unit.</th><th>Subtotal</th><th></th></tr></thead>
                    <tbody>{items.map((it,i)=>(
                      <tr key={i}>
                        <td><input style={{width:"100%",background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)"}} value={it.producto} onChange={e=>updateItem(i,"producto",e.target.value)} placeholder="Ej: Salmón"/></td>
                        <td><input type="number" style={{width:70,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)"}} value={it.cantidad} onChange={e=>updateItem(i,"cantidad",e.target.value)}/></td>
                        <td><select style={{background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)"}} value={it.unidad} onChange={e=>updateItem(i,"unidad",e.target.value)}>{UNIDADES.map(u=><option key={u}>{u}</option>)}</select></td>
                        <td><input type="number" style={{width:90,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)"}} value={it.precio_unitario} onChange={e=>updateItem(i,"precio_unitario",e.target.value)}/></td>
                        <td style={{color:"var(--acc)",fontFamily:"'Syne',sans-serif",fontSize:13,fontWeight:700}}>{fmt_$(it.subtotal)}</td>
                        <td><button className="btn btn-danger btn-sm" onClick={()=>removeItem(i)}>✕</button></td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
          </div>
        </div>
      )}

      {/* MODAL VER FACTURA */}
      {verModal && (
        <div className="overlay" onClick={()=>setVerModal(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Factura {verModal.nro}</div><button className="close-btn" onClick={()=>setVerModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div><span style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Proveedor</span><div style={{marginTop:4}}>{proveedores.find(p=>p.id===verModal.prov_id)?.nombre}</div></div>
                <div><span style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Local</span><div style={{marginTop:4}}>{locales.find(l=>l.id===verModal.local_id)?.nombre}</div></div>
              </div>
              <div className="form3" style={{marginTop:12}}>
                <div><span style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Fecha</span><div style={{marginTop:4}}>{fmt_d(verModal.fecha)}</div></div>
                <div><span style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Vencimiento</span><div style={{marginTop:4}}>{fmt_d(verModal.venc)}</div></div>
                <div><span style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Categoría</span><div style={{marginTop:4}}>{verModal.cat}</div></div>
              </div>
              <div style={{marginTop:16,background:"var(--s2)",padding:12,borderRadius:"var(--r)"}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}><span>Neto Gravado</span><span>{fmt_$(verModal.neto)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}><span>IVA 21%</span><span>{fmt_$(verModal.iva21)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}><span>IVA 10.5%</span><span>{fmt_$(verModal.iva105)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}><span>Perc. IIBB</span><span>{fmt_$(verModal.iibb)}</span></div>
                <div style={{display:"flex",justifyContent:"space-between",borderTop:"1px solid var(--bd)",paddingTop:8,fontFamily:"'Syne',sans-serif",fontSize:18,fontWeight:700}}><span>TOTAL</span><span style={{color:"var(--acc)"}}>{fmt_$(verModal.total)}</span></div>
              </div>
              {(verModal.pagos||[]).length>0 && (
                <div style={{marginTop:12}}>
                  <div style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Pagos registrados</div>
                  {verModal.pagos.map((p,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid var(--bd)",fontSize:12}}>
                      <span>{fmt_d(p.fecha)} · {p.cuenta}</span><span style={{color:"var(--success)"}}>{fmt_$(p.monto)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL PAGAR */}
      {pagarModal && (
        <div className="overlay" onClick={()=>setPagarModal(null)}>
          <div className="modal" style={{width:420}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Registrar Pago</div><button className="close-btn" onClick={()=>setPagarModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-info">{pagarModal.nro} · Total: {fmt_$(pagarModal.total)}</div>
              <div className="field"><label>Cuenta de egreso</label><select value={pagoForm.cuenta} onChange={e=>setPagoForm({...pagoForm,cuenta:e.target.value})}>{CUENTAS.map(c=><option key={c}>{c}</option>)}</select></div>
              <div className="field"><label>Monto</label><input type="number" value={pagoForm.monto} onChange={e=>setPagoForm({...pagoForm,monto:e.target.value})}/></div>
              <div className="field"><label>Fecha</label><input type="date" value={pagoForm.fecha} onChange={e=>setPagoForm({...pagoForm,fecha:e.target.value})}/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setPagarModal(null)}>Cancelar</button><button className="btn btn-success" onClick={pagar}>Confirmar Pago</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
