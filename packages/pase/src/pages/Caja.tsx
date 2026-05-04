import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasVisibles as cuentasVisiblesFn, localesVisibles } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { useCategorias } from "../lib/useCategorias";
import { CUENTAS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$ } from "../lib/utils";
import type { Usuario, Local } from "../types/auth";
import type { Movimiento } from "../types/finanzas";

interface CajaProps {
  user: Usuario | null;
  locales?: Local[];
  localActivo: number | null;
}

// Movimiento en edición: extiende Movimiento con justificativo (obligatorio
// en el modal) y permite que importe sea string mientras el usuario tipea
// — el input numérico devuelve string en e.target.value y parseFloat lo
// convierte al guardar.
interface EditMovDraft extends Omit<Movimiento, "importe"> {
  justificativo: string;
  importe: number | string;
}

// Detalle JSON-parseado de la fila auditoria de tipo EDICION. antes/despues
// son la fila movimiento serializada — se renderiza vía Object.entries
// genérico, por eso Record<string, unknown>.
interface AuditDetalle {
  id: string;
  antes: Record<string, unknown> | null;
  despues: Record<string, unknown> | null;
  justificativo: string;
}

// ─── TESORERÍA ────────────────────────────────────────────────────────────────
export default function Caja({ user, locales = [], localActivo }: CajaProps) {
  const {
    CATEGORIAS_COMPRA, GASTOS_FIJOS, GASTOS_VARIABLES,
    GASTOS_PUBLICIDAD, GASTOS_IMPUESTOS, COMISIONES_CATS, CATEGORIAS_INGRESO,
  } = useCategorias();
  // Listas por dirección para el dropdown de Categoría del Nuevo Movimiento.
  // Egreso: unión de todas las categorías que pueden aparecer en un egreso
  // (CMV + 5 grupos de Gastos). Ingreso: las 11 cat_ingreso de config.
  const catsEgreso = [
    ...CATEGORIAS_COMPRA, ...GASTOS_FIJOS, ...GASTOS_VARIABLES,
    ...GASTOS_PUBLICIDAD, ...GASTOS_IMPUESTOS, ...COMISIONES_CATS,
  ];
  const catsIngreso = CATEGORIAS_INGRESO;

  // Deriva tipo del movimiento a partir de cat + dirección. Se usa tanto
  // en guardar() como en guardarEditMov() cuando cambia el signo.
  const deriveTipoMov = (cat: string, esEgreso: boolean): string => {
    if (!esEgreso) {
      // Ingresos
      if (!cat) return "Ingreso Manual";
      if (cat.startsWith("Liquidación")) return "Liquidación Plataforma";
      if (cat === "Ingreso Socio") return "Aporte Socio";
      if (cat === "Devolución Proveedor") return "Devolución Proveedor";
      if (cat === "Transferencia Varios") return "Transferencia";
      return "Ingreso Manual"; // Otro Ingreso o no mapeado
    }
    // Egresos: según grupo al que pertenece la categoría
    if (GASTOS_FIJOS.includes(cat)) return "Gasto fijo";
    if (GASTOS_VARIABLES.includes(cat)) return "Gasto variable";
    if (GASTOS_PUBLICIDAD.includes(cat)) return "Gasto publicidad";
    if (GASTOS_IMPUESTOS.includes(cat)) return "Gasto impuesto";
    if (COMISIONES_CATS.includes(cat)) return "Gasto comision";
    if (CATEGORIAS_COMPRA.includes(cat)) return "Pago Proveedor";
    return "Egreso Manual";
  };

  // cuentas_visibles del usuario (null = todas). Si null, usamos el listado completo.
  const vis = cuentasVisiblesFn(user);
  const cuentasVisibles = vis === null ? CUENTAS : vis;

  // Locales accesibles: dueno/admin = todos; encargado = los asignados.
  const visLocs = localesVisibles(user);
  const locsDisp: Local[] = visLocs === null ? (locales || []) : (locales || []).filter((l: Local) => visLocs.includes(l.id));
  // local_id implícito: si hay localActivo seteado o el usuario tiene un único local, no se pide selector.
  const lidImplicito: number | null = localActivo != null
    ? Number(localActivo)
    : locsDisp.length === 1 ? Number(locsDisp[0]!.id) : null;

  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [saldos, setSaldos] = useState<Record<string, number>>({});
  const [modal, setModal] = useState(false);
  const [editMov, setEditMov] = useState<EditMovDraft | null>(null);
  const [filtCuenta, setFiltCuenta] = useState("Todas");
  const [mostrarAnulados, setMostrarAnulados] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detalleEdicion, setDetalleEdicion] = useState<Movimiento | null>(null);
  const [auditLog, setAuditLog] = useState<AuditDetalle | null>(null);
  const emptyForm = {fecha:toISO(today),cuenta:"Caja Chica",tipo:"Pago Gasto",cat:"",importe:"",detalle:"",esEgreso:true};
  const [form, setForm] = useState(emptyForm);
  // BUG 5: al abrir el modal de nuevo movimiento, resetear todos los campos
  // a estado vacío (antes quedaban pre-llenados con el último movimiento).
  const abrirNuevoMovimiento = () => {
    setForm({...emptyForm, fecha: toISO(today)});
    setModal(true);
  };
  // Selector de local en el modal cuando no hay localActivo y hay >1 local visible.
  const [localFormId, setLocalFormId] = useState<string>(lidImplicito != null ? String(lidImplicito) : "");
  // Sincroniza el local del form modal cuando cambia el localActivo del
  // sidebar. Patrón "derived form state from outer prop" — refactor a
  // key-reset del modal sería más React-correcto pero requiere mover
  // el modal al árbol bajo el local-prop.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalFormId(lidImplicito != null ? String(lidImplicito) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localActivo, locsDisp.length]);
  // Al cambiar dirección (egreso↔ingreso), resetear cat porque el dropdown
  // cambia de opciones — dejar un valor de egreso cuando está en ingreso
  // sería incompatible.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(f => ({ ...f, cat: "" }));
  }, [form.esEgreso]);
  // Transferencia entre cuentas: misma direccion (no afecta saldo total),
  // genera 2 movimientos (egreso en origen, ingreso en destino) vía RPC
  // transferencia_cuentas.
  const [transfModal, setTransfModal] = useState(false);
  const [transfForm, setTransfForm] = useState({fecha:toISO(today),origen:"",destino:"",monto:"",detalle:""});
  const [transfSaving, setTransfSaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const necesitaSelectorLocal = lidImplicito == null && locsDisp.length > 1;

  const load = async () => {
    setLoading(true);
    let q = db.from("movimientos").select("*").order("fecha", {ascending: false}).order("id", {ascending: false}).limit(80);
    q = applyLocalScope(q, user, localActivo);
    // Defense-in-depth: si el usuario tiene cuentas restringidas, no traemos
    // movimientos de cuentas ajenas ni saldos de cuentas ajenas.
    if (vis !== null) {
      if (vis.length === 0) {
        q = q.eq("cuenta", "___NONE___"); // match imposible → 0 filas
      } else {
        q = q.in("cuenta", vis);
      }
    }
    let sq = db.from("saldos_caja").select("*");
    sq = applyLocalScope(sq, user, localActivo);
    if (vis !== null) {
      if (vis.length === 0) {
        sq = sq.eq("cuenta", "___NONE___");
      } else {
        sq = sq.in("cuenta", vis);
      }
    }
    const [{data:m},{data:s}] = await Promise.all([q, sq]);
    setMovimientos((m as Movimiento[]) || []);
    // Si no hay localActivo, se agregan saldos de todos los locales por cuenta
    const obj: Record<string, number> = {};
    (s||[]).forEach(x=> { obj[x.cuenta] = (obj[x.cuenta]||0) + (x.saldo||0); });
    setSaldos(obj);
    setLoading(false);
  };
  // Patrón fetch-on-dep-change.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{load();},[localActivo]);

  // Carga el auditoría log cuando el usuario clickea "Ver edición" en
  // un movimiento. setAuditLog es derivada del detalleEdicion.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
        setAuditLog(log ? (JSON.parse(log.detalle) as AuditDetalle) : null);
      });
  }, [detalleEdicion]);

  const mFilt = movimientos
    .filter(m => filtCuenta === "Todas" || m.cuenta === filtCuenta)
    .filter(m => mostrarAnulados ? true : !m.anulado);

  const guardar = async () => {
    if (saving) return;
    if(!form.importe) return;
    const lid = lidImplicito != null ? lidImplicito : parseInt(localFormId);
    if (!Number.isFinite(lid)) return;
    const importe = parseFloat(form.importe)*(form.esEgreso?-1:1);
    // Tipo derivado de cat + dirección (ver deriveTipoMov). Ej: cat="ALQUILER"
    // con dirección egreso → "Gasto fijo". cat="Liquidación Rappi" con
    // ingreso → "Liquidación Plataforma".
    const tipoEfectivo = deriveTipoMov(form.cat, form.esEgreso);
    setSaving(true);
    try {
      const { error } = await db.rpc("crear_movimiento_caja", {
        p_fecha: form.fecha,
        p_cuenta: form.cuenta,
        p_tipo: tipoEfectivo,
        p_cat: form.cat || null,
        p_importe: importe,
        p_detalle: form.detalle || tipoEfectivo,
        p_local_id: lid,
      });
      if (error) { alert(translateRpcError(error)); return; }
      setModal(false);
      setForm({...emptyForm, fecha: toISO(today)});
      load();
    } finally {
      setSaving(false);
    }
  };

  const guardarTransferencia = async () => {
    const lid = lidImplicito != null ? lidImplicito : parseInt(localFormId);
    if (!Number.isFinite(lid)) { alert("Elegí un local"); return; }
    if (!transfForm.origen || !transfForm.destino) { alert("Elegí cuenta origen y destino"); return; }
    if (transfForm.origen === transfForm.destino) { alert("Las cuentas deben ser distintas"); return; }
    const monto = parseFloat(transfForm.monto);
    if (!Number.isFinite(monto) || monto <= 0) { alert("Monto inválido"); return; }
    setTransfSaving(true);
    try {
      const { error } = await db.rpc("transferencia_cuentas", {
        p_local_id: lid,
        p_cuenta_origen: transfForm.origen,
        p_cuenta_destino: transfForm.destino,
        p_monto: monto,
        p_fecha: transfForm.fecha,
        p_detalle: transfForm.detalle || null,
      });
      if (error) { alert(translateRpcError(error)); return; }
      setTransfModal(false);
      setTransfForm({fecha:toISO(today),origen:"",destino:"",monto:"",detalle:""});
      load();
    } finally {
      setTransfSaving(false);
    }
  };

  const eliminarMov = async (m: Movimiento) => {
    const motivo = prompt("¿Por qué anulás este movimiento? (obligatorio)");
    if (!motivo?.trim()) return;
    const { error } = await db.rpc("anular_movimiento", {
      p_mov_id: m.id,
      p_motivo: motivo,
    });
    if (error) { alert(translateRpcError(error)); return; }
    load();
  };

  const guardarEditMov = async () => {
    if (savingEdit) return;
    if (!editMov) return;
    if (!editMov.justificativo?.trim()) { alert("El justificativo es obligatorio"); return; }
    const original = movimientos.find(m => m.id === editMov.id);
    const lid = editMov.local_id;
    setSavingEdit(true);
    try {
      if (original && lid && (original.importe !== parseFloat(String(editMov.importe)) || original.cuenta !== editMov.cuenta)) {
        const { data: cajaOrig } = await db.from("saldos_caja").select("saldo")
          .eq("cuenta", original.cuenta).eq("local_id", lid).maybeSingle();
        if (cajaOrig) await db.from("saldos_caja")
          .update({ saldo: (cajaOrig.saldo || 0) - (original.importe || 0) })
          .eq("cuenta", original.cuenta).eq("local_id", lid);

        const { data: cajaNueva } = await db.from("saldos_caja").select("saldo")
          .eq("cuenta", editMov.cuenta).eq("local_id", lid).maybeSingle();
        if (cajaNueva) await db.from("saldos_caja")
          .update({ saldo: (cajaNueva.saldo || 0) + (parseFloat(String(editMov.importe)) || 0) })
          .eq("cuenta", editMov.cuenta).eq("local_id", lid);
      }

      // Si el signo o la categoría cambiaron, recalcular tipo usando
      // deriveTipoMov(cat, esEgreso). Así un movimiento que pasa de egreso
      // a ingreso con cat="Liquidación Rappi" queda como "Liquidación
      // Plataforma" y no como tipo viejo incoherente.
      const nuevoImporte = parseFloat(String(editMov.importe)) || original?.importe || 0;
      const signoOriginal = (original?.importe || 0) >= 0 ? 1 : -1;
      const signoNuevo = nuevoImporte >= 0 ? 1 : -1;
      const cambioSigno = signoOriginal !== signoNuevo;
      const catCambio = editMov.cat !== original?.cat;
      const tipoNuevo = (cambioSigno || catCambio)
        ? deriveTipoMov(editMov.cat || "", signoNuevo < 0)
        : original?.tipo;

      await db.from("movimientos").update({
        fecha: editMov.fecha,
        detalle: editMov.detalle,
        cat: editMov.cat || null,
        importe: nuevoImporte,
        cuenta: editMov.cuenta,
        tipo: tipoNuevo,
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
    } finally {
      setSavingEdit(false);
    }
  };

  const cc = (c: string) => c==="Caja Chica"?"var(--acc)":c==="Caja Mayor"?"var(--acc2)":c==="MercadoPago"?"var(--acc3)":"var(--info)";

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Tesorería</div></div>
        <div style={{display:"flex",gap:8}}>
          <button className="btn btn-sec" onClick={()=>setTransfModal(true)} disabled={cuentasVisibles.length<2}>↔ Transferir</button>
          <button className="btn btn-acc" onClick={abrirNuevoMovimiento}>+ Movimiento</button>
        </div>
      </div>
      {cuentasVisibles.length === 0 ? (
        <div className="empty" style={{padding:24,marginBottom:16}}>No tenés cuentas asignadas. Pedile a un administrador que te habilite.</div>
      ) : (
        <div className="grid4">
          {cuentasVisibles.filter(k=>k!=="MercadoPago").map(k=>(
            <div key={k} className={`caja-card caja-${k==="Caja Chica"?"chica":k==="Caja Mayor"?"mayor":"banco"}`}>
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
                  <span className="badge b-danger" style={{fontSize:8}} title={m.anulado_motivo ?? undefined}>Anulado</span>
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
                    {((parseFloat(String(editMov.importe)) || 0) < 0 ? catsEgreso : catsIngreso).map(c => <option key={c}>{c}</option>)}
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
              <button className="btn btn-acc" onClick={guardarEditMov} disabled={savingEdit}>{savingEdit ? "Guardando..." : "Guardar"}</button>
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
                    {auditLog.antes && Object.entries(auditLog.antes).map(([k, v]) => (
                      <div key={k} style={{fontSize:11,marginBottom:4}}>
                        <span style={{color:"var(--muted2)"}}>{k}:</span> <span style={{color:"var(--danger)"}}>{String(v??'—')}</span>
                      </div>
                    ))}
                  </div>
                  <div>
                    <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:1,color:"var(--muted)",marginBottom:8}}>Después</div>
                    {auditLog.despues && Object.entries(auditLog.despues).map(([k, v]) => (
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
                    {locsDisp.map((l: Local)=><option key={l.id} value={l.id}>{l.nombre}</option>)}
                  </select>
                </div>
              )}
              <div className="form2">
                <div className="field"><label>Cuenta</label><select value={form.cuenta} onChange={e=>setForm({...form,cuenta:e.target.value})}>{cuentasVisibles.map(c=><option key={c}>{c}</option>)}</select></div>
                <div className="field"><label>Dirección</label><select value={form.esEgreso?"egreso":"ingreso"} onChange={e=>setForm({...form,esEgreso:e.target.value==="egreso"})}><option value="egreso">Egreso (sale plata)</option><option value="ingreso">Ingreso (entra plata)</option></select></div>
              </div>
              <div className="form2">
                <div className="field">
                  <label>Categoría</label>
                  <select value={form.cat} onChange={e=>setForm({...form,cat:e.target.value})}>
                    <option value="">{form.esEgreso ? "Sin categoría" : "— elegí una categoría"}</option>
                    {(form.esEgreso ? catsEgreso : catsIngreso).map(c=><option key={c}>{c}</option>)}
                  </select>
                </div>
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
              </div>
              <div className="field"><label>Importe $</label><input type="number" value={form.importe} onChange={e=>setForm({...form,importe:e.target.value})} placeholder="0"/></div>
              <div className="field"><label>Detalle</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Descripción..."/></div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setModal(false)}>Cancelar</button><button className="btn btn-acc" onClick={guardar} disabled={saving || !form.importe || (necesitaSelectorLocal && !localFormId)}>{saving ? "Guardando..." : "Guardar"}</button></div>
          </div>
        </div>
      )}
      {transfModal && (
        <div className="overlay" onClick={()=>setTransfModal(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Transferir entre cuentas</div><button className="close-btn" onClick={()=>setTransfModal(false)}>✕</button></div>
            <div className="modal-body">
              {necesitaSelectorLocal && (
                <div className="field">
                  <label>Local *</label>
                  <select value={localFormId} onChange={e=>setLocalFormId(e.target.value)} required>
                    <option value="">Seleccioná el local...</option>
                    {locsDisp.map((l: Local)=><option key={l.id} value={l.id}>{l.nombre}</option>)}
                  </select>
                </div>
              )}
              <div className="form2">
                <div className="field"><label>Cuenta origen</label><select value={transfForm.origen} onChange={e=>setTransfForm({...transfForm,origen:e.target.value})}><option value="">— elegí cuenta —</option>{cuentasVisibles.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
                <div className="field"><label>Cuenta destino</label><select value={transfForm.destino} onChange={e=>setTransfForm({...transfForm,destino:e.target.value})}><option value="">— elegí cuenta —</option>{cuentasVisibles.filter(c=>c!==transfForm.origen).map(c=><option key={c} value={c}>{c}</option>)}</select></div>
              </div>
              <div className="form2">
                <div className="field"><label>Monto $</label><input type="number" value={transfForm.monto} onChange={e=>setTransfForm({...transfForm,monto:e.target.value})} placeholder="0"/></div>
                <div className="field"><label>Fecha</label><input type="date" value={transfForm.fecha} onChange={e=>setTransfForm({...transfForm,fecha:e.target.value})}/></div>
              </div>
              <div className="field"><label>Detalle (opcional)</label><input value={transfForm.detalle} onChange={e=>setTransfForm({...transfForm,detalle:e.target.value})} placeholder="Motivo de la transferencia..."/></div>
              <div style={{fontSize:11,color:"var(--muted)",marginTop:8}}>Genera 2 movimientos: egreso en <b>{transfForm.origen||"origen"}</b> e ingreso en <b>{transfForm.destino||"destino"}</b>. No afecta el saldo total.</div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setTransfModal(false)} disabled={transfSaving}>Cancelar</button><button className="btn btn-acc" onClick={guardarTransferencia} disabled={transfSaving || !transfForm.origen || !transfForm.destino || transfForm.origen===transfForm.destino || !transfForm.monto || (necesitaSelectorLocal && !localFormId)}>{transfSaving?"Transfiriendo…":"Transferir"}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
