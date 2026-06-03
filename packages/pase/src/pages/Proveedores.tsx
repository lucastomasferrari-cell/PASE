import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { db } from "../lib/supabase";
import { applyLocalScope, tienePermiso } from "../lib/auth";
import { useGuardedHandler } from "../lib/useGuardedHandler";
import { useCategorias } from "../lib/useCategorias";
import { toISO, fmt_$ } from "@pase/shared/utils";
import { today } from "../lib/utils";
import { calcularSaldosPorProveedor } from "../lib/saldoProveedor";
import type { Usuario, Local } from "../types/auth";
import type { Proveedor, Factura } from "../types/finanzas";
import { EstadoCuentaDrawer, type SaldoMov } from "./compras/EstadoCuentaDrawer";
import { Modal } from "../components/ui";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";

interface ProveedoresProps {
  user: Usuario;
  locales?: Local[];
  localActivo: number | null;
  /** Cuando true, omite el ph-row con título + botones. Usado al embeberlo
   * como sub-sección dentro de Compras (el módulo madre ya tiene su header
   * y sus botones contextuales). Sprint mayo 2026 v2 Commit 4. */
  embedded?: boolean;
  /** Filtro controlado desde el sub-nav del módulo madre (sprint v2 bug 2 fix). */
  embeddedFilter?: "activos" | "inactivos";
}

// ─── PROVEEDORES ──────────────────────────────────────────────────────────────
export default function Proveedores({ user, localActivo, embedded = false, embeddedFilter }: ProveedoresProps) {
  const { CATEGORIAS_COMPRA } = useCategorias();
  // AUDIT F4B / sprint #6: toasts en vez de alert() — feedback inline no-bloqueante.
  const { toast, showError } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [proveedores,setProveedores]=useState<Proveedor[]>([]);
  const [modal,setModal]=useState(false);

  // En modo embedded, el padre Compras dispara "Nuevo proveedor" vía
  // query param ?action=nuevo. Lo leemos al render y abrimos el modal.
  // Después limpiamos el param para que un refresh no lo re-dispare.
  useEffect(() => {
    if (!embedded) return;
    if (searchParams.get("action") === "nuevo") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModal(true);
      const next = new URLSearchParams(searchParams);
      next.delete("action");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, embedded]);
  const [editModal,setEditModal]=useState<Proveedor | null>(null);
  const [ctaModal,setCtaModal]=useState<Proveedor | null>(null);
  const [ctaFacts,setCtaFacts]=useState<Factura[]>([]);
  const [ctaSaldoMovs,setCtaSaldoMovs]=useState<SaldoMov[]>([]);
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
    // Filtro de estado: en modo embedded, el sub-nav del módulo madre Compras
    // controla activos/inactivos vía prop. En modo suelto, usa el toggle interno
    // 'Ver inactivos'.
    .filter(p => {
      if (embedded && embeddedFilter === "inactivos") return p.estado === "Inactivo";
      if (embedded && embeddedFilter === "activos") return p.estado !== "Inactivo";
      return verInactivos || p.estado !== "Inactivo";
    })
    .filter(p=>!search||p.nombre.toLowerCase().includes(search.toLowerCase())||(p.cuit||"").includes(search));
  // Guarded contra doble-click (fix sistémico 2026-05-18).
  const guardarHandler = useGuardedHandler(async () => {
    if(!form.nombre)return;
    const {error}=await db.from("proveedores").insert([{...form,saldo:0}]);
    if(error){showError("Error creando proveedor: "+error.message);return;}
    setModal(false);setForm(emptyForm);
    await load();
  });
  const guardar = guardarHandler.run;
  const guardando = guardarHandler.isPending;
  const guardarEditHandler = useGuardedHandler(async () => {
    if(!editModal) return;
    const {error}=await db.from("proveedores").update({nombre:editModal.nombre,cuit:editModal.cuit,cat:editModal.cat,estado:editModal.estado}).eq("id",editModal.id);
    if(error){showError("Error editando proveedor: "+error.message);return;}
    setEditModal(null);
    await load();
  });
  const guardarEdit = guardarEditHandler.run;
  const guardandoEdit = guardarEditHandler.isPending;
  const toggleEstado=async(p: Proveedor)=>{
    const {error}=await db.from("proveedores").update({estado:p.estado==="Activo"?"Inactivo":"Activo"}).eq("id",p.id);
    if(error){showError("Error: "+error.message);return;}
    await load();
  };
  const abrirCta=async(p: Proveedor)=>{
    setCtaFacts([]);
    setCtaSaldoMovs([]);
    setCtaMes(toISO(today).slice(0,7));
    setCtaModal(p);
    setCtaLoading(true);
    let q=db.from("facturas").select("*").eq("prov_id",p.id).neq("estado","anulada").order("fecha",{ascending:false});
    q=applyLocalScope(q,user,localActivo);
    const [facRes, movsRes] = await Promise.all([
      q,
      // Ledger de saldo a favor / en contra. Tolera tabla inexistente
      // (si la migration 202606031400 aún no se aplicó, queda en []).
      db.from("proveedor_saldo_movimientos")
        .select("id, fecha, tipo, monto, motivo, factura_id, movimiento_id, created_at")
        .eq("proveedor_id", p.id)
        .is("deleted_at", null)
        .order("fecha", { ascending: false }),
    ]);
    if(facRes.error)console.error("Error cargando estado de cuenta:",facRes.error);
    setCtaFacts((facRes.data as Factura[]) || []);
    // Si la tabla no existe (relation does not exist), dejamos array vacío
    // sin loguear nada — es esperado mientras la migration no se aplique.
    if (movsRes.error && !/relation.*does not exist|table.*does not exist/i.test(movsRes.error.message)) {
      console.error("Error cargando saldo movimientos:", movsRes.error);
    }
    setCtaSaldoMovs((movsRes.data as SaldoMov[]) || []);
    setCtaLoading(false);
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
        /* Toolbar fina embedded: solo búsqueda. El botón '+ Nuevo proveedor'
           se movió al header del módulo madre Compras (regla 2026-05-13:
           botones de acción viven en el header, toolbar solo lleva inputs
           y filtros). El toggle 'Ver inactivos' lo reemplazó el sub-nav. */
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:14,flexWrap:"wrap"}}>
          <input className="search" placeholder="Buscar proveedor o CUIT…" value={search} onChange={e=>setSearch(e.target.value)} style={{width:280}}/>
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
      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido (focus trap, ESC, body-lock). */}
      <Modal
        isOpen={modal}
        onClose={()=>setModal(false)}
        title="Nuevo Proveedor"
        preventCloseOnOverlay={guardando}
        footer={
          <>
            <button className="btn btn-sec" onClick={()=>setModal(false)} disabled={guardando}>Cancelar</button>
            <button className="btn btn-acc" onClick={guardar} disabled={guardando}>{guardando ? "Guardando…" : "Guardar"}</button>
          </>
        }
      >
        <div className="field"><label>Razón Social *</label><input value={form.nombre} onChange={e=>setForm({...form,nombre:e.target.value})} placeholder="Empresa S.A."/></div>
        <div className="form2">
          <div className="field"><label>CUIT</label><input value={form.cuit} onChange={e=>setForm({...form,cuit:e.target.value})} placeholder="30-12345678-0"/></div>
          <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
        </div>
      </Modal>
      <Modal
        isOpen={!!editModal}
        onClose={()=>setEditModal(null)}
        title="Editar Proveedor"
        preventCloseOnOverlay={guardandoEdit}
        footer={
          <>
            <button className="btn btn-sec" onClick={()=>setEditModal(null)} disabled={guardandoEdit}>Cancelar</button>
            <button className="btn btn-acc" onClick={guardarEdit} disabled={guardandoEdit}>{guardandoEdit ? "Guardando…" : "Guardar"}</button>
          </>
        }
      >
        {editModal && (
          <>
            <div className="field"><label>Razón Social</label><input value={editModal.nombre} onChange={e=>setEditModal({...editModal,nombre:e.target.value})}/></div>
            <div className="form2">
              <div className="field"><label>CUIT</label><input value={editModal.cuit||""} onChange={e=>setEditModal({...editModal,cuit:e.target.value})}/></div>
              <div className="field"><label>Categoría EERR</label><select value={editModal.cat||""} onChange={e=>setEditModal({...editModal,cat:e.target.value})}>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
            </div>
          </>
        )}
      </Modal>

      {/* Drawer Estado de Cuenta (sprint mayo 2026 v2 Commit 4).
          Reemplaza el modal anterior con números 28-30px desbalanceados.
          Layout: panel lateral 480px desde la derecha. */}
      {ctaModal && (
        <EstadoCuentaDrawer
          proveedor={ctaModal}
          facturas={ctaFacts}
          saldoMovimientos={ctaSaldoMovs}
          loading={ctaLoading}
          mes={ctaMes}
          onMesChange={setCtaMes}
          onClose={() => setCtaModal(null)}
          onEditar={() => setEditModal(ctaModal)}
        />
      )}

      {/* AUDIT F4B / sprint #6: toast no bloqueante en vez de alert() */}
      <ToastComponent toast={toast} />
    </div>
  );
}
