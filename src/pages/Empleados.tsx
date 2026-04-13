import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { CUENTAS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

export default function Empleados({ locales }) {
  const [empleados,setEmpleados]=useState([]);
  const [modal,setModal]=useState(false);
  const [editModal,setEditModal]=useState(null);
  const [pagarModal,setPagarModal]=useState(null);
  const [aumentoModal,setAumentoModal]=useState(false);
  const [archivosModal,setArchivosModal]=useState(null);
  const [archivos,setArchivos]=useState([]);
  const [uploading,setUploading]=useState(false);
  const [loading,setLoading]=useState(true);
  const [search,setSearch]=useState("");
  const [pct,setPct]=useState("");
  const [pagandoSue,setPagandoSue]=useState(false);
  const [pagoForm,setPagoForm]=useState({cuenta:"Banco",fecha:toISO(today),monto:""});
  const emptyForm={nombre:"",legajo:"",local_id:"",puesto:"",sueldo:"",fecha_ingreso:toISO(today),fecha_alta_afip:"",estado:"Activo"};
  const [form,setForm]=useState(emptyForm);
  const load=async()=>{setLoading(true);const {data}=await db.from("empleados").select("*").order("nombre");setEmpleados(data||[]);setLoading(false);};
  useEffect(()=>{load();},[]);
  const loadArchivos=async(empId)=>{const {data}=await db.from("empleado_archivos").select("*").eq("empleado_id",empId).order("fecha",{ascending:false});setArchivos(data||[]);};
  const abrirArchivos=async(e)=>{setArchivosModal(e);await loadArchivos(e.id);};
  const subirArchivo=async(file,empId)=>{
    if(!file)return; setUploading(true);
    const ext=file.name.split(".").pop();
    const path=`${empId}/${Date.now()}.${ext}`;
    const {error}=await db.storage.from("empleados").upload(path,file);
    if(!error){const {data:urlData}=db.storage.from("empleados").getPublicUrl(path);await db.from("empleado_archivos").insert([{id:genId("ARG"),empleado_id:empId,nombre:file.name,url:urlData.publicUrl,tipo:ext,fecha:toISO(today),detalle:""}]);await loadArchivos(empId);}
    setUploading(false);
  };
  const eFilt=empleados.filter(e=>!search||e.nombre.toLowerCase().includes(search.toLowerCase()));
  const totalSueldos=empleados.filter(e=>e.estado==="Activo").reduce((s,e)=>s+(e.sueldo||0),0);
  const guardar=async()=>{if(!form.nombre)return;await db.from("empleados").insert([{...form,local_id:form.local_id?parseInt(form.local_id):null,sueldo:parseFloat(form.sueldo)||0}]);setModal(false);setForm(emptyForm);load();};
  const guardarEdit=async()=>{await db.from("empleados").update({nombre:editModal.nombre,legajo:editModal.legajo,puesto:editModal.puesto,sueldo:parseFloat(editModal.sueldo)||0,local_id:editModal.local_id?parseInt(editModal.local_id):null,estado:editModal.estado,fecha_ingreso:editModal.fecha_ingreso,fecha_alta_afip:editModal.fecha_alta_afip,fecha_baja:editModal.fecha_baja,fecha_baja_afip:editModal.fecha_baja_afip}).eq("id",editModal.id);setEditModal(null);load();};
  const pagar=async()=>{
    if(pagandoSue)return; setPagandoSue(true);
    const e=pagarModal;const monto=parseFloat(pagoForm.monto)||e.sueldo;
    const {data:caja}=await db.from("saldos_caja").select("saldo").eq("cuenta",pagoForm.cuenta).single();
    if(caja)await db.from("saldos_caja").update({saldo:(caja.saldo||0)-monto}).eq("cuenta",pagoForm.cuenta);
    await db.from("movimientos").insert([{id:genId("MOV"),fecha:pagoForm.fecha,cuenta:pagoForm.cuenta,tipo:"Pago Sueldo",cat:"SUELDOS",importe:-monto,detalle:`Sueldo ${e.nombre}`,fact_id:null}]);
    setPagandoSue(false);setPagarModal(null);
  };
  const aumentoMasivo=async()=>{
    const p=parseFloat(pct);if(!p||p<=0)return;
    await Promise.all(empleados.filter(e=>e.estado==="Activo").map(e=>db.from("empleados").update({sueldo:Math.round(e.sueldo*(1+p/100))}).eq("id",e.id)));
    setAumentoModal(false);setPct("");load();
  };
  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Empleados</div><div className="ph-sub">{empleados.filter(e=>e.estado==="Activo").length} activos · Masa salarial {fmt_$(totalSueldos)}/mes</div></div>
        <div style={{display:"flex",gap:8}}>
          <input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)}/>
          <button className="btn btn-ghost" onClick={()=>setAumentoModal(true)}>Aumento %</button>
          <button className="btn btn-acc" onClick={()=>{setForm(emptyForm);setModal(true)}}>+ Nuevo</button>
        </div>
      </div>
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:eFilt.length===0?<div className="empty">No hay empleados</div>:(
          <table><thead><tr><th>Nombre</th><th>Legajo</th><th>Puesto</th><th>Local</th><th>Ingreso</th><th>Alta AFIP</th><th>Sueldo</th><th>Estado</th><th></th></tr></thead>
          <tbody>{eFilt.map(e=>(
            <tr key={e.id} style={{opacity:e.estado==="Inactivo"?0.5:1}}>
              <td style={{fontWeight:500}}>{e.nombre}</td>
              <td className="mono" style={{color:"var(--muted2)"}}>{e.legajo||"\u2014"}</td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{e.puesto||"\u2014"}</td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===e.local_id)?.nombre||"\u2014"}</td>
              <td className="mono" style={{fontSize:11}}>{fmt_d(e.fecha_ingreso)}</td>
              <td className="mono" style={{fontSize:11,color:e.fecha_alta_afip?"var(--success)":"var(--warn)"}}>{e.fecha_alta_afip?fmt_d(e.fecha_alta_afip):"Pendiente"}</td>
              <td><span className="num kpi-acc">{fmt_$(e.sueldo)}</span></td>
              <td><span className={`badge ${e.estado==="Activo"?"b-success":"b-muted"}`}>{e.estado}</span></td>
              <td><div style={{display:"flex",gap:4}}>
                <button className="btn btn-ghost btn-sm" onClick={()=>setEditModal({...e})}>Editar</button>
                <button className="btn btn-ghost btn-sm" onClick={()=>abrirArchivos(e)}>{"\uD83D\uDCCE"}</button>
                {e.estado==="Activo"&&<button className="btn btn-success btn-sm" onClick={()=>{setPagarModal(e);setPagoForm({cuenta:"Banco",fecha:toISO(today),monto:e.sueldo})}}>Pagar</button>}
              </div></td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
      {modal&&(<div className="overlay" onClick={()=>setModal(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Nuevo Empleado</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
        <div className="modal-body">
          <div className="form2"><div className="field"><label>Nombre *</label><input value={form.nombre} onChange={e=>setForm({...form,nombre:e.target.value})}/></div><div className="field"><label>Legajo</label><input value={form.legajo} onChange={e=>setForm({...form,legajo:e.target.value})}/></div></div>
          <div className="form2"><div className="field"><label>Puesto</label><input value={form.puesto} onChange={e=>setForm({...form,puesto:e.target.value})}/></div><div className="field"><label>Local</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Sin asignar</option>{locales.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div></div>
          <div className="form2"><div className="field"><label>Fecha Ingreso</label><input type="date" value={form.fecha_ingreso} onChange={e=>setForm({...form,fecha_ingreso:e.target.value})}/></div><div className="field"><label>Alta AFIP</label><input type="date" value={form.fecha_alta_afip} onChange={e=>setForm({...form,fecha_alta_afip:e.target.value})}/></div></div>
          <div className="field"><label>Sueldo $</label><input type="number" value={form.sueldo} onChange={e=>setForm({...form,sueldo:e.target.value})} placeholder="0"/></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
      </div></div>)}
      {editModal&&(<div className="overlay" onClick={()=>setEditModal(null)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Editar Empleado</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
        <div className="modal-body">
          <div className="form2"><div className="field"><label>Nombre</label><input value={editModal.nombre} onChange={e=>setEditModal({...editModal,nombre:e.target.value})}/></div><div className="field"><label>Legajo</label><input value={editModal.legajo||""} onChange={e=>setEditModal({...editModal,legajo:e.target.value})}/></div></div>
          <div className="form2"><div className="field"><label>Puesto</label><input value={editModal.puesto||""} onChange={e=>setEditModal({...editModal,puesto:e.target.value})}/></div><div className="field"><label>Local</label><select value={editModal.local_id||""} onChange={e=>setEditModal({...editModal,local_id:e.target.value})}><option value="">Sin asignar</option>{locales.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div></div>
          <div className="form2"><div className="field"><label>Fecha Ingreso</label><input type="date" value={editModal.fecha_ingreso||""} onChange={e=>setEditModal({...editModal,fecha_ingreso:e.target.value})}/></div><div className="field"><label>Alta AFIP</label><input type="date" value={editModal.fecha_alta_afip||""} onChange={e=>setEditModal({...editModal,fecha_alta_afip:e.target.value})}/></div></div>
          <div className="form2"><div className="field"><label>Fecha Baja</label><input type="date" value={editModal.fecha_baja||""} onChange={e=>setEditModal({...editModal,fecha_baja:e.target.value})}/></div><div className="field"><label>Baja AFIP</label><input type="date" value={editModal.fecha_baja_afip||""} onChange={e=>setEditModal({...editModal,fecha_baja_afip:e.target.value})}/></div></div>
          <div className="form2"><div className="field"><label>Sueldo $</label><input type="number" value={editModal.sueldo} onChange={e=>setEditModal({...editModal,sueldo:e.target.value})}/></div><div className="field"><label>Estado</label><select value={editModal.estado} onChange={e=>setEditModal({...editModal,estado:e.target.value})}><option>Activo</option><option>Inactivo</option></select></div></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
      </div></div>)}
      {pagarModal&&(<div className="overlay" onClick={()=>setPagarModal(null)}><div className="modal" style={{width:420}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Pagar Sueldo</div><button className="close-btn" onClick={()=>setPagarModal(null)}>✕</button></div>
        <div className="modal-body">
          <div className="alert alert-info">{pagarModal.nombre} · {fmt_$(pagarModal.sueldo)}</div>
          <div className="field"><label>Cuenta</label><select value={pagoForm.cuenta} onChange={e=>setPagoForm({...pagoForm,cuenta:e.target.value})}>{CUENTAS.map(c=><option key={c}>{c}</option>)}</select></div>
          <div className="field"><label>Monto</label><input type="number" value={pagoForm.monto} onChange={e=>setPagoForm({...pagoForm,monto:e.target.value})}/></div>
          <div className="field"><label>Fecha</label><input type="date" value={pagoForm.fecha} onChange={e=>setPagoForm({...pagoForm,fecha:e.target.value})}/></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setPagarModal(null)}>Cancelar</button><button className="btn btn-success" onClick={pagar} disabled={pagandoSue}>{pagandoSue?"Procesando...":"Confirmar Pago"}</button></div>
      </div></div>)}
      {aumentoModal&&(<div className="overlay" onClick={()=>setAumentoModal(false)}><div className="modal" style={{width:380}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Aumento Masivo</div><button className="close-btn" onClick={()=>setAumentoModal(false)}>✕</button></div>
        <div className="modal-body">
          <div className="alert alert-warn">Masa actual: {fmt_$(totalSueldos)}</div>
          <div className="field"><label>Porcentaje %</label><input type="number" value={pct} onChange={e=>setPct(e.target.value)} placeholder="15"/></div>
          {pct&&<div style={{padding:10,background:"var(--s2)",borderRadius:"var(--r)",fontSize:12}}>Nueva masa: <strong style={{color:"var(--acc)"}}>{fmt_$(totalSueldos*(1+parseFloat(pct)/100))}</strong></div>}
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setAumentoModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={aumentoMasivo}>Aplicar</button></div>
      </div></div>)}
      {archivosModal&&(<div className="overlay" onClick={()=>setArchivosModal(null)}><div className="modal" style={{width:580}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div><div className="modal-title">{"\uD83D\uDCCE"} Legajo — {archivosModal.nombre}</div><div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>{archivosModal.puesto} · {locales.find(l=>l.id===archivosModal.local_id)?.nombre}</div></div><button className="close-btn" onClick={()=>setArchivosModal(null)}>✕</button></div>
        <div className="modal-body">
          <div style={{marginBottom:16,padding:12,background:"var(--s2)",borderRadius:"var(--r)",border:"2px dashed var(--bd2)"}}>
            <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>Subir documento</div>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx" style={{display:"none"}} id="file-upload" onChange={e=>subirArchivo(e.target.files[0],archivosModal.id)}/>
            <label htmlFor="file-upload" className="btn btn-acc" style={{cursor:"pointer",display:"inline-flex"}}>{uploading?"Subiendo...":"+ Seleccionar archivo"}</label>
            <span style={{fontSize:10,color:"var(--muted)",marginLeft:10}}>PDF, JPG, PNG — Altas, bajas, recibos...</span>
          </div>
          {archivos.length===0?<div className="empty">No hay archivos cargados</div>:(
            <table><thead><tr><th>Nombre</th><th>Tipo</th><th>Fecha</th><th></th></tr></thead>
            <tbody>{archivos.map(a=><tr key={a.id}><td><a href={a.url} target="_blank" rel="noreferrer" style={{color:"var(--acc)",textDecoration:"none"}}>{a.nombre}</a></td><td><span className="badge b-muted">{a.tipo?.toUpperCase()}</span></td><td className="mono" style={{fontSize:11}}>{fmt_d(a.fecha)}</td><td><a href={a.url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">{"\u2B07"} Ver</a></td></tr>)}</tbody>
          </table>)}
        </div>
      </div></div>)}
    </div>
  );
}
