import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasVisibles } from "../lib/auth";
import { CUENTAS } from "../lib/constants";
import { toISO, today, fmt_$ } from "../lib/utils";
import { computeSaldoMP, type MovParaSaldo } from "../lib/saldoMP";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import type { Usuario } from "../types/auth";
import type { Factura, Proveedor, Venta, SaldoCaja } from "../types/finanzas";

interface DashboardProps {
  user: Usuario;
  localActivo: number | null;
}

// Subset de mp_credenciales que el Dashboard lee para computar saldo MP.
interface MpCredCompacta {
  local_id: number;
  tenant_id: string;
  saldo_inicial: number | null;
  saldo_inicial_at: string | null;
}

// Fila del array chartData (gráfico ventas últimos 7 días).
interface ChartPoint { dia: string; ventas: number }

// Subset de blindaje_documentos que el Dashboard lee.
interface BlindajeDoc { vencimiento: string | null; local_id: number | null }

// Proveedor + saldo computado en runtime (suma facturas pendientes por prov).
interface ProveedorConSaldo extends Proveedor { saldo: number }

// Subset de remitos que el Dashboard lee (solo para contar pendientes).
interface RemitoMin { estado: string; local_id: number | null }

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
export default function Dashboard({ user, localActivo }: DashboardProps) {
  const [stats, setStats] = useState<{saldos: Record<string, number>, deuda: number, vencidas: number, ventasHoy: number, remPend: number, blindajeVencidos: number, blindajePorVencer: number, saldoMpTotal: number, credsSinCorte: number}>({saldos:{},deuda:0,vencidas:0,ventasHoy:0,remPend:0,blindajeVencidos:0,blindajePorVencer:0,saldoMpTotal:0,credsSinCorte:0});
  const [provDeuda, setProvDeuda] = useState<ProveedorConSaldo[]>([]);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
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
    // Saldos cajas tradicionales — EXCLUIR la fila legacy MercadoPago (la
    // mantiene mp-process con saldoAprobado acumulado de rr-/set-, doble
    // conteo + histórico desde el corte original = $108M inflado).
    // El saldo MP correcto se calcula abajo via computeSaldoMP (mismo modelo
    // que ConciliacionMP refactor — saldo_inicial + delta pay-* posteriores).
    let sq = db.from("saldos_caja").select("*").neq("cuenta", "MercadoPago");
    sq = applyLocalScope(sq, user, lid);
    const visCuentas = cuentasVisibles(user);
    if (visCuentas !== null) {
      sq = visCuentas.length === 0 ? sq.eq("cuenta", "___NONE___") : sq.in("cuenta", visCuentas);
    }
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

    // Saldo MP — saldo_inicial + SUM(monto pay-* WHERE fecha > corte). Mismo
    // modelo que ConciliacionMP card. Si user no ve cuenta "MercadoPago"
    // (cuentas_visibles), se omite sin pegarle innecesario a la DB.
    const includeMp = visCuentas === null || visCuentas.includes("MercadoPago");
    let credsQ = db.from("mp_credenciales")
      .select("local_id, tenant_id, saldo_inicial, saldo_inicial_at")
      .eq("activo", true);
    credsQ = applyLocalScope(credsQ, user, lid);
    let saldoMovsQ = db.from("mp_movimientos")
      .select("local_id, monto, fecha, anulado")
      .like("id", "pay-%")
      .eq("anulado", false)
      .limit(20000);
    saldoMovsQ = applyLocalScope(saldoMovsQ, user, lid);

    const [{data:saldos},{data:facturas},{data:remitos},{data:ventas},{data:provs},{data:blindaje},{data:ventasSemana},credsMpRes,saldoMovsRes] = await Promise.all([
      sq,
      fq,
      rq,
      vtq,
      db.from("proveedores").select("*").gt("saldo",0).eq("estado","Activo"),
      bq,
      vsq,
      includeMp ? credsQ : Promise.resolve({ data: [] as MpCredCompacta[] }),
      includeMp ? saldoMovsQ : Promise.resolve({ data: [] as MovParaSaldo[] }),
    ]);
    const credsMp = (credsMpRes.data as MpCredCompacta[]) || [];
    const saldoMovs = (saldoMovsRes.data as MovParaSaldo[]) || [];
    const ventasSem = (ventasSemana as Pick<Venta, "fecha" | "monto" | "local_id">[]) || [];
    setChartData(ultimos7.map(d => ({
      dia: d.slice(5),
      ventas: ventasSem.filter(v => v.fecha === d).reduce((s, v) => s + Number(v.monto), 0),
    })));
    const saldosObj: Record<string, number> = {};
    ((saldos as SaldoCaja[]) || []).forEach(s => { saldosObj[s.cuenta] = (saldosObj[s.cuenta] || 0) + (s.saldo || 0); });
    const matchLocal = (rowLocal: number | null) => !localId || String(rowLocal) === String(localId);
    const fAct = ((facturas as Factura[]) || []).filter(f => f.estado !== "pagada" && matchLocal(f.local_id));
    const ahora = Date.now();
    let blindajeVencidos = 0, blindajePorVencer = 0;
    ((blindaje as BlindajeDoc[]) || []).forEach(d => {
      if (!d.vencimiento) return;
      const dias = Math.floor((new Date(d.vencimiento + "T12:00:00").getTime() - ahora) / 86400000);
      if (dias < 0) blindajeVencidos++;
      else if (dias <= 30) blindajePorVencer++;
    });
    // Calcular saldo MP por cred: saldo_inicial + delta de pay-* posteriores
    // al corte. Las creds sin corte fijado NO suman (aportan $0) pero las
    // contamos para footnote. Una cred ignora movs de otros local_id (lo hace
    // computeSaldoMP internamente).
    let saldoMpTotal = 0;
    let credsSinCorte = 0;
    for (const cred of credsMp) {
      if (!cred.saldo_inicial_at) {
        credsSinCorte++;
        continue;
      }
      const r = computeSaldoMP({
        saldoInicial: cred.saldo_inicial,
        saldoInicialAt: cred.saldo_inicial_at,
        movs: saldoMovs,
        localId: cred.local_id,
      });
      if (r.total != null) saldoMpTotal += r.total;
    }

    const ventasHoyArr = (ventas as Venta[]) || [];
    const remitosArr = (remitos as RemitoMin[]) || [];
    const provsArr = (provs as Proveedor[]) || [];
    setStats({
      saldos: saldosObj,
      deuda: fAct.reduce((s, f) => s + (f.total || 0), 0),
      vencidas: fAct.filter(f => f.estado === "vencida").length,
      ventasHoy: ventasHoyArr.filter(v => matchLocal(v.local_id)).reduce((s, v) => s + (v.monto || 0), 0),
      remPend: remitosArr.filter(r => r.estado === "sin_factura" && matchLocal(r.local_id)).length,
      blindajeVencidos, blindajePorVencer,
      saldoMpTotal, credsSinCorte,
    });
    if (localId) {
      const deudaPorProv: Record<number, number> = {};
      fAct.forEach(f => { deudaPorProv[f.prov_id] = (deudaPorProv[f.prov_id] || 0) + (f.total || 0); });
      setProvDeuda(
        provsArr
          .map<ProveedorConSaldo>(p => ({ ...p, saldo: deudaPorProv[p.id] || 0 }))
          .filter(p => p.saldo > 0)
          .sort((a, b) => b.saldo - a.saldo)
          .slice(0, 8),
      );
    } else {
      // Sin localId: mantener el saldo persistido de la fila proveedor (no
      // recompute). provs ya es Proveedor[], saldo es number directo.
      setProvDeuda(provsArr.slice().sort((a, b) => b.saldo - a.saldo).slice(0, 8));
    }
    setLoading(false);
  };
  // Patrón fetch-on-dep-change. No agregar load a deps (re-fetch infinito).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{ load(localActivo); },[localActivo]);
  if(loading) return <div className="loading">Cargando...</div>;
  // Liquidez Total = cajas tradicionales (Caja Chica/Mayor/Efectivo/Banco) +
  // saldo MP correcto (computeSaldoMP). La fila legacy saldos_caja MercadoPago
  // queda excluida en la query (.neq("cuenta","MercadoPago")).
  const totalLiquidez = Object.values(stats.saldos).reduce((a: number,b: number)=>a+b,0) + stats.saldoMpTotal;
  const liquidezSub = stats.credsSinCorte > 0
    ? `Todas las cuentas · ${stats.credsSinCorte} ${stats.credsSinCorte===1?'local sin':'locales sin'} saldo MP fijado`
    : "Todas las cuentas";
  return (
    <div>
      <div style={{marginBottom:20}}>
        <div className="ph-title">Dashboard</div>
      </div>
      <div className="grid4">
        <div className="kpi"><div className="kpi-label">Liquidez Total</div><div className="kpi-value kpi-acc">{fmt_$(totalLiquidez)}</div><div className="kpi-sub">{liquidezSub}</div></div>
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
                formatter={v => [`$${Number(v).toLocaleString("es-AR")}`, "Ventas"] as [string, string]}
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
            {CUENTAS.filter(k=>k!=="MercadoPago").map(k=>(
              <div key={k} className={`caja-card caja-${k==="Caja Chica"?"chica":k==="Caja Mayor"?"mayor":"banco"}`}>
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
          <tbody>{provDeuda.map(p => (
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