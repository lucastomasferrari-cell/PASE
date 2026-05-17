import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, localesVisibles, tienePermiso } from "../lib/auth";
import { useMediosCobro } from "../lib/useMediosCobro";
import { toISO, today, fmt_d, fmt_$ } from "../lib/utils";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import ImportarMaxirest from "./ImportarMaxirest";
import { Modal, PageHeader, EmptyState, LocalLockedChip, LocalSelectorObligatorio } from "../components/ui";
import type { Usuario, Local, Venta, CierreVentas } from "../types";

interface VentasProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

// editModal mantiene los valores del input mientras el usuario edita.
// monto y local_id pueden ser string mientras el usuario tipea, antes
// de ser parseados al guardar.
type VentaEditable = Omit<Venta, "monto" | "local_id"> & {
  monto: number | string;
  local_id: number | string;
};

// ─── VENTAS ───────────────────────────────────────────────────────────────────
export default function Ventas({ user, locales, localActivo }: VentasProps) {
  const [ventas,setVentas]=useState<Venta[]>([]);
  const [loading,setLoading]=useState(true);
  const [modalNuevo,setModalNuevo]=useState(false);
  const [showMaxirest,setShowMaxirest]=useState(false);
  const [detalleModal,setDetalleModal]=useState<CierreVentas | null>(null);
  const [editModal,setEditModal]=useState<VentaEditable | null>(null);
  // Default: últimos 90 días (consistente con Compras/Gastos/ConciliacionMP).
  const [filtDesde,setFiltDesde]=useState(()=>{const d=new Date(today);d.setDate(d.getDate()-90);return toISO(d);});
  const [filtHasta,setFiltHasta]=useState(toISO(today));
  const [form,setForm]=useState({local_id:"",fecha:toISO(today),turno:"Noche"});
  const [lineas,setLineas]=useState<{medio:string,monto:string}[]>([{medio:"EFECTIVO SALON",monto:""}]);
  // localesVisibles cubre dueño/admin/superadmin/encargado.
  const visLocs = localesVisibles(user);
  const localesDisp = visLocs === null ? locales : locales.filter((l: Local)=>visLocs.includes(l.id));
  const { mediosDisponibles } = useMediosCobro();
  // Catálogo en cada modal viene del local del form (no del localActivo del
  // sidebar) — el dueño puede cargar venta para cualquiera de sus locales.
  const mediosForm = mediosDisponibles(form.local_id ? parseInt(form.local_id) : null);
  const mediosEdit = mediosDisponibles(editModal?.local_id ? parseInt(String(editModal.local_id)) : null);
  // El medio default de una nueva línea: el primero del catálogo del local
  // seleccionado o "EFECTIVO SALON" como último resort.
  const medioDefault = mediosForm[0]?.nombre || "EFECTIVO SALON";
  const updateLinea=(i:number,field:"medio"|"monto",value:string)=>{
    setLineas(prev=>prev.map((l,j)=>j===i?{...l,[field]:value}:l));
  };

  const load=async()=>{
    setLoading(true);
    let q=db.from("ventas").select("*").order("fecha",{ascending:false});
    if(filtDesde) q=q.gte("fecha",filtDesde);
    if(filtHasta) q=q.lte("fecha",filtHasta);
    q=applyLocalScope(q,user,localActivo);
    const {data}=await q.limit(500);
    setVentas((data||[]) as Venta[]);setLoading(false);
  };
  // Debounce de los date pickers: evita un fetch por cada tecla cuando el
  // usuario tipea YYYY-MM-DD manualmente (convención C6).
  const debDesde = useDebouncedValue(filtDesde, 300);
  const debHasta = useDebouncedValue(filtHasta, 300);
  // Patrón fetch-on-dep-change.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{load();},[debDesde,debHasta,localActivo]);
  // Pre-llena form.local_id con la sucursal del sidebar si hay una activa.
  // Si el sidebar está en "Todas" (localActivo=null), DEJAMOS vacío para forzar
  // elección explícita en el form (decisión Lucas 2026-05-17). La única
  // excepción: si el user tiene 1 solo local visible, usamos ese (no hay nada
  // que elegir).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{
    if (!form.local_id) {
      if (localActivo != null) setForm(f => ({ ...f, local_id: String(localActivo) }));
      else if (localesDisp.length === 1) setForm(f => ({ ...f, local_id: String(localesDisp[0]!.id) }));
      // sino: queda "" hasta que el user elija en el form.
    }
  }, [locales, localActivo]);

  // Group ventas by fecha + turno + local
  const grupos: CierreVentas[]=[];
  const seen: Record<string, CierreVentas>={};
  for(const v of ventas){
    const key=`${v.fecha}||${v.turno}||${v.local_id}`;
    if(!seen[key]){seen[key]={key,fecha:v.fecha,turno:v.turno,local_id:v.local_id,items:[],total:0};grupos.push(seen[key]);}
    seen[key].items.push(v);
    seen[key].total+=(v.monto||0);
  }
  grupos.sort((a,b)=>a.fecha<b.fecha?1:a.fecha>b.fecha?-1:0);

  // idempotency_key se genera al abrir el modal. Si Lucas hace doble-click
  // en "Confirmar", la 2da llamada con el mismo key devuelve el resultado
  // cacheado de la 1ra (no duplica ventas). Se renueva al cerrar el modal.
  const [idempKey, setIdempKey] = useState<string>(() => crypto.randomUUID());
  const [guardando, setGuardando] = useState(false);
  // Toast de confirmación al guardar. Necesario para usuarios sin permiso
  // 'ventas_historico' (típicamente cajero) que no ven la tabla del histórico
  // — sin feedback visual, parece que la venta "no se cargó" (incidente
  // reportado 2026-05-12).
  const { toast, showToast } = useToast();

  const guardar = async () => {
    if (!form.local_id || guardando) return;
    const lid = parseInt(form.local_id);
    const lineasValidas = lineas
      .filter(l => parseFloat(l.monto) > 0)
      .map(l => ({ medio: l.medio, monto: parseFloat(l.monto) }));
    if (lineasValidas.length === 0) return;

    setGuardando(true);
    try {
      // Bloqueo de duplicados (2026-05-13): no permitir 2 cierres del mismo
      // (local, fecha, turno). Mismo fix que ImportarMaxirest — antes ahí
      // había un confirm() que dejaba pasar duplicados. Ver bug Caja Chica
      // Rene 12/05 noche cargado 2 veces.
      const { data: dup } = await db.from('ventas').select('id')
        .eq('local_id', lid).eq('fecha', form.fecha).eq('turno', form.turno).limit(1);
      if (dup && dup.length > 0) {
        alert(
          `Ya existe un cierre del ${fmt_d(form.fecha)} turno ${form.turno} para este local.\n\n` +
          `Si querés reemplazarlo, primero eliminalo desde la grilla de Ventas y volvé a cargar.`,
        );
        setGuardando(false);
        return;
      }

      // RPC atómica: si cualquier paso falla (insert venta, movimiento o
      // update saldos_caja), rollback completo — no quedan estados parciales.
      // Reemplazó los 3 inserts secuenciales del flow viejo (F1 del plan
      // sunny-creek). La cuenta_destino se resuelve server-side en la RPC
      // (lookup en medios_cobro con override por local).
      const { error } = await db.rpc("crear_cierre_ventas", {
        p_local_id: lid,
        p_fecha: form.fecha,
        p_turno: form.turno,
        p_lineas: lineasValidas,
        p_idempotency_key: idempKey,
      });
      if (error) {
        alert("Error al guardar venta: " + error.message);
        return;
      }
      const totalGuardado = lineasValidas.reduce((s, l) => s + l.monto, 0);
      showToast(`Venta cargada · ${fmt_$(totalGuardado)} (${lineasValidas.length} ${lineasValidas.length === 1 ? "medio" : "medios"})`);
      setLineas([{ medio: medioDefault, monto: "" }]);
      setIdempKey(crypto.randomUUID());
      setModalNuevo(false);
      load();
    } finally {
      setGuardando(false);
    }
  };

  const guardarEdit=async()=>{
    if(!editModal)return;
    const id=editModal.id;
    const nuevoMonto=parseFloat(String(editModal.monto));
    if(!Number.isFinite(nuevoMonto)||nuevoMonto<=0){
      alert("El monto debe ser un número mayor a 0");return;
    }
    // editar_venta RPC: ajusta monto + recalcula movimiento + saldos
    // atómicamente. Solo se puede cambiar el monto desde acá; otros
    // campos se actualizan después con un update directo (no afectan
    // movimientos en el caso típico).
    const {error:rpcErr}=await db.rpc("editar_venta",{p_venta_id:id,p_nuevo_monto:nuevoMonto});
    if(rpcErr){alert("Error al editar venta: "+(rpcErr.message||""));return;}

    // Otros campos (fecha, turno, medio, local_id) — update directo.
    // Cambiar estos puede descuadrar el saldo en casos raros (ej:
    // pasar de EFECTIVO a TARJETA). Para esos casos hay que borrar y
    // re-cargar manualmente. La UI debería desactivar esos campos en
    // un sprint futuro.
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4: editar_venta RPC solo cubre monto; cambiar fecha/turno/medio/local_id va por UPDATE directo. Necesita RPC editar_venta_completa para ser 100% atómico — F1 ya cerró la creación, esto es deuda residual del flow de edición.
    await db.from("ventas").update({
      fecha:editModal.fecha,
      turno:editModal.turno,
      medio:editModal.medio,
      local_id:parseInt(String(editModal.local_id)),
    }).eq("id",id);

    setEditModal(null);
    if(detalleModal){
      const updated: Venta[]=detalleModal.items.map(i=>i.id===id?{...i,...editModal,monto:nuevoMonto,local_id:parseInt(String(editModal.local_id))}:i);
      setDetalleModal({...detalleModal,items:updated,total:updated.reduce((s,i)=>s+(i.monto||0),0)});
    }
    load();
  };

  const eliminarLinea=async(id: string)=>{
    if(!confirm("¿Eliminar este registro?"))return;
    // eliminar_venta RPC: borra venta + ajusta movimiento + saldos
    // atómicamente. Si el mov es legacy sin venta_ids, solo borra la venta.
    const {error}=await db.rpc("eliminar_venta",{p_venta_id:id});
    if(error){alert("Error al eliminar venta: "+(error.message||""));return;}
    if(detalleModal){
      const updated=detalleModal.items.filter(i=>i.id!==id);
      if(updated.length===0){setDetalleModal(null);}
      else{setDetalleModal({...detalleModal,items:updated,total:updated.reduce((s: number,i: Venta)=>s+(i.monto||0),0)});}
    }
    load();
  };

  const eliminarBloque=async(grupo: CierreVentas)=>{
    if(!confirm(`¿Eliminar el cierre completo del ${fmt_d(grupo.fecha)} ${grupo.turno}?`))return;
    // RPC eliminar_cierre: atómico a nivel cierre completo. Si falla en
    // mitad, rollback transaccional → no quedan estados parciales como
    // pasaba con el loop secuencial de eliminar_venta.
    const {data,error}=await db.rpc("eliminar_cierre",{
      p_local_id:grupo.local_id,
      p_fecha:grupo.fecha,
      p_turno:grupo.turno,
    });
    if(error){alert("Error eliminando cierre: "+(error.message||""));return;}
    if(data?.contiene_legacy){
      alert("Cierre borrado. Algunos movimientos antiguos en Caja Chica pueden requerir borrado manual (cierres pre-2026-04-27 sin link a sus ventas).");
    }
    setDetalleModal(null);load();
  };

  return (
    <div>
      <ToastComponent toast={toast} />
      <PageHeader
        title="Ventas"
        info={<>
          Cierres de venta diarios o por turno (almuerzo, cena). Las ventas en efectivo generan
          automáticamente un movimiento en Caja. Las cobranzas de MP, tarjetas, etc. se registran
          cuando llega la liquidación (en el módulo Caja).
        </>}
        actions={
          <>
            <button className="btn btn-ghost" onClick={()=>setShowMaxirest(true)}>Importar cierre Maxirest</button>
            <button className="btn btn-acc" onClick={()=>setModalNuevo(true)}>+ Cargar venta</button>
          </>
        }
      />

      {/* Importador Maxirest como modal pop-up centrado (sprint v2 bug fix).
          Antes era un bloque inline arriba del historial que lo empujaba
          hacia abajo. */}
      <Modal
        isOpen={showMaxirest}
        onClose={() => setShowMaxirest(false)}
        title="Importar cierre Maxirest"
        subtitle="Pegá el texto del mail de cierre y procesalo."
        maxWidth={720}
        preventCloseOnOverlay
      >
        <ImportarMaxirest
          locales={locales}
          localActivo={localActivo}
          onImported={() => { load(); setShowMaxirest(false); }}
          embedded
        />
      </Modal>

      {/* SECCIÓN INFERIOR: filtros + historial.
          Visible solo para usuarios con permiso 'ventas_historico'. Sin el
          permiso (típicamente cajero), solo puede cargar ventas/cierres pero
          no ver el histórico de cierres anteriores — evita que pueda
          calcular cuánto facturó el local. */}
      {tienePermiso(user, "ventas_historico") && (
      <div className="panel">
        <div className="panel-hd" style={{flexWrap:"wrap",gap:8,justifyContent:"flex-end"}}>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            <span style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:0.5,marginRight:2}}>Período</span>
            <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--muted2)"}}>
              Desde
              <input type="date" className="search" style={{width:140}} value={filtDesde}
                onChange={e=>setFiltDesde(e.target.value)}/>
            </label>
            <span style={{color:"var(--muted2)",fontSize:12}}>→</span>
            <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--muted2)"}}>
              Hasta
              <input type="date" className="search" style={{width:140}} value={filtHasta}
                onChange={e=>setFiltHasta(e.target.value)}/>
            </label>
          </div>
        </div>
        {loading?<div className="loading">Cargando...</div>:grupos.length===0?(
          <EmptyState
            icon="📊"
            title="Sin ventas en el período"
            description="No hay ventas cargadas en el rango de fechas. Probá ampliar el rango o cargar una venta."
          />
        ):(
          <table>
            <thead><tr><th className="col-fecha">Fecha</th><th>Turno</th><th>Local</th><th>Registros</th><th className="num-right">Total</th><th></th></tr></thead>
            <tbody>{grupos.map(g=>(
              <tr key={g.key}>
                <td className="mono">{fmt_d(g.fecha)}</td>
                <td>
                  {/* Turno con color contextual: Mediodía → beige/durazno
                      (estética solar), Noche → lila/violeta pastel (estética
                      nocturna). Reemplaza b-info/b-warn que eran gris uniformes. */}
                  <span className="badge" style={{
                    background: g.turno === "Noche" ? "#E5E0F0" : "#FBEDD9",
                    color:      g.turno === "Noche" ? "#4E3D7A" : "#7A5018",
                  }}>{g.turno}</span>
                </td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find((l: Local)=>String(l.id)===String(g.local_id))?.nombre||"—"}</td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{g.items.length} formas de cobro</td>
                <td className="num-right kpi-success">{fmt_$(g.total)}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={()=>setDetalleModal(g)}>Ver detalle →</button></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      )}

      {/* DETALLE MODAL */}
      {detalleModal&&(
        <div className="overlay" onClick={()=>setDetalleModal(null)}>
          <div className="modal" style={{width:640}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd">
              <div>
                <div className="modal-title">{fmt_d(detalleModal.fecha)} · {detalleModal.turno}</div>
                <div style={{fontSize:11,color:"var(--muted2)",marginTop:2}}>{locales.find((l: Local)=>l.id===detalleModal.local_id)?.nombre} · Total: <span style={{color:"var(--success)",fontFamily:"'Inter',sans-serif",fontWeight:500}}>{fmt_$(detalleModal.total)}</span></div>
              </div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-danger btn-sm" onClick={()=>eliminarBloque(detalleModal)}>Eliminar cierre</button>
                <button className="close-btn" onClick={()=>setDetalleModal(null)}>✕</button>
              </div>
            </div>
            <div className="modal-body" style={{padding:0}}>
              <table>
                <thead><tr><th>Forma de Cobro</th><th>Monto</th><th>% del total</th><th></th></tr></thead>
                <tbody>{detalleModal.items.sort((a: Venta,b: Venta)=>b.monto-a.monto).map((v: Venta)=>(
                  <tr key={v.id}>
                    <td style={{fontWeight:500}}>{v.medio}{v.origen==="maxirest"&&<span className="badge b-muted" style={{marginLeft:6,fontSize:8}}>Maxirest</span>}</td>
                    <td><span className="num kpi-success">{fmt_$(v.monto)}</span></td>
                    <td style={{fontSize:11,color:"var(--muted2)"}}>{detalleModal.total>0?((v.monto/detalleModal.total)*100).toFixed(1):0}%</td>
                    <td><div style={{display:"flex",gap:4}}>
                      {v.origen!=="maxirest"&&<button className="btn btn-ghost btn-sm" onClick={()=>setEditModal({...v})}>Editar</button>}
                      <button className="btn btn-danger btn-sm" onClick={()=>eliminarLinea(v.id)}>✕</button>
                    </div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* EDIT MODAL */}
      {editModal&&(
        <div className="overlay" onClick={()=>setEditModal(null)}>
          <div className="modal" style={{width:440}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Editar Venta</div><button className="close-btn" onClick={()=>setEditModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Fecha</label><input type="date" value={editModal.fecha} onChange={e=>setEditModal({...editModal,fecha:e.target.value})}/></div>
                <div className="field"><label>Turno</label><select value={editModal.turno} onChange={e=>setEditModal({...editModal,turno:e.target.value})}><option>Mediodía</option><option>Noche</option></select></div>
              </div>
              <div className="field"><label>Forma de Cobro</label><select value={editModal.medio} onChange={e=>setEditModal({...editModal,medio:e.target.value})}>
                {/* Si el medio actual no está en el catálogo (medio legacy o
                    desactivado), lo agregamos como opción para no perder el valor. */}
                {!mediosEdit.some(m=>m.nombre===editModal.medio) && editModal.medio && <option key="legacy" value={editModal.medio}>{String(editModal.medio)} (legacy)</option>}
                {mediosEdit.map(m=><option key={m.id} value={m.nombre}>{m.nombre}</option>)}
              </select></div>
              <div className="field"><label>Monto $</label><input type="number" value={editModal.monto} onChange={e=>setEditModal({...editModal,monto:e.target.value})}/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEdit}>Guardar</button></div>
          </div>
        </div>
      )}

      {/* NUEVO MODAL */}
      {modalNuevo&&(
        <div className="overlay" onClick={()=>setModalNuevo(false)}>
          <div className="modal" style={{width:520}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nueva Venta</div><button className="close-btn" onClick={()=>setModalNuevo(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Local *</label>
                  {localActivo !== null ? (
                    <div style={{ paddingTop: 4 }}>
                      <LocalLockedChip nombre={locales.find((l: Local) => l.id === localActivo)?.nombre ?? "—"} />
                    </div>
                  ) : localesDisp.length === 1 ? (
                    <input type="text" value={localesDisp[0]!.nombre} disabled readOnly />
                  ) : (
                    <LocalSelectorObligatorio
                      value={form.local_id ? Number(form.local_id) : null}
                      onChange={id => setForm({ ...form, local_id: id !== null ? String(id) : "" })}
                      locales={localesDisp}
                    />
                  )}
                </div>
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
              </div>
              <div className="field"><label>Turno</label><select value={form.turno} onChange={e=>setForm({...form,turno:e.target.value})}><option>Mediodía</option><option>Noche</option></select></div>

              <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginTop:16,marginBottom:8}}>Formas de cobro</div>
              {lineas.map((l,i)=>(
                <div key={i} style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
                  <select className="search" style={{flex:1}} value={l.medio} onChange={e=>updateLinea(i,"medio",e.target.value)}>
                    {!mediosForm.some(m=>m.nombre===l.medio) && l.medio && <option key="legacy" value={l.medio}>{l.medio} (legacy)</option>}
                    {mediosForm.map(m=><option key={m.id} value={m.nombre}>{m.nombre}</option>)}
                  </select>
                  <input type="number" className="search" style={{width:120}} placeholder="Monto" value={l.monto} onChange={e=>updateLinea(i,"monto",e.target.value)}/>
                  {lineas.length>1 && <button className="btn btn-danger btn-sm" onClick={()=>setLineas(prev=>prev.filter((_,j)=>j!==i))}>✕</button>}
                </div>
              ))}
              <button className="btn btn-ghost btn-sm" style={{marginBottom:12}} onClick={()=>setLineas(prev=>[...prev,{medio:medioDefault,monto:""}])}>+ Agregar forma de cobro</button>

              <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:"1px solid var(--bd)",fontSize:12}}>
                <span style={{color:"var(--muted2)"}}>Total</span>
                <span style={{fontWeight:500,color:"var(--success)"}}>{fmt_$(lineas.reduce((s,l)=>s+(parseFloat(l.monto)||0),0))}</span>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModalNuevo(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar} disabled={guardando || !form.local_id}>Guardar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}