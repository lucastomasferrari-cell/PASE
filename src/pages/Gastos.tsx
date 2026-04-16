import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { CUENTAS, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, COMISIONES_CATS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

export default function Gastos({ user, locales, localActivo }) {
  const [gastos,setGastos]=useState<any[]>([]);
  const [plantillas,setPlantillas]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);
  const [tab,setTab]=useState("fijos");
  const [subTab,setSubTab]=useState("recurrentes");
  const [modal,setModal]=useState(false);
  const [plantModal,setPlantModal]=useState(false);
  const [plantForm,setPlantForm]=useState({nombre:"",categoria:"",detalle:"",monto_estimado:""});
  const [plantEdit,setPlantEdit]=useState<any>(null);
  const [mes,setMes]=useState(toISO(today).slice(0,7));
  const emptyForm={fecha:toISO(today),local_id:"",categoria:"",monto:"",detalle:"",cuenta:"MercadoPago",plantilla_id:null as number|null};
  const [form,setForm]=useState(emptyForm);

  const load=async()=>{
    setLoading(true);
    const [gyr,gmo]=mes.split("-").map(Number);
    const glast=new Date(gyr,gmo,0).getDate();
    const desde=mes+"-01",hasta=mes+"-"+String(glast).padStart(2,"0");
    let q=db.from("gastos").select("*").gte("fecha",desde).lte("fecha",hasta).order("fecha",{ascending:false});
    if(localActivo)q=q.eq("local_id",localActivo);
    const [{data:g},{data:p}]=await Promise.all([q,db.from("gastos_plantillas").select("*").eq("activo",true).order("nombre")]);
    setGastos(g||[]);setPlantillas(p||[]);setLoading(false);
  };
  useEffect(()=>{load();},[mes,localActivo]);

  const getCats=()=>tab==="fijos"?GASTOS_FIJOS:tab==="variables"?GASTOS_VARIABLES:tab==="publicidad"?GASTOS_PUBLICIDAD:COMISIONES_CATS;
  const getTipo=()=>tab==="fijos"?"fijo":tab==="variables"?"variable":tab==="publicidad"?"publicidad":"comision";
  const gFilt=gastos.filter(g=>g.tipo===getTipo());
  const totalMes=gastos.reduce((s,g)=>s+(g.monto||0),0);
  const totalTab=gFilt.reduce((s,g)=>s+(g.monto||0),0);
  const plantFilt=plantillas.filter(p=>p.tipo===getTipo());

  const guardar=async()=>{
    if(!form.monto||!form.categoria)return;
    try {
      const nuevo={...form,id:genId("GASTO"),tipo:getTipo(),local_id:form.local_id?parseInt(form.local_id):null,monto:parseFloat(form.monto),plantilla_id:form.plantilla_id||null};
      const {error:gastoErr}=await db.from("gastos").insert([nuevo]);
      if(gastoErr)throw new Error("Error guardando gasto: "+gastoErr.message);

      const {data:caja}=await db.from("saldos_caja").select("saldo").eq("cuenta",form.cuenta).maybeSingle();
      if(caja)await db.from("saldos_caja").update({saldo:(caja.saldo||0)-parseFloat(form.monto)}).eq("cuenta",form.cuenta);

      const {error:movErr}=await db.from("movimientos").insert([{id:genId("MOV"),fecha:form.fecha,cuenta:form.cuenta,tipo:"Gasto "+getTipo(),cat:form.categoria,importe:-parseFloat(form.monto),detalle:form.detalle||form.categoria,fact_id:null}]);
      if(movErr)console.error("movimientos error (no crítico):",movErr);

      setModal(false);setForm(emptyForm);load();
    } catch (err: any) {
      console.error("Error guardando gasto:",err);
      alert("Error al guardar: "+err.message);
    }
  };

  const guardarPlantilla=async()=>{
    if(!plantForm.nombre||!plantForm.categoria)return;
    const payload={nombre:plantForm.nombre,tipo:getTipo(),categoria:plantForm.categoria,detalle:plantForm.detalle||null,monto_estimado:parseFloat(plantForm.monto_estimado)||0,activo:true};
    if(plantEdit){
      await db.from("gastos_plantillas").update(payload).eq("id",plantEdit.id);
    }else{
      await db.from("gastos_plantillas").insert([payload]);
    }
    setPlantEdit(null);setPlantForm({nombre:"",categoria:"",detalle:"",monto_estimado:""});load();
  };

  const eliminarPlantilla=async(id:number)=>{
    await db.from("gastos_plantillas").update({activo:false}).eq("id",id);
    load();
  };

  const pagarPlantilla=(p:any)=>{
    setForm({...emptyForm,categoria:p.categoria,detalle:p.detalle||p.nombre,monto:String(p.monto_estimado||""),plantilla_id:p.id});
    setModal(true);
  };

  const tabLabels:[string,string][]=[ ["fijos","Gastos Fijos"],["variables","Gastos Variables"],["publicidad","Publicidad y MKT"],["comisiones","Comisiones"] ];

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Gastos</div><div className="ph-sub">Total mes: {fmt_$(totalMes)}</div></div>
        <div style={{display:"flex",gap:8}}>
          <input type="month" className="search" style={{width:160}} value={mes} onChange={e=>setMes(e.target.value)}/>
          <button className="btn btn-acc" onClick={()=>{setForm(emptyForm);setModal(true)}}>+ Cargar Gasto</button>
        </div>
      </div>
      <div className="tabs">{tabLabels.map(([id,l])=><div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}</div>)}</div>

      {/* Sub-tabs */}
      <div style={{display:"flex",gap:16,marginBottom:12,borderBottom:"1px solid var(--bd)",paddingBottom:8}}>
        <span style={{fontSize:10,letterSpacing:1,cursor:"pointer",color:subTab==="recurrentes"?"var(--acc)":"var(--muted2)",borderBottom:subTab==="recurrentes"?"2px solid var(--acc)":"none",paddingBottom:4}} onClick={()=>setSubTab("recurrentes")}>RECURRENTES</span>
        <span style={{fontSize:10,letterSpacing:1,cursor:"pointer",color:subTab==="historial"?"var(--acc)":"var(--muted2)",borderBottom:subTab==="historial"?"2px solid var(--acc)":"none",paddingBottom:4}} onClick={()=>setSubTab("historial")}>HISTORIAL</span>
      </div>

      {subTab==="recurrentes"?(
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Gastos recurrentes — {tabLabels.find(t=>t[0]===tab)?.[1]}</span>
            <button className="btn btn-ghost btn-sm" onClick={()=>{setPlantForm({nombre:"",categoria:"",detalle:"",monto_estimado:""});setPlantEdit(null);setPlantModal(true)}}>Gestionar</button>
          </div>
          {plantFilt.length===0?<div className="empty">No hay gastos recurrentes configurados. Usá "Gestionar" para agregar.</div>:(
            <table><thead><tr><th>Nombre</th><th>Categoría</th><th>Estimado</th><th>Estado mes</th><th></th></tr></thead>
            <tbody>{plantFilt.map(p=>{
              const pagado=gFilt.find(g=>g.plantilla_id===p.id);
              return(
                <tr key={p.id} style={pagado?{opacity:0.6}:{}}>
                  <td style={{fontWeight:500,fontSize:12}}>{p.nombre}</td>
                  <td><span className="badge b-muted">{p.categoria}</span></td>
                  <td><span className="num">{fmt_$(p.monto_estimado)}</span></td>
                  <td>{pagado
                    ?<span className="badge b-success">Pagado {fmt_$(pagado.monto)}</span>
                    :<span className="badge b-warn">Pendiente</span>}
                  </td>
                  <td>{!pagado&&<button className="btn btn-acc btn-sm" onClick={()=>pagarPlantilla(p)}>Pagar</button>}</td>
                </tr>
              );
            })}</tbody></table>
          )}
        </div>
      ):(
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">{tabLabels.find(t=>t[0]===tab)?.[1]}</span><span className="num kpi-warn">{fmt_$(totalTab)}</span></div>
          {loading?<div className="loading">Cargando...</div>:gFilt.length===0?<div className="empty">No hay gastos este mes</div>:(
            <table><thead><tr><th>Fecha</th><th>Categoría</th><th>Detalle</th><th>Local</th><th>Cuenta</th><th>Monto</th></tr></thead>
            <tbody>{gFilt.map(g=>(
              <tr key={g.id}>
                <td className="mono">{fmt_d(g.fecha)}</td>
                <td><span className="badge b-muted">{g.categoria}</span></td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{g.detalle||"—"}</td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===g.local_id)?.nombre||"Todos"}</td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{g.cuenta||"—"}</td>
                <td><span className="num kpi-danger">{fmt_$(g.monto)}</span></td>
              </tr>
            ))}</tbody></table>
          )}
        </div>
      )}

      {/* Modal cargar gasto */}
      {modal&&(<div className="overlay" onClick={()=>setModal(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Cargar — {tabLabels.find(t=>t[0]===tab)?.[1]}</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
        <div className="modal-body">
          <div className="form2">
            <div className="field"><label>Categoría *</label><select value={form.categoria} onChange={e=>setForm({...form,categoria:e.target.value})}><option value="">Seleccioná...</option>{getCats().map(c=><option key={c}>{c}</option>)}</select></div>
            <div className="field"><label>Local</label><select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}><option value="">Todos</option>{locales.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}</select></div>
          </div>
          <div className="form2">
            <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
            <div className="field"><label>Cuenta de egreso</label><select value={form.cuenta} onChange={e=>setForm({...form,cuenta:e.target.value})}>{CUENTAS.map(c=><option key={c}>{c}</option>)}</select></div>
          </div>
          <div className="field"><label>Monto $</label><input type="number" value={form.monto} onChange={e=>setForm({...form,monto:e.target.value})} placeholder="0"/></div>
          <div className="field"><label>Detalle</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Descripción..."/></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
      </div></div>)}

      {/* Modal gestionar plantillas */}
      {plantModal&&(<div className="overlay" onClick={()=>setPlantModal(false)}><div className="modal" style={{width:580}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Gestionar Recurrentes — {tabLabels.find(t=>t[0]===tab)?.[1]}</div><button className="close-btn" onClick={()=>setPlantModal(false)}>✕</button></div>
        <div className="modal-body">
          {plantFilt.length>0&&(
            <table style={{marginBottom:16}}><thead><tr><th>Nombre</th><th>Categoría</th><th>Estimado</th><th></th></tr></thead>
            <tbody>{plantFilt.map(p=>(
              <tr key={p.id}>
                <td style={{fontSize:12}}>{p.nombre}</td>
                <td><span className="badge b-muted">{p.categoria}</span></td>
                <td className="num">{fmt_$(p.monto_estimado)}</td>
                <td><div style={{display:"flex",gap:4}}>
                  <button className="btn btn-ghost btn-sm" onClick={()=>{setPlantEdit(p);setPlantForm({nombre:p.nombre,categoria:p.categoria,detalle:p.detalle||"",monto_estimado:String(p.monto_estimado||"")});}}>Editar</button>
                  <button className="btn btn-danger btn-sm" onClick={()=>eliminarPlantilla(p.id)}>X</button>
                </div></td>
              </tr>
            ))}</tbody></table>
          )}
          <div style={{borderTop:"1px solid var(--bd)",paddingTop:12}}>
            <div style={{fontSize:10,letterSpacing:1,textTransform:"uppercase",color:"var(--muted)",marginBottom:8}}>{plantEdit?"Editar":"Nueva"} plantilla</div>
            <div className="form2">
              <div className="field"><label>Nombre *</label><input value={plantForm.nombre} onChange={e=>setPlantForm({...plantForm,nombre:e.target.value})} placeholder="Ej: Alquiler local"/></div>
              <div className="field"><label>Categoría *</label><select value={plantForm.categoria} onChange={e=>setPlantForm({...plantForm,categoria:e.target.value})}><option value="">Seleccioná...</option>{getCats().map(c=><option key={c}>{c}</option>)}</select></div>
            </div>
            <div className="form2">
              <div className="field"><label>Monto estimado</label><input type="number" value={plantForm.monto_estimado} onChange={e=>setPlantForm({...plantForm,monto_estimado:e.target.value})} placeholder="0"/></div>
              <div className="field"><label>Detalle</label><input value={plantForm.detalle} onChange={e=>setPlantForm({...plantForm,detalle:e.target.value})} placeholder="Descripción..."/></div>
            </div>
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              {plantEdit&&<button className="btn btn-ghost btn-sm" onClick={()=>{setPlantEdit(null);setPlantForm({nombre:"",categoria:"",detalle:"",monto_estimado:""});}}>Cancelar edición</button>}
              <button className="btn btn-acc btn-sm" onClick={guardarPlantilla}>{plantEdit?"Guardar":"Agregar"}</button>
            </div>
          </div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setPlantModal(false)}>Cerrar</button></div>
      </div></div>)}
    </div>
  );
}
