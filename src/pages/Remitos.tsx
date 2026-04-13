import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { CATEGORIAS_COMPRA, CUENTAS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

export default function Remitos({ user, locales, localActivo }) {
  const [remitos, setRemitos] = useState([]);
  const [facturas, setFacturas] = useState([]);
  const [proveedores, setProveedores] = useState([]);
  const [modal, setModal] = useState(false);
  const [vincModal, setVincModal] = useState(null);
  const [pagarModal, setPagarModal] = useState(null);
  const [loading, setLoading] = useState(true);
  const emptyForm = {prov_id:"",local_id:localActivo||"",nro:"",fecha:toISO(today),monto:"",cat:"",detalle:""};
  const [form, setForm] = useState(emptyForm);
  const [pagoForm, setPagoForm] = useState({cuenta:"MercadoPago",monto:"",fecha:toISO(today)});
  const localesDisp = user.rol==="dueno"?locales:locales.filter(l=>(user.locales||[]).includes(l.id));

  const load = async () => {
    setLoading(true);
    const [{data:r},{data:f},{data:p}] = await Promise.all([
      db.from("remitos").select("*").order("fecha",{ascending:false}),
      db.from("facturas").select("*").neq("estado","pagada").neq("estado","anulada"),
      db.from("proveedores").select("*").eq("estado","Activo").order("nombre"),
    ]);
    setRemitos(r||[]); setFacturas(f||[]); setProveedores(p||[]); setLoading(false);
  };
  useEffect(()=>{load();},[]);

  const rFilt = remitos.filter(r=>!localActivo||r.local_id===localActivo);
  const sinFact = rFilt.filter(r=>r.estado==="sin_factura");

  const onProvChange = (prov_id) => {
    const prov = proveedores.find(p=>p.id===parseInt(prov_id));
    setForm(f=>({...f,prov_id,cat:prov?.cat||f.cat}));
  };

  const guardar = async () => {
    if(!form.prov_id||!form.monto||!form.local_id) return;
    const nro = form.nro||`REM-${Date.now().toString().slice(-6)}`;
    const nuevo = {...form,id:genId("REM"),prov_id:parseInt(form.prov_id),local_id:parseInt(form.local_id),nro,monto:parseFloat(form.monto),estado:"sin_factura",fact_id:null};
    await db.from("remitos").insert([nuevo]);
    const prov = proveedores.find(p=>p.id===nuevo.prov_id);
    if(prov) await db.from("proveedores").update({saldo:(prov.saldo||0)+nuevo.monto}).eq("id",prov.id);
    setModal(false); setForm(emptyForm); load();
  };

  const vincFact = async (fid) => {
    const r = vincModal;
    const f = facturas.find(f=>f.id===fid);
    // Cancelar deuda del remito y reemplazar por la de la factura (diferencia)
    const prov = proveedores.find(p=>p.id===r.prov_id);
    if(prov) {
      const diff = (f?.total||0) - r.monto; // diferencia puede ser positiva o negativa
      // El saldo ya tiene la deuda del remito, solo ajustamos la diferencia
      await db.from("proveedores").update({saldo:Math.max(0,(prov.saldo||0)+diff)}).eq("id",prov.id);
    }
    await db.from("remitos").update({estado:"facturado",fact_id:fid}).eq("id",r.id);
    setVincModal(null); load();
  };

  const [pagandoRem,setPagandoRem]=useState(false);
  const pagarRemito = async () => {
    if(pagandoRem) return; setPagandoRem(true);
    const r = pagarModal;
    const monto = parseFloat(pagoForm.monto)||r.monto;
    await db.from("remitos").update({estado:"pagado"}).eq("id",r.id);
    const prov = proveedores.find(p=>p.id===r.prov_id);
    if(prov) await db.from("proveedores").update({saldo:Math.max(0,(prov.saldo||0)-monto)}).eq("id",r.prov_id);
    const {data:caja} = await db.from("saldos_caja").select("saldo").eq("cuenta",pagoForm.cuenta).single();
    if(caja) await db.from("saldos_caja").update({saldo:(caja.saldo||0)-monto}).eq("cuenta",pagoForm.cuenta);
    await db.from("movimientos").insert([{id:genId("MOV"),fecha:pagoForm.fecha,cuenta:pagoForm.cuenta,tipo:"Pago Proveedor",cat:r.cat,importe:-monto,detalle:`Pago remito ${r.nro} - ${prov?.nombre||""}`,fact_id:null}]);
    setPagandoRem(false); setPagarModal(null); load();
  };

  const anular = async (r) => {
    if(!confirm(`¿Anular remito ${r.nro}?`)) return;
    await db.from("remitos").update({estado:"anulado"}).eq("id",r.id);
    if(r.estado==="sin_factura") {
      const prov = proveedores.find(p=>p.id===r.prov_id);
      if(prov) await db.from("proveedores").update({saldo:Math.max(0,(prov.saldo||0)-r.monto)}).eq("id",r.prov_id);
    }
    load();
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Remitos</div><div className="ph-sub">{sinFact.length} sin factura · {fmt_$(sinFact.reduce((s,r)=>s+(r.monto||0),0))} deuda provisoria</div></div>
        <button className="btn btn-acc" onClick={()=>{setForm(emptyForm);setModal(true)}}>+ Remito Valorado</button>
      </div>
      <div className="alert alert-warn">Los remitos generan <strong>deuda provisoria</strong>. Vinculalos a la factura cuando llegue, o registrá el pago directo si no viene factura.</div>
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:rFilt.length===0?<div className="empty">No hay remitos</div>:(
          <table><thead><tr><th>Proveedor</th><th>Nº Remito</th><th>Fecha</th><th>Categoría</th><th>Monto</th><th>Estado</th><th></th></tr></thead>
          <tbody>{rFilt.map(r=>{
            const prov=proveedores.find(p=>p.id===r.prov_id);
            const isAnulado = r.estado==="anulado";
            return (
              <tr key={r.id} className={r.estado==="sin_factura"?"remito-row":isAnulado?"anulada-row":""}>
                <td style={{fontWeight:500}}>{prov?.nombre}</td>
                <td className="mono">{r.nro}</td>
                <td className="mono">{fmt_d(r.fecha)}</td>
                <td><span className="badge b-muted">{r.cat}</span></td>
                <td><span className="num kpi-warn">{fmt_$(r.monto)}</span></td>
                <td>
                  {r.estado==="sin_factura"&&<span className="badge b-warn">Sin Factura</span>}
                  {r.estado==="facturado"&&<span className="badge b-success">Facturado</span>}
                  {r.estado==="pagado"&&<span className="badge b-info">Pagado</span>}
                  {r.estado==="anulado"&&<span className="badge b-anulada">Anulado</span>}
                </td>
                <td>
                  {!isAnulado && (
                    <div style={{display:"flex",gap:4}}>
                      {r.estado==="sin_factura"&&<button className="btn btn-ghost btn-sm" onClick={()=>setVincModal(r)}>Vincular FC</button>}
                      {r.estado==="sin_factura"&&<button className="btn btn-success btn-sm" onClick={()=>{setPagarModal(r);setPagoForm({cuenta:"MercadoPago",monto:r.monto,fecha:toISO(today)})}}>Pagar</button>}
                      <button className="btn btn-danger btn-sm" onClick={()=>anular(r)}>Anular</button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}</tbody></table>
        )}
      </div>

      {modal && (
        <div className="overlay" onClick={()=>setModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nuevo Remito Valorado</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-info">Para compras informales. Si llega factura, la vinculás. Si no llega, pagás directo.</div>
              <div className="form2">
                <div className="field"><label>Proveedor *</label><select value={form.prov_id} onChange={e=>onProvChange(e.target.value)}><option value="">Seleccioná...</option>{proveedores.map(p=><option key={p.id} value={p.id}>{p.nombre}</option>)}</select></div>
                <div className="field"><label>Local *</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Seleccioná...</option>{localesDisp.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Nº Remito (opcional)</label><input value={form.nro} onChange={e=>setForm({...form,nro:e.target.value})} placeholder="Se genera automático"/></div>
                <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}><option value="">Seleccioná...</option>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
                <div className="field"><label>Monto *</label><input type="number" value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="0"/></div>
              </div>
              <div className="field"><label>Descripción / Folio</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Folio 1234 - Detalle..."/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Confirmar</button></div>
          </div>
        </div>
      )}

      {vincModal && (
        <div className="overlay" onClick={()=>setVincModal(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Vincular a Factura</div><button className="close-btn" onClick={()=>setVincModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-warn">Remito {vincModal.nro} · {fmt_$(vincModal.monto)}</div>
              <p style={{fontSize:11,color:"var(--muted2)",marginBottom:12}}>Al vincular, la deuda provisoria del remito se ajusta con la deuda fiscal de la factura.</p>
              <table><thead><tr><th>Factura</th><th>Fecha</th><th>Total</th><th>Diferencia</th><th></th></tr></thead>
              <tbody>{facturas.filter(f=>f.prov_id===vincModal.prov_id).map(f=>{
                const diff = (f.total||0)-(vincModal.monto||0);
                return (<tr key={f.id}>
                  <td className="mono">{f.nro}</td><td>{fmt_d(f.fecha)}</td>
                  <td className="num">{fmt_$(f.total)}</td>
                  <td style={{color:diff>0?"var(--danger)":diff<0?"var(--success)":"var(--muted2)"}}>{diff>0?"+":""}{fmt_$(diff)}</td>
                  <td><button className="btn btn-acc btn-sm" onClick={()=>vincFact(f.id)}>Vincular</button></td>
                </tr>);
              })}</tbody></table>
              {facturas.filter(f=>f.prov_id===vincModal.prov_id).length===0&&<div className="empty">No hay facturas pendientes de este proveedor</div>}
            </div>
          </div>
        </div>
      )}

      {pagarModal && (
        <div className="overlay" onClick={()=>setPagarModal(null)}>
          <div className="modal" style={{width:420}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Pagar Remito Directo</div><button className="close-btn" onClick={()=>setPagarModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-info">Remito {pagarModal.nro} · {fmt_$(pagarModal.monto)}</div>
              <div className="alert alert-warn">Esto registra el pago sin factura. El gasto impacta en caja y en el EERR.</div>
              <div className="field"><label>Cuenta de egreso</label><select value={pagoForm.cuenta} onChange={e=>setPagoForm({...pagoForm,cuenta:e.target.value})}>{CUENTAS.map(c=><option key={c}>{c}</option>)}</select></div>
              <div className="field"><label>Monto</label><input type="number" value={pagoForm.monto} onChange={e=>setPagoForm({...pagoForm,monto:e.target.value})}/></div>
              <div className="field"><label>Fecha</label><input type="date" value={pagoForm.fecha} onChange={e=>setPagoForm({...pagoForm,fecha:e.target.value})}/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setPagarModal(null)}>Cancelar</button><button className="btn btn-success" onClick={pagarRemito} disabled={pagandoRem}>{pagandoRem?"Procesando...":"Confirmar Pago"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
