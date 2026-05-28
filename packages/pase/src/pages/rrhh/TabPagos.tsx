import { db } from "../../lib/supabase";
import { translateRpcError } from "../../lib/errors";
import { toISO, today, fmt_d, fmt_$, parseMonto } from "../../lib/utils";
import { Modal } from "../../components/ui";
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
  /** Fecha del movimiento de pago (editable en el modal). Default: today. */
  fechaPago: string;
  setFechaPago: React.Dispatch<React.SetStateAction<string>>;
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
  fechaPago, setFechaPago,
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
            <thead><tr><th>Empleado</th><th>Puesto</th><th>Cuota</th><th style={{textAlign:"right"}}>Total</th><th>CBU / Alias</th><th>Estado</th><th></th></tr></thead>
            <tbody>{pagoData.map(row => {
              const { emp, nov, liq } = row;
              if (!liq) return null;
              const pagado = liq.estado === "pagado";
              const yaPagado = Number(liq.pagos_realizados || 0);
              const total = Number(liq.total_a_pagar || 0);
              const pendiente = Math.max(0, Math.round(total) - Math.round(yaPagado));
              const esParcial = !pagado && yaPagado > 0;
              const pct = total > 0 ? Math.round((yaPagado / total) * 100) : 0;
              const cuotaN = liq.cuota_num ?? 1;
              const cuotasT = liq.cuotas_total ?? 1;
              const esMultiCuota = cuotasT > 1;
              // key estable: si la liq está persistida usa su id, si está
              // generada usa (emp.id, cuota_num) para que el remap por cuota
              // dentro de un mismo empleado tenga keys únicas.
              const rowKey = liq.id ?? `${emp.id}-${cuotaN}`;
              return (
                <tr key={rowKey}>
                  <td style={{fontWeight:500,fontSize:12}}>{emp.apellido}, {emp.nombre}</td>
                  <td><span className="badge b-muted" style={{fontSize:8}}>{emp.puesto}</span></td>
                  <td style={{fontSize:10}}>
                    {esMultiCuota ? (
                      <>
                        <span className="badge b-info">{cuotaN}/{cuotasT}</span>
                        {liq.fecha_vencimiento && (
                          <div style={{fontSize:9,color:"var(--muted2)",marginTop:2}}>
                            vence {fmt_d(liq.fecha_vencimiento)}
                          </div>
                        )}
                      </>
                    ) : <span style={{color:"var(--muted2)"}}>—</span>}
                  </td>
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
        // Validación por línea. Bug Caja-1: cada línea debe tener cuenta.
        // Sobrepago permitido (Lucas 2026-05-19): si no hay cambio justo
        // se acepta pagar de más sin acumular saldo a favor ni deuda.
        // El exceso sale de caja como verdad pero no queda registrado en
        // la liquidación. Solo mostramos warning + pedimos confirmación.
        const lineaSinCuenta = formasPago.findIndex(f => parseMonto(f.monto) > 0 && !f.cuenta);
        const lineaSinMonto = formasPago.findIndex(f => f.cuenta && parseMonto(f.monto) <= 0);
        const puedeConfirmar = asignadoTotal > 0
          && lineaSinCuenta === -1
          && lineaSinMonto === -1;

        let motivoBloqueo: string | null = null;
        if (asignadoTotal === 0) motivoBloqueo = 'Asigná un monto en alguna línea para confirmar.';
        else if (lineaSinCuenta !== -1) motivoBloqueo = `Línea ${lineaSinCuenta + 1}: falta elegir cuenta.`;
        else if (lineaSinMonto !== -1) motivoBloqueo = `Línea ${lineaSinMonto + 1}: falta el monto.`;
        const cerrarModal = () => { setPagoModal(null); setFormasPago([]); setAdelantosPendientes([]); };

        const confirmarPago = async () => {
          if (!puedeConfirmar || pagando) return;
          // Sobrepago > $1 (toleramos $1 de redondeo): pedimos confirmación
          // explícita. Lucas 2026-05-19: que pase pero quede claro que el
          // exceso es absorbido (no acumula saldo ni deuda).
          if (sobrepago > 1) {
            const ok = window.confirm(
              `Vas a pagar $${sobrepago.toLocaleString('es-AR')} de MÁS sobre lo adeudado.\n\n` +
              `El sueldo queda registrado como pagado completo. Los $${sobrepago.toLocaleString('es-AR')} extra salen de caja real (refleja el efectivo) pero NO se acumulan como saldo a favor del empleado ni como deuda.\n\n` +
              `¿Confirmar pago con sobrepago?`,
            );
            if (!ok) return;
          }
          setPagando(true);
          try {
            // Serializar las formas de pago (sólo las con monto > 0).
            // local_id por línea (2026-05-20): si la línea trae uno, lo
            // pasamos; si no, omitimos el campo y la RPC usa el local
            // principal del empleado.
            const formasValidas = formasPago
              .filter(fp => parseMonto(fp.monto) > 0 && !!fp.cuenta)
              .map(fp => {
                const base: { cuenta: string; monto: number; local_id?: number } = {
                  cuenta: fp.cuenta,
                  monto: parseMonto(fp.monto),
                };
                if (fp.local_id != null) base.local_id = fp.local_id;
                return base;
              });
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
              // Fecha editable desde el modal (default today). Permite a
              // Anto registrar pagos atrasados con la fecha real en la que
              // salió la plata (ej. pago de sueldo de Abril hecho en Mayo).
              p_fecha: fechaPago || toISO(today),
              p_mes: pagoMes,
              p_anio: pagoAnio,
              p_crear_liq: !!liq._generated,
              p_calc: pCalc,
              p_idempotency_key: idempKeyPagarSueldo,
              // Multi-cuota: si la liq está persistida (no _generated),
              // mandamos su id para que la RPC pague esa cuota específica.
              // Para _generated (legacy mensual on-the-fly) queda null y
              // la RPC la crea o la busca por novedad_id.
              p_liq_id: liq._generated ? null : (liq.id ?? null),
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

        // AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido.
        const tituloModal = (liq.cuotas_total ?? 1) > 1
          ? `Pagar — ${emp.apellido}, ${emp.nombre}`
          : `Pagar — ${emp.apellido}, ${emp.nombre}`;
        const subtituloModal = (liq.cuotas_total ?? 1) > 1
          ? `Cuota ${liq.cuota_num}/${liq.cuotas_total}${liq.fecha_vencimiento ? ` · vence ${fmt_d(liq.fecha_vencimiento)}` : ''}`
          : undefined;
        return (
          <Modal
            isOpen={true}
            onClose={cerrarModal}
            title={tituloModal}
            subtitle={subtituloModal}
            maxWidth={480}
            preventCloseOnOverlay={pagando}
            footer={
              <>
                <button className="btn btn-sec" onClick={cerrarModal}>Cancelar</button>
                <button
                  className="btn btn-success"
                  onClick={confirmarPago}
                  disabled={!puedeConfirmar || pagando}
                  title={motivoBloqueo ?? undefined}
                >
                  {pagando
                    ? "Procesando..."
                    : sobrepago > 1
                      ? `Pagar con sobrepago (+${fmt_$(sobrepago)})`
                      : completaPago ? "Confirmar pago" : "Registrar pago parcial"}
                </button>
              </>
            }
          >
                <div className="field" style={{marginBottom:12}}>
                  <label>
                    <span>📅 Fecha del movimiento</span>
                  </label>
                  <input
                    type="date"
                    value={fechaPago}
                    onChange={(e) => setFechaPago(e.target.value)}
                    style={{width:"100%"}}
                  />
                  <div style={{fontSize:10,color:"var(--muted2)",marginTop:4,lineHeight:1.4}}>
                    Cuando realmente sale la plata de caja. Por default es hoy.
                    Cambialo si registrás un pago atrasado o adelantado.
                  </div>
                </div>
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

                {/* Líneas de pago: cada una con SU local + SU cuenta + SU monto.
                    Esto permite repartir un pago de sueldo entre varios locales
                    (ej. sueldo admin que se reparte entre VC + Belgrano + Devoto).
                    Default del local: el local principal del empleado. El usuario
                    lo puede cambiar para repartir. Lucas 2026-05-20. */}
                {formasPago.map((fp, i) => {
                  const localLinea = fp.local_id ?? emp.local_id ?? null;
                  const localEmp = emp.local_id ?? null;
                  const distinto = localLinea !== null && localEmp !== null && localLinea !== localEmp;
                  return (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <select
                          className="search"
                          style={{ width: 150 }}
                          value={localLinea ?? ""}
                          onChange={e => setFormasPago(prev => prev.map((f, j) =>
                            j === i ? { ...f, local_id: e.target.value ? Number(e.target.value) : null } : f
                          ))}
                          title="Local desde donde sale el dinero"
                        >
                          <option value="">Local…</option>
                          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                        </select>
                        <select
                          className="search"
                          style={{ flex: 1 }}
                          value={fp.cuenta}
                          onChange={e => setFormasPago(prev => prev.map((f, j) => j === i ? { ...f, cuenta: e.target.value } : f))}
                          title="Cuenta / caja de pago"
                        >
                          <option value="">Cuenta…</option>
                          {cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <input
                          type="number"
                          className="search"
                          style={{ width: 110 }}
                          placeholder="Monto"
                          value={fp.monto}
                          onChange={e => setFormasPago(prev => prev.map((f, j) => j === i ? { ...f, monto: e.target.value } : f))}
                        />
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => setFormasPago(prev => prev.filter((_, j) => j !== i))}
                          title="Quitar esta línea"
                        >✕</button>
                      </div>
                      {distinto && (
                        <div style={{ fontSize: 10, color: "var(--warn)", paddingLeft: 4, marginTop: 2 }}>
                          ⚠ Pago repartido — origen del empleado: {locsDisp.find(l => l.id === localEmp)?.nombre ?? "—"}
                        </div>
                      )}
                    </div>
                  );
                })}

                <button className="btn btn-ghost btn-sm" style={{marginBottom:16}}
                  onClick={() => setFormasPago(prev => [...prev, {
                    cuenta: "",
                    monto: restanteTrasEste > 0 ? String(restanteTrasEste) : "",
                    // La nueva línea hereda el local del empleado por default
                    local_id: emp.local_id ?? null,
                  }])}>
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
                  <span style={{fontSize:12,color: sobrepago > 1 ? "var(--warn)" : esPagoParcial ? "var(--warn)" : "var(--muted2)"}}>
                    {sobrepago > 1 ? "Sobrepago" : esPagoParcial ? "Pago parcial — Restante" : "Restante"}
                  </span>
                  <span style={{fontSize:14,fontWeight:500,color: sobrepago > 1 ? "var(--warn)" : Math.abs(restanteTrasEste) < 1 ? "var(--success)" : "var(--warn)"}}>
                    {sobrepago > 1 ? `+${fmt_$(sobrepago)}` : fmt_$(Math.max(0, restanteTrasEste))}
                  </span>
                </div>
                {sobrepago > 1 && (
                  <div style={{
                    marginTop:8, padding:"8px 10px",
                    background:"rgba(217,119,6,0.08)",
                    border:"1px solid rgba(217,119,6,0.25)",
                    borderRadius:"var(--r)",
                    fontSize:11, color:"var(--warn)",
                  }}>
                    ⚠ Vas a pagar {fmt_$(sobrepago)} de más. Sale de caja real,
                    el sueldo queda pagado completo. No se acumula como saldo a
                    favor ni como deuda.
                  </div>
                )}
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
          </Modal>
        );
      })()}

      {/* Modal de adelanto extraído a packages/pase/src/pages/rrhh/AdelantoModal.tsx
          y renderizado desde RRHH.tsx para que esté disponible en cualquier tab. */}
    </>
  );
}
