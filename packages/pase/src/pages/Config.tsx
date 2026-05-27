import { useState, useEffect, useRef } from "react";
import { db } from "../lib/supabase";
import { ROLES } from "../lib/auth";
import type { Local, UsuarioRow } from "../types";

// AUDIT F2D #29: SHA-256 client-side eliminado. Antes este archivo escribía
// `usuarios.password` con SHA-256 sin sal — contradice CLAUDE.md y es vulnerable
// a rainbow tables. Ahora solo se cambian passwords via /api/auth-admin que
// usa Supabase Auth (Argon2id internamente).

interface ConfigProps {
  locales: Local[];
}

interface EditState {
  id: number;
  nombre: string;
  auth_id: string | null;
  password: string;
}

interface NuevoUsuarioForm {
  nombre: string;
  email: string;
  password: string;
  rol: string;
  locales: number[];
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
export default function Config(_props: ConfigProps) {
  const [usuarios,setUsuarios]=useState<UsuarioRow[]>([]);
  const [loading,setLoading]=useState(true);
  const [modal,setModal]=useState(false);
  const [editModal,setEditModal]=useState<EditState | null>(null);
  const [form,setForm]=useState<NuevoUsuarioForm>({nombre:"",email:"",password:"",rol:"cajero",locales:[]});
  const [saving,setSaving]=useState(false);
  const [formErr,setFormErr]=useState("");

  const load=async()=>{setLoading(true);const {data}=await db.from("usuarios").select("*").order("rol");setUsuarios((data||[]) as UsuarioRow[]);setLoading(false);};
  // Patrón fetch-on-mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{load();},[]);

  const savingRef = useRef(false);
  const guardar=async()=>{
    if(savingRef.current)return;
    if(!form.nombre||!form.email||!form.password)return;
    savingRef.current=true;
    setSaving(true);setFormErr("");
    try{
      const r=await fetch("/api/auth-admin",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"create",nombre:form.nombre,usuario:form.email,password:form.password,rol:form.rol,locales:form.locales}),
      });
      const d=await r.json();
      if(!d.ok){setFormErr(d.error||"Error creando usuario");return;}
      setModal(false);setForm({nombre:"",email:"",password:"",rol:"cajero",locales:[]});load();
    }catch(e){setFormErr(e instanceof Error ? e.message : String(e));}
    finally{ savingRef.current=false; setSaving(false); }
  };

  const guardarEdit=async()=>{
    if(savingRef.current)return;
    if(!editModal||!editModal.password)return;
    savingRef.current=true;
    setSaving(true);setFormErr("");
    try{
      // AUDIT F2D #29: NO escribimos a usuarios.password (SHA-256 sin sal).
      // Solo cambio de password via Supabase Auth. Si el user no tiene auth_id
      // (legacy), debe migrarse primero desde /usuarios.
      if(!editModal.auth_id){
        setFormErr("Usuario legacy sin Supabase Auth — migralo desde /usuarios primero.");
        return;
      }
      const r=await fetch("/api/auth-admin",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({action:"change_password",authId:editModal.auth_id,password:editModal.password}),
      });
      const d=await r.json();
      if(!d.ok){setFormErr(d.error||"Error cambiando contraseña");return;}
      setEditModal(null);load();
    }catch(e){setFormErr(e instanceof Error ? e.message : String(e));}
    finally{ savingRef.current=false; setSaving(false); }
  };

  return (
    <div>
      <div className="ph-row"><div><div className="ph-title">Usuarios</div></div><button className="btn btn-acc" onClick={()=>{setModal(true);setFormErr("");}}>+ Nuevo</button></div>
      <div className="panel">
        {loading?<div className="loading">Cargando...</div>:(
          <table><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Auth</th><th></th></tr></thead>
          <tbody>{usuarios.map(u=><tr key={u.id}><td style={{fontWeight:500}}>{u.nombre}</td><td className="mono" style={{color:"var(--muted2)"}}>{u.email}</td><td><span className="badge" style={{background:ROLES[u.rol]?.color+"22",color:ROLES[u.rol]?.color}}>{ROLES[u.rol]?.label}</span></td><td style={{fontSize:10,color:u.auth_id?"var(--ok)":"var(--muted)"}}>{u.auth_id?"Migrado":"Legacy"}</td><td><button className="btn btn-ghost btn-sm" onClick={()=>{setEditModal({id:u.id,nombre:u.nombre,auth_id:u.auth_id,password:""});setFormErr("");}}>Cambiar clave</button></td></tr>)}</tbody>
        </table>)}
      </div>
      {modal&&(<div className="overlay" onClick={()=>setModal(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Nuevo Usuario</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
        <div className="modal-body">
          {formErr&&<div className="alert alert-danger">{formErr}</div>}
          <div className="field"><label>Nombre</label><input value={form.nombre} onChange={e=>setForm({...form,nombre:e.target.value})}/></div>
          <div className="form2"><div className="field"><label>Usuario</label><input autoComplete="off" value={form.email} onChange={e=>setForm({...form,email:e.target.value})} placeholder="nombre (se agrega @pase.local)"/></div><div className="field"><label>Contraseña</label><input type="password" autoComplete="new-password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></div></div>
          <div className="field"><label>Rol</label><select value={form.rol} onChange={e=>setForm({...form,rol:e.target.value})}>{Object.entries(ROLES).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}</select></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar} disabled={saving}>{saving?"Creando...":"Crear"}</button></div>
      </div></div>)}
      {editModal&&(<div className="overlay" onClick={()=>setEditModal(null)}><div className="modal" style={{width:380}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Cambiar Contraseña</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
        <div className="modal-body">
          {formErr&&<div className="alert alert-danger">{formErr}</div>}
          <div className="alert alert-info">{editModal.nombre}</div>
          <div className="field"><label>Nueva contraseña</label><input type="password" autoComplete="new-password" placeholder="Nueva contraseña" value={editModal.password} onChange={e=>setEditModal({...editModal,password:e.target.value})}/></div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit} disabled={saving}>{saving?"Guardando...":"Guardar"}</button></div>
      </div></div>)}
    </div>
  );
}
