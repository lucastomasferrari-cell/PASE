import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasVisibles as cuentasVisiblesFn, localesVisibles } from "../lib/auth";
import { CATEGORIAS_COMPRA, CUENTAS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

// ─── TESORERÍA ────────────────────────────────────────────────────────────────
export default function Caja({ user, locales = [], localActivo }: any) {
  // cuentas_visibles del usuario (null = todas). Si null, usamos el listado completo.
  const vis = cuentasVisiblesFn(user);
  const cuentasVisibles = vis === null ? CUENTAS : vis;

  // Locales accesibles: dueno/admin = todos; encargado = los asignados.
  const visLocs = localesVisibles(user);
  const locsDisp: any[] = visLocs === null ? (locales || []) : (locales || []).filter((l: any) => visLocs.includes(l.id));
  // local_id implícito: si hay localActivo seteado o el usuario tiene un único local, no se pide selector.
  const lidImplicito: number | null = localActivo != null
    ? Number(localActivo)
    : locsDisp.length === 1 ? Number(locsDisp[0].id) : null;

  const [movimientos, setMovimientos] = useState<any[]>([]);
  const [saldos, setSaldos] = useState<Record<string, number>>({});
  const [modal, setModal] = useState(false);
  const [editMov, setEditMov] = useState<any>(null);
  const [filtCuenta, setFiltCuenta] = useState("Todas");
  const [mostrarAnulados, setMostrarAnulados] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detalleEdicion, setDetalleEdicion] = useState<any>(null);
  const [auditLog, setAuditLog] = useState<any>(null);
  const [form, setForm] = useState({fecha:toISO(today),cuenta:"Caja Chica",tipo:"Pago Gasto",cat:"",importe:"",detalle:"",esEgreso:true});
  // Selector de local en el modal cuando no hay localActivo y hay >1 local visible.
  const [localFormId, setLocalFormId] = useState<string>(lidImplicito != null ? String(lidImplicito) : "");
  useEffect(() => {
    setLocalFormId(lidImplicito != null ? String(lidImplicito) : "");
  }, [localActivo, locsDisp.length]);
  const [movCajaEf, setMovCajaEf] = useState<any[]>([]);
  const [modalCajaEf, setModalCajaEf] = useState(false);
  const [formCajaEf, setFormCajaEf] = useState({fecha:toISO(today),descripcion:"",monto:"",esIngreso:true});
  const esDueno = user?.rol === "dueno" || user?.rol === "admin";
  const necesitaSelectorLocal = lidImplicito == null && locsDisp.length > 1;

  const load = async () => {
    setLoading(true);
    let q = db.from("movimientos").select("*").order("fecha", {ascending: false}).order("id", {ascending: false}).limit(80);
    q = applyLocalScope(q, user, localActivo);
    let sq = db.from("saldos_caja").select("*");
    sq = applyLocalScope(sq, user, localActivo);
    const [{data:m},{data:s}] = await Promise.all([q, sq]);
    setMovimientos(m||[]);
    // Si no hay localActivo, se agregan saldos de todos los locales por cuenta
    const obj: Record<string, number> = {};
    (s||[]).forEach(x=> { obj[x.cuenta] = (obj[x.cuenta]||0) + (x.saldo||0); });
    setSaldos(obj);
    if (esDueno) {
      let ceQ = db.from("caja_efectivo").select("*")
        .order("fecha", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(50);
      ceQ = applyLocalScope(ceQ, user, localActivo);
      const { data: ce } = await ceQ;
      setMovCajaEf(ce || []);
    }
    setLoading(false);
  };
  useEffect(()=>{load();},[localActivo]);

  useEffect(() => {
    if (!detalleEdicion) { setAuditLog(null); return; }
    db.from("auditoria")
      .select("*")
      .eq("tabla", "movimientos")
      .eq("accion", "EDICION")
      .order("fecha", { ascending: false })
      .then(({ data }) => {
        const log = (data || []).find(l => {
          try { return JSON.parse(l.detalle)?.id === detalleEdicion.id; } catch { return false; }
        });
        setAuditLog(log ? JSON.parse(log.detalle) : null);
      });
  }, [detalleEdicion]);

  const mFilt = movimientos
    .filter(m => filtCuenta === "Todas" || m.cuenta === filtCuenta)
    .filter(m => mostrarAnulados ? true : !m.anulado);
  const totalLiquidez = Object.values(saldos).reduce((a,b)=>a+b,0);

  const guardar = async () => {
    if(!form.importe) return;
    const lid = lidImplicito != null ? lidImplicito : parseInt(localFormId);
    if (!Number.isFinite(lid)) return; // el botón Guardar está disabled cuando falta, defensa extra
    const importe = parseFloat(form.importe)*(form.esEgreso?-1:1);
    const {esEgreso,...rest} = form;
    await db.from("movimientos").insert([{...rest,id:genId("MOV"),importe,fact_id:null,local_id:lid}]);
    const actual = saldos[form.cuenta]||0;
    await db.from("saldos_caja").update({saldo:actual+importe}).eq("cuenta",form.cuenta).eq("local_id",lid);
    setModal(false); load();
  };

  const eliminarMov = async (m: any) => {
    const motivo = prompt("¿Por qué anulás este movimiento? (obligatorio)");
    if (!motivo?.trim()) return;

    await db.from("movimientos").update({
      anulado: true,
      anulado_motivo: motivo,
    }).eq("id", m.id);

    if (m.local_id) {
      const { data: caja } = await db.from("saldos_caja").select("saldo")
        .eq("cuenta", m.cuenta).eq("local_id", m.local_id).maybeSingle();
      if (caja) await db.from("saldos_caja")
        .update({ saldo: (caja.saldo || 0) - (m.importe || 0) })
        .eq("cuenta", m.cuenta).eq("local_id", m.local_id);
    }

    // Si es un pago de sueldo, propagamos la anulación a rrhh_liquidaciones
    // así el EERR lo excluye. Match fragilito por (detalle+fecha+cuenta+local_id)
    // pero es la única traza disponible entre movimientos y gastos hoy.
    if (m.cat === "SUELDOS" && m.local_id) {
      const { data: gastoMatch } = await db.from("gastos")
        .select("id")
        .eq("detalle", m.detalle)
        .eq("fecha", m.fecha)
        .eq("cuenta", m.cuenta)
        .eq("local_id", m.local_id)
        .maybeSingle();
      if (gastoMatch?.id) {
        await db.from("rrhh_liquidaciones")
          .update({ anulado: true })
          .eq("gasto_id", gastoMatch.id);
      }
    }

    await db.from("auditoria").insert([{
      tabla: "movimientos", accion: "ANULACION",
      detalle: JSON.stringify({ movimiento: m, justificativo: motivo }),
      fecha: new Date().toISOString(),
    }]);

    load();
  };

  const guardarEditMov = async () => {
    if (!editMov) return;
    if (!editMov.justificativo?.trim()) { alert("El justificativo es obligatorio"); return; }
    const original = movimientos.find(m => m.id === editMov.id);
    const lid = editMov.local_id;

    if (original && lid && (original.importe !== parseFloat(editMov.importe) || original.cuenta !== editMov.cuenta)) {
      const { data: cajaOrig } = await db.from("saldos_caja").select("saldo")
        .eq("cuenta", original.cuenta).eq("local_id", lid).maybeSingle();
      if (cajaOrig) await db.from("saldos_caja")
        .update({ saldo: (cajaOrig.saldo || 0) - (original.importe || 0) })
        .eq("cuenta", original.cuenta).eq("local_id", lid);

      const { data: cajaNueva } = await db.from("saldos_caja").select("saldo")
        .eq("cuenta", editMov.cuenta).eq("local_id", lid).maybeSingle();
      if (cajaNueva) await db.from("saldos_caja")
        .update({ saldo: (cajaNueva.saldo || 0) + (parseFloat(editMov.importe) || 0) })
        .eq("cuenta", editMov.cuenta).eq("local_id", lid);
    }

    await db.from("movimientos").update({
      fecha: editMov.fecha,
      detalle: editMov.detalle,
      cat: editMov.cat || null,
      importe: parseFloat(editMov.importe) || original?.importe,
      cuenta: editMov.cuenta,
      editado: true,
      editado_motivo: editMov.justificativo,
      editado_at: new Date().toISOString(),
    }).eq("id", editMov.id);

    await db.from("auditoria").insert([{
      tabla: "movimientos", accion: "EDICION",
      detalle: JSON.stringify({
        id: editMov.id,
        antes: original,
        despues: editMov,
        justificativo: editMov.justificativo,
      }),
      fecha: new Date().toISOString(),
    }]);

    setEditMov(null); load();
  };

  const guardarCajaEf = async () => {
    if (!formCajaEf.monto || !localActivo) return;
    const monto = parseFloat(formCajaEf.monto) * (formCajaEf.esIngreso ? 1 : -1);
    await db.from("caja_efectivo").insert([{
      fecha: formCajaEf.fecha,
      descripcion: formCajaEf.descripcion,
      monto,
      local_id: parseInt(String(localActivo)),
      creado_por: user?.nombre || "—",
    }]);
    setModalCajaEf(false);
    setFormCajaEf({fecha:toISO(today),descripcion:"",monto:"",esIngreso:true});
    load();
  };

  const cc = c => c==="Caja Chica"?"var(--acc)":c==="Caja Mayor"?"var(--acc2)":c==="MercadoPago"?"var(--acc3)":"var(--info)";

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Tesorería</div></div>
        <button className="btn btn-acc" onClick={()=>setModal(true)}>+ Movimiento</button>
      </div>
      {cuentasVisibles.length === 0 ? (
        <div className="empty" style={{padding:24,marginBottom:16}}>No tenés cuentas asignadas. Pedile a un administrador que te habilite.</div>
      ) : (
        <div className="grid4">
          {cuentasVisibles.map(k=>(
            <div key={k} className={`caja-card caja-${k==="Caja Chica"?"chica":k==="Caja Mayor"?"mayor":k==="MercadoPago"?"mp":"banco"}`}>
              <div className="caja-name">{k}</div>
              <div className="caja-saldo" style={{color:(saldos[k]||0)<0?"var(--danger)":"var(--txt)"}}>{fmt_$(saldos[k]||0)}</div>
            </div>
          ))}
        </div>
      )}
      <div className="panel">
        <div className="panel-hd">
          <span className="panel-title">Movimientos</span>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--muted2)",cursor:"pointer"}}>
              <input type="checkbox" checked={mostrarAnulados} onChange={e => setMostrarAnulados(e.target.checked)}/>
              Ver anulados
            </label>
            <select className="search" style={{width:160}} value={filtCuenta} onChange={e=>setFiltCuenta(e.target.value)}>
              <option>Todas</option>{cuentasVisibles.map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
        </div>
        {loading?<div className="loading">Cargando...</div>:mFilt.length===0?<div className="empty">Sin movimientos</div>:(
          <table><thead><tr><th>Fecha</th><th>Cuenta</th><th>Tipo</th><th>Categoría</th><th>Detalle</th><th>Importe</th><th>Estado</th><th></th></tr></thead>
          <tbody>{mFilt.map(m=>(
            <tr key={m.id} style={{opacity: m.anulado ? 0.5 : 1, textDecoration: m.anulado ? "line-through" : "none"}}>
              <td className="mono">{fmt_d(m.fecha)}</td>
              <td><span className="badge" style={{background:"transparent",color:cc(m.cuenta),border:`1px solid ${cc(m.cuenta)}44`}}>{m.cuenta}</span></td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{m.tipo}</td>
              <td>{m.cat?<span className="badge b-muted">{m.cat}</span>:"—"}</td>
              <td style={{fontSize:11,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.detalle}</td>
              <td><span className="num" style={{color:m.importe<0?"var(--danger)":"var(--success)"}}>{fmt_$(m.importe)}</span></td>
              <td>
                {m.anulado && (
                  <span className="badge b-danger" style={{fontSize:8}} title={m.anulado_motivo}>Anulado</span>
                )}
                {m.editado && !m.anulado && (
                  <span
                    className="badge b-warn"
                    style={{fontSize:8, cursor:"pointer"}}
                    onClick={() => setDetalleEdicion(m)}
                    title="Ver detalle de edición"
                  >
                    Editado
                  </span>
                )}
              </td>
              <td>
                <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                  {!m.anulado && <button className="btn btn-ghost btn-sm" onClick={() => setEditMov({...m, justificativo: ""})}>Editar</button>}
                  {!m.anulado && <button className="btn btn-danger btn-sm" onClick={() => eliminarMov(m)}>Anular</button>}
                </div>
              </td>
            </tr>
          ))}</tbody></table>
        )}
      </div>

      {esDueno && (
        <div className="panel" style={{marginTop:16}}>
          <div className="panel-hd">
            <span className="panel-title">Caja Efectivo — Privado</span>
            <button className="btn btn-acc btn-sm" onClick={() => setModalCajaEf(true)}>+ Movimiento</button>
          </div>
          {movCajaEf.length === 0 ? <div className="empty">Sin movimientos</div> : (
            <table>
              <thead><tr><th>Fecha</th><th>Descripción</th><th style={{textAlign:"right"}}>Monto</th></tr></thead>
              <tbody>{movCajaEf.map(m => (
                <tr key={m.id}>
                  <td className="mono">{fmt_d(m.fecha)}</td>
                  <td style={{fontSize:11}}>{m.descripcion}</td>
                  <td style={{textAlign:"right"}}>
                    <span className="num" style={{color: Number(m.monto) < 0 ? "var(--danger)" : "var(--success)"}}>
                      {fmt_$(Number(m.monto))}
                    </span>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}

      {modalCajaEf && (
        <div className="overlay" onClick={() => setModalCajaEf(false)}>
          <div className="modal" style={{width:460}} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Caja Efectivo — Nuevo movimiento</div><button className="close-btn" onClick={() => setModalCajaEf(false)}>✕</button></div>
            <div className="modal-body">
              <div className="field"><label>Tipo</label>
                <select value={formCajaEf.esIngreso ? "ingreso" : "egreso"} onChange={e => setFormCajaEf({...formCajaEf, esIngreso: e.target.value === "ingreso"})}>
                  <option value="ingreso">Ingreso (entra plata)</option>
                  <option value="egreso">Egreso (sale plata)</option>
                </select>
              </div>
              <div className="form2">
                <div className="field"><label>Monto $</label><input type="number" value={formCajaEf.monto} onChange={e => setFormCajaEf({...formCajaEf, monto: e.target.value})} placeholder="0"/></div>
                <div className="field"><label>Fecha</label><input type="date" value={formCajaEf.fecha} onChange={e => setFormCajaEf({...formCajaEf, fecha: e.target.value})}/></div>
              </div>
              <div className="field"><label>Descripción</label><input value={formCajaEf.descripcion} onChange={e => setFormCajaEf({...formCajaEf, descripcion: e.target.value})} placeholder="Ej: Retiro, ajuste..."/></div>
              {!localActivo && <div className="alert alert-warn">Seleccioná un local activo en el sidebar.</div>}
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setModalCajaEf(false)}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardarCajaEf} disabled={!formCajaEf.monto || !localActivo}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {editMov && (
        <div className="overlay" onClick={() => setEditMov(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Editar Movimiento</div>
              <button className="close-btn" onClick={() => setEditMov(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Fecha</label>
                  <input type="date" value={editMov.fecha} onChange={e => setEditMov({...editMov, fecha: e.target.value})}/>
                </div>
                <div className="field"><label>Categoría</label>
                  <select value={editMov.cat||""} onChange={e => setEditMov({...editMov, cat: e.target.value})}>
                    <option value="">Sin categoría</option>
                    {CATEGORIAS_COMPRA.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div className="form2">
                <div className="field"><label>Cuenta</label>
                  <select value={editMov.cuenta} onChange={e => setEditMov({...editMov, cuenta: e.target.value})}>
                    {cuentasVisibles.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field"><label>Importe $</label>
                  <input type="number" value={editMov.importe}
                    onChange={e => setEditMov({...editMov, importe: e.target.value})}/>
                </div>
              </div>
              <div className="field"><label>Detalle</label>
                <input value={editMov.detalle||""} onChange={e => setEditMov({...editMov, detalle: e.target.value})}/>
              </div>
              <div className="field"><label>Justificativo de la edición *</label>
                <input value={editMov.justificativo||""}
                  onChange={e => setEditMov({...editMov, justificativo: e.target.value})}
                  placeholder="Motivo de la modificación..."/>
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setEditMov(null)}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardarEditMov}>Guardar</button>
            </div>
          </div>
        </div>
      )}

      {detalleEdicion && (
        <div className="overlay" onClick={() => setDetalleEdicion(null)}>
          <div className="modal" style={{width:480}} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Detalle de edición</div>
              <button className="close-btn" onClick={() => setDetalleEdicion(null)}>✕</button>
            </div>
            <div className="modal-body">
              {auditLog ? (<>
                <div style={{marginBottom:12,fontSize:11,color:"var(--muted2)"}}>
                  Justificativo: <strong style={{color:"var(--txt)"}}>{auditLog.justificativo || "—"}</strong>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                  <div>
                    <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:1,color:"var(--muted)",marginBottom:8}}>Antes</div>
                    {auditLog.antes && Object.entries(auditLog.antes).map(([k, v]: any) => (
                      <div key={k} style={{fontSize:11,marginBottom:4}}>
                        <span style={{color:"var(--muted2)"}}>{k}:</span> <span style={{color:"var(--danger)"}}>{String(v??'—')}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:1,color:"var(--muted)",marginBottom:8}}>Después</div>
                    {auditLog.despues && Object.entries(auditLog.despues).map(([k, v]: any) => (
                      <div key={k} style={{fontSize:11,marginBottom:4}}>
                        <span style={{color:"var(--muted2)"}}>{k}:</span> <span style={{color:"var(--success)"}}>{String(v??'—')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>) : (
                <div className="empty">Sin detalle de auditoría disponible</div>
              )}
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setDetalleEdicion(null)}>Cerrar</button></div>
          </div>
        </div>
      )}

      {modal && (
        <div className="overlay" onClick={()=>setModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nuevo Movimiento</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
            <div className="modal-body">
              {necesitaSelectorLocal && (
                <div className="field">
                  <label>Local *</label>
                  <select value={localFormId} onChange={e=>setLocalFormId(e.target.value)} required>
                    <option value="">Seleccioná el local...</option>
                    {locsDisp.map((l:any)=><option key={l.id} value={l.id}>{l.nombre}</option>)}
                  </select>
                </div>
              )}
              <div className="form2">
                <div className="field"><label>Cuenta</label><select value={form.cuenta} onChange={e=>setForm({...form,cuenta:e.target.value})}>{cuentasVisibles.map(c=><option key={c}>{c}</option>)}</select></div>
                <div className="field"><label>Dirección</label><select value={form.esEgreso?"egreso":"ingreso"} onChange={e=>setForm({...form,esEgreso:e.target.value==="egreso"})}><option value="egreso">Egreso (sale plata)</option><option value="ingreso">Ingreso (entra plata)</option></select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}><option value="">Sin categoría</option>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
              </div>
              <div className="field"><label>Importe $</label><input type="number" value={form.importe} onChange={e=>setForm({...form,importe:e.target.value})} placeholder="0"/></div>
              <div className="field"><label>Detalle</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Descripción..."/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar} disabled={!form.importe || (necesitaSelectorLocal && !localFormId)}>Guardar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
