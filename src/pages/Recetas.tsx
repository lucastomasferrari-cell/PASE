import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { fmt_d, fmt_$ } from "../lib/utils";

export default function Recetas({ locales, localActivo }) {
  const [recetas,setRecetas]=useState([]);
  const [insumos,setInsumos]=useState([]);
  const [loading,setLoading]=useState(true);
  const [modal,setModal]=useState(false);
  const [verModal,setVerModal]=useState(null);
  const [search,setSearch]=useState("");

  const CATEGORIAS_RECETA=["SUSHI","COCINA CALIENTE","ENTRADAS","POSTRES","BEBIDAS","DELIVERY","MENU DEL DIA","OTROS"];
  const emptyForm={nombre:"",categoria:"",precio_venta:"",local_id:localActivo||"",activo:true};
  const [form,setForm]=useState(emptyForm);
  const [items,setItems]=useState([]);
  const [editando,setEditando]=useState(null);

  const load=async()=>{
    setLoading(true);
    const [{data:r},{data:i}]=await Promise.all([
      db.from("recetas").select("*").order("nombre"),
      db.from("insumos").select("*").eq("activo",true).order("nombre"),
    ]);
    setRecetas(r||[]);setInsumos(i||[]);setLoading(false);
  };
  useEffect(()=>{load();},[]);

  const rFilt=recetas.filter(r=>{
    if(localActivo&&r.local_id&&r.local_id!==localActivo)return false;
    return !search||r.nombre.toLowerCase().includes(search.toLowerCase());
  });

  const calcCosto=(its)=>{
    return its.reduce((s,it)=>{
      const ins=insumos.find(i=>i.id===parseInt(it.insumo_id));
      if(!ins||!it.cantidad)return s;
      const cantReal=parseFloat(it.cantidad)*(1+(ins.merma||0)/100);
      return s+(cantReal*(ins.costo_promedio||0));
    },0);
  };

  const addItem=()=>setItems([...items,{insumo_id:"",cantidad:"",unidad:"g"}]);
  const updateItem=(i,field,val)=>{
    const ni=[...items];ni[i]={...ni[i],[field]:val};
    if(field==="insumo_id"){const ins=insumos.find(x=>x.id===parseInt(val));if(ins)ni[i].unidad=ins.unidad_label||"g";}
    setItems(ni);
  };

  const guardar=async()=>{
    if(!form.nombre)return;
    const id=editando||null;
    if(id){
      await db.from("recetas").update({nombre:form.nombre,categoria:form.categoria,precio_venta:parseFloat(form.precio_venta)||0,local_id:form.local_id?parseInt(form.local_id):null,activo:form.activo}).eq("id",id);
      await db.from("receta_items").delete().eq("receta_id",id);
      const its=items.filter(it=>it.insumo_id&&it.cantidad).map(it=>({receta_id:id,insumo_id:parseInt(it.insumo_id),cantidad:parseFloat(it.cantidad),unidad:it.unidad}));
      if(its.length>0)await db.from("receta_items").insert(its);
    } else {
      const {data:nueva}=await db.from("recetas").insert([{...form,local_id:form.local_id?parseInt(form.local_id):null,precio_venta:parseFloat(form.precio_venta)||0}]).select().single();
      if(nueva){
        const its=items.filter(it=>it.insumo_id&&it.cantidad).map(it=>({receta_id:nueva.id,insumo_id:parseInt(it.insumo_id),cantidad:parseFloat(it.cantidad),unidad:it.unidad}));
        if(its.length>0)await db.from("receta_items").insert(its);
      }
    }
    setModal(false);setForm(emptyForm);setItems([]);setEditando(null);load();
  };

  const abrir=async(r)=>{
    const {data:its}=await db.from("receta_items").select("*").eq("receta_id",r.id);
    setVerModal({...r,items:its||[]});
  };

  const editar=async(r)=>{
    const {data:its}=await db.from("receta_items").select("*").eq("receta_id",r.id);
    setForm({nombre:r.nombre,categoria:r.categoria||"",precio_venta:r.precio_venta||"",local_id:r.local_id||"",activo:r.activo});
    setItems((its||[]).map(it=>({insumo_id:it.insumo_id,cantidad:it.cantidad,unidad:it.unidad})));
    setEditando(r.id);setModal(true);
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Recetas</div></div>
        <div style={{display:"flex",gap:8}}>
          <input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)}/>
          <button className="btn btn-acc" onClick={()=>{setForm(emptyForm);setItems([]);setEditando(null);setModal(true)}}>+ Nueva Receta</button>
        </div>
      </div>

      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:rFilt.length===0?<div className="empty">No hay recetas cargadas</div>:(
          <table>
            <thead><tr><th>Nombre</th><th>Categoría</th><th>Local</th><th>Costo Teórico</th><th>Precio Venta</th><th>Margen</th><th>Estado</th><th></th></tr></thead>
            <tbody>{rFilt.map(r=>{
              const costo=r._costo||0;
              const margen=r.precio_venta>0?((r.precio_venta-costo)/r.precio_venta*100):0;
              return(
                <tr key={r.id} style={{opacity:r.activo?1:0.4}}>
                  <td style={{fontWeight:500}}>{r.nombre}</td>
                  <td><span className="badge b-muted">{r.categoria||"—"}</span></td>
                  <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===r.local_id)?.nombre||"Todos"}</td>
                  <td><span className="num kpi-warn">—</span></td>
                  <td><span className="num kpi-success">{fmt_$(r.precio_venta)}</span></td>
                  <td style={{color:"var(--muted2)"}}>—</td>
                  <td><span className={`badge ${r.activo?"b-success":"b-muted"}`}>{r.activo?"Activa":"Inactiva"}</span></td>
                  <td><div style={{display:"flex",gap:4}}>
                    <button className="btn btn-ghost btn-sm" onClick={()=>abrir(r)}>Ver</button>
                    <button className="btn btn-ghost btn-sm" onClick={()=>editar(r)}>Editar</button>
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>

      {modal&&(<div className="overlay" onClick={()=>setModal(false)}><div className="modal" style={{width:700}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd">
          <div className="modal-title">{editando?"Editar Receta":"Nueva Receta"}</div>
          <button className="close-btn" onClick={()=>setModal(false)}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form2">
            <div className="field"><label>Nombre del plato *</label><input value={form.nombre} onChange={e=>setForm({...form,nombre:e.target.value})} placeholder="Ej: Roll Philadelphia, Ensalada Mixta"/></div>
            <div className="field"><label>Categoría</label>
              <select value={form.categoria} onChange={e=>setForm({...form,categoria:e.target.value})}>
                <option value="">Sin categoría</option>
                {CATEGORIAS_RECETA.map(c=><option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="form2">
            <div className="field"><label>Precio de Venta $</label><input type="number" value={form.precio_venta} onChange={e=>setForm({...form,precio_venta:e.target.value})} placeholder="0"/></div>
            <div className="field"><label>Local</label>
              <select value={form.local_id} onChange={e=>setForm({...form,local_id:e.target.value})}>
                <option value="">Todos los locales</option>
                {locales.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}
              </select>
            </div>
          </div>

          <div style={{marginTop:16,borderTop:"1px solid var(--bd)",paddingTop:16}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div>
                <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"var(--muted2)"}}>Ingredientes</div>
                <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>El sistema calcula el costo automáticamente aplicando la merma de cada insumo</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={addItem}>+ Agregar ingrediente</button>
            </div>

            {items.length===0&&<div style={{padding:"20px",textAlign:"center",color:"var(--muted)",fontSize:12,background:"var(--s2)",borderRadius:"var(--r)"}}>Agregá los ingredientes para calcular el costo teórico del plato</div>}

            {items.length>0&&(
              <table className="items-table">
                <thead><tr><th>Insumo</th><th>Cantidad</th><th>Unidad</th><th>Merma</th><th>Costo</th><th></th></tr></thead>
                <tbody>{items.map((it,i)=>{
                  const ins=insumos.find(x=>x.id===parseInt(it.insumo_id));
                  const cantReal=it.cantidad?(parseFloat(it.cantidad)*(1+(ins?.merma||0)/100)):0;
                  const costo=cantReal*(ins?.costo_promedio||0);
                  return(
                    <tr key={i}>
                      <td>
                        <select style={{width:"100%",background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)"}}
                          value={it.insumo_id} onChange={e=>updateItem(i,"insumo_id",e.target.value)}>
                          <option value="">Seleccioná...</option>
                          {insumos.map(ins=><option key={ins.id} value={ins.id}>{ins.nombre}</option>)}
                        </select>
                      </td>
                      <td><input type="number" style={{width:70,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",padding:"4px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,borderRadius:"var(--r)"}} value={it.cantidad} onChange={e=>updateItem(i,"cantidad",e.target.value)} placeholder="0"/></td>
                      <td style={{color:"var(--muted2)",fontSize:11}}>{ins?.unidad_label||"—"}</td>
                      <td style={{color:ins?.merma>0?"var(--warn)":"var(--muted2)",fontSize:11}}>{ins?.merma>0?`${ins.merma}%`:"0%"}</td>
                      <td style={{color:"var(--acc)",fontFamily:"'Inter',sans-serif",fontSize:13,fontWeight:500}}>{costo>0?fmt_$(costo):"—"}</td>
                      <td><button className="btn btn-danger btn-sm" onClick={()=>setItems(items.filter((_,idx)=>idx!==i))}>✕</button></td>
                    </tr>
                  );
                })}</tbody>
              </table>
            )}

            {items.length>0&&(()=>{
              const costoTotal=calcCosto(items);
              const precio=parseFloat(form.precio_venta)||0;
              const margen=precio>0?((precio-costoTotal)/precio*100):0;
              const foodCost=precio>0?((costoTotal/precio)*100):0;
              return(
                <div style={{marginTop:12,padding:12,background:"var(--s2)",borderRadius:"var(--r)",display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                  <div><div style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Costo Teórico</div><div style={{fontFamily:"'Inter',sans-serif",fontSize:15,fontWeight:500,color:"var(--warn)"}}>{fmt_$(costoTotal)}</div></div>
                  <div><div style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Food Cost</div><div style={{fontFamily:"'Inter',sans-serif",fontSize:15,fontWeight:500,color:foodCost>35?"var(--danger)":foodCost>25?"var(--warn)":"var(--success)"}}>{foodCost.toFixed(1)}%</div></div>
                  <div><div style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase"}}>Margen Bruto</div><div style={{fontFamily:"'Inter',sans-serif",fontSize:15,fontWeight:500,color:margen<60?"var(--danger)":"var(--success)"}}>{margen.toFixed(1)}%</div></div>
                </div>
              );
            })()}
          </div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar Receta</button></div>
      </div></div>)}

      {verModal&&(<div className="overlay" onClick={()=>setVerModal(null)}><div className="modal" style={{width:600}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd">
          <div><div className="modal-title">{verModal.nombre}</div><div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>{verModal.categoria} · {locales.find(l=>l.id===verModal.local_id)?.nombre||"Todos los locales"}</div></div>
          <button className="close-btn" onClick={()=>setVerModal(null)}>✕</button>
        </div>
        <div className="modal-body">
          {verModal.items.length===0?<div className="empty">Sin ingredientes cargados</div>:(
            <>
              <table className="items-table">
                <thead><tr><th>Ingrediente</th><th>Cantidad</th><th>Merma</th><th>Cant. Real</th><th>Costo Unit.</th><th>Subtotal</th></tr></thead>
                <tbody>{verModal.items.map((it,i)=>{
                  const ins=insumos.find(x=>x.id===it.insumo_id);
                  const cantReal=parseFloat(it.cantidad)*(1+(ins?.merma||0)/100);
                  const costo=cantReal*(ins?.costo_promedio||0);
                  return(
                    <tr key={i}>
                      <td style={{fontWeight:500}}>{ins?.nombre||"—"}</td>
                      <td>{it.cantidad} {it.unidad}</td>
                      <td style={{color:ins?.merma>0?"var(--warn)":"var(--muted2)"}}>{ins?.merma||0}%</td>
                      <td style={{color:"var(--muted2)"}}>{cantReal.toFixed(1)} {it.unidad}</td>
                      <td style={{color:"var(--muted2)"}}>{fmt_$(ins?.costo_promedio||0)}/{it.unidad}</td>
                      <td><span className="num kpi-warn">{fmt_$(costo)}</span></td>
                    </tr>
                  );
                })}</tbody>
              </table>
              {(()=>{
                const costoTotal=calcCosto(verModal.items);
                const precio=verModal.precio_venta||0;
                const foodCost=precio>0?(costoTotal/precio*100):0;
                const margen=precio>0?((precio-costoTotal)/precio*100):0;
                return(
                  <div style={{marginTop:16,padding:16,background:"var(--s2)",borderRadius:"var(--r)",display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
                    {[["Costo Teórico",fmt_$(costoTotal),"var(--warn)"],["Precio Venta",fmt_$(precio),"var(--success)"],["Food Cost",foodCost.toFixed(1)+"%",foodCost>35?"var(--danger)":foodCost>25?"var(--warn)":"var(--success)"],["Margen Bruto",margen.toFixed(1)+"%",margen<60?"var(--danger)":"var(--success)"]].map(([l,v,c])=>(
                      <div key={l}><div style={{fontSize:9,color:"var(--muted)",letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>{l}</div><div style={{fontFamily:"'Inter',sans-serif",fontSize:14,fontWeight:500,color:c}}>{v}</div></div>
                    ))}
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </div></div>)}
    </div>
  );
}
