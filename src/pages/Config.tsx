import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { ROLES } from "../lib/auth";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
export default function Config({ locales }) {
  const [usuarios,setUsuarios]=useState([]);
  const [loading,setLoading]=useState(true);
  const [modal,setModal]=useState(false);
  const [editModal,setEditModal]=useState(null);
  const [form,setForm]=useState({nombre:"",email:"",password:"",rol:"cajero",locales:[]});
  const load=async()=>{setLoading(true);const {data}=await db.from("usuarios").select("*").order("rol");setUsuarios(data||[]);setLoading(false);};
  useEffect(()=>{load();},[]);
  const guardar=async()=>{if(!form.nombre||!form.email||!form.password)return;await db.from("usuarios").insert([form]);setModal(false);setForm({nombre:"",email:"",password:"",rol:"cajero",locales:[]});load();};
  const guardarEdit=async()=>{await db.from("usuarios").update({password:editModal.password}).eq("id",editModal.id);setEditModal(null);load();};
  return (
    <div>
      <div className="ph-row"><div><div className="ph-title">Usuarios</div><div className="ph-sub">Accesos y permisos</div></div><button className="btn btn-acc" onClick={()=>setModal(true)}>+ Nuevo</button></div>
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:(
          <table><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th></th></tr></thead>
          <tbody>{usuarios.map(u=><tr key={u.id}><td style={{fontWeight:500}}>{u.nombre}</td><td className="mono" style={{color:"var(--muted2)"}}>{u.email}</td><td><span className="badge" style={{background:ROLES[u.rol]?.color+"22",color:ROLES[u.rol]?.color}}>{ROLES[u.rol]?.label}</span></td><td><button className="btn btn-ghost btn-sm" onClick={()=>setEditModal({id:u.id,nombre:u.nombre,password:""})}>Cambiar clave</button></td></tr>)}</tbody>
        </table>)}
      </div>
      {modal&&(<div className="overlay" onClick={()=>setModal(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Nuevo Usuario</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
        <div className="modal-body">
          <div className="field"><label>Nombre</label><input value={form.nombre} onChange={e=>setForm({...form,nombre:e.target.value})}/></div>
          <div className="form2"><div className="field"><label>Usuario</label><input autoComplete="off" value={form.email} onChange={e=>setForm({...form,email:e.target.value})}/></div><div className="field"><label>Contraseña</label><input type="password" autoComplete="new-password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></div></div>
          <div className="field"><label>Rol</label><select value={form.rol} onChange={e=>setForm({...form,rol:e.target.value})}>{Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Crear</button></div>
      </div></div>)}
      {editModal&&(<div className="overlay" onClick={()=>setEditModal(null)}><div className="modal" style={{width:380}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Cambiar Contraseña</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
        <div className="modal-body">
          <div className="alert alert-info">{editModal.nombre}</div>
          <div className="field"><label>Nueva contraseña</label><input type="password" autoComplete="new-password" placeholder="Nueva contraseña" value={editModal.password} onChange={e=>setEditModal({...editModal,password:e.target.value})}/></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
      </div></div>)}
    </div>
  );
}
