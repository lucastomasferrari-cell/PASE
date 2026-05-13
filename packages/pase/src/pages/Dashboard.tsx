import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasVisibles } from "../lib/auth";
import { CUENTAS } from "../lib/constants";
import { toISO, today, fmt_$, estadoFactura } from "../lib/utils";
import { computeSaldoMP, type MovParaSaldo } from "../lib/saldoMP";
import { calcularSaldosPorProveedor } from "../lib/saldoProveedor";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Bento, CardAnchor, KpiTile, Card } from "../components/ui";
import type { Usuario } from "../types/auth";
import type { Factura, Proveedor, Venta, SaldoCaja } from "../types/finanzas";

interface DashboardProps {
  user: Usuario;
  localActivo: number | null;
}

interface MpCredCompacta {
  local_id: number;
  tenant_id: string;
  saldo_inicial: number | null;
  saldo_inicial_at: string | null;
}

interface ChartPoint { dia: string; ventas: number }
interface BlindajeDoc { vencimiento: string | null; local_id: number | null }
interface ProveedorConSaldo extends Proveedor { saldo: number }
interface RemitoMin { estado: string; local_id: number | null }

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

    const naq = db.from("nc_aplicaciones").select("nc_id,monto");

    const [{data:saldos},{data:facturas},{data:remitos},{data:ventas},{data:provs},{data:blindaje},{data:ventasSemana},credsMpRes,saldoMovsRes,{data:ncApls}] = await Promise.all([
      sq,
      fq,
      rq,
      vtq,
      db.from("proveedores").select("*").eq("estado","Activo"),
      bq,
      vsq,
      includeMp ? credsQ : Promise.resolve({ data: [] as MpCredCompacta[] }),
      includeMp ? saldoMovsQ : Promise.resolve({ data: [] as MovParaSaldo[] }),
      naq,
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

    const facturasParaCalc = ((facturas as Factura[]) || []).filter(f => matchLocal(f.local_id));
    const remitosParaCalc = remitosArr.filter(r => matchLocal(r.local_id));
    const saldoPorProv = calcularSaldosPorProveedor(
      facturasParaCalc as unknown as Parameters<typeof calcularSaldosPorProveedor>[0],
      remitosParaCalc as unknown as Parameters<typeof calcularSaldosPorProveedor>[1],
      (ncApls as Array<{ nc_id: string; monto: number }>) || [],
    );
    const deudaTotal = Array.from(saldoPorProv.values()).reduce((s, v) => s + v, 0);

    setStats({
      saldos: saldosObj,
      deuda: deudaTotal,
      vencidas: fAct.filter(f => estadoFactura(f) === "vencida").length,
      ventasHoy: ventasHoyArr.filter(v => matchLocal(v.local_id)).reduce((s, v) => s + (v.monto || 0), 0),
      remPend: remitosArr.filter(r => r.estado === "sin_factura" && matchLocal(r.local_id)).length,
      blindajeVencidos, blindajePorVencer,
      saldoMpTotal, credsSinCorte,
    });

    setProvDeuda(
      provsArr
        .map<ProveedorConSaldo>(p => ({ ...p, saldo: saldoPorProv.get(p.id) || 0 }))
        .filter(p => p.saldo > 0)
        .sort((a, b) => b.saldo - a.saldo)
        .slice(0, 8),
    );
    setLoading(false);
  };
  // Patrón fetch-on-dep-change. No agregar load a deps (re-fetch infinito).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{ load(localActivo); },[localActivo]);
  if(loading) return <div className="loading">Cargando...</div>;
  const totalLiquidez = Object.values(stats.saldos).reduce((a: number,b: number)=>a+b,0) + stats.saldoMpTotal;
  const liquidezSub = stats.credsSinCorte > 0
    ? `${stats.credsSinCorte} ${stats.credsSinCorte===1?'local sin':'locales sin'} saldo MP fijado`
    : "Todas las cuentas activas";

  // Sparkline de ventas semana (escala 0-100 para Sparkline component)
  const maxVentaSem = Math.max(1, ...chartData.map(d => d.ventas));
  const ventasSpark = chartData.map(d => Math.round((d.ventas / maxVentaSem) * 100));
  const ventasSemTotal = chartData.reduce((s, d) => s + d.ventas, 0);

  // Sparkline ficticio para los KPIs sin histórico (deuda/vencidas/remitos),
  // valor único repetido — visualmente neutral. TODO: capturar series reales
  // cuando agreguemos la tabla rrhh_kpi_snapshots o similar.
  const flatSpark = [40, 40, 40, 40, 40, 40, 40];

  const sinAlertas =
    stats.vencidas === 0 &&
    stats.remPend === 0 &&
    stats.blindajeVencidos === 0 &&
    stats.blindajePorVencer === 0;

  return (
    <div>
      <div style={{marginBottom:20}}>
        <div className="ph-title">Dashboard</div>
        <div className="ph-sub">Resumen ejecutivo del estado financiero al día.</div>
      </div>

      {/* Bento: ancla con Liquidez Total + 4 KPIs chicos ──────────── */}
      <Bento>
        <CardAnchor
          label="Liquidez total"
          value={fmt_$(totalLiquidez)}
          delta={`+ ${fmt_$(stats.ventasHoy)} hoy`}
          meta={liquidezSub}
          pillText="en vivo"
        />
        <KpiTile
          label="Ventas hoy"
          value={fmt_$(stats.ventasHoy)}
          delta={`Semana: ${fmt_$(ventasSemTotal)}`}
          sparkline={ventasSpark}
        />
        <KpiTile
          label="Deuda proveedores"
          value={fmt_$(stats.deuda)}
          delta={provDeuda.length > 0 ? `${provDeuda.length} proveedor${provDeuda.length === 1 ? "" : "es"}` : "Sin deuda"}
          deltaTone="muted"
          sparkline={flatSpark}
        />
        <KpiTile
          label="Facturas vencidas"
          value={String(stats.vencidas)}
          delta={stats.vencidas > 0 ? "Requieren atención" : "Al día"}
          deltaTone="muted"
          sparkline={flatSpark}
        />
        <KpiTile
          label="Remitos pendientes"
          value={String(stats.remPend)}
          delta={stats.remPend > 0 ? "Sin factura asociada" : "Sin remitos pendientes"}
          deltaTone="muted"
          sparkline={flatSpark}
        />
      </Bento>

      {/* Row inferior: chart + saldos + alertas ──────────────────────── */}
      <div style={{display:"grid",gridTemplateColumns:"1.5fr 1fr",gap:10,marginTop:14}}>
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <div style={{fontSize:13,fontWeight:500,color:"var(--pase-text)",letterSpacing:"-0.02em"}}>Ventas — últimos 7 días</div>
            <div style={{fontSize:11,color:"var(--pase-text-muted)",fontVariantNumeric:"tabular-nums"}}>{fmt_$(ventasSemTotal)} acum.</div>
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData} margin={{top:4,right:8,left:0,bottom:0}}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--pase-border)" vertical={false}/>
              <XAxis dataKey="dia" tick={{fontSize:10,fill:"var(--pase-text-muted)"}} axisLine={false} tickLine={false}/>
              <YAxis tick={{fontSize:10,fill:"var(--pase-text-muted)"}} axisLine={false} tickLine={false} tickFormatter={v=>v===0?"":`$${(v/1000).toFixed(0)}k`}/>
              <Tooltip
                contentStyle={{background:"var(--pase-bg)",border:"0.5px solid var(--pase-border-strong)",borderRadius:8,fontSize:11,color:"var(--pase-text)"}}
                labelStyle={{color:"var(--pase-text-muted)"}}
                formatter={v => [`$${Number(v).toLocaleString("es-AR")}`, "Ventas"] as [string, string]}
              />
              <Line type="monotone" dataKey="ventas" stroke="var(--pase-celeste)" strokeWidth={2} dot={false} activeDot={{r:4,fill:"var(--pase-celeste)"}}/>
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card>
          <div style={{fontSize:13,fontWeight:500,color:"var(--pase-text)",letterSpacing:"-0.02em",marginBottom:12}}>Alertas</div>
          {sinAlertas ? (
            <div style={{padding:"24px 8px",textAlign:"center",color:"var(--pase-text-muted)",fontSize:12}}>
              Todo al día.
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {stats.vencidas>0 && <div className="alert">{stats.vencidas} factura{stats.vencidas===1?"":"s"} vencida{stats.vencidas===1?"":"s"}</div>}
              {stats.remPend>0 && <div className="alert">{stats.remPend} remito{stats.remPend===1?"":"s"} sin factura</div>}
              {stats.blindajeVencidos>0 && <div className="alert">{stats.blindajeVencidos} documento{stats.blindajeVencidos===1?"":"s"} vencido{stats.blindajeVencidos===1?"":"s"} en Blindaje</div>}
              {stats.blindajePorVencer>0 && <div className="alert">{stats.blindajePorVencer} documento{stats.blindajePorVencer===1?"":"s"} por vencer en ≤30 días</div>}
            </div>
          )}
        </Card>
      </div>

      {/* Saldos por cuenta ───────────────────────────────────────────── */}
      <div style={{marginTop:14}}>
        <Card>
          <div style={{fontSize:13,fontWeight:500,color:"var(--pase-text)",letterSpacing:"-0.02em",marginBottom:14}}>Saldos en tiempo real</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))",gap:10}}>
            {CUENTAS.filter(k=>k!=="MercadoPago").map(k=>(
              <div key={k} style={{background:"var(--pase-bg-soft)",border:"0.5px solid var(--pase-border)",borderRadius:10,padding:"12px 14px"}}>
                <div style={{fontSize:11,color:"var(--pase-text-muted)",marginBottom:6,letterSpacing:"-0.01em"}}>{k}</div>
                <div style={{fontSize:18,fontWeight:500,color:"var(--pase-text)",letterSpacing:"-0.025em",fontVariantNumeric:"tabular-nums"}}>{fmt_$(stats.saldos[k]||0)}</div>
              </div>
            ))}
            {stats.saldoMpTotal !== 0 && (
              <div style={{background:"var(--pase-bg-soft)",border:"0.5px solid var(--pase-border)",borderRadius:10,padding:"12px 14px"}}>
                <div style={{fontSize:11,color:"var(--pase-text-muted)",marginBottom:6,letterSpacing:"-0.01em"}}>MercadoPago</div>
                <div style={{fontSize:18,fontWeight:500,color:"var(--pase-text)",letterSpacing:"-0.025em",fontVariantNumeric:"tabular-nums"}}>{fmt_$(stats.saldoMpTotal)}</div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Deuda por proveedor ─────────────────────────────────────────── */}
      {provDeuda.length > 0 && (
        <div style={{marginTop:14}}>
          <Card>
            <div style={{fontSize:13,fontWeight:500,color:"var(--pase-text)",letterSpacing:"-0.02em",marginBottom:12}}>Deuda por proveedor</div>
            <table>
              <thead><tr><th>Proveedor</th><th>Categoría</th><th style={{textAlign:"right"}}>Saldo</th></tr></thead>
              <tbody>
                {provDeuda.map(p => (
                  <tr key={p.id}>
                    <td style={{fontWeight:500}}>{p.nombre}</td>
                    <td><span className="badge b-muted">{p.cat}</span></td>
                    <td style={{textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{fmt_$(p.saldo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}
