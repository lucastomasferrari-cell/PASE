import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { CUENTAS } from "../lib/constants";
import { toISO, today, fmt_$ } from "../lib/utils";

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
export default function Dashboard({ locales, localActivo }) {
  const [stats, setStats] = useState({saldos:{},deuda:0,vencidas:0,ventasHoy:0,remPend:0,blindajeVencidos:0,blindajePorVencer:0});
  const [provDeuda, setProvDeuda] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = async (localId = localActivo) => {
    setLoading(true);
    const hoy = toISO(today);
    let sq = db.from("saldos_caja").select("*");
    if (localId) sq = sq.eq("local_id", parseInt(String(localId)));
    let bq = db.from("blindaje_documentos").select("vencimiento, local_id");
    if (localId) bq = bq.eq("local_id", parseInt(String(localId)));
    const [{data:saldos},{data:facturas},{data:remitos},{data:ventas},{data:provs},{data:blindaje}] = await Promise.all([
      sq,
      db.from("facturas").select("*").neq("estado","anulada"),
      db.from("remitos").select("*"),
      db.from("ventas").select("*").eq("fecha",hoy),
      db.from("proveedores").select("*").gt("saldo",0).eq("estado","Activo"),
      bq,
    ]);
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
