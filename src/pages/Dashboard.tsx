import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope } from "../lib/auth";
import { CUENTAS } from "../lib/constants";
import { toISO, today, fmt_$ } from "../lib/utils";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
export default function Dashboard({ user, locales, localActivo }: any) {
  const [stats, setStats] = useState({saldos:{},deuda:0,vencidas:0,ventasHoy:0,remPend:0,blindajeVencidos:0,blindajePorVencer:0});
  const [provDeuda, setProvDeuda] = useState([]);
  const [chartData, setChartData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const load = async (localId = localActivo) => {
    setLoading(true);
    const hoy = toISO(today);
    const lid = localId ? parseInt(String(localId)) : null;
    const ultimos7 = Array.from({length:7},(_,i)=>{
      const d = new Date();
      d.setDate(d.getDate()-6+i);
      return d.toISOString().slice(0,10);
    });
    let sq = db.from("saldos_caja").select("*");
    sq = applyLocalScope(sq, user, lid);
    let bq = db.from("blindaje_documentos").select("vencimiento, local_id");
    bq = applyLocalScope(bq, user, lid);
    let vsq = db.from("ventas").select("fecha, monto, local_id").gte("fecha", ultimos7[0]).lte("fecha", ultimos7[6]);
    vsq = applyLocalScope(vsq, user, lid);
    let fq = db.from("facturas").select("*").neq("estado","anulada");
    fq = applyLocalScope(fq, user, lid);
    let rq = db.from("remitos").select("*");
    rq = applyLocalScope(rq, user, lid);
    let vtq = db.from("ventas").select("*").eq("fecha",hoy);
    vtq = applyLocalScope(vtq, user, lid);
    const [{data:saldos},{data:facturas},{data:remitos},{data:ventas},{data:provs},{data:blindaje},{data:ventasSemana}] = await Promise.all([
      sq,
      fq,
      rq,
      vtq,
      db.from("proveedores").select("*").gt("saldo",0).eq("estado","Activo"),
      bq,
      vsq,
    ]);
    setChartData(ultimos7.map(d => ({
      dia: d.slice(5),
      ventas: (ventasSemana||[]).filter((v:any)=>v.fecha===d).reduce((s:number,v:any)=>s+Number(v.monto),0),
    })));
    const saldosObj: Record<string, number> = {};
    (saldos||[]).forEach(s => { saldosObj[s.cuenta] = (saldosObj[s.cuenta]||0) + (s.saldo||0); });
    const matchLocal = (rowLocal) => !localId || String(rowLocal) === String(localId);
    const fAct = (facturas||[]).filter(f=>f.estado!=="pagada"&&matchLocal(f.local_id));
    const ahora = Date.now();
    let blindajeVencidos = 0, blindajePorVencer = 0;
    (blindaje || []).forEach((d: any) => {
      if (!d.vencimiento) return;
      const dias = Math.floor((new Date(d.vencimiento + "T12:00:00").getTime() - ahora) / 86400000);
      if (dias < 0) blindajeVencidos++;
      else if (dias <= 30) blindajePorVencer++;
    });
    setStats({
      saldos:saldosObj,
      deuda:fAct.reduce((s,f)=>s+(f.total||0),0),
      vencidas:fAct.filter(f=>f.estado==="vencida").length,
      ventasHoy:(ventas||[]).filter(v=>matchLocal(v.local_id)).reduce((s,v)=>s+(v.monto||0),0),
      remPend:(remitos||[]).filter(r=>r.estado==="sin_factura"&&matchLocal(r.local_id)).length,
      blindajeVencidos, blindajePorVencer,
    });
    if (localId) {
      const deudaPorProv: Record<number, number> = {};
      fAct.forEach(f => { deudaPorProv[f.prov_id] = (deudaPorProv[f.prov_id]||0) + (f.total||0); });
      setProvDeuda((provs||[]).map(p => ({...p, saldo: deudaPorProv[p.id] || 0})).filter(p => p.saldo > 0).sort((a,b)=>b.saldo-a.saldo).slice(0,8));
    } else {
      setProvDeuda((provs||[]).sort((a,b)=>b.saldo-a.saldo).slice(0,8));
    }
    setLoading(false);
  };
  useEffect(()=>{ load(localActivo); },[localActivo]);
  if(loading) return <div className="loading">Cargando...</div>;
  const totalLiquidez = Object.values(stats.saldos).reduce((a,b)=>a+b,0);
  return (
    <div>
      <div style={{marginBottom:20}}>
        <div className="ph-title">Dashboard</div>
      </div>
      <div className="grid4">
        <div className="kpi"><div className="kpi-label">Liquidez Total</div><div className="kpi-value kpi-acc">{fmt_$(totalLiquidez)}</div><div className="kpi-sub">Todas las cuentas</div></div>
        <div className="kpi"><div className="kpi-label">Ventas Hoy</div><div className="kpi-value kpi-success">{fmt_$(stats.ventasHoy)}</div></div>
        <div className="kpi"><div className="kpi-label">Deuda Proveedores</div><div className="kpi-value kpi-warn">{fmt_$(stats.deuda)}</div></div>
        <div className="kpi"><div className="kpi-label">Facturas Vencidas</div><div className="kpi-value kpi-danger">{stats.vencidas}</div></div>
      </div>
      <div className="panel" style={{marginBottom:16}}>
        <div className="panel-hd"><span className="panel-title">Ventas — últimos 7 días</span></div>
        <div style={{padding:"12px 4px"}}>
          <ResponsiveContainer width="100%" height={140}>
            <LineChart data={chartData} margin={{top:4,right:16,left:0,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--bd2)" vertical={false}/>
              <XAxis dataKey="dia" tick={{fontSize:10,fill:"var(--muted)"}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fontSize:10,fill:"var(--muted)"}} axisLine={false} tickLine={false} tickFormatter={v=>v===0?"":`$${(v/1000).toFixed(0)}k`}/>
              <Tooltip
                contentStyle={{background:"var(--s1)",border:"1px solid var(--bd2)",borderRadius:6,fontSize:11}}
                labelStyle={{color:"var(--muted2)"}}
                formatter={(v:number)=>[`$${v.toLocaleString("es-AR")}`, "Ventas"]}
              />
              <Line type="monotone" dataKey="ventas" stroke="var(--acc)" strokeWidth={2} dot={false} activeDot={{r:4,fill:"var(--acc)"}}/>
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="grid2">
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Saldos en Tiempo Real</span></div>
          <div style={{padding:"12px 16px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            {CUENTAS.map(k=>(
              <div key={k} className={`caja-card caja-${k==="Caja Chica"?"chica":k==="Caja Mayor"?"mayor":k==="MercadoPago"?"mp":"banco"}`}>
                <div className="caja-name">{k}</div>
                <div className="caja-saldo" style={{color:(stats.saldos[k]||0)<0?"var(--danger)":"var(--txt)"}}>{fmt_$(stats.saldos[k]||0)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-hd"><span className="panel-title" style={{color:"var(--warn)"}}>⚡ Alertas</span></div>
          <div style={{padding:"8px 16px"}}>
            {stats.vencidas>0 && <div className="alert alert-danger">⚠ {stats.vencidas} factura(s) vencida(s)</div>}
            {stats.remPend>0 && <div className="alert alert-warn">🚚 {stats.remPend} remito(s) sin factura</div>}
            {stats.blindajeVencidos>0 && <div className="alert alert-danger">🛡 {stats.blindajeVencidos} documento(s) vencido(s) — Blindaje</div>}
            {stats.blindajePorVencer>0 && <div className="alert alert-warn">🛡 {stats.blindajePorVencer} documento(s) por vencer en ≤30d — Blindaje</div>}
            {stats.vencidas===0&&stats.remPend===0&&stats.blindajeVencidos===0&&stats.blindajePorVencer===0 && <div className="alert alert-success">✓ Todo al día</div>}
          </div>
        </div>
      </div>
      {provDeuda.length>0 && (
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Deuda por Proveedor</span></div>
          <table><thead><tr><th>Proveedor</th><th>Categoría</th><th>Saldo</th></tr></thead>
          <tbody>{provDeuda.map(p=>(
            <tr key={p.id} className="prov-row">
              <td style={{fontWeight:500}}>{p.nombre}</td>
              <td><span className="badge b-muted">{p.cat}</span></td>
              <td><span className="num kpi-warn">{fmt_$(p.saldo)}</span></td>
            </tr>
          ))}</tbody></table>
        </div>
      )}
    </div>
  );
}
