import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { CUENTAS, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, COMISIONES_CATS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

export default function Gastos({ user, locales, localActivo }) {
  const [gastos,setGastos]=useState([]);
  const [loading,setLoading]=useState(true);
  const [tab,setTab]=useState("fijos");
  const [modal,setModal]=useState(false);
  const [mes,setMes]=useState(toISO(today).slice(0,7));
  const emptyForm={fecha:toISO(today),local_id:"",categoria:"",monto:"",detalle:"",cuenta:"MercadoPago"};
  const [form,setForm]=useState(emptyForm);
  const load=async()=>{
    setLoading(true);
    const [gyr,gmo]=mes.split("-").map(Number);
    const glast=new Date(gyr,gmo,0).getDate();
    const desde=mes+"-01",hasta=mes+"-"+String(glast).padStart(2,"0");
    let q=db.from("gastos").select("*").gte("fecha",desde).lte("fecha",hasta).order("fecha",{ascending:false});
    if(localActivo)q=q.eq("local_id",localActivo);
    const {data}=await q;setGastos(data||[]);setLoading(false);
  };
  useEffect(()=>{load();},[mes,localActivo]);
  const getCats=()=>tab==="fijos"?GASTOS_FIJOS:tab==="variables"?GASTOS_VARIABLES:tab==="publicidad"?GASTOS_PUBLICIDAD:COMISIONES_CATS;
  const getTipo=()=>tab==="fijos"?"fijo":tab==="variables"?"variable":tab==="publicidad"?"publicidad":"comision";
  const gFilt=gastos.filter(g=>g.tipo===getTipo());
  const totalMes=gastos.reduce((s,g)=>s+(g.monto||0),0);
  const totalTab=gFilt.reduce((s,g)=>s+(g.monto||0),0);
  const guardar=async()=>{
    if(!form.monto||!form.categoria)return;
    const nuevo={...form,id:genId("GASTO"),tipo:getTipo(),local_id:form.local_id?parseInt(form.local_id):null,monto:parseFloat(form.monto)};
    await db.from("gastos").insert([nuevo]);
    const {data:caja}=await db.from("saldos_caja").select("saldo").eq("cuenta",form.cuenta).single();
    if(caja)await db.from("saldos_caja").update({saldo:(caja.saldo||0)-parseFloat(form.monto)}).eq("cuenta",form.cuenta);
    await db.from("movimientos").insert([{id:genId("MOV"),fecha:form.fecha,cuenta:form.cuenta,tipo:"Gasto "+getTipo(),cat:form.categoria,importe:-parseFloat(form.monto),detalle:form.detalle||form.categoria,fact_id:null}]);
    setModal(false);setForm(emptyForm);load();
  };
  const tabLabels=[["fijos","Gastos Fijos"],["variables","Gastos Variables"],["publicidad","Publicidad y MKT"],["comisiones","Comisiones"]];
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
    </div>
  );
}
