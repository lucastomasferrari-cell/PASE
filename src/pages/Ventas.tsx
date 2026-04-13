import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { MEDIOS_COBRO } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

// ─── VENTAS ───────────────────────────────────────────────────────────────────
export default function Ventas({ user, locales, localActivo }) {
  const [ventas,setVentas]=useState([]);
  const [loading,setLoading]=useState(true);
  const [modalNuevo,setModalNuevo]=useState(false);
  const [detalleModal,setDetalleModal]=useState(null);
  const [editModal,setEditModal]=useState(null);
  const [filtFecha,setFiltFecha]=useState("");
  const [filtMes,setFiltMes]=useState(toISO(today).slice(0,7));
  // filtMes is always active unless filtFecha is set
  const [form,setForm]=useState({local_id:"",fecha:toISO(today),turno:"Noche",medio:"EFECTIVO SALON",monto:"",cant:""});
  const localesDisp=user.rol==="dueno"?locales:locales.filter(l=>(user.locales||[]).includes(l.id));

  const load=async()=>{
    setLoading(true);
    let q=db.from("ventas").select("*").order("fecha",{ascending:false});
    if(filtFecha){
      q=q.eq("fecha",filtFecha);
    } else {
      const desde=filtMes+"-01";
      const [fyr,fmo]=filtMes.split("-").map(Number); const hasta=filtMes+"-"+String(new Date(fyr,fmo,0).getDate()).padStart(2,"0");
      q=q.gte("fecha",desde).lte("fecha",hasta);
    }
    if(localActivo) q=q.eq("local_id",localActivo);
    const {data}=await q.limit(500);
    setVentas(data||[]);setLoading(false);
  };
  useEffect(()=>{load();},[filtFecha,filtMes,localActivo]);
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
    if(!form.monto||!form.local_id)return;
    await db.from("ventas").insert([{...form,id:genId("V"),local_id:parseInt(form.local_id),monto:parseFloat(form.monto),cant:parseInt(form.cant)||1}]);
    setModalNuevo(false);load();
  };

  const guardarEdit=async()=>{
    if(!editModal)return;
    await db.from("ventas").update({fecha:editModal.fecha,turno:editModal.turno,medio:editModal.medio,monto:parseFloat(editModal.monto),cant:parseInt(editModal.cant)||1,local_id:parseInt(editModal.local_id)}).eq("id",editModal.id);
    setEditModal(null);
    if(detalleModal){
      // refresh detalle
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
        <div><div className="ph-title">Ventas</div><div className="ph-sub">Total período: {fmt_$(totalPeriodo)}</div></div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <input type="date" className="search" style={{width:155}} value={filtFecha}
            onChange={e=>{setFiltFecha(e.target.value);}}
            placeholder="Día específico"/>
          <input type="month" className="search" style={{width:140}} value={filtMes}
            onChange={e=>{setFiltMes(e.target.value);setFiltFecha("");}}/>
          <button className="btn btn-acc" onClick={()=>setModalNuevo(true)}>+ Cargar</button>
        </div>
      </div>

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
                <div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>{locales.find(l=>l.id===detalleModal.local_id)?.nombre} · Total: <span style={{color:"var(--success)",fontFamily:"'Syne',sans-serif",fontWeight:700}}>{fmt_$(detalleModal.total)}</span></div>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-danger btn-sm" onClick={()=>eliminarBloque(detalleModal)}>Eliminar cierre</button>
                <button className="close-btn" onClick={()=>setDetalleModal(null)}>✕</button>
              </div>
            </div>
            <div className="modal-body" style={{padding:0}}>
              <table>
                <thead><tr><th>Forma de Cobro</th><th>Cubiertos</th><th>Monto</th><th>% del total</th><th></th></tr></thead>
                <tbody>{detalleModal.items.sort((a,b)=>b.monto-a.monto).map(v=>(
                  <tr key={v.id}>
                    <td style={{fontWeight:500}}>{v.medio}</td>
                    <td style={{color:"var(--muted2)"}}>{v.cant||"—"}</td>
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
              <div className="form2">
                <div className="field"><label>Monto $</label><input type="number" value={editModal.monto} onChange={e=>setEditModal({...editModal,monto:e.target.value})}/></div>
                <div className="field"><label>Cubiertos</label><input type="number" value={editModal.cant||""} onChange={e=>setEditModal({...editModal,cant:e.target.value})}/></div>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
          </div>
        </div>
      )}

      {/* NUEVO MODAL */}
      {modalNuevo&&(
        <div className="overlay" onClick={()=>setModalNuevo(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nueva Venta</div><button className="close-btn" onClick={()=>setModalNuevo(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Local</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Seleccioná...</option>{localesDisp.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
              </div>
              <div className="form2">
                <div className="field"><label>Turno</label><select value={form.turno} onChange={e=>setForm({...form,turno:e.target.value})}><option>Mediodía</option><option>Noche</option></select></div>
                <div className="field"><label>Medio de Cobro</label><select value={form.medio} onChange={e=>setForm({...form,medio:e.target.value})}>{MEDIOS_COBRO.map(m=><option key={m}>{m}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Monto $</label><input type="number" value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="0"/></div>
                <div className="field"><label>Cubiertos</label><input type="number" value={form.cant} onChange={e=>setForm({...form,cant:e.target.value})} placeholder="0"/></div>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModalNuevo(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
