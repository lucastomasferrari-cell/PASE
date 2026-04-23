import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope } from "../lib/auth";
import { CATEGORIAS_COMPRA } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$ } from "../lib/utils";

// ─── PROVEEDORES ──────────────────────────────────────────────────────────────
export default function Proveedores({ user, localActivo }: { user: any; locales?: any; localActivo: number | null }) {
  const [proveedores,setProveedores]=useState<any[]>([]);
  const [modal,setModal]=useState(false);
  const [editModal,setEditModal]=useState<any>(null);
  const [ctaModal,setCtaModal]=useState<any>(null);
  const [ctaFacts,setCtaFacts]=useState<any[]>([]);
  const [ctaLoading,setCtaLoading]=useState(false);
  const [ctaMes,setCtaMes]=useState(toISO(today).slice(0,7));
  const [search,setSearch]=useState("");
  const [loading,setLoading]=useState(true);
  const emptyForm={nombre:"",cuit:"",cat:"PESCADERIA",estado:"Activo"};
  const [form,setForm]=useState(emptyForm);
  const load=async()=>{
    setLoading(true);
    // proveedores es global (sin local_id)
    const {data:provs}=await db.from("proveedores").select("*").order("nombre");
    // facturas scoped para recalcular saldo por proveedor dentro del alcance del usuario
    let fq=db.from("facturas").select("prov_id,total,tipo,estado").neq("estado","anulada");
    fq=applyLocalScope(fq,user,localActivo);
    const {data:facts}=await fq;
    const saldoPorProv=new Map<number,number>();
    for(const f of (facts||[])){
      if(f.prov_id==null)continue;
      const isNC=(f.tipo||"factura")==="nota_credito";
      const impagable=f.estado==="pendiente"||f.estado==="vencida";
      if(isNC)saldoPorProv.set(f.prov_id,(saldoPorProv.get(f.prov_id)||0)-Math.abs(f.total||0));
      else if(impagable)saldoPorProv.set(f.prov_id,(saldoPorProv.get(f.prov_id)||0)+Number(f.total||0));
    }
    setProveedores((provs||[]).map(p=>({...p,saldo:saldoPorProv.get(p.id)||0})));
    setLoading(false);
  };
  useEffect(()=>{load();},[localActivo]);
  const pFilt=proveedores.filter(p=>!search||p.nombre.toLowerCase().includes(search.toLowerCase())||(p.cuit||"").includes(search));
  const guardar=async()=>{
    if(!form.nombre)return;
    const {error}=await db.from("proveedores").insert([{...form,saldo:0}]);
    if(error){alert("Error creando proveedor: "+error.message);return;}
    setModal(false);setForm(emptyForm);
    await load();
  };
  const guardarEdit=async()=>{
    const {error}=await db.from("proveedores").update({nombre:editModal.nombre,cuit:editModal.cuit,cat:editModal.cat,estado:editModal.estado}).eq("id",editModal.id);
    if(error){alert("Error editando proveedor: "+error.message);return;}
    setEditModal(null);
    await load();
  };
  const toggleEstado=async(p)=>{
    const {error}=await db.from("proveedores").update({estado:p.estado==="Activo"?"Inactivo":"Activo"}).eq("id",p.id);
    if(error){alert("Error: "+error.message);return;}
    await load();
  };
  const abrirCta=async(p)=>{
    setCtaFacts([]);
    setCtaMes(toISO(today).slice(0,7));
    setCtaModal(p);
    setCtaLoading(true);
    let q=db.from("facturas").select("*").eq("prov_id",p.id).neq("estado","anulada").order("fecha",{ascending:false});
    q=applyLocalScope(q,user,localActivo);
    const {data,error}=await q;
    if(error)console.error("Error cargando estado de cuenta:",error);
    setCtaFacts(data||[]);setCtaLoading(false);
  };
  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Proveedores</div></div>
        <div style={{display:"flex",gap:8}}><input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)}/><button className="btn btn-acc" onClick={()=>setModal(true)}>+ Nuevo</button></div>
      </div>
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:(
          <table><thead><tr><th>Proveedor</th><th>CUIT</th><th>Categoría EERR</th><th>Saldo</th><th>Estado</th><th></th></tr></thead>
          <tbody>{pFilt.map(p=>(
            <tr key={p.id} className={p.saldo>0?"prov-row":""} style={{opacity:p.estado==="Inactivo"?0.5:1}}>
              <td style={{fontWeight:500}}>{p.nombre}</td>
              <td className="mono" style={{color:"var(--muted2)"}}>{p.cuit||"—"}</td>
              <td><span className="badge b-muted">{p.cat}</span></td>
              <td><span className="num" style={{color:p.saldo>0?"var(--warn)":"var(--muted2)"}}>{fmt_$(p.saldo||0)}</span></td>
              <td><span className={`badge ${p.estado==="Activo"?"b-success":"b-muted"}`}>{p.estado}</span></td>
              <td><div style={{display:"flex",gap:4}}>
                <button className="btn btn-ghost btn-sm" onClick={()=>abrirCta(p)}>Edo. Cuenta</button>
                <button className="btn btn-ghost btn-sm" onClick={()=>setEditModal({...p})}>Editar</button>
                <button className="btn btn-ghost btn-sm" onClick={()=>toggleEstado(p)}>{p.estado==="Activo"?"Desactivar":"Activar"}</button>
              </div></td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
      {modal&&(<div className="overlay" onClick={()=>setModal(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Nuevo Proveedor</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
        <div className="modal-body">
          <div className="field"><label>Razón Social *</label><input value={form.nombre} onChange={e=>setForm({...form,nombre:e.target.value})} placeholder="Empresa S.A."/></div>
          <div className="form2">
            <div className="field"><label>CUIT</label><input value={form.cuit} onChange={e=>setForm({...form,cuit:e.target.value})} placeholder="30-12345678-0"/></div>
            <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
          </div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
      </div></div>)}
      {editModal&&(<div className="overlay" onClick={()=>setEditModal(null)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Editar Proveedor</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
        <div className="modal-body">
          <div className="field"><label>Razón Social</label><input value={editModal.nombre} onChange={e=>setEditModal({...editModal,nombre:e.target.value})}/></div>
          <div className="form2">
            <div className="field"><label>CUIT</label><input value={editModal.cuit||""} onChange={e=>setEditModal({...editModal,cuit:e.target.value})}/></div>
            <div className="field"><label>Categoría EERR</label><select value={editModal.cat} onChange={e=>setEditModal({...editModal,cat:e.target.value})}>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
          </div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
      </div></div>)}

      {/* Modal Estado de Cuenta */}
      {ctaModal&&(<div className="overlay" onClick={()=>setCtaModal(null)}><div className="modal" style={{width:700}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">{ctaModal.nombre} — Estado de Cuenta</div><button className="close-btn" onClick={()=>setCtaModal(null)}>✕</button></div>
        <div className="modal-body">
          {ctaLoading?<div className="loading">Cargando...</div>:(()=>{
            const pendientes=ctaFacts.filter(f=>f.estado==="pendiente"&&(f.tipo||"factura")==="factura");
            const vencidas=ctaFacts.filter(f=>f.estado==="vencida"&&(f.tipo||"factura")==="factura");
            const ncs=ctaFacts.filter(f=>(f.tipo||"factura")==="nota_credito");
            const aPagar=pendientes.reduce((s,f)=>s+(f.total||0),0)+vencidas.reduce((s,f)=>s+(f.total||0),0);
            const totalVencido=vencidas.reduce((s,f)=>s+(f.total||0),0);
            const totalNC=ncs.reduce((s,f)=>s+Math.abs(f.total||0),0);
            const deudaNeta=aPagar-totalNC;
            const pagos=ctaFacts.flatMap(f=>(f.pagos||[]).map(p=>({...p,nro:f.nro})));

            const [yr,mo]=ctaMes.split("-").map(Number);
            const desde=ctaMes+"-01";
            const hasta=ctaMes+"-"+String(new Date(yr,mo,0).getDate()).padStart(2,"0");
            const facturasDelMes=ctaFacts.filter(f=>(f.tipo||"factura")==="factura"&&f.fecha>=desde&&f.fecha<=hasta);
            const totalFacturadoMes=facturasDelMes.reduce((s,f)=>s+Number(f.total||0),0);
            const totalPagadoMes=ctaFacts.reduce((s,f)=>{
              const pagosDelMes=(f.pagos||[]).filter(p=>p.fecha>=desde&&p.fecha<=hasta);
              return s+pagosDelMes.reduce((sp,p)=>sp+Number(p.monto||0),0);
            },0);
            const pendienteMes=totalFacturadoMes-totalPagadoMes;

            return(<>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
                <span style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1}}>Resumen del mes</span>
                <input type="month" className="search" style={{width:140}} value={ctaMes} onChange={e=>setCtaMes(e.target.value)}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:16}}>
                <div className="kpi"><div className="kpi-label">Facturado en {ctaMes}</div><div className="kpi-value kpi-warn">{fmt_$(totalFacturadoMes)}</div></div>
                <div className="kpi"><div className="kpi-label">Pagado en {ctaMes}</div><div className="kpi-value kpi-success">{fmt_$(totalPagadoMes)}</div></div>
                <div className="kpi"><div className="kpi-label">Pendiente del mes</div><div className={`kpi-value ${pendienteMes>0?"kpi-danger":"kpi-success"}`}>{fmt_$(pendienteMes)}</div></div>
              </div>
              <div className="grid4" style={{marginBottom:16}}>
                <div className="kpi"><div className="kpi-label">A Pagar</div><div className="kpi-value kpi-warn">{fmt_$(aPagar)}</div></div>
                <div className="kpi"><div className="kpi-label">Vencido</div><div className="kpi-value kpi-danger">{fmt_$(totalVencido)}</div></div>
                <div className="kpi"><div className="kpi-label">NC Disponibles</div><div className="kpi-value kpi-info">{fmt_$(totalNC)}</div></div>
                <div className="kpi"><div className="kpi-label">Deuda Neta</div><div className={`kpi-value ${deudaNeta>0?"kpi-danger":"kpi-success"}`}>{fmt_$(deudaNeta)}</div></div>
              </div>
              {(pendientes.length>0||vencidas.length>0)&&(<div className="panel" style={{marginBottom:12}}>
                <div className="panel-hd"><span className="panel-title">Facturas Impagas</span></div>
                <table><thead><tr><th>Nº Factura</th><th>Fecha</th><th>Vencimiento</th><th style={{textAlign:"right"}}>Total</th><th>Estado</th></tr></thead>
                <tbody>{[...vencidas,...pendientes].map(f=>(
                  <tr key={f.id}><td className="mono">{f.nro}</td><td className="mono">{fmt_d(f.fecha)}</td><td className="mono" style={{color:f.estado==="vencida"?"var(--danger)":"var(--muted2)"}}>{fmt_d(f.venc)}</td><td style={{textAlign:"right"}}><span className="num kpi-warn">{fmt_$(f.total)}</span></td><td><span className={`badge ${f.estado==="vencida"?"b-danger":"b-warn"}`}>{f.estado==="vencida"?"Vencida":"Pendiente"}</span></td></tr>
                ))}</tbody></table>
              </div>)}
              {pagos.length>0&&(<div className="panel">
                <div className="panel-hd"><span className="panel-title">Historial de Pagos</span></div>
                <table><thead><tr><th>Fecha</th><th>Factura</th><th>Cuenta</th><th style={{textAlign:"right"}}>Monto</th></tr></thead>
                <tbody>{pagos.sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")).map((p,i)=>(
                  <tr key={i}><td className="mono">{fmt_d(p.fecha)}</td><td className="mono">{p.nro}</td><td style={{fontSize:11,color:"var(--muted2)"}}>{p.cuenta}</td><td style={{textAlign:"right"}}><span className="num kpi-success">{fmt_$(p.monto)}</span></td></tr>
                ))}</tbody></table>
              </div>)}
              {pendientes.length===0&&vencidas.length===0&&pagos.length===0&&<div className="empty">Sin movimientos registrados</div>}
            </>);
          })()}
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setCtaModal(null)}>Cerrar</button></div>
      </div></div>)}
    </div>
  );
}
