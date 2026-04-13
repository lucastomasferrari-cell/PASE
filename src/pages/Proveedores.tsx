import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { CATEGORIAS_COMPRA } from "../lib/constants";
import { fmt_$ } from "../lib/utils";

// ─── PROVEEDORES ──────────────────────────────────────────────────────────────
export default function Proveedores() {
  const [proveedores,setProveedores]=useState([]);
  const [modal,setModal]=useState(false);
  const [editModal,setEditModal]=useState(null);
  const [search,setSearch]=useState("");
  const [loading,setLoading]=useState(true);
  const emptyForm={nombre:"",cuit:"",cat:"PESCADERIA",estado:"Activo"};
  const [form,setForm]=useState(emptyForm);
  const load=async()=>{setLoading(true);const {data}=await db.from("proveedores").select("*").order("nombre");setProveedores(data||[]);setLoading(false);};
  useEffect(()=>{load();},[]);
  const pFilt=proveedores.filter(p=>!search||p.nombre.toLowerCase().includes(search.toLowerCase())||(p.cuit||"").includes(search));
  const guardar=async()=>{if(!form.nombre)return;await db.from("proveedores").insert([{...form,saldo:0}]);setModal(false);setForm(emptyForm);load();};
  const guardarEdit=async()=>{await db.from("proveedores").update({nombre:editModal.nombre,cuit:editModal.cuit,cat:editModal.cat,estado:editModal.estado}).eq("id",editModal.id);setEditModal(null);load();};
  const toggleEstado=async(p)=>{await db.from("proveedores").update({estado:p.estado==="Activo"?"Inactivo":"Activo"}).eq("id",p.id);load();};
  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Proveedores</div><div className="ph-sub">{proveedores.filter(p=>p.estado==="Activo").length} activos · {fmt_$(proveedores.reduce((s,p)=>s+(p.saldo||0),0))} deuda total</div></div>
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
    </div>
  );
}
