import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { fmt_$ } from "../lib/utils";

// ─── INSUMOS ──────────────────────────────────────────────────────────────────
export default function Insumos() {
  const [insumos,setInsumos]=useState([]);
  const [loading,setLoading]=useState(true);
  const [modal,setModal]=useState(false);
  const [editModal,setEditModal]=useState(null);
  const [search,setSearch]=useState("");
  const [mermaCal,setMermaCal]=useState({sucio:"",limpio:""});
  const [showMermaCal,setShowMermaCal]=useState(false);

  const emptyForm={nombre:"",unidad:"peso",merma:0,categoria:"",stock_actual:0,costo_promedio:0};
  const [form,setForm]=useState(emptyForm);

  const UNIDAD_INFO={
    peso:{label:"PESO",unit:"g",icon:"⚖️",tip:"Elegí esto para todo lo que puedas pesar (carnes, harinas, verduras). El sistema usará gramos. No importa si comprás por bolsa, cajón o bulto."},
    volumen:{label:"VOLUMEN",unit:"ml",icon:"💧",tip:"Ideal para líquidos (aceites, bebidas, limpieza). El sistema usará mililitros."},
    unidad:{label:"UNIDAD",unit:"u",icon:"📦",tip:"Solo para cosas que nunca se fraccionan (huevos, latas enteras). Si vas a usar 'media lata', mejor usá volumen o peso."},
  };
  const CATEGORIAS_INS=["PROTEINAS","VERDURAS Y FRUTAS","LACTEOS","SECOS Y ALMACEN","BEBIDAS","LIMPIEZA","PACKAGING","OTROS"];

  const load=async()=>{setLoading(true);const {data}=await db.from("insumos").select("*").order("nombre");setInsumos(data||[]);setLoading(false);};
  useEffect(()=>{load();},[]);

  const calcMerma=()=>{
    const s=parseFloat(mermaCal.sucio),l=parseFloat(mermaCal.limpio);
    if(!s||!l||s<=0)return null;
    return Math.round((l/s)*100);
  };

  const guardar=async()=>{
    if(!form.nombre)return;
    await db.from("insumos").insert([{...form,unidad_label:UNIDAD_INFO[form.unidad].unit,merma:parseFloat(form.merma)||0}]);
    setModal(false);setForm(emptyForm);setShowMermaCal(false);setMermaCal({sucio:"",limpio:""});load();
  };

  const guardarEdit=async()=>{
    await db.from("insumos").update({nombre:editModal.nombre,categoria:editModal.categoria,merma:parseFloat(editModal.merma)||0,activo:editModal.activo}).eq("id",editModal.id);
    setEditModal(null);load();
  };

  const iFilt=insumos.filter(i=>!search||i.nombre.toLowerCase().includes(search.toLowerCase()));
  const mermaRes=calcMerma();

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Insumos</div><div className="ph-sub">{insumos.filter(i=>i.activo).length} activos</div></div>
        <div style={{display:"flex",gap:8}}>
          <input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)}/>
          <button className="btn btn-acc" onClick={()=>{setForm(emptyForm);setShowMermaCal(false);setMermaCal({sucio:"",limpio:""});setModal(true)}}>+ Nuevo Insumo</button>
        </div>
      </div>

      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:iFilt.length===0?<div className="empty">No hay insumos cargados</div>:(
          <table>
            <thead><tr><th>Nombre</th><th>Unidad</th><th>Categoría</th><th>Merma</th><th>Stock Actual</th><th>Costo Prom.</th><th>Estado</th><th></th></tr></thead>
            <tbody>{iFilt.map(i=>(
              <tr key={i.id} style={{opacity:i.activo?1:0.4}}>
                <td style={{fontWeight:500}}>{i.nombre}</td>
                <td><span className="badge b-muted">{UNIDAD_INFO[i.unidad]?.label||i.unidad}</span></td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{i.categoria||"—"}</td>
                <td style={{color:i.merma>0?"var(--warn)":"var(--muted2)"}}>{i.merma>0?`${i.merma}% merma`:"Sin merma"}</td>
                <td><span className="num">{i.stock_actual} {i.unidad_label}</span></td>
                <td><span className="num kpi-acc">{fmt_$(i.costo_promedio)}</span></td>
                <td><span className={`badge ${i.activo?"b-success":"b-muted"}`}>{i.activo?"Activo":"Inactivo"}</span></td>
                <td><button className="btn btn-ghost btn-sm" onClick={()=>setEditModal({...i})}>Editar</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {modal&&(<div className="overlay" onClick={()=>setModal(false)}><div className="modal" style={{width:620}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Nuevo Insumo</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
        <div className="modal-body">
          <div className="field">
            <label>Nombre del insumo</label>
            <input value={form.nombre} onChange={e=>setForm({...form,nombre:e.target.value})} placeholder="Ej: Trucha, Tomate, Aceite de girasol"/>
            <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>💡 Usá un nombre genérico. Poné "Trucha" en vez de "Trucha Patagónica". Así te sirve para cualquier marca.</div>
          </div>

          <div className="field">
            <label>¿Cómo vas a contar esto en tus recetas?</label>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:6}}>
              {Object.entries(UNIDAD_INFO).map(([key,info])=>(
                <div key={key} onClick={()=>setForm({...form,unidad:key})}
                  style={{padding:"12px",border:`2px solid ${form.unidad===key?"var(--acc)":"var(--bd)"}`,borderRadius:"var(--r)",cursor:"pointer",background:form.unidad===key?"rgba(232,197,71,.08)":"var(--s2)",transition:"all 0.15s"}}>
                  <div style={{fontSize:20,marginBottom:4}}>{info.icon}</div>
                  <div style={{fontFamily:"'Inter',sans-serif",fontWeight:500,fontSize:13,color:form.unidad===key?"var(--acc)":"var(--txt)"}}>{info.label}</div>
                  <div style={{fontSize:9,color:"var(--muted)",marginTop:4,lineHeight:1.4}}>{info.tip}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Categoría</label>
            <select value={form.categoria} onChange={e=>setForm({...form,categoria:e.target.value})}>
              <option value="">Sin categoría</option>
              {CATEGORIAS_INS.map(c=><option key={c}>{c}</option>)}
            </select>
          </div>

          <div className="field">
            <label>¿Este insumo tiene merma o desperdicio al limpiarlo?</label>
            <div style={{display:"flex",gap:8,marginTop:6}}>
              <button className={`btn ${!showMermaCal&&form.merma===0?"btn-acc":"btn-sec"}`} onClick={()=>{setShowMermaCal(false);setForm({...form,merma:0});}}>No tiene merma</button>
              <button className={`btn ${form.merma>0&&!showMermaCal?"btn-acc":"btn-sec"}`} onClick={()=>setShowMermaCal(false)}>Ya sé el porcentaje</button>
              <button className={`btn ${showMermaCal?"btn-acc":"btn-sec"}`} onClick={()=>setShowMermaCal(true)}>Ayudame a calcular</button>
            </div>

            {!showMermaCal&&form.merma===0&&<div style={{marginTop:8,fontSize:11,color:"var(--muted2)"}}>El insumo se usa completo, sin desperdicio.</div>}

            {!showMermaCal&&form.merma>=0&&<div style={{marginTop:8}}>
              <input type="number" value={form.merma} onChange={e=>setForm({...form,merma:e.target.value})} placeholder="Ej: 30" style={{width:120,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"6px 10px",fontFamily:"'DM Mono',monospace",fontSize:12,borderRadius:"var(--r)"}}/>
              <span style={{fontSize:11,color:"var(--muted)",marginLeft:8}}>% de merma</span>
            </div>}

            {showMermaCal&&(
              <div style={{marginTop:12,padding:16,background:"var(--s2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)"}}>
                <div style={{fontSize:12,fontWeight:600,marginBottom:12}}>🧪 Calculadora de rendimiento</div>
                <div style={{fontSize:11,color:"var(--muted2)",marginBottom:12,lineHeight:1.6}}>
                  Agarrá el bulto tal cual llegó y pesalo. Limpialo como hacés siempre. Pesá lo que te quedó limpio.
                </div>
                <div className="form2">
                  <div className="field">
                    <label>¿Cuánto pesaba SUCIO/CERRADO? ({UNIDAD_INFO[form.unidad]?.unit})</label>
                    <input type="number" value={mermaCal.sucio} onChange={e=>setMermaCal({...mermaCal,sucio:e.target.value})} placeholder="Ej: 1000"/>
                  </div>
                  <div className="field">
                    <label>¿Cuánto pesa LIMPIO/LISTO? ({UNIDAD_INFO[form.unidad]?.unit})</label>
                    <input type="number" value={mermaCal.limpio} onChange={e=>setMermaCal({...mermaCal,limpio:e.target.value})} placeholder="Ej: 700"/>
                  </div>
                </div>
                {mermaRes!==null&&(
                  <div style={{padding:"12px",background:"rgba(232,197,71,.1)",border:"1px solid var(--acc)",borderRadius:"var(--r)",marginTop:8}}>
                    <div style={{fontFamily:"'Inter',sans-serif",fontSize:15,fontWeight:500,color:"var(--acc)"}}>Rendimiento: {mermaRes}%</div>
                    <div style={{fontSize:11,color:"var(--muted2)",marginTop:4}}>Por cada 1000{UNIDAD_INFO[form.unidad]?.unit} que comprás, a la cocina entran {Math.round(mermaRes*10)}{UNIDAD_INFO[form.unidad]?.unit}.</div>
                    <button className="btn btn-acc" style={{marginTop:8}} onClick={()=>{setForm({...form,merma:100-mermaRes});setShowMermaCal(false);}}>Aplicar este rendimiento</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar Insumo</button></div>
      </div></div>)}

      {editModal&&(<div className="overlay" onClick={()=>setEditModal(null)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Editar — {editModal.nombre}</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
        <div className="modal-body">
          <div className="field"><label>Nombre</label><input value={editModal.nombre} onChange={e=>setEditModal({...editModal,nombre:e.target.value})}/></div>
          <div className="form2">
            <div className="field"><label>Categoría</label><select value={editModal.categoria||""} onChange={e=>setEditModal({...editModal,categoria:e.target.value})}><option value="">Sin categoría</option>{CATEGORIAS_INS.map(c=><option key={c}>{c}</option>)}</select></div>
            <div className="field"><label>Merma %</label><input type="number" value={editModal.merma||0} onChange={e=>setEditModal({...editModal,merma:e.target.value})}/></div>
          </div>
          <div className="field"><label>Estado</label><select value={editModal.activo?"true":"false"} onChange={e=>setEditModal({...editModal,activo:e.target.value==="true"})}><option value="true">Activo</option><option value="false">Inactivo</option></select></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
      </div></div>)}
    </div>
  );
}
