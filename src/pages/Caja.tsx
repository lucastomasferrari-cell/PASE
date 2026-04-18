import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { CATEGORIAS_COMPRA, CUENTAS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

// ─── CAJA ─────────────────────────────────────────────────────────────────────
export default function Caja({ localActivo }: any) {
  const [movimientos, setMovimientos] = useState<any[]>([]);
  const [saldos, setSaldos] = useState<Record<string, number>>({});
  const [modal, setModal] = useState(false);
  const [editSaldoModal, setEditSaldoModal] = useState<any>(null);
  const [filtCuenta, setFiltCuenta] = useState("Todas");
  const [mostrarAnulados, setMostrarAnulados] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({fecha:toISO(today),cuenta:"Caja Chica",tipo:"Pago Gasto",cat:"",importe:"",detalle:"",esEgreso:true});

  const load = async () => {
    setLoading(true);
    let q = db.from("movimientos").select("*").order("fecha", {ascending: false}).limit(80);
    if (localActivo) q = q.eq("local_id", parseInt(String(localActivo)));
    let sq = db.from("saldos_caja").select("*");
    if (localActivo) sq = sq.eq("local_id", parseInt(String(localActivo)));
    const [{data:m},{data:s}] = await Promise.all([q, sq]);
    setMovimientos(m||[]);
    // Si no hay localActivo, se agregan saldos de todos los locales por cuenta
    const obj: Record<string, number> = {};
    (s||[]).forEach(x=> { obj[x.cuenta] = (obj[x.cuenta]||0) + (x.saldo||0); });
    setSaldos(obj);
    setLoading(false);
  };
  useEffect(()=>{load();},[localActivo]);

  const mFilt = movimientos
    .filter(m => filtCuenta === "Todas" || m.cuenta === filtCuenta)
    .filter(m => mostrarAnulados ? true : !m.anulado);
  const totalLiquidez = Object.values(saldos).reduce((a,b)=>a+b,0);

  const guardar = async () => {
    if(!form.importe) return;
    if(!localActivo) { alert("Seleccioná un local activo en el sidebar"); return; }
    const lid = parseInt(String(localActivo));
    const importe = parseFloat(form.importe)*(form.esEgreso?-1:1);
    const {esEgreso,...rest} = form;
    await db.from("movimientos").insert([{...rest,id:genId("MOV"),importe,fact_id:null,local_id:lid}]);
    const actual = saldos[form.cuenta]||0;
    await db.from("saldos_caja").update({saldo:actual+importe}).eq("cuenta",form.cuenta).eq("local_id",lid);
    setModal(false); load();
  };

  const guardarAjusteSaldo = async () => {
    if (!localActivo) { alert("Seleccioná un local activo"); return; }
    if (!editSaldoModal.justificativo?.trim()) { alert("El justificativo es obligatorio"); return; }
    const lid = parseInt(String(localActivo));
    const saldoAnterior = saldos[editSaldoModal.cuenta] || 0;
    const saldoNuevo = parseFloat(editSaldoModal.saldo) || 0;
    const diferencia = saldoNuevo - saldoAnterior;

    await db.from("saldos_caja").update({ saldo: saldoNuevo })
      .eq("cuenta", editSaldoModal.cuenta).eq("local_id", lid);

    await db.from("movimientos").insert([{
      id: genId("MOV"), fecha: toISO(today),
      cuenta: editSaldoModal.cuenta, tipo: "Ajuste de saldo",
      cat: "AJUSTE", importe: diferencia,
      detalle: `Ajuste: ${editSaldoModal.justificativo}`,
      local_id: lid,
    }]);

    await db.from("auditoria").insert([{
      tabla: "saldos_caja", accion: "AJUSTE",
      detalle: JSON.stringify({
        cuenta: editSaldoModal.cuenta,
        saldo_anterior: saldoAnterior,
        saldo_nuevo: saldoNuevo,
        justificativo: editSaldoModal.justificativo,
        local_id: lid,
      }),
      fecha: new Date().toISOString(),
    }]);

    setEditSaldoModal(null); load();
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

    await db.from("auditoria").insert([{
      tabla: "movimientos", accion: "ANULACION",
      detalle: JSON.stringify({ movimiento: m, justificativo: motivo }),
      fecha: new Date().toISOString(),
    }]);

    load();
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
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--muted2)",cursor:"pointer"}}>
              <input type="checkbox" checked={mostrarAnulados} onChange={e => setMostrarAnulados(e.target.checked)}/>
              Ver anulados
            </label>
            <select className="search" style={{width:160}} value={filtCuenta} onChange={e=>setFiltCuenta(e.target.value)}>
              <option>Todas</option>{CUENTAS.map(c=><option key={c}>{c}</option>)}
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
                  <span className="badge b-warn" style={{fontSize:8}} title={`Editado: ${m.editado_motivo}`}>Editado</span>
                )}
              </td>
              <td>
                <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                  {!m.anulado && <button className="btn btn-danger btn-sm" onClick={() => eliminarMov(m)}>Anular</button>}
                </div>
              </td>
            </tr>
          ))}</tbody></table>
        )}
      </div>

      {editSaldoModal && (
        <div className="overlay" onClick={() => setEditSaldoModal(null)}>
          <div className="modal" style={{width:420}} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Ajuste de Saldo — {editSaldoModal.cuenta}</div>
              <button className="close-btn" onClick={() => setEditSaldoModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div style={{padding:"8px 0",marginBottom:12,fontSize:12,color:"var(--muted2)"}}>
                Saldo actual: <strong style={{color:"var(--acc)"}}>{fmt_$(saldos[editSaldoModal.cuenta]||0)}</strong>
              </div>
              <div className="field">
                <label>Nuevo saldo real $</label>
                <input type="number" value={editSaldoModal.saldo}
                  onChange={e => setEditSaldoModal({...editSaldoModal, saldo: e.target.value})} placeholder="0"/>
                {editSaldoModal.saldo !== "" && (
                  <div style={{fontSize:11,color:"var(--muted2)",marginTop:4}}>
                    Diferencia: <strong style={{color: (parseFloat(editSaldoModal.saldo)||0) - (saldos[editSaldoModal.cuenta]||0) >= 0 ? "var(--success)" : "var(--danger)"}}>
                      {fmt_$((parseFloat(editSaldoModal.saldo)||0) - (saldos[editSaldoModal.cuenta]||0))}
                    </strong>
                  </div>
                )}
              </div>
              <div className="field">
                <label>Justificativo *</label>
                <input value={editSaldoModal.justificativo || ""}
                  onChange={e => setEditSaldoModal({...editSaldoModal, justificativo: e.target.value})}
                  placeholder="Ej: Arqueo de caja, corrección de error, saldo inicial..."/>
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setEditSaldoModal(null)}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardarAjusteSaldo}>Confirmar ajuste</button>
            </div>
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
