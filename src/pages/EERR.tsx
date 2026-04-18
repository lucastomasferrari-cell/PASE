import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { MEDIOS_COBRO, CATEGORIAS_COMPRA, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, COMISIONES_CATS, GASTOS_IMPUESTOS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$ } from "../lib/utils";

export default function EERR({ locales, localActivo }) {
  const [ventas,setVentas]=useState([]);
  const [facturas,setFacturas]=useState([]);
  const [gastos,setGastos]=useState([]);
  const [sueldos,setSueldos]=useState(0);
  const [sueldosDetalle,setSueldosDetalle]=useState<any[]>([]);
  const [sueldosExpanded,setSueldosExpanded]=useState(false);
  const [mes,setMes]=useState(toISO(today).slice(0,7));
  const [loading,setLoading]=useState(true);

  useEffect(()=>{
    const load=async()=>{
      setLoading(true);
      const [yr,mo]=mes.split("-").map(Number);
      const lastDay=new Date(yr,mo,0).getDate();
      const desde=mes+"-01", hasta=mes+"-"+String(lastDay).padStart(2,"0");
      const lid=localActivo?parseInt(localActivo):null;
      const [{data:v},{data:f},{data:g},{data:liqData}]=await Promise.all([
        db.from("ventas").select("*").gte("fecha",desde).lte("fecha",hasta),
        db.from("facturas").select("*").gte("fecha",desde).lte("fecha",hasta).neq("estado","anulada"),
        db.from("gastos").select("*").gte("fecha",desde).lte("fecha",hasta),
        db.from("rrhh_liquidaciones")
          .select("*, rrhh_novedades(mes, anio, empleado_id, rrhh_empleados(nombre, apellido, puesto, local_id))")
          .eq("estado","pagado")
          .eq("anulado", false)
          .gte("pagado_at", desde+"T00:00:00")
          .lte("pagado_at", hasta+"T23:59:59"),
      ]);
      setVentas((v||[]).filter(x=>!lid||parseInt(x.local_id)===lid));
      setFacturas((f||[]).filter(x=>!lid||parseInt(x.local_id)===lid));
      setGastos((g||[]).filter(x=>x.categoria!=="SUELDOS"&&(!lid||!x.local_id||parseInt(x.local_id)===lid)));
      const liqFiltradas=(liqData||[]).filter(l=>{
        const emp=l.rrhh_novedades?.rrhh_empleados;
        return !lid||parseInt(emp?.local_id)===lid;
      });
      setSueldosDetalle(liqFiltradas);
      setSueldos(liqFiltradas.reduce((s,l)=>s+(l.total_a_pagar||0),0));
      setLoading(false);
    };
    load();
  },[mes,localActivo]);

  const totalVentas=ventas.reduce((s,v)=>s+(v.monto||0),0);
  const totalCMV=facturas.reduce((s,f)=>s+(f.total||0),0);
  const totalGastosFijos=gastos.filter(g=>g.tipo==="fijo").reduce((s,g)=>s+(g.monto||0),0);
  const totalGastosVar=gastos.filter(g=>g.tipo==="variable").reduce((s,g)=>s+(g.monto||0),0);
  const totalPublicidad=gastos.filter(g=>g.tipo==="publicidad").reduce((s,g)=>s+(g.monto||0),0);
  const totalComisiones=gastos.filter(g=>g.tipo==="comision").reduce((s,g)=>s+(g.monto||0),0);
  const totalImpuestos=gastos.filter(g=>g.tipo==="impuesto").reduce((s,g)=>s+(g.monto||0),0);
  const totalGastos=totalGastosFijos+totalGastosVar;
  const utilBruta=totalVentas-totalCMV;
  const utilNeta=utilBruta-totalGastos-sueldos-totalPublicidad-totalComisiones-totalImpuestos;
  const pct=n=>totalVentas>0?((n/totalVentas)*100).toFixed(1)+"%":"0%";

  const porMedio=MEDIOS_COBRO.map(m=>({m,t:ventas.filter(v=>v.medio===m).reduce((s,v)=>s+v.monto,0)})).filter(x=>x.t>0).sort((a,b)=>b.t-a.t);
  const porCatCMV=CATEGORIAS_COMPRA.map(c=>({c,t:facturas.filter(f=>f.cat===c).reduce((s,f)=>s+f.total,0)})).filter(x=>x.t>0).sort((a,b)=>b.t-a.t);
  const porCatFijos=GASTOS_FIJOS.map(c=>({c,t:gastos.filter(g=>g.tipo==="fijo"&&g.categoria===c).reduce((s,g)=>s+g.monto,0)})).filter(x=>x.t>0);
  const porCatVar=GASTOS_VARIABLES.map(c=>({c,t:gastos.filter(g=>g.tipo==="variable"&&g.categoria===c).reduce((s,g)=>s+g.monto,0)})).filter(x=>x.t>0);
  const porCatPub=GASTOS_PUBLICIDAD.map(c=>({c,t:gastos.filter(g=>g.tipo==="publicidad"&&g.categoria===c).reduce((s,g)=>s+g.monto,0)})).filter(x=>x.t>0);
  const porCatCom=COMISIONES_CATS.map(c=>({c,t:gastos.filter(g=>g.tipo==="comision"&&g.categoria===c).reduce((s,g)=>s+g.monto,0)})).filter(x=>x.t>0);
  const porCatImp=GASTOS_IMPUESTOS.map(c=>({c,t:gastos.filter(g=>g.tipo==="impuesto"&&g.categoria===c).reduce((s,g)=>s+g.monto,0)})).filter(x=>x.t>0);

  const ERow=({label,valor,color,big})=>(
    <div className="eerr-row" style={big?{background:"var(--s2)",padding:"12px 16px"}:{}}>
      <span style={{fontSize:big?13:11,fontWeight:big?600:400,color:big?"var(--txt)":"var(--muted2)"}}>{label}</span>
      <div>
        <span style={{fontFamily:"'Inter',sans-serif",fontSize:big?17:13,fontWeight:500,color}}>{fmt_$(valor)}</span>
        {!big&&<span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(Math.abs(valor))}</span>}
      </div>
    </div>
  );

  const ESection=({title,items,total,color})=>(
    <>
      <div className="eerr-section-title">{title} — <span style={{color}}>{fmt_$(total)}</span> <span style={{color:"var(--muted)"}}>{pct(total)}</span></div>
      {items.map(x=><div key={x.c||x.m} className="eerr-row"><span style={{fontSize:11,color:"var(--muted2)"}}>{x.c||x.m}</span><div><span className="num" style={{color}}>{fmt_$(x.t)}</span><span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(x.t)}</span></div></div>)}
    </>
  );

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Estado de Resultados</div></div>
        <input type="month" className="search" style={{width:160}} value={mes} onChange={e=>setMes(e.target.value)}/>
      </div>
      {loading?<div className="loading">Cargando...</div>:(
        <>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12,marginBottom:20}}>
            <div className="kpi"><div className="kpi-label">Ventas</div><div className="kpi-value kpi-success">{fmt_$(totalVentas)}</div></div>
            <div className="kpi"><div className="kpi-label">CMV</div><div className="kpi-value kpi-warn">{fmt_$(totalCMV)}</div><div className="kpi-sub">{pct(totalCMV)}</div></div>
            <div className="kpi"><div className="kpi-label">Labor Cost</div><div className="kpi-value kpi-danger">{fmt_$(sueldos)}</div><div className="kpi-sub">{pct(sueldos)}</div></div>
            <div className="kpi"><div className="kpi-label">% Rentabilidad</div><div className={`kpi-value ${utilNeta>=0?"kpi-success":"kpi-danger"}`}>{totalVentas>0?((utilNeta/totalVentas)*100).toFixed(1):"0"}%</div></div>
            <div className="kpi"><div className="kpi-label">Ganancia del mes</div><div className={`kpi-value ${utilNeta>=0?"kpi-success":"kpi-danger"}`}>{fmt_$(utilNeta)}</div></div>
          </div>

          <div className="grid2">
            <div className="panel">
              <div className="panel-hd"><span className="panel-title">Ingresos por Forma de Cobro</span></div>
              {porMedio.length===0?<div className="empty">Sin ventas este mes</div>:(
                <div>
                  {porMedio.map(x=><div key={x.m} className="eerr-row"><span style={{fontSize:11}}>{x.m}</span><div><span className="num kpi-success">{fmt_$(x.t)}</span><span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(x.t)}</span></div></div>)}
                  <div className="eerr-row" style={{background:"var(--s2)"}}><span style={{fontWeight:600}}>TOTAL VENTAS</span><span style={{fontFamily:"'Inter',sans-serif",fontSize:15,fontWeight:500,color:"var(--success)"}}>{fmt_$(totalVentas)}</span></div>
                </div>
              )}
            </div>
            <div className="panel">
              <div className="panel-hd"><span className="panel-title">Resumen P&L</span></div>
              <div style={{padding:"4px 0 12px"}}>
                <ERow label="Ventas Brutas" valor={totalVentas} color="var(--success)" big={false}/>
                <ERow label="(-) CMV" valor={-totalCMV} color="var(--danger)" big={false}/>
                <ERow label="(=) Utilidad Bruta" valor={utilBruta} color={utilBruta>=0?"var(--success)":"var(--danger)"} big={true}/>
                <ERow label="(-) Gastos Fijos y Variables" valor={-totalGastos} color="var(--danger)" big={false}/>
                <ERow label="(-) Sueldos" valor={-sueldos} color="var(--danger)" big={false}/>
                <ERow label="(-) Publicidad y MKT" valor={-totalPublicidad} color="var(--danger)" big={false}/>
                <ERow label="(-) Comisiones" valor={-totalComisiones} color="var(--danger)" big={false}/>
                <ERow label="(-) Impuestos" valor={-totalImpuestos} color="var(--danger)" big={false}/>
                <ERow label="(=) Utilidad Neta" valor={utilNeta} color={utilNeta>=0?"var(--success)":"var(--danger)"} big={true}/>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-hd"><span className="panel-title">Detalle por Categoría</span></div>
            <ESection title="MERCADERÍA (CMV)" items={porCatCMV} total={totalCMV} color="var(--warn)"/>
            <ESection title="GASTOS FIJOS" items={porCatFijos} total={totalGastosFijos} color="var(--danger)"/>
            <ESection title="GASTOS VARIABLES" items={porCatVar} total={totalGastosVar} color="var(--danger)"/>
            <div
              className="eerr-section-title"
              style={{cursor:"pointer",userSelect:"none"}}
              onClick={()=>setSueldosExpanded(e=>!e)}
            >
              SUELDOS — <span style={{color:"var(--danger)"}}>{fmt_$(sueldos)}</span>{" "}
              <span style={{color:"var(--muted)"}}>{pct(sueldos)}</span>
              <span style={{color:"var(--muted2)",fontSize:10,marginLeft:8}}>{sueldosExpanded?"▲ ocultar":"▼ ver detalle"}</span>
            </div>
            {sueldosExpanded&&(
              <div style={{paddingBottom:8}}>
                {sueldosDetalle.length===0?(
                  <div className="eerr-row"><span style={{fontSize:11,color:"var(--muted2)"}}>Sin sueldos pagados este mes</span></div>
                ):sueldosDetalle.map((liq,i)=>{
                  const emp=liq.rrhh_novedades?.rrhh_empleados;
                  if(!emp) return null;
                  return (
                    <div key={i} className="eerr-row">
                      <span style={{fontSize:11,color:"var(--muted2)"}}>
                        {emp.apellido}, {emp.nombre}
                        <span style={{fontSize:9,color:"var(--muted)",marginLeft:6}}>{emp.puesto}</span>
                      </span>
                      <div>
                        <span className="num" style={{color:"var(--danger)"}}>{fmt_$(liq.total_a_pagar)}</span>
                        <span style={{fontSize:10,color:"var(--muted)",marginLeft:6}}>{pct(liq.total_a_pagar)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <ESection title="PUBLICIDAD Y MKT" items={porCatPub} total={totalPublicidad} color="var(--info)"/>
            <ESection title="COMISIONES" items={porCatCom} total={totalComisiones} color="var(--acc2)"/>
            <ESection title="IMPUESTOS" items={porCatImp} total={totalImpuestos} color="var(--danger)"/>
          </div>
        </>
      )}
    </div>
  );
}
