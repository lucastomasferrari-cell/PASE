import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { COMISIONES_CATS, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";

function ConciliacionMP({ user, locales, localActivo }) {
  const [credenciales,setCredenciales]=useState([]);
  const [movimientos,setMovimientos]=useState([]);
  const [facturas,setFacturas]=useState([]);
  const [gastos,setGastos]=useState([]);
  const [loading,setLoading]=useState(true);
  const [sincronizando,setSincronizando]=useState(false);
  const [toast,setToast]=useState(null); // {kind:'ok'|'err', msg:string}
  const [tab,setTab]=useState("movimientos");
  const _hace30=new Date();_hace30.setDate(_hace30.getDate()-30);
  const [desde,setDesde]=useState(toISO(_hace30));
  const [hasta,setHasta]=useState(toISO(today));
  const [configModal,setConfigModal]=useState(false);
  const [configForm,setConfigForm]=useState({local_id:"",access_token:""});
  const [conciliarModal,setConciliarModal]=useState(null); // movimiento a conciliar
  const [conciliarTab,setConciliarTab]=useState("gasto"); // gasto | factura | nuevo
  const [nuevoGastoForm,setNuevoGastoForm]=useState({categoria:"",detalle:""});
  const [vinculoSel,setVinculoSel]=useState("");
  const [saldoInicialModal,setSaldoInicialModal]=useState(null); // {local_id, monto}

  const load=async()=>{
    setLoading(true);
    try{
      const desdeTs=desde+"T00:00:00";
      const hastaTs=hasta+"T23:59:59";
      // Filtramos mp_movimientos por local en el server cuando hay un
      // local activo, así evitamos traer filas que igual vamos a descartar.
      let movQ=db.from("mp_movimientos").select("*").gte("fecha",desdeTs).lte("fecha",hastaTs).order("fecha",{ascending:false}).limit(5000);
      if(localActivo)movQ=movQ.eq("local_id",localActivo);
      const [credRes,movRes,facRes,gasRes]=await Promise.all([
        db.from("mp_credenciales").select("*,locales(nombre)"),
        movQ,
        db.from("facturas").select("id,nro,fecha,total,local_id,cat,estado").gte("fecha",desde).lte("fecha",hasta).order("fecha",{ascending:false}),
        db.from("gastos").select("id,fecha,categoria,detalle,monto,local_id,cuenta").gte("fecha",desde).lte("fecha",hasta).order("fecha",{ascending:false}),
      ]);
      if(credRes.error)console.warn("mp_credenciales load error:",credRes.error);
      if(movRes.error)console.warn("mp_movimientos load error:",movRes.error);
      if(facRes.error)console.warn("facturas load error:",facRes.error);
      if(gasRes.error)console.warn("gastos load error:",gasRes.error);
      const c=credRes.data||[], m=movRes.data||[], f=facRes.data||[], g=gasRes.data||[];
      console.log("[MP] load:",c.length,"credenciales /",m.length,"movimientos /",f.length,"facturas /",g.length,"gastos");
      setCredenciales(c.filter(x=>!localActivo||x.local_id===localActivo));
      setMovimientos(m);
      setFacturas(f.filter(x=>!localActivo||x.local_id===localActivo));
      setGastos(g.filter(x=>!localActivo||x.local_id===localActivo));
    }catch(e){
      console.error("ConciliacionMP load error:",e);
    }finally{
      setLoading(false);
    }
  };

  useEffect(()=>{load();},[desde,hasta,localActivo]);

  const showToast=(kind,msg)=>{
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
      await new Promise(resolve=>{
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
        const totalMovs=(d.resultados||[]).reduce((s,x)=>s+(Number(x.movimientos)||0),0);
        const saldoTotal=(d.resultados||[]).reduce((s,x)=>s+(Number(x.saldo_disponible)||0),0);
        const csvNoEncontrado=(d.resultados||[]).some(x=>x.release_error&&x.release_error.includes("CSV no encontrado"));
        if(csvNoEncontrado){
          showToast("err","⚠ MercadoPago no generó el reporte a tiempo. Intentá sincronizar de nuevo en unos minutos.");
        }else{
          showToast("ok","Sincronización completada · "+totalMovs+" movimientos · "+fmt_mp(saldoTotal)+" saldo");
        }
      }else{
        showToast("err","⚠ Error procesando: "+(d.error||"desconocido"));
      }
    }catch(e){
      console.error("ConciliacionMP sincronizar error:",e);
      showToast("err","⚠ Error al conectar con MP: "+(e?.message||""));
    }finally{
      setSincronizando(false);
      setSyncCountdown(0);
    }
  };

  const guardarCredencial=async()=>{
    if(!configForm.local_id||!configForm.access_token)return;
    await db.from("mp_credenciales").upsert([{local_id:parseInt(configForm.local_id),access_token:configForm.access_token,activo:true}],{onConflict:"local_id"});
    setConfigModal(false);setConfigForm({local_id:"",access_token:""});load();
  };

  // Borra todos los mp_movimientos de un local y vuelve a sincronizar,
  // así los pagos se re-clasifican con la lógica actual. Útil después
  // de arreglar reglas de clasificación.
  const resetearLocal=async(localId,nombre)=>{
    if(!confirm(`Borrar todos los movimientos MP de ${nombre||"este local"} y re-sincronizar? Esta acción no se puede deshacer.`))return;
    setSincronizando(true);
    try{
      const r=await fetch("/api/mp-sync?reset="+encodeURIComponent(localId),{method:"POST"});
      const d=await r.json();
      console.log("[MP] reset response:",d);
      if(d.ok){
        const resetInfo=(d.reset||[]).map(x=>x.local_id+": "+(x.deleted??x.error)).join(", ");
        await load();
        alert("Reset + sync completados\n"+resetInfo);
      }else{
        alert("Error en reset: "+(d.error||"desconocido"));
      }
    }catch(e){alert("Error al resetear: "+(e?.message||""));}
    setSincronizando(false);
  };

  // Comisiones/impuestos son egresos automáticos y se muestran aparte — no entran en conciliación manual.
  const ES_AUTOMATICO=t=>t==="fee"||t==="tax";

  const ingresos=movimientos.filter(m=>m.monto>0).reduce((s,m)=>s+m.monto,0);
  const egresosList=movimientos.filter(m=>m.monto<0);
  const egresos=egresosList.reduce((s,m)=>s+Math.abs(m.monto),0);
  const comisionesList=egresosList.filter(m=>ES_AUTOMATICO(m.tipo));
  const comisionesTotal=comisionesList.reduce((s,m)=>s+Math.abs(m.monto),0);
  const egresosManualesList=egresosList.filter(m=>!ES_AUTOMATICO(m.tipo));
  const egresosManualesTotal=egresosManualesList.reduce((s,m)=>s+Math.abs(m.monto),0);
  const egresosConciliados=egresosManualesList.filter(m=>m.conciliado).reduce((s,m)=>s+Math.abs(m.monto),0);
  const egresosPendientes=egresosManualesTotal-egresosConciliados;
  const pendientesCount=egresosManualesList.filter(m=>!m.conciliado).length;
  const neto=ingresos-egresos;

  // Ventas presenciales: Point devices (POS físico) - transaction_amount se mapea a monto.
  const ventasPresenciales=movimientos.filter(m=>m.tipo==="point"&&m.monto>0).reduce((s,m)=>s+m.monto,0);
  const ventasOnline=movimientos.filter(m=>m.tipo==="payment"&&m.monto>0).reduce((s,m)=>s+m.monto,0);

  // Saldo real = saldo_inicial (fijado por el usuario) + movimientos
  // aprobados posteriores. /api/mp-sync lo guarda en saldo_disponible.
  const saldoRealDisponible=credenciales.reduce((s,c)=>s+(Number(c.saldo_disponible)||0),0);
  const porAcreditarTotal=credenciales.reduce((s,c)=>s+(Number(c.por_acreditar)||0),0);
  const ultimaActualizacionBalance=credenciales.map(c=>c.balance_at).filter(Boolean).sort().pop();

  const guardarSaldoInicial=async()=>{
    if(!saldoInicialModal||saldoInicialModal.monto===""||saldoInicialModal.monto==null)return;
    if(!saldoInicialModal.local_id)return;
    const monto=parseFloat(saldoInicialModal.monto);
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

  const TIPO_LABELS={
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
  const fmt_mp=n=>new Intl.NumberFormat("es-AR",{style:"currency",currency:"ARS",minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0);

  const getTipoColor=(tipo,monto)=>{
    if(monto>0)return "var(--success)";
    if(tipo==="refund"||tipo==="dispute")return "var(--danger)";
    if(tipo==="fee"||tipo==="tax")return "var(--warn)";
    return "var(--muted2)";
  };

  const abrirConciliar=(mov)=>{
    setConciliarModal(mov);
    setConciliarTab("gasto");
    setVinculoSel("");
    setNuevoGastoForm({categoria:"",detalle:mov.descripcion||""});
  };

  const vincularMovimiento=async(tipo,id)=>{
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
    }]);
    await vincularMovimiento("gasto",nuevoId);
  };

  const desconciliar=async(mov)=>{
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
        <div><div className="ph-title">Conciliación MP</div><div className="ph-sub">MercadoPago · {credenciales.filter(c=>c.activo).length} cuentas conectadas</div></div>
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
        <div className="kpi">
          <div className="kpi-label">Saldo disponible MP</div>
          <div className="kpi-value" style={{color:"var(--acc3)",fontFamily:"'Syne',sans-serif",fontSize:34,fontWeight:800}}>{fmt_mp(saldoRealDisponible)}</div>
          <div className="kpi-sub">{ultimaActualizacionBalance?"Actualizado "+new Date(ultimaActualizacionBalance).toLocaleString("es-AR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):"Ejecutá una sincronización"}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Egresos sin justificar</div>
          <div className="kpi-value kpi-warn" style={{fontFamily:"'Syne',sans-serif",fontSize:34,fontWeight:800}}>{pendientesCount}</div>
          <div className="kpi-sub">{pendientesCount===0?"Todos conciliados ✓":"Requieren conciliación manual"}</div>
        </div>
        {porAcreditarTotal>0&&(
          <div className="kpi">
            <div className="kpi-label">Por acreditar</div>
            <div className="kpi-value kpi-warn" style={{fontSize:28}}>{fmt_mp(porAcreditarTotal)}</div>
            <div className="kpi-sub">Pagos en proceso / pending</div>
          </div>
        )}
      </div>

      <div className="tabs">
        {[["movimientos","Movimientos"],["comisiones","Comisiones MP"]].map(([id,l])=>(
          <div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}</div>
        ))}
      </div>

      {loading?<div className="loading">Cargando...</div>:tab==="movimientos"?(
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Movimientos — {movimientos.filter(m=>!ES_AUTOMATICO(m.tipo)).length} registros</span>
            <span style={{fontSize:11,color:"var(--muted2)"}}>Comisiones en pestaña aparte · se actualiza cada hora</span>
          </div>
          {movimientos.filter(m=>!ES_AUTOMATICO(m.tipo)).length===0?<div className="empty">Sin movimientos. Sincronizá para traer los datos de MP.</div>:(
            <table>
              <thead><tr><th>Fecha</th><th>Local</th><th>Tipo</th><th>Descripción</th><th>Monto</th><th>Saldo</th><th>Conciliación</th></tr></thead>
              <tbody>{movimientos.filter(m=>!ES_AUTOMATICO(m.tipo)).map(m=>{
                const esEgreso=m.monto<0;
                const esAuto=ES_AUTOMATICO(m.tipo);
                const pend=esEgreso&&!esAuto&&!m.conciliado;
                return (
                <tr key={m.id} style={pend?{background:"rgba(239,68,68,0.08)",borderLeft:"2px solid var(--danger)"}:undefined}>
                  <td className="mono" style={{fontSize:11}}>{new Date(m.fecha).toLocaleDateString("es-AR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</td>
                  <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===m.local_id)?.nombre||"—"}</td>
                  <td><span className="badge b-muted">{TIPO_LABELS[m.tipo]||m.tipo||"—"}</span></td>
                  <td style={{fontSize:11,maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.descripcion||"—"}</td>
                  <td><span className="num" style={{color:getTipoColor(m.tipo,m.monto)}}>{m.monto>0?"+":""}{fmt_mp(m.monto)}</span></td>
                  <td style={{color:"var(--muted2)"}}>{fmt_mp(m.saldo)}</td>
                  <td>
                    {!esEgreso?<span style={{fontSize:10,color:"var(--muted)"}}>—</span>:
                      esAuto?<span className="badge b-muted" style={{fontSize:9}}>Automático</span>:
                      m.conciliado?
                        <span style={{display:"flex",gap:4,alignItems:"center"}}>
                          <span className="badge b-success" style={{fontSize:9}}>✓ {m.vinculo_tipo||"ok"}</span>
                          <button className="btn btn-ghost btn-sm" style={{fontSize:9,padding:"2px 6px"}} onClick={()=>desconciliar(m)}>✕</button>
                        </span>
                      :<button className="btn btn-warn btn-sm" style={{fontSize:10,padding:"3px 8px"}} onClick={()=>abrirConciliar(m)}>Conciliar</button>
                    }
                  </td>
                </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
      ):(
        (()=>{
          // Comisiones y retenciones — resumen por tipo de cobro padre.
          // Cada fee/tax referencia al pago original vía referencia_id, y
          // ese pago tiene tipo 'payment' (online) o 'point' (presencial).
          const fees=movimientos.filter(m=>ES_AUTOMATICO(m.tipo));
          const porIdPago=new Map(movimientos.map(m=>[String(m.id),m]));
          let comisionOnline=0, comisionPresencial=0, comisionOtras=0;
          for(const f of fees){
            const parent=porIdPago.get(String(f.referencia_id));
            const monto=Math.abs(Number(f.monto)||0);
            if(parent?.tipo==="point")comisionPresencial+=monto;
            else if(parent?.tipo==="payment")comisionOnline+=monto;
            else comisionOtras+=monto;
          }
          const total=comisionOnline+comisionPresencial+comisionOtras;
          return (
            <div className="panel">
              <div className="panel-hd">
                <span className="panel-title">Comisiones y Retenciones MP</span>
                <span style={{fontSize:11,color:"var(--muted2)"}}>{fees.length} cargos en el período</span>
              </div>
              {total===0?<div className="empty">Sin comisiones en este período</div>:(
                <div style={{padding:"20px 24px",display:"grid",gap:12,gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))"}}>
                  <div className="kpi">
                    <div className="kpi-label">Cobro Online</div>
                    <div className="kpi-value kpi-warn">{fmt_mp(comisionOnline)}</div>
                    <div className="kpi-sub">Comisiones por ventas online</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-label">Presencial</div>
                    <div className="kpi-value kpi-warn">{fmt_mp(comisionPresencial)}</div>
                    <div className="kpi-sub">Comisiones Point / POS</div>
                  </div>
                  <div className="kpi">
                    <div className="kpi-label">Otras comisiones</div>
                    <div className="kpi-value" style={{color:"var(--muted2)"}}>{fmt_mp(comisionOtras)}</div>
                    <div className="kpi-sub">Sin pago padre en el período</div>
                  </div>
                  <div className="kpi" style={{borderLeft:"3px solid var(--danger)"}}>
                    <div className="kpi-label">TOTAL</div>
                    <div className="kpi-value kpi-danger">{fmt_mp(total)}</div>
                    <div className="kpi-sub">Todas las comisiones del período</div>
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
        const montoNum=saldoInicialModal.monto===""||saldoInicialModal.monto==null?null:parseFloat(saldoInicialModal.monto);
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
              <select value={saldoInicialModal.local_id} onChange={e=>setSaldoInicialModal({...saldoInicialModal,local_id:parseInt(e.target.value)||e.target.value})}>
                <option value="">Seleccioná...</option>
                {credenciales.map(c=><option key={c.id} value={c.local_id}>{c.locales?.nombre||`Local ${c.local_id}`}</option>)}
              </select>
            </div>

            {credSel&&(
              <div style={{padding:12,background:"var(--s2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)",marginBottom:12}}>
                <div style={{fontSize:9,letterSpacing:2,textTransform:"uppercase",color:"var(--muted2)",marginBottom:6}}>Saldo calculado actual</div>
                <div className="num" style={{fontSize:22,fontWeight:600,color:"var(--acc3)",fontFamily:"'Syne',sans-serif"}}>{fmt_mp(calculado)}</div>
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
              <div className="num kpi-danger" style={{fontSize:16}}>{fmt_$(conciliarModal.monto)}</div>
            </div>
          </div>
          <div className="tabs" style={{marginBottom:12}}>
            {[["gasto","Gasto existente"],["factura","Factura existente"],["nuevo","Crear Gasto nuevo"]].map(([id,l])=>(
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
                    <span style={{fontSize:10,color:"var(--muted)",marginLeft:8}}>...{c.access_token?.slice(-8)}</span>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    {c.ultima_sync&&<span style={{fontSize:10,color:"var(--success)"}}>✓ Sync {new Date(c.ultima_sync).toLocaleDateString("es-AR")}</span>}
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
