import { useState } from "react";
import { fmt_$ } from "../../lib/utils";
import type { Local } from "../../types";
import type { Empleado } from "../../types/rrhh";
import type { NovedadEditable } from "./types";
import { MESES_SEL, calcularValorDoble, calcLiquidacion, inp } from "./helpers";

// Rediseño 2026-05-14 (auditoría UX RRHH):
//   • Pasamos de tabla angosta de 9 columnas + scroll horizontal a una lista
//     de cards expandibles. Cada card muestra siempre lo importante (nombre,
//     puesto, sueldo base, estado, total) y al expandir aparecen los campos
//     editables + el desglose del cálculo en vivo.
//   • "OK" como label se renombró a "Confirmar". El botón "Confirmar todas"
//     solo aparece si hay ≥2 pendientes (antes era redundante con 1 solo
//     empleado pendiente).
//   • Botón "Ir a Pagos →" en el header lleva al tab Pagos con los mismos
//     filtros pre-cargados (UX: confirmás → pagás sin re-elegir filtros).
//   • Presentismo: dropdown "Tiene/No tiene" → checkbox "Mantiene (+5%)".
//   • Adelantos: se elimina el input numérico libre (era un "adelanto
//     fantasma" sin link a rrhh_adelantos). Ahora se muestra SOLO LECTURA
//     el monto real de adelantos descontado=false del mes (leído por
//     RRHH.tsx desde la tabla real). Si el dueño quiere agregar un adelanto,
//     usa el botón "+ Adelanto" del tab Pagos (que crea un movimiento real
//     en caja + adelanto en DB).
//   • Selector de período con flechas ← → además del select de mes/año.

interface TabNovedadesProps {
  novMes: number;
  setNovMes: React.Dispatch<React.SetStateAction<number>>;
  novAnio: number;
  setNovAnio: React.Dispatch<React.SetStateAction<number>>;
  novLocal: string | number;
  setNovLocal: (v: string) => void;
  locsDisp: Local[];
  novLoading: boolean;
  novEmps: Empleado[];
  novMap: Record<string, NovedadEditable>;
  novAdelantosPorEmp: Record<string, number>;
  updateNov: (empId: string, field: keyof NovedadEditable, value: string | number) => void;
  confirmarUno: (emp: Empleado) => Promise<void>;
  confirmarTodas: () => Promise<void>;
  editarNov: (empId: string) => Promise<void>;
  irAPagos: () => void;
  esDueno: boolean;
}

export function TabNovedades({
  novMes, setNovMes, novAnio, setNovAnio, novLocal, setNovLocal,
  locsDisp, novLoading, novEmps, novMap, novAdelantosPorEmp,
  updateNov, confirmarUno, confirmarTodas, editarNov, irAPagos, esDueno,
}: TabNovedadesProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (empId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(empId)) next.delete(empId);
      else next.add(empId);
      return next;
    });
  };

  const goPrevMonth = () => {
    if (novMes === 1) { setNovMes(12); setNovAnio(novAnio - 1); }
    else setNovMes(novMes - 1);
  };
  const goNextMonth = () => {
    if (novMes === 12) { setNovMes(1); setNovAnio(novAnio + 1); }
    else setNovMes(novMes + 1);
  };

  const totalEmps = novEmps.length;
  const confirmadas = novEmps.filter(e => novMap[e.id]?.estado === "confirmado").length;
  const pendientes = totalEmps - confirmadas;

  return (
    <>
      {/* Toolbar */}
      <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
        <button className="btn btn-ghost btn-sm" onClick={goPrevMonth} title="Mes anterior" style={{padding:"4px 10px"}}>←</button>
        <select className="search" style={{width:100}} value={novMes} onChange={e => setNovMes(parseInt(e.target.value))}>
          {MESES_SEL.map((m, i) => <option key={i} value={i+1}>{m}</option>)}
        </select>
        <input type="number" className="search" style={{width:70}} value={novAnio} onChange={e => setNovAnio(parseInt(e.target.value))} />
        <button className="btn btn-ghost btn-sm" onClick={goNextMonth} title="Mes siguiente" style={{padding:"4px 10px"}}>→</button>

        <div style={{width:1, height:24, background:"var(--bd)", margin:"0 8px"}} />

        <select className="search" style={{width:180}} value={String(novLocal || "")} onChange={e => setNovLocal(e.target.value)}>
          <option value="">Seleccionar local...</option>
          {locsDisp.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>

        <div style={{flex:1}} />

        {novLocal && totalEmps > 0 && (
          <>
            <span style={{fontSize:11, color:"var(--muted2)"}}>
              {totalEmps} empleado{totalEmps !== 1 ? "s" : ""} ·{" "}
              <span style={{color:"var(--success)"}}>{confirmadas} confirmad{confirmadas !== 1 ? "as" : "a"}</span>
              {pendientes > 0 && <> · <span style={{color:"var(--warn)"}}>{pendientes} pendiente{pendientes !== 1 ? "s" : ""}</span></>}
            </span>
            {esDueno && pendientes >= 2 && (
              <button className="btn btn-sec btn-sm" onClick={confirmarTodas}>
                Confirmar {pendientes} pendientes
              </button>
            )}
            {confirmadas > 0 && (
              <button className="btn btn-acc btn-sm" onClick={irAPagos}>
                Ir a Pagos →
              </button>
            )}
          </>
        )}
      </div>

      {/* Cuerpo */}
      {!novLocal ? <div className="alert alert-info">Seleccioná un local para cargar novedades</div> :
       novLoading ? <div className="loading">Cargando...</div> :
       novEmps.length === 0 ? <div className="empty">Sin empleados activos en este local</div> : (
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {novEmps.map(emp => (
            <EmpleadoCard
              key={emp.id}
              emp={emp}
              nov={novMap[emp.id] || {}}
              adelantosDelMes={novAdelantosPorEmp[emp.id] ?? 0}
              expanded={expanded.has(emp.id)}
              onToggle={() => toggleExpanded(emp.id)}
              updateNov={updateNov}
              confirmar={() => confirmarUno(emp)}
              editar={() => editarNov(emp.id)}
              irAPagos={irAPagos}
              esDueno={esDueno}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ─── Empleado Card ─────────────────────────────────────────────────────────

interface EmpleadoCardProps {
  emp: Empleado;
  nov: NovedadEditable;
  adelantosDelMes: number;
  expanded: boolean;
  onToggle: () => void;
  updateNov: (empId: string, field: keyof NovedadEditable, value: string | number) => void;
  confirmar: () => Promise<void>;
  editar: () => Promise<void>;
  irAPagos: () => void;
  esDueno: boolean;
}

function EmpleadoCard({ emp, nov, adelantosDelMes, expanded, onToggle, updateNov, confirmar, editar, irAPagos, esDueno }: EmpleadoCardProps) {
  const vd = calcularValorDoble(emp);
  const calc = calcLiquidacion(emp, nov, vd, adelantosDelMes);
  const total = calc.total_a_pagar;
  const confirmado = nov.estado === "confirmado";

  return (
    <div className="panel" style={{padding:0, overflow:"hidden"}}>
      {/* Header siempre visible */}
      <div
        onClick={onToggle}
        style={{
          display:"grid",
          gridTemplateColumns:"24px 1.5fr 1fr 110px 100px 120px",
          gap:12, padding:"12px 16px",
          cursor:"pointer", alignItems:"center",
          background: confirmado ? "var(--s2)" : "transparent",
        }}>
        <span style={{fontSize:11, color:"var(--muted)"}}>{expanded ? "▾" : "▸"}</span>
        <div>
          <div style={{fontWeight:500, fontSize:13}}>{emp.apellido}, {emp.nombre}</div>
          <div style={{fontSize:10, color:"var(--muted2)", marginTop:2}}>{emp.puesto}</div>
        </div>
        <div style={{fontSize:11}}>
          <div style={{color:"var(--muted)", fontSize:9, textTransform:"uppercase", letterSpacing:0.5}}>Sueldo base</div>
          <div className="num">{fmt_$(emp.sueldo_mensual)}</div>
        </div>
        <div>
          {confirmado
            ? <span className="badge b-success" style={{fontSize:10}}>Confirmado</span>
            : <span className="badge b-warn" style={{fontSize:10}}>Borrador</span>}
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{color:"var(--muted)", fontSize:9, textTransform:"uppercase", letterSpacing:0.5}}>Total</div>
          <div className="num" style={{fontSize:14, fontWeight:500, color: total < 0 ? "var(--danger)" : "var(--success)"}}>
            {fmt_$(total)}
          </div>
        </div>
        <div style={{display:"flex",justifyContent:"flex-end"}} onClick={e => e.stopPropagation()}>
          {confirmado
            ? <button className="btn btn-acc btn-sm" onClick={irAPagos}>Pagar →</button>
            : <button className="btn btn-acc btn-sm" onClick={confirmar}>Confirmar</button>}
        </div>
      </div>

      {/* Body expandido */}
      {expanded && (
        <div style={{
          display:"grid", gridTemplateColumns:"2fr 1fr", gap:24,
          padding:"16px 20px", borderTop:"1px solid var(--bd)",
        }}>
          {/* Columna izq: inputs */}
          <div>
            <div style={{display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:12, marginBottom:16}}>
              <Field label="Inasistencias (días)" hint="0 a 31">
                <input type="number" min="0" max="31" style={{...inp, width:"100%", textAlign:"left"}} disabled={confirmado}
                  value={nov.inasistencias ?? 0}
                  onChange={e => updateNov(emp.id, "inasistencias", Math.max(0, Math.min(31, parseFloat(e.target.value) || 0)))} />
              </Field>
              <Field label="Horas extras" hint="cantidad de horas">
                <input type="number" min="0" max="200" style={{...inp, width:"100%", textAlign:"left"}} disabled={confirmado}
                  value={nov.horas_extras ?? 0}
                  onChange={e => updateNov(emp.id, "horas_extras", Math.max(0, parseFloat(e.target.value) || 0))} />
              </Field>
              <Field label="Turnos dobles" hint="cantidad">
                <input type="number" min="0" max="31" style={{...inp, width:"100%", textAlign:"left"}} disabled={confirmado}
                  value={nov.dobles ?? 0}
                  onChange={e => updateNov(emp.id, "dobles", Math.max(0, parseFloat(e.target.value) || 0))} />
              </Field>
              <Field label="Feriados trabajados" hint="cantidad">
                <input type="number" min="0" max="31" style={{...inp, width:"100%", textAlign:"left"}} disabled={confirmado}
                  value={nov.feriados ?? 0}
                  onChange={e => updateNov(emp.id, "feriados", Math.max(0, parseFloat(e.target.value) || 0))} />
              </Field>
              <Field label="Adelantos del mes" hint="suma de los cargados en Pagos · solo lectura">
                <input type="text" style={{...inp, width:"100%", textAlign:"left", background:"var(--s3)", cursor:"not-allowed"}}
                  disabled value={fmt_$(adelantosDelMes)} readOnly />
              </Field>
              <Field label="Presentismo" hint="bono del 5% del subtotal">
                <label style={{
                  display:"flex", alignItems:"center", gap:8,
                  padding:"6px 8px", borderRadius:"var(--r)",
                  background:"var(--bg)", border:"1px solid var(--bd)",
                  cursor: confirmado ? "default" : "pointer",
                  opacity: confirmado ? 0.6 : 1,
                  fontSize:11,
                }}>
                  <input type="checkbox" disabled={confirmado}
                    checked={nov.presentismo === "MANTIENE"}
                    onChange={e => updateNov(emp.id, "presentismo", e.target.checked ? "MANTIENE" : "PIERDE")}
                    style={{accentColor:"var(--acc)"}} />
                  Mantiene (+5%)
                </label>
              </Field>
            </div>

            <Field label="Observaciones" hint="texto libre">
              <input style={{...inp, width:"100%", textAlign:"left"}} disabled={confirmado}
                value={nov.observaciones || ""}
                onChange={e => updateNov(emp.id, "observaciones", e.target.value)} />
            </Field>

            {confirmado && esDueno && (
              <button className="btn btn-ghost btn-sm" style={{marginTop:12}} onClick={editar}>
                ← Volver a borrador para editar
              </button>
            )}
          </div>

          {/* Columna der: desglose del cálculo */}
          <div style={{
            background:"var(--s2)", padding:16, borderRadius:"var(--r)",
            fontSize:11, alignSelf:"flex-start",
          }}>
            <div style={{fontSize:9, color:"var(--muted)", textTransform:"uppercase", letterSpacing:1, marginBottom:10}}>
              Desglose del cálculo
            </div>
            <BreakdownLine label="Sueldo base" value={Number(emp.sueldo_mensual)} />
            {(calc.total_horas_extras || 0) > 0 && <BreakdownLine label="+ Horas extras" value={calc.total_horas_extras} positive />}
            {(calc.total_dobles || 0) > 0 && <BreakdownLine label="+ Turnos dobles" value={calc.total_dobles} positive />}
            {(calc.total_feriados || 0) > 0 && <BreakdownLine label="+ Feriados" value={calc.total_feriados} positive />}
            {(calc.monto_presentismo || 0) > 0 && <BreakdownLine label="+ Presentismo (5%)" value={calc.monto_presentismo} positive />}
            {(calc.descuento_ausencias || 0) > 0 && <BreakdownLine label="− Inasistencias" value={-calc.descuento_ausencias} negative />}
            {adelantosDelMes > 0 && <BreakdownLine label="− Adelantos" value={-adelantosDelMes} negative />}
            <div style={{borderTop:"1px solid var(--bd)", marginTop:10, paddingTop:10,
              display:"flex", justifyContent:"space-between", fontWeight:600, fontSize:13}}>
              <span>Total</span>
              <span className="num" style={{color: total < 0 ? "var(--danger)" : "var(--success)"}}>{fmt_$(total)}</span>
            </div>
            <div style={{fontSize:9, color:"var(--muted2)", marginTop:8}}>
              {emp.alias_mp
                ? <>💰 Se paga 100% por transferencia al alias <code>{emp.alias_mp}</code></>
                : <>💵 Se paga 100% en efectivo (sin alias MP cargado)</>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers visuales ──────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{fontSize:9, color:"var(--muted)", textTransform:"uppercase", letterSpacing:0.5, marginBottom:4}}>
        {label}
      </div>
      {children}
      {hint && <div style={{fontSize:9, color:"var(--muted2)", marginTop:2}}>{hint}</div>}
    </div>
  );
}

function BreakdownLine({ label, value, positive, negative }: { label: string; value: number; positive?: boolean; negative?: boolean }) {
  const color = positive ? "var(--success)" : negative ? "var(--danger)" : "var(--txt)";
  return (
    <div style={{display:"flex", justifyContent:"space-between", padding:"2px 0"}}>
      <span style={{color:"var(--muted2)"}}>{label}</span>
      <span className="num" style={{color}}>{fmt_$(value)}</span>
    </div>
  );
}
