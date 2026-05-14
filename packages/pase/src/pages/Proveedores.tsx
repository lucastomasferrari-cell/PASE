import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, tienePermiso } from "../lib/auth";
import { useCategorias } from "../lib/useCategorias";
import { toISO, today, fmt_$ } from "../lib/utils";
import { calcularSaldosPorProveedor } from "../lib/saldoProveedor";
import type { Usuario, Local } from "../types/auth";
import type { Proveedor, Factura } from "../types/finanzas";
import { EstadoCuentaDrawer } from "./compras/EstadoCuentaDrawer";

interface ProveedoresProps {
  user: Usuario;
  locales?: Local[];
  localActivo: number | null;
  /** Cuando true, omite el ph-row con título + botones. Usado al embeberlo
   * como sub-sección dentro de Compras (el módulo madre ya tiene su header
   * y sus botones contextuales). Sprint mayo 2026 v2 Commit 4. */
  embedded?: boolean;
}

// ─── PROVEEDORES ──────────────────────────────────────────────────────────────
export default function Proveedores({ user, localActivo, embedded = false }: ProveedoresProps) {
  const { CATEGORIAS_COMPRA } = useCategorias();
  const [proveedores,setProveedores]=useState<Proveedor[]>([]);
  const [modal,setModal]=useState(false);
  const [editModal,setEditModal]=useState<Proveedor | null>(null);
  const [ctaModal,setCtaModal]=useState<Proveedor | null>(null);
  const [ctaFacts,setCtaFacts]=useState<Factura[]>([]);
  const [ctaLoading,setCtaLoading]=useState(false);
  const [ctaMes,setCtaMes]=useState(toISO(today).slice(0,7));
  const [search,setSearch]=useState("");
  const [verInactivos,setVerInactivos]=useState(false);
  const [loading,setLoading]=useState(true);
  const emptyForm={nombre:"",cuit:"",cat:"PESCADERIA",estado:"Activo"};
  const [form,setForm]=useState(emptyForm);
  const load=async()=>{
    setLoading(true);
    // proveedores es global (sin local_id)
    const {data:provs}=await db.from("proveedores").select("*").order("nombre");
    // facturas + remitos scoped al alcance del usuario. Antes solo se
    // miraban facturas y subreportaba la deuda cuando había remitos sin
    // facturar. Ahora ambas tablas se combinan vía calcularSaldosPorProveedor
    // (helper compartido con Dashboard.tsx para garantizar el mismo número).
    let fq=db.from("facturas").select("id,prov_id,total,tipo,estado,pagos,local_id").neq("estado","anulada");
    fq=applyLocalScope(fq,user,localActivo);
    let rq=db.from("remitos").select("prov_id,monto,estado,factura_id,local_id");
    rq=applyLocalScope(rq,user,localActivo);
    // T-19 auditoría: cargar nc_aplicaciones para que las NCs parcialmente
    // aplicadas resten solo su saldo restante, no el total completo.
    const naq=db.from("nc_aplicaciones").select("nc_id,monto");
    const [{data:facts},{data:rems},{data:apls}]=await Promise.all([fq,rq,naq]);
    const saldoPorProv = calcularSaldosPorProveedor(
      (facts as Factura[]) || [],
      (rems as Array<{ prov_id: number | null; monto: number; estado: string; factura_id: string | null }>) || [],
      (apls as Array<{ nc_id: string; monto: number }>) || [],
    );
    setProveedores(((provs as Proveedor[]) || []).map(p => ({...p, saldo: saldoPorProv.get(p.id) || 0})));
    setLoading(false);
  };
  // Patrón fetch-on-dep-change. No agregar load a deps (re-fetch infinito).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{load();},[localActivo]);
  const pFilt=proveedores
    .filter(p=>verInactivos||p.estado!=="Inactivo")
    .filter(p=>!search||p.nombre.toLowerCase().includes(search.toLowerCase())||(p.cuit||"").includes(search));
  const guardar=async()=>{
    if(!form.nombre)return;
    const {error}=await db.from("proveedores").insert([{...form,saldo:0}]);
    if(error){alert("Error creando proveedor: "+error.message);return;}
    setModal(false);setForm(emptyForm);
    await load();
  };
  const guardarEdit=async()=>{
    if(!editModal) return;
    const {error}=await db.from("proveedores").update({nombre:editModal.nombre,cuit:editModal.cuit,cat:editModal.cat,estado:editModal.estado}).eq("id",editModal.id);
    if(error){alert("Error editando proveedor: "+error.message);return;}
    setEditModal(null);
    await load();
  };
  const toggleEstado=async(p: Proveedor)=>{
    const {error}=await db.from("proveedores").update({estado:p.estado==="Activo"?"Inactivo":"Activo"}).eq("id",p.id);
    if(error){alert("Error: "+error.message);return;}
    await load();
  };
  const abrirCta=async(p: Proveedor)=>{
    setCtaFacts([]);
    setCtaMes(toISO(today).slice(0,7));
    setCtaModal(p);
    setCtaLoading(true);
    let q=db.from("facturas").select("*").eq("prov_id",p.id).neq("estado","anulada").order("fecha",{ascending:false});
    q=applyLocalScope(q,user,localActivo);
    const {data,error}=await q;
    if(error)console.error("Error cargando estado de cuenta:",error);
    setCtaFacts((data as Factura[]) || []);setCtaLoading(false);
  };
  return (
    <div>
      {!embedded && (
        <div className="ph-row">
          <div><div className="ph-title">Proveedores</div></div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {tienePermiso(user, "ver_anulados") && (
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--muted2)",cursor:"pointer"}}>
                <input type="checkbox" checked={verInactivos} onChange={e=>setVerInactivos(e.target.checked)} style={{accentColor:"var(--acc)"}}/>
                Ver inactivos
              </label>
            )}
            <input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)}/>
            <button className="btn btn-acc" onClick={()=>setModal(true)}>+ Nuevo</button>
          </div>
        </div>
      )}
      {embedded && (
        /* Toolbar reducida cuando estamos embebidos: el header lo dibuja el
           módulo madre (Compras). Mostramos solo búsqueda + toggle inactivos. */
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:14,flexWrap:"wrap"}}>
          {tienePermiso(user, "ver_anulados") && (
            <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--muted2)",cursor:"pointer"}}>
              <input type="checkbox" checked={verInactivos} onChange={e=>setVerInactivos(e.target.checked)} style={{accentColor:"var(--acc)"}}/>
              Ver inactivos
            </label>
          )}
          <input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)} style={{width:240}}/>
          <button className="btn btn-acc" style={{marginLeft:"auto"}} onClick={()=>setModal(true)}>+ Nuevo proveedor</button>
        </div>
      )}
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
                <button className="btn btn-ghost btn-sm" onClick={()=>abrirCta(p)}>Edo. Cuenta</button>
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
            <div className="field"><label>Categoría EERR</label><select value={editModal.cat||""} onChange={e=>setEditModal({...editModal,cat:e.target.value})}>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
          </div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
      </div></div>)}

      {/* Drawer Estado de Cuenta (sprint mayo 2026 v2 Commit 4).
          Reemplaza el modal anterior con números 28-30px desbalanceados.
          Layout: panel lateral 480px desde la derecha. */}
      {ctaModal && (
        <EstadoCuentaDrawer
          proveedor={ctaModal}
          facturas={ctaFacts}
          loading={ctaLoading}
          mes={ctaMes}
          onMesChange={setCtaMes}
          onClose={() => setCtaModal(null)}
          onEditar={() => setEditModal(ctaModal)}
        />
      )}
    </div>
  );
}
