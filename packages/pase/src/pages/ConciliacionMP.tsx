import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope } from "../lib/auth";
import { useCategorias } from "../lib/useCategorias";
import { toISO, today, fmt_d, fmt_$, genId, fmt_dt_ar } from "../lib/utils";
import type { Usuario, Local } from "../types";

interface ConciliacionMPProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

interface ToastState {
  kind: "ok" | "err";
  msg: string;
}

function ConciliacionMP({ user, locales, localActivo }: ConciliacionMPProps) {
  const { COMISIONES_CATS, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD } = useCategorias();
  const [credenciales,setCredenciales]=useState<any[]>([]);
  const [movimientos,setMovimientos]=useState<any[]>([]);
  const [saldoMpReleasedTotal,setSaldoMpReleasedTotal]=useState(0);
  const [facturas,setFacturas]=useState<any[]>([]);
  const [gastos,setGastos]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);
  const [sincronizando,setSincronizando]=useState(false);
  const [toast,setToast]=useState<ToastState | null>(null);
  const [tab,setTab]=useState("ventas");
  const _hace30=new Date();_hace30.setDate(_hace30.getDate()-30);
  const [desde,setDesde]=useState(toISO(_hace30));
  const [hasta,setHasta]=useState(toISO(today));
  const [configModal,setConfigModal]=useState(false);
  const [configForm,setConfigForm]=useState({local_id:"",access_token:""});
  const [conciliarModal,setConciliarModal]=useState<any | null>(null); // movimiento a conciliar
  const [conciliarTab,setConciliarTab]=useState("gasto"); // gasto | factura | nuevo
  const [nuevoGastoForm,setNuevoGastoForm]=useState({categoria:"",detalle:""});
  const [vinculoSel,setVinculoSel]=useState("");
  const [saldoInicialModal,setSaldoInicialModal]=useState<{local_id: number, monto: string|number, fecha?: string} | null>(null);

  const load=async()=>{
    setLoading(true);
    try{
      // Rango por día calendario AR (UTC-3): convertimos los datepickers
      // 'YYYY-MM-DD' AR-local a su rango UTC equivalente. desde 00:00 AR =
      // {desde}T03:00:00Z; hasta 24:00 AR = {hasta+1}T03:00:00Z (exclusive).
      const desdeTs=new Date(`${desde}T00:00:00-03:00`).toISOString();
      const _hastaPlus=new Date(`${hasta}T00:00:00-03:00`);
      _hastaPlus.setUTCDate(_hastaPlus.getUTCDate()+1);
      const hastaTs=_hastaPlus.toISOString();
      // Mitigación A1 — query con OR de 2 ventanas: trae filas cuya fecha
      // (= date_created) cae en el rango O cuya money_release_date cae en
      // el rango. Necesario porque tab "Ventas" filtra por fecha y tab
      // "Ingresos al saldo" filtra por money_release_date — ambos tabs
      // necesitan filas que pueden no estar en el otro rango.
      const orFilter =
        `and(fecha.gte.${desdeTs},fecha.lt.${hastaTs}),` +
        `and(money_release_date.gte.${desdeTs},money_release_date.lt.${hastaTs})`;
      let movQ=db.from("mp_movimientos").select("*").or(orFilter).order("fecha",{ascending:false}).limit(5000);
      movQ=applyLocalScope(movQ,user,localActivo);
      // Mitigación M6 — saldo header se calcula desde pay-* released cumulativo
      // (no más rr-/set-* via saldo_disponible legacy). Sin filtro de fecha
      // para reflejar el saldo TOTAL liberado, no solo el del rango activo.
      let saldoQ=db.from("mp_movimientos")
        .select("monto")
        .like("id","pay-%")
        .eq("money_release_status","released")
        .eq("anulado",false);
      saldoQ=applyLocalScope(saldoQ,user,localActivo);
      let facQ=db.from("facturas").select("id,nro,fecha,total,local_id,cat,estado").gte("fecha",desde).lte("fecha",hasta).order("fecha",{ascending:false});
      facQ=applyLocalScope(facQ,user,localActivo);
      let gasQ=db.from("gastos").select("id,fecha,categoria,detalle,monto,local_id,cuenta").gte("fecha",desde).lte("fecha",hasta).order("fecha",{ascending:false});
      gasQ=applyLocalScope(gasQ,user,localActivo);
      const [credRes,movRes,saldoRes,facRes,gasRes]=await Promise.all([
        db.from("mp_credenciales").select("id, local_id, activo, ultima_sync, access_token_last8, saldo_disponible, por_acreditar, balance_at, locales(nombre)"),
        movQ,
        saldoQ,
        facQ,
        gasQ,
      ]);
      if(credRes.error)console.warn("mp_credenciales load error:",credRes.error);
      if(movRes.error)console.warn("mp_movimientos load error:",movRes.error);
      if(saldoRes.error)console.warn("saldo released load error:",saldoRes.error);
      if(facRes.error)console.warn("facturas load error:",facRes.error);
      if(gasRes.error)console.warn("gastos load error:",gasRes.error);
      const c=credRes.data||[], m=movRes.data||[], saldoRows=saldoRes.data||[], f=facRes.data||[], g=gasRes.data||[];
      const saldoSum=(saldoRows as any[]).reduce((s,r)=>s+(Number(r.monto)||0),0);
      console.log("[MP] load:",c.length,"credenciales /",m.length,"movimientos /",f.length,"facturas /",g.length,"gastos / saldo released:",saldoSum);
      setCredenciales((c as any[]).filter((x: any)=>!localActivo||x.local_id===localActivo));
      setMovimientos(m as any[]);
      setSaldoMpReleasedTotal(saldoSum);
      setFacturas((f as any[]).filter((x: any)=>!localActivo||x.local_id===localActivo));
      setGastos((g as any[]).filter((x: any)=>!localActivo||x.local_id===localActivo));
    }catch(e){
      console.error("ConciliacionMP load error:",e);
    }finally{
      setLoading(false);
    }
  };

  useEffect(()=>{load();},[desde,hasta,localActivo]);

  const showToast=(kind: "ok"|"err", msg: string)=>{
    setToast({kind,msg});
    setTimeout(()=>setToast(t=>t&&t.msg===msg?null:t),5000);
  };

  const [syncCountdown,setSyncCountdown]=useState(0);

  const sincronizar=async()=>{
    setSincronizando(true);
    setSyncCountdown(120);
    try{
      // Paso 1: generar CSV (< 5s)
      const genRes=await fetch("/api/mp-generate",{method:"POST"});
      const genData=await genRes.json().catch(()=>({ok:false}));
      const ts=genData.timestamp||Date.now();
      console.log("[MP] mp-generate:",genData);

      if(!genData.ok){
        showToast("err","⚠ Error generando reporte: "+(genData.error||"desconocido"));
        setSincronizando(false);
        setSyncCountdown(0);
        return;
      }

      // Paso 2: countdown de 2 minutos
      await new Promise<void>(resolve=>{
        let remaining=120;
        const interval=setInterval(()=>{
          remaining--;
          setSyncCountdown(remaining);
          if(remaining<=0){clearInterval(interval);resolve();}
        },1000);
      });

      // Paso 3: procesar CSV + calcular saldo
      setSyncCountdown(-1); // indica "procesando"
      const procRes=await fetch("/api/mp-process",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({ts})});
      const d=await procRes.json().catch(()=>({ok:false,error:"respuesta no-JSON del servidor"}));

      console.groupCollapsed("%c[MP] /api/mp-process response","color:#3ECFCF;font-weight:600");
      console.log("ok:",d.ok,"error:",d.error||null);
      if(d.cleanup_dedup_deleted)console.log("[MP] dedup cleanup:",d.cleanup_dedup_deleted);
      for(const x of (d.resultados||[])){
        console.groupCollapsed("["+x.local_id+"] "+x.local);
        console.log("movimientos:",x.movimientos,"release_rows:",x.release_rows,"saldo_disponible:",x.saldo_disponible);
        if(x.release_error)console.warn("release err:",x.release_error);
        if(x.upd_error)console.warn("DB err:",x.upd_error);
        console.groupEnd();
      }
      console.groupEnd();

      if(d.ok){
        await load();
        const totalMovs=(d.resultados||[]).reduce((s: number,x: any)=>s+(Number(x.movimientos)||0),0);
        const saldoTotal=(d.resultados||[]).reduce((s: number,x: any)=>s+(Number(x.saldo_disponible)||0),0);
        const csvNoEncontrado=(d.resultados||[]).some((x: any)=>x.release_error&&x.release_error.includes("CSV no encontrado"));
        if(csvNoEncontrado){
          showToast("err","⚠ MercadoPago no generó el reporte a tiempo. Intentá sincronizar de nuevo en unos minutos.");
        }else{
          showToast("ok","Sincronización completada · "+totalMovs+" movimientos · "+fmt_mp(saldoTotal)+" saldo");
        }
      }else{
        showToast("err","⚠ Error procesando: "+(d.error||"desconocido"));
      }
    }catch(e: unknown){
      console.error("ConciliacionMP sincronizar error:",e);
      showToast("err","⚠ Error al conectar con MP: "+(e instanceof Error ? e.message : String(e)));
    }finally{
      setSincronizando(false);
      setSyncCountdown(0);
    }
  };

  const guardarCredencial=async()=>{
    if(!configForm.local_id||!configForm.access_token)return;
    const {error}=await db.rpc("set_mp_token",{
      p_local_id:parseInt(configForm.local_id),
      p_access_token:configForm.access_token,
    });
    if(error){
      console.error("set_mp_token error:",error);
      showToast("err","⚠ Error guardando credencial: "+(error.message||""));
      return;
    }
    setConfigModal(false);setConfigForm({local_id:"",access_token:""});load();
  };

  // Borra todos los mp_movimientos de un local y vuelve a sincronizar,
  // así los pagos se re-clasifican con la lógica actual. Útil después
  // de arreglar reglas de clasificación.
  const resetearLocal=async(localId: number, nombre: string)=>{
    if(!confirm(`Borrar todos los movimientos MP de ${nombre||"este local"} y re-sincronizar? Esta acción no se puede deshacer.`))return;
    setSincronizando(true);
    try{
      const r=await fetch("/api/mp-sync?reset="+encodeURIComponent(localId),{method:"POST"});
      const d=await r.json();
      console.log("[MP] reset response:",d);
      if(d.ok){
        const resetInfo=(d.reset||[]).map((x: any)=>x.local_id+": "+(x.deleted??x.error)).join(", ");
        await load();
        alert("Reset + sync completados\n"+resetInfo);
      }else{
        alert("Error en reset: "+(d.error||"desconocido"));
      }
    }catch(e: unknown){alert("Error al resetear: "+(e instanceof Error ? e.message : String(e)));}
    setSincronizando(false);
  };

  // Comisiones/impuestos son egresos automáticos y se muestran aparte — no entran en conciliación manual.
  const ES_AUTOMATICO=(t: string)=>t==="fee"||t==="tax";

  // ─── Dedup multi-fuente (TASK 0.18) ─────────────────────────────────────
  // mp_movimientos puede tener hasta 3 filas para el mismo cobro:
  //   pay-{X}  ← payments/search por date_created (cobro inmediato)
  //   set-{X}  ← settlement_report por settlement_date
  //   rr-{X}   ← release_report por release_date
  // Las 3 representan el mismo movimiento desde ángulos distintos. Para el
  // listado del conciliador agrupamos por core_id (id sin prefijo) y mostramos
  // UNA sola fila preferiendo pay-* > rr-* > set-*. La fila ganadora lleva
  // _fuentes con la lista de prefijos disponibles para badge visual.
  // Saldo legacy NO usa esta lógica — sigue sumando solo rr-*/set-* via
  // saldo_disponible (precalculado en mp_credenciales por mp-process).
  const dedupedMovs = (() => {
    const groups = new Map<string, any[]>();
    const sinId: any[] = [];
    for (const m of movimientos as any[]) {
      const idStr = String(m.id || "");
      if (!idStr) { sinId.push(m); continue; }
      const core = idStr.startsWith("pay-") ? idStr.slice(4)
        : idStr.startsWith("set-") ? idStr.slice(4)
        : idStr.startsWith("rr-")  ? idStr.slice(3)
        : idStr;
      const arr = groups.get(core) || [];
      arr.push(m);
      groups.set(core, arr);
    }
    const prio = (id: string) =>
      id.startsWith("pay-") ? 1 : id.startsWith("rr-") ? 2 : id.startsWith("set-") ? 3 : 4;
    const tag = (id: string) =>
      id.startsWith("pay-") ? "pay" : id.startsWith("rr-") ? "rr" : id.startsWith("set-") ? "set" : "leg";
    const winners: any[] = [];
    for (const arr of groups.values()) {
      arr.sort((a, b) => prio(String(a.id)) - prio(String(b.id)));
      const w = { ...arr[0], _fuentes: arr.map(m => tag(String(m.id))) };
      winners.push(w);
    }
    return [...winners, ...sinId];
  })();

  // ─── Mitigaciones A1+A2+A3 — Filtros por tab ──────────────────────────────
  // Cada tab tiene su propio dataset filtrado. NUNCA agregar KPIs cross-tab
  // sin chequear doble conteo: una venta del 1/5 con release 11/5 aparece
  // en Ventas (date_created) Y en Ingresos al saldo (release_date) si el
  // rango abarca ambas fechas. Para evitar contarla dos veces, cada tab
  // calcula sus totales sobre SU propio array — NO sumar entre tabs.
  // También: tab "Ventas" muestra monto_bruto (transaction_amount), tab
  // "Por cobrar" e "Ingresos al saldo" muestran monto (net_received_amount).
  // Mitigación A2 — etiquetar visualmente "bruto" vs "neto" en cada tab.
  const desdeMs = new Date(`${desde}T00:00:00-03:00`).getTime();
  const hastaMsExcl = (() => {
    const d = new Date(`${hasta}T00:00:00-03:00`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  })();
  const inRange = (iso: any): boolean => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= desdeMs && t < hastaMsExcl;
  };

  // Tab Ventas — pay-* con fecha (date_created) en rango AR, no anulados
  // Mitigación M7: filas con money_release_status=NULL aparecen acá igual
  // (no filtramos por release_status), pero NO en Por cobrar / Ingresos.
  const ventasMovs = (movimientos as any[]).filter(m =>
    String(m.id || '').startsWith('pay-') &&
    inRange(m.fecha) &&
    m.anulado !== true
  );
  const ventasBruto = ventasMovs.reduce((s, m) => s + (Number(m.monto_bruto) || 0), 0);
  const ventasNeto = ventasMovs.reduce((s, m) => s + (Number(m.monto) || 0), 0);
  const ventasCount = ventasMovs.length;
  const ventasTicketProm = ventasCount > 0 ? ventasBruto / ventasCount : 0;

  // Tab Por cobrar — pay-* pending con money_release_date en rango
  const porCobrarMovs = (movimientos as any[]).filter(m =>
    String(m.id || '').startsWith('pay-') &&
    m.money_release_status === 'pending' &&
    inRange(m.money_release_date) &&
    m.anulado !== true
  );
  const porCobrarTotal = porCobrarMovs.reduce((s, m) => s + (Number(m.monto) || 0), 0);
  const proximaFechaRelease = porCobrarMovs
    .map(m => m.money_release_date)
    .filter(Boolean)
    .sort()[0] || null;

  // Tab Ingresos al saldo — pay-* released con money_release_date en rango
  const ingresosMovs = (movimientos as any[]).filter(m =>
    String(m.id || '').startsWith('pay-') &&
    m.money_release_status === 'released' &&
    inRange(m.money_release_date) &&
    m.anulado !== true
  );
  const ingresosTotal = ingresosMovs.reduce((s, m) => s + (Number(m.monto) || 0), 0);
  const ingresosCount = ingresosMovs.length;

  // Egresos sin justificar (KPI del header) — egresos manuales en rango
  // por fecha, no anulados, no conciliados, no automáticos (fee/tax).
  const egresosPendientesList = dedupedMovs.filter((m: any) =>
    Number(m.monto) < 0 &&
    !ES_AUTOMATICO(m.tipo) &&
    !m.conciliado &&
    m.anulado !== true &&
    inRange(m.fecha)
  );
  const pendientesCount = egresosPendientesList.length;

  // Mitigación M6 — Saldo MP cumulativo desde pay-* released (no más
  // saldo_disponible legacy de mp_credenciales). Viene del query separado
  // en load() sin filtro de fecha, así refleja el saldo TOTAL liberado.
  const porAcreditarTotal = credenciales.reduce((s, c) => s + (Number(c.por_acreditar) || 0), 0);

  const guardarSaldoInicial=async()=>{
    if(!saldoInicialModal||saldoInicialModal.monto===""||saldoInicialModal.monto==null)return;
    if(!saldoInicialModal.local_id)return;
    const monto=parseFloat(String(saldoInicialModal.monto));
    if(Number.isNaN(monto))return;
    // La fecha de corte viene del input del modal. Si el usuario dejó
    // una fecha sin hora, la convertimos a ISO tratándola como medianoche
    // local del día elegido. Eso queda guardado en saldo_inicial_at y
    // el sync futuro sólo suma los movimientos posteriores a ese corte.
    const rawFecha=saldoInicialModal.fecha;
    let corteIso;
    if(rawFecha){
      const parsed=new Date(rawFecha.length===10?rawFecha+"T00:00:00":rawFecha);
      corteIso=Number.isNaN(parsed.getTime())?new Date().toISOString():parsed.toISOString();
    }else{
      corteIso=new Date().toISOString();
    }
    // Al fijar un nuevo saldo inicial, reseteamos también saldo_disponible
    // y por_acreditar para que la UI refleje el valor inmediatamente sin
    // esperar al próximo sync. El sync posterior volverá a computarlos
    // sumando los movimientos que ocurran después de este corte.
    const {error}=await db.from("mp_credenciales").update({
      saldo_inicial:monto,
      saldo_inicial_at:corteIso,
      saldo_disponible:monto,
      por_acreditar:0,
      balance_at:new Date().toISOString(),
    }).eq("local_id",saldoInicialModal.local_id);
    if(error){
      console.error("guardarSaldoInicial error:",error);
      alert("No se pudo guardar el saldo inicial: "+error.message);
      return;
    }
    setSaldoInicialModal(null);
    load();
  };

  const TIPO_LABELS: Record<string, string>={
    "payment":"Cobro Online","point":"Venta Presencial",
    "payment_out":"Pago saliente","recurring":"Servicio/Suscripción",
    "money_transfer":"Transferencia","transferencia":"Transferencia enviada",
    "bank_transfer":"Transferencia a CBU","bank_transfer_in":"Transferencia recibida",
    "liquidacion":"Liquidación",
    "withdrawal":"Retiro",
    "investment":"Inversión","recharge":"Recarga",
    "refund":"Devolución","dispute":"Disputa","tax":"Impuesto",
    "fee":"Comisión","payout":"Liquidación"
  };
  // Formatter local con 2 decimales para mostrar los montos MP con
  // centavos (fmt_$ global trunca a enteros).
  const fmt_mp=(n: number)=>new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0);

  const getTipoColor=(tipo: string,monto: number)=>{
    if(monto>0)return "var(--success)";
    if(tipo==="refund"||tipo==="dispute")return "var(--danger)";
    if(tipo==="fee"||tipo==="tax")return "var(--warn)";
    return "var(--muted2)";
  };

  const abrirConciliar=(mov: any)=>{
    setConciliarModal(mov);
    setConciliarTab("gasto");
    setVinculoSel("");
    setNuevoGastoForm({categoria:"",detalle:mov.descripcion||""});
  };

  const vincularMovimiento=async(tipo: string,id: string|number)=>{
    if(!conciliarModal||!id)return;
    await db.from("mp_movimientos").update({
      conciliado:true,
      vinculo_tipo:tipo,
      vinculo_id:String(id),
      conciliado_at:new Date().toISOString(),
      conciliado_por:user?.nombre||user?.email||null,
    }).eq("id",conciliarModal.id);
    setConciliarModal(null);
    load();
  };

  const crearGastoYConciliar=async()=>{
    if(!conciliarModal||!nuevoGastoForm.categoria)return;
    const montoAbs=Math.abs(conciliarModal.monto||0);
    const esComision=conciliarModal.tipo==="fee"||conciliarModal.tipo==="tax";
    const gastoTipo=esComision?"comision":"variable";
    const nuevoId=genId("GASTO");
    await db.from("gastos").insert([{
      id:nuevoId,
      fecha:(conciliarModal.fecha||"").split("T")[0]||toISO(today),
      local_id:conciliarModal.local_id||null,
      categoria:nuevoGastoForm.categoria,
      monto:montoAbs,
      detalle:nuevoGastoForm.detalle||conciliarModal.descripcion||"",
      tipo:gastoTipo,
      cuenta:"MercadoPago",
    }]);
    await db.from("movimientos").insert([{
      id:genId("MOV"),
      fecha:(conciliarModal.fecha||"").split("T")[0]||toISO(today),
      cuenta:"MercadoPago",
      tipo:"Conciliación MP "+(TIPO_LABELS[conciliarModal.tipo]||conciliarModal.tipo||""),
      cat:nuevoGastoForm.categoria,
      importe:-montoAbs,
      detalle:nuevoGastoForm.detalle||conciliarModal.descripcion||"",
      fact_id:null,
      local_id:conciliarModal.local_id||null,
    }]);
    await vincularMovimiento("gasto",nuevoId);
  };

  const desconciliar=async(mov: any)=>{
    if(!confirm("¿Quitar la conciliación de este movimiento?"))return;
    await db.from("mp_movimientos").update({
      conciliado:false,
      vinculo_tipo:null,
      vinculo_id:null,
      conciliado_at:null,
      conciliado_por:null,
    }).eq("id",mov.id);
    load();
  };

  return (
    <div>
      {toast&&(
        <div
          onClick={()=>setToast(null)}
          style={{
            position:"fixed",
            bottom:24,
            right:24,
            zIndex:1000,
            padding:"12px 16px",
            borderRadius:"var(--r)",
            background:toast.kind==="ok"?"rgba(34,197,94,0.15)":"rgba(239,68,68,0.15)",
            border:"1px solid "+(toast.kind==="ok"?"rgba(34,197,94,0.4)":"rgba(239,68,68,0.4)"),
            color:toast.kind==="ok"?"var(--success)":"var(--danger)",
            fontSize:12,
            fontWeight:500,
            maxWidth:420,
            cursor:"pointer",
            boxShadow:"0 4px 16px rgba(0,0,0,0.4)",
          }}
        >
          {toast.msg}
        </div>
      )}
      <div className="ph-row">
        <div><div className="ph-title">Conciliación MP</div></div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <div style={{display:"flex",gap:4,alignItems:"center",fontSize:10,color:"var(--muted2)"}}>
            <span>Desde</span>
            <input type="date" className="search" style={{width:140}} value={desde} onChange={e=>setDesde(e.target.value)}/>
            <span>Hasta</span>
            <input type="date" className="search" style={{width:140}} value={hasta} onChange={e=>setHasta(e.target.value)}/>
          </div>
          <button className="btn btn-ghost btn-sm" style={{fontSize:10}} onClick={()=>{const d=new Date();d.setDate(d.getDate()-30);setDesde(toISO(d));setHasta(toISO(today));}}>Últ. 30d</button>
          <button className="btn btn-ghost" onClick={()=>setSaldoInicialModal({local_id:credenciales[0]?.local_id||"",monto:"",fecha:toISO(today)})}>⚙ Fijar saldo inicial</button>
          <button className="btn btn-ghost" onClick={()=>setConfigModal(true)}>⚙ Cuentas MP</button>
          <button className="btn btn-acc" onClick={sincronizar} disabled={sincronizando}>
            {sincronizando?"🔄 Sincronizando...":"↻ Sincronizar ahora"}
          </button>
        </div>
      </div>

      {sincronizando&&(
        <div className="alert" style={{background:"var(--bg2)",border:"1px solid var(--acc3)",color:"var(--acc3)",textAlign:"center",padding:"14px 20px",marginBottom:12,borderRadius:8,fontSize:14}}>
          {syncCountdown>0
            ? `Esperando reporte de MercadoPago... ${Math.floor(syncCountdown/60)}:${String(syncCountdown%60).padStart(2,"0")}`
            : syncCountdown===-1
            ? "Procesando movimientos y calculando saldo..."
            : "Conectando con MercadoPago..."}
        </div>
      )}

      {credenciales.length===0&&!loading&&(
        <div className="alert alert-warn">
          ⚠ No hay cuentas de MercadoPago configuradas. Cliclá en "⚙ Cuentas MP" para agregar las credenciales de cada local.
        </div>
      )}

      <div className="grid3">
        {/* Mitigación M6 — Saldo MP cumulativo: SUM(monto) de pay-* released
            no anulados, sin filtro de fecha. Coherencia total con tab
            "Ingresos al saldo". Reemplaza el saldo_disponible legacy de
            mp_credenciales (que sumaba rr-/set-* approved post-corte). */}
        <div className="kpi">
          <div className="kpi-label" style={{color:"var(--muted)"}}>Saldo MP (released)</div>
          <div className="kpi-value" style={{color:"var(--muted2)",fontFamily:"'Inter',sans-serif",fontSize:18,fontWeight:500}}>
            {fmt_mp(saldoMpReleasedTotal)}
          </div>
          <div className="kpi-sub">Suma de cobros liberados al saldo</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Egresos sin justificar</div>
          <div className="kpi-value kpi-warn" style={{fontFamily:"'Inter',sans-serif",fontSize:18,fontWeight:500}}>{pendientesCount}</div>
          <div className="kpi-sub">{pendientesCount===0?"Todos conciliados ✓":"Requieren conciliación manual"}</div>
        </div>
        {porAcreditarTotal>0&&(
          <div className="kpi">
            <div className="kpi-label">Por acreditar</div>
            <div className="kpi-value kpi-warn" style={{fontSize:18}}>{fmt_mp(porAcreditarTotal)}</div>
            <div className="kpi-sub">Pagos en proceso / pending</div>
          </div>
        )}
      </div>

      <div className="tabs">
        {([
          ["ventas","Ventas"],
          ["por_cobrar","Por cobrar"],
          ["ingresos","Ingresos al saldo"],
          ["comisiones","Comisiones MP"],
        ] as [string, string][]).map(([id,l])=>(
          <div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}</div>
        ))}
      </div>

      {loading?<div className="loading">Cargando...</div>:tab==="ventas"?(
        // ─── Tab VENTAS — pay-* con date_created en rango AR (M2 etiqueta bruto) ─
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Ventas — {ventasCount} cobros</span>
            <span style={{fontSize:11,color:"var(--muted2)"}}>Filtra por fecha de venta · monto en bruto</span>
          </div>
          <div style={{padding:"16px 20px",display:"grid",gap:10,gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))"}}>
            <div className="kpi">
              <div className="kpi-label">Total bruto</div>
              <div className="kpi-value kpi-success" style={{fontSize:16}}>{fmt_mp(ventasBruto)}</div>
              <div className="kpi-sub">Cobrado del cliente</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Total neto a recibir</div>
              <div className="kpi-value" style={{color:"var(--muted2)",fontSize:16}}>{fmt_mp(ventasNeto)}</div>
              <div className="kpi-sub">Después de comisión + retención</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Cantidad</div>
              <div className="kpi-value" style={{fontSize:16}}>{ventasCount}</div>
              <div className="kpi-sub">Operaciones en el período</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Ticket promedio</div>
              <div className="kpi-value" style={{fontSize:16}}>{fmt_mp(ventasTicketProm)}</div>
              <div className="kpi-sub">Bruto promedio por venta</div>
            </div>
          </div>
          {ventasCount===0?<div className="empty">Sin ventas en el período. Sincronizá para traer datos.</div>:(
            <table>
              <thead><tr>
                <th>Fecha venta</th><th>Local</th><th>Medio</th><th>Descripción</th>
                <th style={{textAlign:"right"}}>Bruto</th><th style={{textAlign:"right"}}>Neto</th>
                <th>Release</th>
              </tr></thead>
              <tbody>{ventasMovs.map(m=>(
                <tr key={m.id}>
                  <td className="mono" style={{fontSize:11}}>{fmt_dt_ar(m.fecha)}</td>
                  <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===m.local_id)?.nombre||"—"}</td>
                  <td><span className="badge b-muted" style={{fontSize:9}}>{m.medio_pago||"—"}</span></td>
                  <td style={{fontSize:11,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.descripcion||"—"}</td>
                  <td style={{textAlign:"right"}}><span className="num kpi-success">{fmt_mp(Number(m.monto_bruto)||0)}</span></td>
                  <td style={{textAlign:"right",color:"var(--muted2)"}}><span className="num">{fmt_mp(Number(m.monto)||0)}</span></td>
                  <td style={{fontSize:10}}>
                    {m.money_release_status==="released"?
                      <span className="badge b-success" title={fmt_dt_ar(m.money_release_date)}>✓ liberado</span>:
                     m.money_release_status==="pending"?
                      <span className="badge b-warn" title={fmt_dt_ar(m.money_release_date)}>⏳ {fmt_d(String(m.money_release_date||"").slice(0,10))}</span>:
                      <span style={{color:"var(--muted)"}}>—</span>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      ):tab==="por_cobrar"?(
        // ─── Tab POR COBRAR — pay-* pending con money_release_date en rango ───
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Por cobrar — {porCobrarMovs.length} pagos pendientes de liberación</span>
            <span style={{fontSize:11,color:"var(--muted2)"}}>Filtra por fecha de release · monto neto</span>
          </div>
          <div style={{padding:"16px 20px",display:"grid",gap:10,gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))"}}>
            <div className="kpi">
              <div className="kpi-label">Total a cobrar</div>
              <div className="kpi-value kpi-warn" style={{fontSize:16}}>{fmt_mp(porCobrarTotal)}</div>
              <div className="kpi-sub">Neto a liberarse al saldo</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Próxima liberación</div>
              <div className="kpi-value" style={{fontSize:14}}>{proximaFechaRelease?fmt_d(String(proximaFechaRelease).slice(0,10)):"—"}</div>
              <div className="kpi-sub">Fecha más cercana en el rango</div>
            </div>
          </div>
          {porCobrarMovs.length===0?<div className="empty">Sin pagos pendientes en el período. Probá ampliar el rango futuro.</div>:(
            <table>
              <thead><tr>
                <th>Release</th><th>Fecha venta</th><th>Local</th><th>Medio</th>
                <th>Descripción</th><th style={{textAlign:"right"}}>Neto</th>
              </tr></thead>
              <tbody>{porCobrarMovs.sort((a:any,b:any)=>String(a.money_release_date).localeCompare(String(b.money_release_date))).map((m:any)=>(
                <tr key={m.id}>
                  <td className="mono" style={{fontSize:11}}>{fmt_d(String(m.money_release_date||"").slice(0,10))}</td>
                  <td className="mono" style={{fontSize:11,color:"var(--muted2)"}}>{fmt_d(String(m.fecha||"").slice(0,10))}</td>
                  <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===m.local_id)?.nombre||"—"}</td>
                  <td><span className="badge b-muted" style={{fontSize:9}}>{m.medio_pago||"—"}</span></td>
                  <td style={{fontSize:11,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.descripcion||"—"}</td>
                  <td style={{textAlign:"right"}}><span className="num kpi-warn">{fmt_mp(Number(m.monto)||0)}</span></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      ):tab==="ingresos"?(
        // ─── Tab INGRESOS AL SALDO — pay-* released con release en rango ──────
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Ingresos al saldo — {ingresosCount} liberados</span>
            <span style={{fontSize:11,color:"var(--muted2)"}}>Filtra por fecha de release · monto neto</span>
          </div>
          <div style={{padding:"16px 20px",display:"grid",gap:10,gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))"}}>
            <div className="kpi">
              <div className="kpi-label">Total ingresado</div>
              <div className="kpi-value kpi-success" style={{fontSize:16}}>{fmt_mp(ingresosTotal)}</div>
              <div className="kpi-sub">Neto que llegó al saldo</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Cantidad</div>
              <div className="kpi-value" style={{fontSize:16}}>{ingresosCount}</div>
              <div className="kpi-sub">Cobros liberados en el período</div>
            </div>
          </div>
          {ingresosCount===0?<div className="empty">Sin ingresos liberados en el período.</div>:(
            <table>
              <thead><tr>
                <th>Release</th><th>Fecha venta</th><th>Local</th><th>Medio</th>
                <th>Descripción</th><th style={{textAlign:"right"}}>Neto</th>
              </tr></thead>
              <tbody>{ingresosMovs.sort((a:any,b:any)=>String(b.money_release_date).localeCompare(String(a.money_release_date))).map((m:any)=>(
                <tr key={m.id}>
                  <td className="mono" style={{fontSize:11}}>{fmt_d(String(m.money_release_date||"").slice(0,10))}</td>
                  <td className="mono" style={{fontSize:11,color:"var(--muted2)"}}>{fmt_d(String(m.fecha||"").slice(0,10))}</td>
                  <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===m.local_id)?.nombre||"—"}</td>
                  <td><span className="badge b-muted" style={{fontSize:9}}>{m.medio_pago||"—"}</span></td>
                  <td style={{fontSize:11,maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.descripcion||"—"}</td>
                  <td style={{textAlign:"right"}}><span className="num kpi-success">{fmt_mp(Number(m.monto)||0)}</span></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      ):(
        (()=>{
          // Comisiones MP y retenciones impositivas — resumen por origen.
          // TASK 0.18: cada fee-*/tax-* tiene referencia_id == payment.id (mismo
          // que su pay-* hermano). El padre que clasifica POS vs online es
          // el pay-* (medio_pago='point_smart_*' para POS).
          //
          // Distinción CRÍTICA:
          //   tipo='fee' → comisión MP (gasto operativo del negocio)
          //   tipo='tax' → retención impositiva (crédito fiscal, ej IIBB CABA)
          // Mezclarlos genera contabilidad equivocada.
          // Filtrar por fecha de venta (date_created del padre, heredado por
          // fee/tax). Consistencia con tab Ventas — comisiones del rango son
          // las de las ventas del rango.
          const cargosFee=dedupedMovs.filter(m=>m.tipo==="fee" && inRange(m.fecha));
          const cargosTax=dedupedMovs.filter(m=>m.tipo==="tax" && inRange(m.fecha));
          // Map referencia_id → fila no-fee/tax (preferir pay-* > rr-* > set-*).
          const porPaymentId=new Map<string, any>();
          for(const m of dedupedMovs){
            if(ES_AUTOMATICO(m.tipo))continue;
            if(!m.referencia_id)continue;
            const k=String(m.referencia_id);
            if(!porPaymentId.has(k))porPaymentId.set(k,m);
          }
          let comisionOnline=0, comisionPresencial=0, comisionOtras=0;
          for(const f of cargosFee){
            const parent=porPaymentId.get(String(f.referencia_id));
            const monto=Math.abs(Number(f.monto)||0);
            const mp=parent?.medio_pago;
            if(typeof mp==="string"&&mp.startsWith("point_smart_"))comisionPresencial+=monto;
            else if(parent)comisionOnline+=monto;
            else comisionOtras+=monto;
          }
          const retencionesTotal=cargosTax.reduce((s,t)=>s+Math.abs(Number(t.monto)||0),0);
          const totalComisiones=comisionOnline+comisionPresencial+comisionOtras;
          const totalCargos=totalComisiones+retencionesTotal;
          const cargosCount=cargosFee.length+cargosTax.length;
          return (
            <div className="panel">
              <div className="panel-hd">
                <span className="panel-title">Comisiones MP y Retenciones</span>
                <span style={{fontSize:11,color:"var(--muted2)"}}>{cargosCount} cargos en el período · {cargosFee.length} comisión · {cargosTax.length} retención</span>
              </div>
              {totalCargos===0?<div className="empty">Sin cargos en este período</div>:(
                <div style={{padding:"20px 24px",display:"grid",gap:12,gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))"}}>
                  <div className="kpi">
                    <div className="kpi-label">Comisión MP — Online</div>
                    <div className="kpi-value kpi-warn">{fmt_mp(comisionOnline)}</div>
                    <div className="kpi-sub">Checkout / Link / QR online</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-label">Comisión MP — Presencial</div>
                    <div className="kpi-value kpi-warn">{fmt_mp(comisionPresencial)}</div>
                    <div className="kpi-sub">Point Smart / POS</div>
                  </div>
                  <div className="kpi" style={{borderLeft:"3px solid var(--info)"}}>
                    <div className="kpi-label">Retenciones impositivas</div>
                    <div className="kpi-value" style={{color:"var(--info)"}}>{fmt_mp(retencionesTotal)}</div>
                    <div className="kpi-sub">IIBB / IVA / Ganancias — crédito fiscal</div>
                  </div>
                  {comisionOtras>0&&(
                    <div className="kpi">
                      <div className="kpi-label">Otras comisiones</div>
                      <div className="kpi-value" style={{color:"var(--muted2)"}}>{fmt_mp(comisionOtras)}</div>
                      <div className="kpi-sub">Sin pago padre en el período</div>
                    </div>
                  )}
                  <div className="kpi" style={{borderLeft:"3px solid var(--danger)"}}>
                    <div className="kpi-label">TOTAL descontado</div>
                    <div className="kpi-value kpi-danger">{fmt_mp(totalCargos)}</div>
                    <div className="kpi-sub">Comisiones + retenciones</div>
                  </div>
                </div>
              )}
            </div>
          );
        })()
      )}

      {saldoInicialModal&&(()=>{
        const credSel=credenciales.find(x=>x.local_id===saldoInicialModal.local_id);
        const calculado=credSel?Number(credSel.saldo_disponible)||0:0;
        const inicialPrev=credSel?Number(credSel.saldo_inicial)||0:0;
        const montoNum=saldoInicialModal.monto===""||saldoInicialModal.monto==null?null:parseFloat(String(saldoInicialModal.monto));
        const diferencia=montoNum!=null&&!Number.isNaN(montoNum)?montoNum-calculado:null;
        return (
        <div className="overlay" onClick={()=>setSaldoInicialModal(null)}><div className="modal" style={{width:560}} onClick={e=>e.stopPropagation()}>
          <div className="modal-hd"><div className="modal-title">Fijar saldo inicial MP</div><button className="close-btn" onClick={()=>setSaldoInicialModal(null)}>✕</button></div>
          <div className="modal-body">
            <div className="alert alert-warn" style={{marginBottom:12}}>
              Ingresá el saldo real de tu cuenta MP y la fecha en que ese saldo es válido. A partir de ese corte el sistema va a sumar sólo los movimientos aprobados posteriores.
            </div>
            <div className="field">
              <label>Local</label>
              <select value={saldoInicialModal.local_id} onChange={e=>setSaldoInicialModal({...saldoInicialModal,local_id:parseInt(e.target.value)||0})}>
                <option value="">Seleccioná...</option>
                {credenciales.map(c=><option key={c.id} value={c.local_id}>{c.locales?.nombre||`Local ${c.local_id}`}</option>)}
              </select>
            </div>

            {credSel&&(
              <div style={{padding:12,background:"var(--s2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)",marginBottom:12}}>
                <div style={{fontSize:9,letterSpacing:2,textTransform:"uppercase",color:"var(--muted2)",marginBottom:6}}>Saldo calculado actual</div>
                <div className="num" style={{fontSize:17,fontWeight:500,color:"var(--acc)",fontFamily:"'Inter',sans-serif"}}>{fmt_mp(calculado)}</div>
                <div style={{fontSize:10,color:"var(--muted2)",marginTop:4}}>
                  = saldo inicial {fmt_mp(inicialPrev)}{credSel.saldo_inicial_at?` (corte ${fmt_d(credSel.saldo_inicial_at.slice(0,10))})`:" (sin corte)"} + movimientos aprobados posteriores
                </div>
              </div>
            )}

            <div className="form2">
              <div className="field">
                <label>Fecha del corte</label>
                <input type="date" value={saldoInicialModal.fecha||""} onChange={e=>setSaldoInicialModal({...saldoInicialModal,fecha:e.target.value})}/>
              </div>
              <div className="field">
                <label>Saldo real en MP $</label>
                <input type="number" value={saldoInicialModal.monto} onChange={e=>setSaldoInicialModal({...saldoInicialModal,monto:e.target.value})} placeholder="0"/>
              </div>
            </div>

            {credSel&&diferencia!=null&&(
              <div style={{padding:"10px 12px",background:"var(--s2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)",marginTop:4,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div style={{fontSize:11,color:"var(--muted2)"}}>Diferencia contra el calculado</div>
                <div className="num" style={{color:Math.abs(diferencia)<1?"var(--success)":diferencia>0?"var(--acc3)":"var(--warn)",fontWeight:600}}>
                  {diferencia>=0?"+":""}{fmt_mp(diferencia)}
                </div>
              </div>
            )}

            {credSel&&credSel.saldo_inicial_at&&(
              <div style={{fontSize:10,color:"var(--muted2)",marginTop:10}}>
                Al guardar, el corte se mueve a la fecha que elijas y se reinicia la suma de movimientos posteriores.
              </div>
            )}
          </div>
          <div className="modal-ft">
            <button className="btn btn-sec" onClick={()=>setSaldoInicialModal(null)}>Cancelar</button>
            <button className="btn btn-acc" disabled={!saldoInicialModal.local_id||saldoInicialModal.monto===""||!saldoInicialModal.fecha} onClick={guardarSaldoInicial}>Guardar</button>
          </div>
        </div></div>
        );
      })()}

      {conciliarModal&&(<div className="overlay" onClick={()=>setConciliarModal(null)}><div className="modal" style={{width:640}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Conciliar egreso MP</div><button className="close-btn" onClick={()=>setConciliarModal(null)}>✕</button></div>
        <div className="modal-body">
          <div style={{padding:12,background:"var(--s2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)",marginBottom:12}}>
            <div style={{fontSize:10,color:"var(--muted2)",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>Movimiento a justificar</div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontWeight:600,fontSize:13}}>{TIPO_LABELS[conciliarModal.tipo]||conciliarModal.tipo}</div>
                <div style={{fontSize:11,color:"var(--muted2)"}}>{conciliarModal.descripcion||"—"} · {fmt_d((conciliarModal.fecha||"").split("T")[0])}</div>
              </div>
              <div className="num kpi-danger" style={{fontSize:14}}>{fmt_$(conciliarModal.monto)}</div>
            </div>
          </div>
          <div className="tabs" style={{marginBottom:12}}>
            {([["gasto","Gasto existente"],["factura","Factura existente"],["nuevo","Crear Gasto nuevo"]] as [string, string][]).map(([id,l])=>(
              <div key={id} className={`tab ${conciliarTab===id?"active":""}`} onClick={()=>{setConciliarTab(id);setVinculoSel("");}}>{l}</div>
            ))}
          </div>
          {conciliarTab==="gasto"&&(
            <div>
              <div className="field"><label>Seleccioná un gasto del mes</label>
                <select value={vinculoSel} onChange={e=>setVinculoSel(e.target.value)}>
                  <option value="">— Elegir gasto —</option>
                  {gastos.map(g=><option key={g.id} value={g.id}>{fmt_d(g.fecha)} · {g.categoria} · {fmt_$(g.monto)} · {g.detalle||""}</option>)}
                </select>
              </div>
              {gastos.length===0&&<div style={{fontSize:11,color:"var(--muted2)"}}>No hay gastos cargados este mes. Creá uno nuevo en la pestaña "Crear Gasto nuevo".</div>}
            </div>
          )}
          {conciliarTab==="factura"&&(
            <div>
              <div className="field"><label>Seleccioná una factura del mes</label>
                <select value={vinculoSel} onChange={e=>setVinculoSel(e.target.value)}>
                  <option value="">— Elegir factura —</option>
                  {facturas.map(f=><option key={f.id} value={f.id}>{fmt_d(f.fecha)} · #{f.nro} · {fmt_$(f.total)} · {f.estado}</option>)}
                </select>
              </div>
              {facturas.length===0&&<div style={{fontSize:11,color:"var(--muted2)"}}>No hay facturas cargadas este mes.</div>}
            </div>
          )}
          {conciliarTab==="nuevo"&&(
            <div>
              <div className="alert alert-warn" style={{marginBottom:12}}>Se creará un gasto por {fmt_$(Math.abs(conciliarModal.monto||0))} con cuenta MercadoPago y se vinculará automáticamente.</div>
              <div className="field"><label>Categoría *</label>
                <select value={nuevoGastoForm.categoria} onChange={e=>setNuevoGastoForm({...nuevoGastoForm,categoria:e.target.value})}>
                  <option value="">Seleccioná...</option>
                  {(conciliarModal.tipo==="fee"||conciliarModal.tipo==="tax"?COMISIONES_CATS:[...GASTOS_VARIABLES,...GASTOS_FIJOS,...GASTOS_PUBLICIDAD]).map(c=><option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="field"><label>Detalle</label><input value={nuevoGastoForm.detalle} onChange={e=>setNuevoGastoForm({...nuevoGastoForm,detalle:e.target.value})} placeholder="Descripción..."/></div>
            </div>
          )}
        </div>
        <div className="modal-ft">
          <button className="btn btn-sec" onClick={()=>setConciliarModal(null)}>Cancelar</button>
          {conciliarTab==="nuevo"?
            <button className="btn btn-acc" disabled={!nuevoGastoForm.categoria} onClick={crearGastoYConciliar}>Crear y conciliar</button>
            :<button className="btn btn-acc" disabled={!vinculoSel} onClick={()=>vincularMovimiento(conciliarTab,vinculoSel)}>Vincular</button>
          }
        </div>
      </div></div>)}

      {configModal&&(<div className="overlay" onClick={()=>setConfigModal(false)}><div className="modal" style={{width:580}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">⚙ Configurar Cuentas MP</div><button className="close-btn" onClick={()=>setConfigModal(false)}>✕</button></div>
        <div className="modal-body">
          {credenciales.length>0&&(
            <div style={{marginBottom:16}}>
              <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:"var(--muted2)",marginBottom:8}}>Cuentas configuradas</div>
              {credenciales.map(c=>(
                <div key={c.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"var(--s2)",borderRadius:"var(--r)",marginBottom:6}}>
                  <div>
                    <span style={{fontWeight:500,fontSize:12}}>{c.locales?.nombre}</span>
                    <span style={{fontSize:10,color:"var(--muted)",marginLeft:8}}>...{c.access_token_last8||"••••••••"}</span>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    {c.ultima_sync&&<span style={{fontSize:10,color:"var(--success)"}}>✓ Sync {fmt_dt_ar(c.ultima_sync)}</span>}
                    <span className={`badge ${c.activo?"b-success":"b-muted"}`}>{c.activo?"Activa":"Inactiva"}</span>
                    <button className="btn btn-ghost btn-sm" style={{fontSize:9,padding:"2px 6px"}} disabled={sincronizando} onClick={()=>resetearLocal(c.local_id,c.locales?.nombre)}>↻ Reset datos</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{padding:16,background:"var(--s2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)"}}>
            <div style={{fontSize:11,fontWeight:600,marginBottom:12}}>Agregar / actualizar cuenta</div>
            <div className="field"><label>Local</label>
              <select value={configForm.local_id} onChange={e=>setConfigForm({...configForm,local_id:e.target.value})}>
                <option value="">Seleccioná el local...</option>
                {locales.map(l=><option key={l.id} value={l.id}>{l.nombre}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Access Token de Producción</label>
              <input value={configForm.access_token} onChange={e=>setConfigForm({...configForm,access_token:e.target.value})} placeholder="APP_USR-..."/>
              <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>Mercado Pago → Tu negocio → Credenciales → Access Token de Producción</div>
            </div>
          </div>
        </div>
        <div className="modal-ft"><button className="btn btn-sec" onClick={()=>setConfigModal(false)}>Cerrar</button><button className="btn btn-acc" onClick={guardarCredencial}>Guardar Credencial</button></div>
      </div></div>)}
    </div>
  );
}

export default ConciliacionMP;