import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { MEDIOS_COBRO, MEDIO_A_CUENTA } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";
import ImportarMaxirest from "./ImportarMaxirest";

// ─── VENTAS ───────────────────────────────────────────────────────────────────
export default function Ventas({ user, locales, localActivo }) {
  const [ventas,setVentas]=useState([]);
  const [loading,setLoading]=useState(true);
  const [modalNuevo,setModalNuevo]=useState(false);
  const [showMaxirest,setShowMaxirest]=useState(false);
  const [detalleModal,setDetalleModal]=useState(null);
  const [editModal,setEditModal]=useState(null);
  const _mesActual=toISO(today).slice(0,7);
  const _ultDia=new Date(today.getFullYear(),today.getMonth()+1,0).getDate();
  const [filtDesde,setFiltDesde]=useState(_mesActual+"-01");
  const [filtHasta,setFiltHasta]=useState(_mesActual+"-"+String(_ultDia).padStart(2,"0"));
  const [form,setForm]=useState({local_id:"",fecha:toISO(today),turno:"Noche"});
  const [lineas,setLineas]=useState<{medio:string,monto:string}[]>([{medio:"EFECTIVO SALON",monto:""}]);
  const localesDisp=user.rol==="dueno"?locales:locales.filter(l=>(user.locales||[]).includes(l.id));
  const updateLinea=(i:number,field:"medio"|"monto",value:string)=>{
    setLineas(prev=>prev.map((l,j)=>j===i?{...l,[field]:value}:l));
  };

  const load=async()=>{
    setLoading(true);
    let q=db.from("ventas").select("*").order("fecha",{ascending:false});
    if(filtDesde) q=q.gte("fecha",filtDesde);
    if(filtHasta) q=q.lte("fecha",filtHasta);
    if(localActivo) q=q.eq("local_id",localActivo);
    const {data}=await q.limit(500);
    setVentas(data||[]);setLoading(false);
  };
  useEffect(()=>{load();},[filtDesde,filtHasta,localActivo]);
  useEffect(()=>{if(localesDisp.length>0&&!form.local_id)setForm(f=>({...f,local_id:localActivo||localesDisp[0]?.id||""}));},[locales,localActivo]);

  // Group ventas by fecha + turno + local
  const grupos=[];
  const seen={};
  for(const v of ventas){
    const key=`${v.fecha}||${v.turno}||${v.local_id}`;
    if(!seen[key]){seen[key]={key,fecha:v.fecha,turno:v.turno,local_id:v.local_id,items:[],total:0};grupos.push(seen[key]);}
    seen[key].items.push(v);
    seen[key].total+=(v.monto||0);
  }
  grupos.sort((a,b)=>a.fecha<b.fecha?1:a.fecha>b.fecha?-1:0);

  const totalPeriodo=ventas.reduce((s,v)=>s+(v.monto||0),0);

  const guardar=async()=>{
    if(!form.local_id)return;
    const lid=parseInt(form.local_id);
    const rows=lineas
      .filter(l=>parseFloat(l.monto)>0)
      .map(l=>({id:genId("V"),local_id:lid,fecha:form.fecha,turno:form.turno,medio:l.medio,monto:parseFloat(l.monto)}));
    if(rows.length===0)return;
    await db.from("ventas").insert(rows);

    const impactoPorCuenta:Record<string,number>={};
    rows.forEach(v=>{
      const cuenta=MEDIO_A_CUENTA[v.medio];
      if(!cuenta) return; // medios no-efectivo no impactan en caja
      impactoPorCuenta[cuenta]=(impactoPorCuenta[cuenta]||0)+v.monto;
    });
    for(const [cuenta,monto] of Object.entries(impactoPorCuenta)){
      if(!cuenta) continue;
      await db.from("movimientos").insert([{
        id:genId("MOV"),fecha:form.fecha,cuenta,
        tipo:"Ingreso Venta",cat:"VENTAS",
        importe:monto,detalle:`Ventas ${form.turno} - ${form.fecha}`,
        local_id:lid,
      }]);
      const {data:caja}=await db.from("saldos_caja").select("saldo")
        .eq("cuenta",cuenta).eq("local_id",lid).maybeSingle();
      if(caja) await db.from("saldos_caja")
        .update({saldo:(caja.saldo||0)+monto})
        .eq("cuenta",cuenta).eq("local_id",lid);
    }

    setLineas([{medio:"EFECTIVO SALON",monto:""}]);
    setModalNuevo(false);load();
  };

  const guardarEdit=async()=>{
    if(!editModal)return;
    await db.from("ventas").update({fecha:editModal.fecha,turno:editModal.turno,medio:editModal.medio,monto:parseFloat(editModal.monto),local_id:parseInt(editModal.local_id)}).eq("id",editModal.id);
    setEditModal(null);
    if(detalleModal){
      const updated=detalleModal.items.map(i=>i.id===editModal.id?{...i,...editModal,monto:parseFloat(editModal.monto)}:i);
      setDetalleModal({...detalleModal,items:updated,total:updated.reduce((s,i)=>s+(i.monto||0),0)});
    }
    load();
  };

  const eliminarLinea=async(id)=>{
    if(!confirm("¿Eliminar este registro?"))return;
    await db.from("ventas").delete().eq("id",id);
    if(detalleModal){
      const updated=detalleModal.items.filter(i=>i.id!==id);
      if(updated.length===0){setDetalleModal(null);}
      else{setDetalleModal({...detalleModal,items:updated,total:updated.reduce((s,i)=>s+(i.monto||0),0)});}
    }
    load();
  };

  const eliminarBloque=async(grupo)=>{
    if(!confirm(`¿Eliminar el cierre completo del ${fmt_d(grupo.fecha)} ${grupo.turno}?`))return;
    await Promise.all(grupo.items.map(v=>db.from("ventas").delete().eq("id",v.id)));
    setDetalleModal(null);load();
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Ventas</div></div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <input type="date" className="search" style={{width:155}} value={filtDesde}
            onChange={e=>setFiltDesde(e.target.value)}/>
          <span style={{color:"var(--muted2)",fontSize:12}}>→</span>
          <input type="date" className="search" style={{width:155}} value={filtHasta}
            onChange={e=>setFiltHasta(e.target.value)}/>
          <button className="btn btn-ghost" onClick={()=>setShowMaxirest(!showMaxirest)}>Importar Maxirest</button>
          <button className="btn btn-acc" onClick={()=>setModalNuevo(true)}>+ Cargar venta</button>
        </div>
      </div>

      {showMaxirest&&<div style={{marginBottom:16}}><ImportarMaxirest locales={locales}/></div>}

      <div className="panel">
        <div className="panel-hd"><span className="panel-title">Cierres de turno — {grupos.length} bloques</span></div>
        {loading?<div className="loading">Cargando...</div>:grupos.length===0?<div className="empty">No hay ventas en este período</div>:(
          <table>
            <thead><tr><th>Fecha</th><th>Turno</th><th>Local</th><th>Registros</th><th>Total</th><th></th></tr></thead>
            <tbody>{grupos.map(g=>(
              <tr key={g.key}>
                <td className="mono">{fmt_d(g.fecha)}</td>
                <td><span className={`badge ${g.turno==="Noche"?"b-info":"b-warn"}`}>{g.turno}</span></td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===g.local_id)?.nombre||"—"}</td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{g.items.length} formas de cobro</td>
                <td><span className="num kpi-success">{fmt_$(g.total)}</span></td>
                <td><button className="btn btn-ghost btn-sm" onClick={()=>setDetalleModal(g)}>Ver detalle →</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {/* DETALLE MODAL */}
      {detalleModal&&(
        <div className="overlay" onClick={()=>setDetalleModal(null)}>
          <div className="modal" style={{width:640}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd">
              <div>
                <div className="modal-title">{fmt_d(detalleModal.fecha)} · {detalleModal.turno}</div>
                <div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>{locales.find(l=>l.id===detalleModal.local_id)?.nombre} · Total: <span style={{color:"var(--success)",fontFamily:"'Inter',sans-serif",fontWeight:500}}>{fmt_$(detalleModal.total)}</span></div>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-danger btn-sm" onClick={()=>eliminarBloque(detalleModal)}>Eliminar cierre</button>
                <button className="close-btn" onClick={()=>setDetalleModal(null)}>✕</button>
              </div>
            </div>
            <div className="modal-body" style={{padding:0}}>
              <table>
                <thead><tr><th>Forma de Cobro</th><th>Monto</th><th>% del total</th><th></th></tr></thead>
                <tbody>{detalleModal.items.sort((a,b)=>b.monto-a.monto).map(v=>(
                  <tr key={v.id}>
                    <td style={{fontWeight:500}}>{v.medio}</td>
                    <td><span className="num kpi-success">{fmt_$(v.monto)}</span></td>
                    <td style={{fontSize:11,color:"var(--muted2)"}}>{detalleModal.total>0?((v.monto/detalleModal.total)*100).toFixed(1):0}%</td>
                    <td><div style={{display:"flex",gap:4}}>
                      <button className="btn btn-ghost btn-sm" onClick={()=>setEditModal({...v})}>Editar</button>
                      <button className="btn btn-danger btn-sm" onClick={()=>eliminarLinea(v.id)}>✕</button>
                    </div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* EDIT MODAL */}
      {editModal&&(
        <div className="overlay" onClick={()=>setEditModal(null)}>
          <div className="modal" style={{width:440}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Editar Venta</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Fecha</label><input type="date" value={editModal.fecha} onChange={e=>setEditModal({...editModal,fecha:e.target.value})}/></div>
                <div className="field"><label>Turno</label><select value={editModal.turno} onChange={e=>setEditModal({...editModal,turno:e.target.value})}><option>Mediodía</option><option>Noche</option></select></div>
              </div>
              <div className="field"><label>Forma de Cobro</label><select value={editModal.medio} onChange={e=>setEditModal({...editModal,medio:e.target.value})}>{MEDIOS_COBRO.map(m=><option key={m}>{m}</option>)}</select></div>
              <div className="field"><label>Monto $</label><input type="number" value={editModal.monto} onChange={e=>setEditModal({...editModal,monto:e.target.value})}/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
          </div>
        </div>
      )}

      {/* NUEVO MODAL */}
      {modalNuevo&&(
        <div className="overlay" onClick={()=>setModalNuevo(false)}>
          <div className="modal" style={{width:520}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nueva Venta</div><button className="close-btn" onClick={()=>setModalNuevo(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Local</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Seleccioná...</option>{localesDisp.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
              </div>
              <div className="field"><label>Turno</label><select value={form.turno} onChange={e=>setForm({...form,turno:e.target.value})}><option>Mediodía</option><option>Noche</option></select></div>

              <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginTop:16,marginBottom:8}}>Formas de cobro</div>
              {lineas.map((l,i)=>(
                <div key={i} style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
                  <select className="search" style={{flex:1}} value={l.medio} onChange={e=>updateLinea(i,"medio",e.target.value)}>
                    {MEDIOS_COBRO.map(m=><option key={m}>{m}</option>)}
                  </select>
                  <input type="number" className="search" style={{width:120}} placeholder="Monto" value={l.monto} onChange={e=>updateLinea(i,"monto",e.target.value)}/>
                  {lineas.length>1 && <button className="btn btn-danger btn-sm" onClick={()=>setLineas(prev=>prev.filter((_,j)=>j!==i))}>✕</button>}
                </div>
              ))}
              <button className="btn btn-ghost btn-sm" style={{marginBottom:12}} onClick={()=>setLineas(prev=>[...prev,{medio:"EFECTIVO SALON",monto:""}])}>+ Agregar forma de cobro</button>

              <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:"1px solid var(--bd)",fontSize:12}}>
                <span style={{color:"var(--muted2)"}}>Total</span>
                <span style={{fontWeight:500,color:"var(--success)"}}>{fmt_$(lineas.reduce((s,l)=>s+(parseFloat(l.monto)||0),0))}</span>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModalNuevo(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
