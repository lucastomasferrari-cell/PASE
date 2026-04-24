import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasVisibles } from "../lib/auth";
import { fmt_$, toISO, today } from "../lib/utils";
import { CUENTAS } from "../lib/constants";

const MESES = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

export default function Cashflow({ user, locales, localActivo }: any) {
  const [mes, setMes] = useState(toISO(today).slice(0,7));
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>({});

  const load = async () => {
    setLoading(true);
    const [yr, mo] = mes.split("-").map(Number);
    const lastDay = new Date(yr, mo, 0).getDate();
    const desde = mes + "-01";
    const hasta = mes + "-" + String(lastDay).padStart(2, "0");
    const lid = localActivo ? parseInt(String(localActivo)) : null;
    const vis = cuentasVisibles(user);
    const aplicarCuentas = <Q,>(q: Q): Q => {
      if (vis === null) return q;
      if (vis.length === 0) return (q as any).eq("cuenta", "___NONE___");
      return (q as any).in("cuenta", vis);
    };

    // 1. Ingresos cobrados — movimientos tipo "Ingreso Venta"
    let qIngresos = db.from("movimientos").select("cuenta, importe")
      .eq("tipo", "Ingreso Venta").eq("anulado", false)
      .gte("fecha", desde).lte("fecha", hasta);
    qIngresos = applyLocalScope(qIngresos, user, lid);
    qIngresos = aplicarCuentas(qIngresos);

    // 2. Egresos pagados — todos los movimientos negativos excepto ingresos
    let qEgresos = db.from("movimientos").select("cuenta, tipo, cat, importe, detalle")
      .eq("anulado", false).lt("importe", 0)
      .gte("fecha", desde).lte("fecha", hasta);
    qEgresos = applyLocalScope(qEgresos, user, lid);
    qEgresos = aplicarCuentas(qEgresos);

    // 3. Saldos actuales de caja
    let qSaldos = db.from("saldos_caja").select("*");
    qSaldos = applyLocalScope(qSaldos, user, lid);
    qSaldos = aplicarCuentas(qSaldos);

    // 4. Facturas pendientes de pago
    let qFactPend = db.from("facturas").select("total, cat")
      .eq("estado", "pendiente").neq("estado", "anulada");
    qFactPend = applyLocalScope(qFactPend, user, lid);

    // 5. Sueldos liquidados sin pagar
    let qSueldosPend = db.from("rrhh_liquidaciones")
      .select("total_a_pagar, rrhh_novedades(empleado_id, rrhh_empleados(local_id))")
      .eq("estado", "pendiente").eq("anulado", false);

    // 6. Ventas del mes por medio (para panel "Por cobrar" derivado).
    let qVentasMes = db.from("ventas").select("medio, monto")
      .gte("fecha", desde).lte("fecha", hasta);
    qVentasMes = applyLocalScope(qVentasMes, user, lid);

    // 7. Liquidaciones recibidas del mes (movimientos cat = 'Liquidación X').
    let qLiqMes = db.from("movimientos").select("cat, importe")
      .eq("anulado", false).gt("importe", 0)
      .gte("fecha", desde).lte("fecha", hasta)
      .like("cat", "Liquidación %");
    qLiqMes = applyLocalScope(qLiqMes, user, lid);
    qLiqMes = aplicarCuentas(qLiqMes);

    const [
      { data: ingresos },
      { data: egresos },
      { data: saldos },
      { data: factPend },
      { data: sueldosPend },
      { data: ventasMes },
      { data: liqMes },
    ] = await Promise.all([qIngresos, qEgresos, qSaldos, qFactPend, qSueldosPend, qVentasMes, qLiqMes]);

    // Procesar ingresos por cuenta
    const ingresosPorCuenta: Record<string, number> = {};
    (ingresos || []).forEach(m => {
      ingresosPorCuenta[m.cuenta] = (ingresosPorCuenta[m.cuenta] || 0) + Number(m.importe);
    });
    const totalIngresos = Object.values(ingresosPorCuenta).reduce((a, b) => a + b, 0);

    // Procesar egresos por tipo
    const egresosPorTipo: Record<string, number> = {};
    (egresos || []).forEach(m => {
      const key = m.tipo || "Otros";
      egresosPorTipo[key] = (egresosPorTipo[key] || 0) + Math.abs(Number(m.importe));
    });
    const totalEgresos = Object.values(egresosPorTipo).reduce((a, b) => a + b, 0);

    // Saldos por cuenta
    const saldosPorCuenta: Record<string, number> = {};
    (saldos || []).forEach(s => {
      saldosPorCuenta[s.cuenta] = (saldosPorCuenta[s.cuenta] || 0) + Number(s.saldo);
    });
    const totalDisponible = Object.values(saldosPorCuenta).reduce((a, b) => a + b, 0);

    // Deuda proveedores
    const deudaProveedores = (factPend || []).reduce((s, f) => s + Number(f.total), 0);

    // Sueldos pendientes
    const sueldosPendTotal = (sueldosPend || [])
      .filter(l => {
        if (!lid) return true;
        const empLocal = l.rrhh_novedades?.rrhh_empleados?.local_id;
        return !empLocal || empLocal === lid;
      })
      .reduce((s, l) => s + Number(l.total_a_pagar), 0);

    // Por cobrar: ventas por medio no-efectivo del mes menos liquidaciones
    // recibidas del mes con la categoría correspondiente.
    // Mapa medio → categoría de liquidación esperada.
    const MEDIO_A_CAT_LIQ: Record<string, string> = {
      "RAPPI ONLINE":       "Liquidación Rappi",
      "PEYA ONLINE":        "Liquidación PedidosYa",
      "MP DELIVERY":        "Liquidación MercadoPago",
      "MASDELIVERY ONLINE": "Liquidación MercadoPago",
      "BIGBOX":             "Liquidación Bigbox",
      "FANBAG":             "Liquidación Fanbag",
      "NAVE":               "Liquidación Nave",
      "Point Nave":         "Liquidación Nave",
      "Point MP":           "Liquidación MercadoPago",
      "TARJETA CREDITO":    "Liquidación MercadoPago",
      "TARJETA DEBITO":     "Liquidación MercadoPago",
      "QR":                 "Liquidación MercadoPago",
      "LINK":               "Liquidación MercadoPago",
      "TRANSFERENCIA":      "Liquidación MercadoPago",
    };
    const ventasPorMedio: Record<string, number> = {};
    (ventasMes || []).forEach(v => {
      ventasPorMedio[v.medio] = (ventasPorMedio[v.medio] || 0) + Number(v.monto);
    });
    const liqPorCat: Record<string, number> = {};
    (liqMes || []).forEach(m => {
      if (!m.cat) return;
      liqPorCat[m.cat] = (liqPorCat[m.cat] || 0) + Number(m.importe);
    });
    const porCobrar = Object.entries(ventasPorMedio)
      .filter(([medio]) => MEDIO_A_CAT_LIQ[medio] !== undefined)
      .map(([medio, vendido]) => {
        const catLiq = MEDIO_A_CAT_LIQ[medio];
        const cobrado = liqPorCat[catLiq] || 0;
        return { medio, catLiq, vendido, cobrado, pendiente: Math.max(0, vendido - cobrado) };
      })
      .filter(x => x.vendido > 0)
      .sort((a, b) => b.pendiente - a.pendiente);
    const totalPorCobrar = porCobrar.reduce((s, x) => s + x.pendiente, 0);

    setData({
      ingresosPorCuenta, totalIngresos,
      egresosPorTipo, totalEgresos,
      flujoNeto: totalIngresos - totalEgresos,
      saldosPorCuenta, totalDisponible,
      deudaProveedores, sueldosPendTotal,
      porCobrar, totalPorCobrar,
    });
    setLoading(false);
  };

  useEffect(() => { load(); }, [mes, localActivo]);

  const { ingresosPorCuenta={}, totalIngresos=0, egresosPorTipo={}, totalEgresos=0,
    flujoNeto=0, saldosPorCuenta={}, totalDisponible=0, deudaProveedores=0, sueldosPendTotal=0,
    porCobrar=[], totalPorCobrar=0 } = data;

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Cashflow</div></div>
        <input type="month" className="search" style={{width:160}} value={mes} onChange={e=>setMes(e.target.value)}/>
      </div>

      {loading ? <div className="loading">Cargando...</div> : (<>

        {/* KPIs */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
          <div className="kpi">
            <div className="kpi-label">Ingresos cobrados</div>
            <div className="kpi-value kpi-success">{fmt_$(totalIngresos)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Egresos pagados</div>
            <div className="kpi-value kpi-danger">{fmt_$(totalEgresos)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Flujo neto</div>
            <div className={`kpi-value ${flujoNeto >= 0 ? "kpi-success" : "kpi-danger"}`}>{fmt_$(flujoNeto)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Disponible total</div>
            <div className={`kpi-value ${totalDisponible >= 0 ? "kpi-success" : "kpi-danger"}`}>{fmt_$(totalDisponible)}</div>
          </div>
        </div>

        {/* Por cobrar: ventas del mes con medio no-efectivo menos liquidaciones
            recibidas (cat Liquidación X). Derivado en runtime, sin nueva columna. */}
        <div className="panel" style={{marginBottom:16}}>
          <div className="panel-hd">
            <span className="panel-title">Por cobrar — ventas pendientes de liquidación</span>
            <span style={{fontSize:12,color:"var(--muted2)"}}>
              Total pendiente: <span className="num" style={{color:"var(--warn)"}}>{fmt_$(totalPorCobrar)}</span>
            </span>
          </div>
          {porCobrar.length === 0 ? (
            <div className="empty">Sin ventas no-efectivo en el mes o todas ya liquidadas</div>
          ) : (
            <table>
              <thead><tr><th>Medio</th><th>Categoría liquidación</th><th style={{textAlign:"right"}}>Vendido</th><th style={{textAlign:"right"}}>Cobrado</th><th style={{textAlign:"right"}}>Pendiente</th></tr></thead>
              <tbody>
                {porCobrar.map((x: any) => (
                  <tr key={x.medio}>
                    <td style={{fontSize:11}}>{x.medio}</td>
                    <td style={{fontSize:10,color:"var(--muted2)"}}>{x.catLiq}</td>
                    <td style={{textAlign:"right"}}><span className="num">{fmt_$(x.vendido)}</span></td>
                    <td style={{textAlign:"right"}}><span className="num" style={{color: x.cobrado > 0 ? "var(--success)" : "var(--muted2)"}}>{fmt_$(x.cobrado)}</span></td>
                    <td style={{textAlign:"right"}}><span className="num" style={{color: x.pendiente > 0 ? "var(--warn)" : "var(--muted2)"}}>{fmt_$(x.pendiente)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{padding:"10px 14px",fontSize:10,color:"var(--muted2)",borderTop:"1px solid var(--bd)"}}>
            Se deriva de ventas.monto (por medio) − movimientos con cat = "Liquidación X" del mismo mes. Informativo. Para registrar que llegó una liquidación, carga un movimiento de ingreso en Caja con la cat correspondiente.
          </div>
        </div>

        <div className="grid2" style={{marginBottom:16}}>
          {/* Ingresos por cuenta */}
          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Ingresos por cuenta</span></div>
            {Object.keys(ingresosPorCuenta).length === 0
              ? <div className="empty">Sin ingresos registrados</div>
              : Object.entries(ingresosPorCuenta).map(([cuenta, monto]) => (
                <div key={cuenta} className="eerr-row">
                  <span style={{fontSize:11,color:"var(--muted2)"}}>{cuenta}</span>
                  <span className="num kpi-success">{fmt_$(monto as number)}</span>
                </div>
              ))
            }
            <div className="eerr-row" style={{background:"var(--s2)"}}>
              <span style={{fontWeight:600,fontSize:12}}>TOTAL</span>
              <span className="num" style={{color:"var(--success)",fontSize:14}}>{fmt_$(totalIngresos)}</span>
            </div>
          </div>

          {/* Egresos por tipo */}
          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Egresos por tipo</span></div>
            {Object.keys(egresosPorTipo).length === 0
              ? <div className="empty">Sin egresos registrados</div>
              : Object.entries(egresosPorTipo).sort((a,b) => (b[1] as number) - (a[1] as number)).map(([tipo, monto]) => (
                <div key={tipo} className="eerr-row">
                  <span style={{fontSize:11,color:"var(--muted2)"}}>{tipo}</span>
                  <span className="num kpi-danger">{fmt_$(monto as number)}</span>
                </div>
              ))
            }
            <div className="eerr-row" style={{background:"var(--s2)"}}>
              <span style={{fontWeight:600,fontSize:12}}>TOTAL</span>
              <span className="num" style={{color:"var(--danger)",fontSize:14}}>{fmt_$(totalEgresos)}</span>
            </div>
          </div>
        </div>

        {/* Saldos actuales */}
        <div className="panel" style={{marginBottom:16}}>
          <div className="panel-hd"><span className="panel-title">Saldos actuales de caja</span></div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12,padding:16}}>
            {CUENTAS.map(cuenta => (
              <div key={cuenta} className="kpi">
                <div className="kpi-label">{cuenta}</div>
                <div className="kpi-value" style={{fontSize:16,color:(saldosPorCuenta[cuenta]||0)<0?"var(--danger)":"var(--txt)"}}>
                  {fmt_$(saldosPorCuenta[cuenta]||0)}
                </div>
              </div>
            ))}
          </div>
          <div style={{padding:"8px 16px",borderTop:"1px solid var(--bd)",display:"flex",justifyContent:"space-between"}}>
            <span style={{fontSize:12,fontWeight:600}}>Total disponible</span>
            <span className="num" style={{fontSize:16,color:totalDisponible<0?"var(--danger)":"var(--success)"}}>{fmt_$(totalDisponible)}</span>
          </div>
        </div>

        {/* Deuda pendiente */}
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Compromisos pendientes</span></div>
          <div style={{padding:16}}>
            <div className="eerr-row">
              <span style={{fontSize:12,color:"var(--muted2)"}}>Facturas sin pagar (proveedores)</span>
              <span className="num kpi-danger">{fmt_$(deudaProveedores)}</span>
            </div>
            <div className="eerr-row">
              <span style={{fontSize:12,color:"var(--muted2)"}}>Sueldos liquidados sin pagar</span>
              <span className="num kpi-danger">{fmt_$(sueldosPendTotal)}</span>
            </div>
            <div className="eerr-row" style={{background:"var(--s2)"}}>
              <span style={{fontWeight:600,fontSize:12}}>Total compromisos</span>
              <span className="num" style={{color:"var(--danger)",fontSize:14}}>{fmt_$(deudaProveedores + sueldosPendTotal)}</span>
            </div>
            <div style={{marginTop:12,padding:"8px 0",borderTop:"1px solid var(--bd)",display:"flex",justifyContent:"space-between"}}>
              <span style={{fontSize:12,fontWeight:600}}>Posición neta (disponible - compromisos)</span>
              <span className="num" style={{fontSize:16,fontWeight:500,color:(totalDisponible - deudaProveedores - sueldosPendTotal)>=0?"var(--success)":"var(--danger)"}}>
                {fmt_$(totalDisponible - deudaProveedores - sueldosPendTotal)}
              </span>
            </div>
          </div>
        </div>

      </>)}
    </div>
  );
}
