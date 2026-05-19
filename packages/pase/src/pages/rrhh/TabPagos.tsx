import { db } from "../../lib/supabase";
import { translateRpcError } from "../../lib/errors";
import { toISO, today, fmt_d, fmt_$, parseMonto } from "../../lib/utils";
import type { Local } from "../../types";
import type {
  Empleado, Novedad, Liquidacion, Adelanto, LineaPago,
} from "../../types/rrhh";
import type { PagoDataRow, LiquidacionConGenerated, AdelantoForm } from "./types";
import { MESES_SEL } from "./helpers";

interface TabPagosProps {
  pagoMes: number;
  setPagoMes: React.Dispatch<React.SetStateAction<number>>;
  pagoAnio: number;
  setPagoAnio: React.Dispatch<React.SetStateAction<number>>;
  pagoLocal: string | number;
  setPagoLocal: (v: string) => void;
  locsDisp: Local[];
  esEnc: boolean;
  esDueno: boolean;
  pagoLoading: boolean;
  pagoData: PagoDataRow[];
  totalPagosPend: number;
  totalGeneral: number;
  pagoModal: PagoDataRow | null;
  setPagoModal: React.Dispatch<React.SetStateAction<PagoDataRow | null>>;
  formasPago: LineaPago[];
  setFormasPago: React.Dispatch<React.SetStateAction<LineaPago[]>>;
  pagando: boolean;
  setPagando: React.Dispatch<React.SetStateAction<boolean>>;
  loadPagos: () => Promise<void>;
  loadEmpleados: () => Promise<void>;
  showToast: (m: string) => void;
  allEmps: Empleado[];
  adelModal: boolean;
  setAdelModal: React.Dispatch<React.SetStateAction<boolean>>;
  adelForm: AdelantoForm;
  setAdelForm: React.Dispatch<React.SetStateAction<AdelantoForm>>;
  guardarAdelanto: () => Promise<void | undefined>;
  guardandoAdelanto: boolean;
  adelantosPendientes: Adelanto[];
  setAdelantosPendientes: React.Dispatch<React.SetStateAction<Adelanto[]>>;
  abrirPagoSueldo: (emp: Empleado, nov: Novedad, liq: LiquidacionConGenerated) => Promise<void>;
  cuentasUsables: string[];
  idempKeyPagarSueldo: string;
}

export function TabPagos({
  pagoMes, setPagoMes, pagoAnio, setPagoAnio, pagoLocal, setPagoLocal,
  locsDisp, esEnc, esDueno, pagoLoading, pagoData,
  totalPagosPend, totalGeneral,
  pagoModal, setPagoModal, formasPago, setFormasPago,
  pagando, setPagando, loadPagos, loadEmpleados, showToast,
  allEmps, adelModal, setAdelModal, adelForm, setAdelForm, guardarAdelanto, guardandoAdelanto,
  adelantosPendientes, setAdelantosPendientes, abrirPagoSueldo,
  cuentasUsables, idempKeyPagarSueldo,
}: TabPagosProps) {
  return (
    <>
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <select className="search" style={{width:100}} value={pagoMes} onChange={e => setPagoMes(parseInt(e.target.value))}>
          {MESES_SEL.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
        </select>
        <input type="number" className="search" style={{width:70}} value={pagoAnio} onChange={e => setPagoAnio(parseInt(e.target.value))} />
        <select className="search" style={{width:160}} value={String(pagoLocal || "")} onChange={e => setPagoLocal(e.target.value)}>
          {!esEnc && <option value="">Seleccionar local...</option>}
          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
        <div style={{flex:1}} />
        {totalPagosPend > 0 && <span style={{fontSize:11,color:"var(--muted2)"}}>{totalPagosPend} pendiente{totalPagosPend > 1 ? "s" : ""}</span>}
        {esDueno && <button className="btn btn-sec btn-sm" onClick={() => setAdelModal(true)}>+ Adelanto</button>}
      </div>

      {!pagoLocal ? <div className="alert alert-info">Seleccioná un local</div> :
       pagoLoading ? <div className="loading">Cargando...</div> :
       pagoData.length === 0 ? <div className="alert alert-warn">Confirmá las novedades primero en el tab Novedades</div> : (<>
        <div className="panel">
          <div style={{overflowX:"auto"}}>
          <table>
            <thead><tr><th>Empleado</th><th>Puesto</th><th style={{textAlign:"right"}}>Total</th><th>CBU / Alias</th><th>Estado</th><th></th></tr></thead>
            <tbody>{pagoData.map(row => {
              const { emp, nov, liq } = row;
              if (!liq) return null;
              const pagado = liq.estado === "pagado";
              const yaPagado = Number(liq.pagos_realizados || 0);
              const total = Number(liq.total_a_pagar || 0);
              const pendiente = Math.max(0, Math.round(total) - Math.round(yaPagado));
              const esParcial = !pagado && yaPagado > 0;
              const pct = total > 0 ? Math.round((yaPagado / total) * 100) : 0;
              return (
                <tr key={emp.id}>
                  <td style={{fontWeight:500,fontSize:12}}>{emp.apellido}, {emp.nombre}</td>
                  <td><span className="badge b-muted" style={{fontSize:8}}>{emp.puesto}</span></td>
                  <td style={{textAlign:"right"}}><span className="num" style={{color:"var(--acc)"}}>{fmt_$(total)}</span></td>
                  <td className="mono" style={{fontSize:10,color:"var(--muted2)"}}>{emp.alias_mp || "—"}</td>
                  <td>
                    {pagado
                      ? <span className="badge b-success">{fmt_d(liq.pagado_at?.split("T")[0])}</span>
                      : esParcial
                        ? <span className="badge b-info" title={`Pagado ${fmt_$(yaPagado)} de ${fmt_$(total)}`}>Parcial · {pct}%</span>
                        : <span className="badge b-warn">Pendiente</span>}
                    {esParcial && (
                      <div style={{fontSize:9,color:"var(--muted2)",marginTop:3}}>
                        {fmt_$(yaPagado)} de {fmt_$(total)} · Resta {fmt_$(pendiente)}
                      </div>
                    )}
                  </td>
                  <td>
                    {esDueno && !pagado && (
                      <button className="btn btn-success btn-sm" onClick={() => abrirPagoSueldo(emp, nov, liq)}>Pagar</button>
                    )}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
          </div>
          <div style={{padding:"12px 16px",borderTop:"1px solid var(--bd)",display:"flex",justifyContent:"flex-end",fontSize:12}}>
            <span>Total mes: <strong style={{color:"var(--success)"}}>{fmt_$(totalGeneral)}</strong></span>
          </div>
        </div>
      </>)}

      {pagoModal && (() => {
        const { emp, nov, liq } = pagoModal;
        const total = Math.round(Number(liq.total_a_pagar || 0));
        const yaPagado = Math.round(Number(liq.pagos_realizados || 0));
        const pendiente = Math.max(0, total - yaPagado);
        const totalAdelantos = Math.round((adelantosPendientes || []).reduce((s, a) => s + Number(a.monto), 0));
        const asignadoCash = Math.round(formasPago.reduce((s, f) => s + parseMonto(f.monto), 0));
        const asignadoTotal = asignadoCash + totalAdelantos;
        const restanteTrasEste = pendiente - asignadoTotal;
        const completaPago = asignadoTotal >= pendiente;
        const esPagoParcial = asignadoTotal > 0 && asignadoTotal < pendiente;
        const sobrepago = asignadoTotal > pendiente ? asignadoTotal - pendiente : 0;
        // Validación por línea + diagnóstico claro de por qué el botón está
        // deshabilitado. Tolerancia ±$1 por redondeos de decimales.
        // Bug Caja-1: cada línea debe tener cuenta seleccionada.
        const lineaSinCuenta = formasPago.findIndex(f => parseMonto(f.monto) > 0 && !f.cuenta);
        const lineaSinMonto = formasPago.findIndex(f => f.cuenta && parseMonto(f.monto) <= 0);
        const puedeConfirmar = asignadoTotal > 0
          && sobrepago <= 1   // tolerancia de redondeo
          && lineaSinCuenta === -1
          && lineaSinMonto === -1;

        let motivoBloqueo: string | null = null;
        if (asignadoTotal === 0) motivoBloqueo = 'Asigná un monto en alguna línea para confirmar.';
        else if (lineaSinCuenta !== -1) motivoBloqueo = `Línea ${lineaSinCuenta + 1}: falta elegir cuenta.`;
        else if (lineaSinMonto !== -1) motivoBloqueo = `Línea ${lineaSinMonto + 1}: falta el monto.`;
        else if (sobrepago > 1) motivoBloqueo = `Te pasaste $${sobrepago.toLocaleString('es-AR')} del total. Bajá algún monto.`;
        const cerrarModal = () => { setPagoModal(null); setFormasPago([]); setAdelantosPendientes([]); };

        const confirmarPago = async () => {
          if (!puedeConfirmar || pagando) return;
          setPagando(true);
          try {
            // Serializar las formas de pago (sólo las con monto > 0).
            const formasValidas = formasPago
              .filter(fp => parseMonto(fp.monto) > 0 && !!fp.cuenta)
              .map(fp => ({ cuenta: fp.cuenta, monto: parseMonto(fp.monto) }));
            const adelIds = (adelantosPendientes || []).map(a => a.id);

            // Si la liq vino _generated (frontend la armó sin persistir),
            // la RPC la crea on-the-fly con p_crear_liq + p_calc.
            let pCalc: Partial<Liquidacion> | null = null;
            if (liq._generated) {
              const { _novedadId, _generated, id: _ignoreId, pagos_realizados: _ignorePag, ...calcFields } = liq;
              pCalc = calcFields;
            }

            const { data, error } = await db.rpc("pagar_sueldo", {
              p_nov_id: nov.id,
              p_formas_pago: formasValidas,
              p_adelantos_ids: adelIds,
              p_fecha: toISO(today),
              p_mes: pagoMes,
              p_anio: pagoAnio,
              p_crear_liq: !!liq._generated,
              p_calc: pCalc,
              p_idempotency_key: idempKeyPagarSueldo,
            });
            if (error) throw error;

            // RPC pagar_sueldo devuelve { completa: boolean, ... }. Tipo
            // estrecho para no usar `any` y validar la propiedad antes de
            // acceder.
            const ok = (data && typeof data === "object" && "completa" in data && data.completa === true);
            if (ok) {
              showToast("Pago completado");
            } else {
              showToast(`Pago parcial registrado — Resta ${fmt_$(restanteTrasEste)}`);
            }
            cerrarModal();
            await loadPagos();
            await loadEmpleados();
          } catch (err) {
            alert(translateRpcError(err as Parameters<typeof translateRpcError>[0]));
          } finally {
            setPagando(false);
          }
        };

        return (
          <div className="overlay" onClick={cerrarModal}>
            <div className="modal" style={{width:480}} onClick={e => e.stopPropagation()}>
              <div className="modal-hd">
                <div className="modal-title">Pagar — {emp.apellido}, {emp.nombre}</div>
                <button className="close-btn" onClick={cerrarModal}>✕</button>
              </div>
              <div className="modal-body">
                <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",marginBottom:yaPagado>0?8:16,borderBottom:"1px solid var(--bd)"}}>
                  <span style={{fontSize:12,color:"var(--muted2)"}}>Total a pagar</span>
                  <span style={{fontSize:16,fontWeight:500,color:"var(--acc)"}}>{fmt_$(total)}</span>
                </div>

                {yaPagado > 0 && (
                  <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",marginBottom:12,fontSize:12}}>
                    <span style={{color:"var(--muted2)"}}>Ya pagado (parcial previo)</span>
                    <span style={{color:"var(--info)"}}>{fmt_$(yaPagado)} — Pendiente: <strong>{fmt_$(pendiente)}</strong></span>
                  </div>
                )}

                {totalAdelantos > 0 && (
                  <div style={{background:"var(--s2)",borderRadius:"var(--r)",padding:12,marginBottom:12}}>
                    <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Adelantos a descontar</div>
                    {adelantosPendientes.map(a => (
                      <div key={a.id} style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:4}}>
                        <span style={{color:"var(--muted2)"}}>{fmt_d(a.fecha)} · {a.cuenta || "—"}</span>
                        <span style={{color:"var(--danger)"}}>−{fmt_$(a.monto)}</span>
                      </div>
                    ))}
                    <div style={{display:"flex",justifyContent:"space-between",marginTop:6,paddingTop:8,borderTop:"1px solid var(--bd)",fontSize:12,fontWeight:500}}>
                      <span>Total adelantos</span>
                      <span style={{color:"var(--danger)"}}>−{fmt_$(totalAdelantos)}</span>
                    </div>
                    <div style={{fontSize:10,color:"var(--muted2)",marginTop:4}}>
                      Ya salieron de caja al registrarse. Se marcarán como descontados al confirmar.
                    </div>
                  </div>
                )}

                {formasPago.map((fp, i) => (
                  <div key={i} style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
                    <select className="search" style={{flex:1}} value={fp.cuenta}
                      onChange={e => setFormasPago(prev => prev.map((f, j) => j === i ? { ...f, cuenta: e.target.value } : f))}>
                      <option value="">Seleccioná una cuenta…</option>
                      {cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <input type="number" className="search" style={{width:120}} placeholder="Monto" value={fp.monto}
                      onChange={e => setFormasPago(prev => prev.map((f, j) => j === i ? { ...f, monto: e.target.value } : f))} />
                    <button className="btn btn-danger btn-sm" onClick={() => setFormasPago(prev => prev.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}

                <button className="btn btn-ghost btn-sm" style={{marginBottom:16}}
                  onClick={() => setFormasPago(prev => [...prev, { cuenta: "", monto: restanteTrasEste > 0 ? String(restanteTrasEste) : "" }])}>
                  + Agregar forma de pago
                </button>

                {totalAdelantos > 0 && (
                  <>
                    <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:11}}>
                      <span style={{color:"var(--muted2)"}}>Efectivo en caja</span>
                      <span style={{color:"var(--txt)"}}>{fmt_$(asignadoCash)}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:11}}>
                      <span style={{color:"var(--muted2)"}}>+ Adelantos a imputar</span>
                      <span style={{color:"var(--txt)"}}>{fmt_$(totalAdelantos)}</span>
                    </div>
                  </>
                )}

                <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:"1px solid var(--bd)"}}>
                  <span style={{fontSize:12,color: sobrepago > 0 ? "var(--danger)" : esPagoParcial ? "var(--warn)" : "var(--muted2)"}}>
                    {sobrepago > 0 ? "Sobrepago" : esPagoParcial ? "Pago parcial — Restante" : "Restante"}
                  </span>
                  <span style={{fontSize:14,fontWeight:500,color: sobrepago > 0 ? "var(--danger)" : Math.abs(restanteTrasEste) < 1 ? "var(--success)" : "var(--warn)"}}>
                    {sobrepago > 0 ? `+${fmt_$(sobrepago)}` : fmt_$(Math.max(0, restanteTrasEste))}
                  </span>
                </div>
                {motivoBloqueo && (
                  <div style={{
                    marginTop:8, padding:"8px 10px",
                    background:"rgba(217,119,6,0.08)",
                    border:"1px solid rgba(217,119,6,0.25)",
                    borderRadius:"var(--r)",
                    fontSize:11, color:"var(--warn)",
                  }}>
                    ⚠ {motivoBloqueo}
                  </div>
                )}
              </div>
              <div className="modal-ft">
                <button className="btn btn-sec" onClick={cerrarModal}>Cancelar</button>
                <button
                  className="btn btn-success"
                  onClick={confirmarPago}
                  disabled={!puedeConfirmar || pagando}
                  title={motivoBloqueo ?? undefined}
                >
                  {pagando ? "Procesando..." : completaPago ? "Confirmar pago" : "Registrar pago parcial"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal de adelanto extraído a packages/pase/src/pages/rrhh/AdelantoModal.tsx
          y renderizado desde RRHH.tsx para que esté disponible en cualquier tab. */}
    </>
  );
}
