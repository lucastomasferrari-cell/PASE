import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { CATEGORIAS_COMPRA, CUENTAS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

// ─── CAJA ─────────────────────────────────────────────────────────────────────
export default function Caja() {
  const [movimientos, setMovimientos] = useState<any[]>([]);
  const [saldos, setSaldos] = useState<Record<string, number>>({});
  const [modal, setModal] = useState(false);
  const [editSaldoModal, setEditSaldoModal] = useState<any>(null);
  const [editMov, setEditMov] = useState<any>(null);
  const [filtCuenta, setFiltCuenta] = useState("Todas");
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({fecha:toISO(today),cuenta:"Caja Chica",tipo:"Pago Gasto",cat:"",importe:"",detalle:"",esEgreso:true});

  const load = async () => {
    setLoading(true);
    const [{data:m},{data:s}] = await Promise.all([
      db.from("movimientos").select("*").order("fecha",{ascending:false}).limit(80),
      db.from("saldos_caja").select("*"),
    ]);
    setMovimientos(m||[]);
    const obj={}; (s||[]).forEach(x=>obj[x.cuenta]=x.saldo); setSaldos(obj);
    setLoading(false);
  };
  useEffect(()=>{load();},[]);

  const mFilt = movimientos.filter(m=>filtCuenta==="Todas"||m.cuenta===filtCuenta);
  const totalLiquidez = Object.values(saldos).reduce((a,b)=>a+b,0);

  const guardar = async () => {
    if(!form.importe) return;
    const importe = parseFloat(form.importe)*(form.esEgreso?-1:1);
    const {esEgreso,...rest} = form;
    await db.from("movimientos").insert([{...rest,id:genId("MOV"),importe,fact_id:null}]);
    const actual = saldos[form.cuenta]||0;
    await db.from("saldos_caja").update({saldo:actual+importe}).eq("cuenta",form.cuenta);
    setModal(false); load();
  };

  const guardarSaldo = async (cuenta: string, nuevoSaldo: any) => {
    await db.from("saldos_caja").update({saldo:parseFloat(nuevoSaldo)||0}).eq("cuenta",cuenta);
    setEditSaldoModal(null); load();
  };

  const eliminarMov = async (m: any) => {
    if (!confirm("¿Eliminar este movimiento? Se revertirá su impacto en la caja.")) return;
    const { error } = await db.from("movimientos").delete().eq("id", m.id);
    if (error) { alert("Error al eliminar: " + error.message); return; }
    const { data: caja } = await db.from("saldos_caja").select("saldo").eq("cuenta", m.cuenta).maybeSingle();
    if (caja) await db.from("saldos_caja").update({ saldo: (caja.saldo || 0) - (m.importe || 0) }).eq("cuenta", m.cuenta);
    load();
  };

  const guardarEditMov = async () => {
    if (!editMov) return;
    const { error } = await db.from("movimientos").update({
      fecha: editMov.fecha, detalle: editMov.detalle, cat: editMov.cat || null
    }).eq("id", editMov.id);
    if (error) { alert("Error al editar: " + error.message); return; }
    setEditMov(null); load();
  };

  const cc = c => c==="Caja Chica"?"var(--acc)":c==="Caja Mayor"?"var(--acc2)":c==="MercadoPago"?"var(--acc3)":"var(--info)";

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Caja & Bancos</div></div>
        <button className="btn btn-acc" onClick={()=>setModal(true)}>+ Movimiento</button>
      </div>
      <div className="grid4">
        {CUENTAS.map(k=>(
          <div key={k} className={`caja-card caja-${k==="Caja Chica"?"chica":k==="Caja Mayor"?"mayor":k==="MercadoPago"?"mp":"banco"}`}>
            <div className="caja-name">{k}</div>
            <div className="caja-saldo" style={{color:(saldos[k]||0)<0?"var(--danger)":"var(--txt)"}}>{fmt_$(saldos[k]||0)}</div>
            <button className="btn btn-ghost btn-sm" style={{marginTop:8,fontSize:9}} onClick={()=>setEditSaldoModal({cuenta:k,saldo:saldos[k]||0})}>Editar saldo</button>
          </div>
        ))}
      </div>
      <div className="panel">
        <div className="panel-hd">
          <span className="panel-title">Movimientos</span>
          <select className="search" style={{width:160}} value={filtCuenta} onChange={e=>setFiltCuenta(e.target.value)}>
            <option>Todas</option>{CUENTAS.map(c=><option key={c}>{c}</option>)}
          </select>
        </div>
        {loading?<div className="loading">Cargando...</div>:mFilt.length===0?<div className="empty">Sin movimientos</div>:(
          <table><thead><tr><th>Fecha</th><th>Cuenta</th><th>Tipo</th><th>Categoría</th><th>Detalle</th><th>Importe</th><th></th></tr></thead>
          <tbody>{mFilt.map(m=>(
            <tr key={m.id}>
              <td className="mono">{fmt_d(m.fecha)}</td>
              <td><span className="badge" style={{background:"transparent",color:cc(m.cuenta),border:`1px solid ${cc(m.cuenta)}44`}}>{m.cuenta}</span></td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{m.tipo}</td>
              <td>{m.cat?<span className="badge b-muted">{m.cat}</span>:"—"}</td>
              <td style={{fontSize:11,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.detalle}</td>
              <td><span className="num" style={{color:m.importe<0?"var(--danger)":"var(--success)"}}>{fmt_$(m.importe)}</span></td>
              <td><div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                <button className="btn btn-ghost btn-sm" onClick={()=>setEditMov({...m})}>Editar</button>
                <button className="btn btn-danger btn-sm" onClick={()=>eliminarMov(m)}>✕</button>
              </div></td>
            </tr>
          ))}</tbody></table>
        )}
      </div>

      {editSaldoModal && (
        <div className="overlay" onClick={()=>setEditSaldoModal(null)}>
          <div className="modal" style={{width:380}} onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Editar Saldo — {editSaldoModal.cuenta}</div><button className="close-btn" onClick={()=>setEditSaldoModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-warn">Este ajuste modifica el saldo directamente. Usalo para sincronizar con el saldo real actual.</div>
              <div className="field"><label>Saldo actual real $</label><input type="number" value={editSaldoModal.saldo} onChange={e=>setEditSaldoModal({...editSaldoModal,saldo:e.target.value})} placeholder="0"/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditSaldoModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={()=>guardarSaldo(editSaldoModal.cuenta,editSaldoModal.saldo)}>Guardar</button></div>
          </div>
        </div>
      )}

      {editMov && (
        <div className="overlay" onClick={()=>setEditMov(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Editar Movimiento</div><button className="close-btn" onClick={()=>setEditMov(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-warn">El importe, cuenta y tipo no son editables para no descuadrar los saldos. Si necesitás corregir el importe, eliminá el movimiento y creá uno nuevo.</div>
              <div className="form2">
                <div className="field"><label>Fecha</label><input type="date" value={editMov.fecha} onChange={e=>setEditMov({...editMov,fecha:e.target.value})}/></div>
                <div className="field"><label>Categoría EERR</label><select value={editMov.cat||""} onChange={e=>setEditMov({...editMov,cat:e.target.value})}><option value="">Sin categoría</option>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
              </div>
              <div className="field"><label>Detalle</label><input value={editMov.detalle||""} onChange={e=>setEditMov({...editMov,detalle:e.target.value})} placeholder="Descripción..."/></div>
              <div className="form2" style={{marginTop:8,opacity:0.5}}>
                <div className="field"><label>Cuenta (bloqueado)</label><input readOnly value={editMov.cuenta}/></div>
                <div className="field"><label>Importe (bloqueado)</label><input readOnly value={fmt_$(editMov.importe)}/></div>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setEditMov(null)}>Cancelar</button><button className="btn btn-acc" onClick={guardarEditMov}>Guardar</button></div>
          </div>
        </div>
      )}

      {modal && (
        <div className="overlay" onClick={()=>setModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Nuevo Movimiento</div><button className="close-btn" onClick={()=>setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div className="form2">
                <div className="field"><label>Cuenta</label><select value={form.cuenta} onChange={e=>setForm({...form,cuenta:e.target.value})}>{CUENTAS.map(c=><option key={c}>{c}</option>)}</select></div>
                <div className="field"><label>Dirección</label><select value={form.esEgreso?"egreso":"ingreso"} onChange={e=>setForm({...form,esEgreso:e.target.value==="egreso"})}><option value="egreso">Egreso (sale plata)</option><option value="ingreso">Ingreso (entra plata)</option></select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Categoría EERR</label><select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}><option value="">Sin categoría</option>{CATEGORIAS_COMPRA.map(c=><option key={c}>{c}</option>)}</select></div>
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
              </div>
              <div className="field"><label>Importe $</label><input type="number" value={form.importe} onChange={e=>setForm({...form,importe:e.target.value})} placeholder="0"/></div>
              <div className="field"><label>Detalle</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Descripción..."/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar}>Guardar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
