import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasOperables as cuentasOperablesFn } from "../lib/auth";
import { CUENTAS } from "../lib/constants";
import { useCategorias } from "../lib/useCategorias";
import { toISO, today, fmt_d, fmt_$, fmt_dt_ar } from "../lib/utils";
import { computeSaldoMP, pickEffectiveLocalId, type MovParaSaldo } from "../lib/saldoMP";
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

// Row consumida del table mp_movimientos. Cubre los campos que la página
// efectivamente lee — la columna real puede tener más, no rompe (los
// datos vienen via cast desde supabase agnóstico).
interface MpMovimiento {
  id: string;
  tipo: string;
  fecha: string | null;
  monto: number;
  monto_bruto?: number | null;
  medio_pago?: string | null;
  descripcion?: string | null;
  local_id?: number | null;
  anulado?: boolean | null;
  conciliado?: boolean | null;
  referencia_id?: string | null;
  money_release_status?: string | null;
  money_release_date?: string | null;
  // Sistema de justificativos (migration 202605080900). Reemplaza el viejo
  // par conciliado/vinculo_tipo que nunca se llegó a poblar correctamente
  // (vinculo_id estaba tipado UUID pero los ids destino son TEXT). Las RPCs
  // fn_conciliar_mp_con_* setean estas columnas atómicamente.
  justificativo_tipo?: JustifTipo | null;
  justificativo_id?: string | null;
  justificativo_at?: string | null;
  justificativo_por?: number | null;
}

type JustifTipo =
  | 'factura' | 'remito' | 'gasto' | 'egreso_manual'
  | 'movimiento_interno' | 'comision_mp' | 'retiro_automatico';

// Row de mp_credenciales con join 1:1 a locales(nombre). En supabase el
// nested-select de FK 1-1 devuelve el objeto plano (o null si el FK está
// roto / sin match).
interface MpCredencial {
  id: number;
  local_id: number;
  tenant_id: string;
  activo: boolean;
  ultima_sync: string | null;
  access_token_last8: string | null;
  saldo_inicial: number | null;
  saldo_inicial_at: string | null;
  saldo_disponible: number | null;
  por_acreditar: number | null;
  balance_at: string | null;
  locales: { nombre: string } | null;
}

// Partial selects: la página solo trae las columnas usadas para los
// dropdowns "vincular a factura/gasto existente" en el modal de conciliar.
interface FacturaSlim {
  id: string;
  nro: string;
  fecha: string;
  total: number;
  local_id: number;
  cat: string;
  estado: string;
}

interface GastoSlim {
  id: string;
  fecha: string;
  categoria: string;
  subcategoria: string | null;
  detalle: string | null;
  monto: number;
  local_id: number | null;
  cuenta: string | null;
}

interface RemitoSlim {
  id: string;
  nro: string | null;
  fecha: string;
  monto: number;
  local_id: number;
  estado: string | null;
}

// Respuesta de /api/mp-process: array d.resultados con un item por local.
interface MpProcessResultado {
  local_id: number;
  local: string;
  movimientos: number;
  release_rows: number;
  saldo_disponible: number;
  release_error?: string;
  upd_error?: string;
}

// Respuesta de /api/mp-sync?reset: array d.reset con un item por local.
interface MpResetResultado {
  local_id: number;
  deleted?: number;
  error?: string;
}

function ConciliacionMP({ user, locales, localActivo }: ConciliacionMPProps) {
  const { COMISIONES_CATS, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD } = useCategorias();
  const [credenciales,setCredenciales]=useState<MpCredencial[]>([]);
  const [movimientos,setMovimientos]=useState<MpMovimiento[]>([]);
  // pay-* (ingresos + egresos, no anulados) sin filtro de fecha — usados
  // para calcular el saldo MP del header relativo al saldo_inicial_at de
  // cada credencial. Se carga en load() y se filtra cliente-side por local
  // y por fecha > corte. Reemplaza el viejo saldoMpReleasedTotal (acumulado
  // histórico que daba un número 12x inflado).
  const [saldoMovs,setSaldoMovs]=useState<MovParaSaldo[]>([]);
  // Bug 2 — tab "Por cobrar" carga TODOS los pending sin filtro de fecha
  // (datepicker ignorado). Se trae en query separada al load() para no
  // mezclar con la ventana de Ventas/Ingresos.
  const [porCobrarAll,setPorCobrarAll]=useState<MpMovimiento[]>([]);
  const [facturas,setFacturas]=useState<FacturaSlim[]>([]);
  const [remitos,setRemitos]=useState<RemitoSlim[]>([]);
  const [gastos,setGastos]=useState<GastoSlim[]>([]);
  // mp_movs ya conciliados a un gasto en el tenant — sirve para
  // ocultar/marcar gastos que ya tienen un egreso MP linkeado.
  const [gastosConciliadosIds,setGastosConciliadosIds]=useState<Set<string>>(new Set());
  // Filtros del combobox del tab F.
  const [tabFQuery,setTabFQuery]=useState("");
  const [tabFSoloNoConciliados,setTabFSoloNoConciliados]=useState(true);
  const [tabFSugerirSimilares,setTabFSugerirSimilares]=useState(true);
  const [loading,setLoading]=useState(true);
  const [sincronizando,setSincronizando]=useState(false);
  const [conciliando,setConciliando]=useState(false);
  const [toast,setToast]=useState<ToastState | null>(null);
  const [tab,setTab]=useState("ventas");
  // Filtro "solo sin justificar" del tab Egresos. Lo activa también el card
  // del header al click ("X egresos sin justificar" → tab Egresos + filtro).
  const [filtroSinJustif,setFiltroSinJustif]=useState(false);
  // Default: últimos 90 días. El botón "Últ. 30d" del toolbar permite
  // restringir a 30 si el usuario quiere ventana más chica.
  const _hace90=new Date();_hace90.setDate(_hace90.getDate()-90);
  const [desde,setDesde]=useState(toISO(_hace90));
  const [hasta,setHasta]=useState(toISO(today));
  const [configModal,setConfigModal]=useState(false);
  const [configForm,setConfigForm]=useState({local_id:"",access_token:""});
  const [conciliarModal,setConciliarModal]=useState<MpMovimiento | null>(null); // movimiento a conciliar
  // Tabs del modal nuevo (6 tipos): factura/remito/gasto-existente (linking
  // a registros previos) y gasto/egreso_manual/movimiento_interno (crean
  // entidad + linkean atómicamente).
  const [conciliarTab,setConciliarTab]=useState<"factura"|"remito"|"gasto_existente"|"gasto"|"egreso_manual"|"movimiento_interno">("gasto");
  const [nuevoGastoForm,setNuevoGastoForm]=useState({categoria:"",detalle:"",tipo:"variable"});
  const [egresoManualForm,setEgresoManualForm]=useState({detalle:"",cat:""});
  const [movInternoForm,setMovInternoForm]=useState({destino:"",detalle:""});
  const [vinculoSel,setVinculoSel]=useState("");
  // saldoInicialModal: SIN datepicker. El corte usa new Date() en el momento
  // del clic en Guardar. La idea: el usuario fija el saldo "ahora" y entiende
  // que ese es el momento exacto del corte.
  const [saldoInicialModal,setSaldoInicialModal]=useState<{local_id: number, monto: string|number} | null>(null);

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
      // Saldo MP: query sin filtro de fecha (necesitamos pay-* desde antes
      // del rango del datepicker para sumar TODO lo posterior al corte
      // saldo_inicial_at de cada cred). El filtro fecha > corte se hace
      // cliente-side en computeSaldoMP. Versión A: sin filtro de
      // money_release_status (incluye pending + released).
      let saldoMovsQ=db.from("mp_movimientos")
        .select("local_id,monto,fecha,anulado")
        .like("id","pay-%")
        .eq("anulado",false)
        .limit(20000);
      saldoMovsQ=applyLocalScope(saldoMovsQ,user,localActivo);
      // Bug 2 — Tab "Por cobrar" trae TODOS los pending sin filtro de fecha.
      // Datepicker no aplica acá: el cronograma de cobros futuro siempre se
      // muestra completo. Ordenado ASC para mostrar primero el más cercano.
      // Bug 1.5 fix: solo tipo='liquidacion' (cobros). Antes incluía egresos
      // bank_transfer (Lucas pagando a AySA/proveedores) cuyo
      // money_release_status='pending' refleja el saldo del RECEPTOR, no de
      // Lucas. Eso restaba ~\$592k erróneamente al total a cobrar.
      let porCobrarQ=db.from("mp_movimientos")
        .select("*")
        .like("id","pay-%")
        .eq("tipo","liquidacion")
        .eq("money_release_status","pending")
        .eq("anulado",false)
        .order("money_release_date",{ascending:true})
        .limit(2000);
      porCobrarQ=applyLocalScope(porCobrarQ,user,localActivo);
      let facQ=db.from("facturas").select("id,nro,fecha,total,local_id,cat,estado").gte("fecha",desde).lte("fecha",hasta).order("fecha",{ascending:false});
      facQ=applyLocalScope(facQ,user,localActivo);
      let remQ=db.from("remitos").select("id,nro,fecha,monto,local_id,estado").gte("fecha",desde).lte("fecha",hasta).order("fecha",{ascending:false});
      remQ=applyLocalScope(remQ,user,localActivo);
      // Tab F necesita gastos para vincular. Trae ventana ±15d a cada lado del rango
      // para sugerir gastos cercanos a egresos MP del borde sin tener que ampliar
      // el datepicker. cuenta=MercadoPago se prioriza visualmente pero no se filtra
      // — un gasto pagado con efectivo y mal cargado podría ser el correcto link.
      const desdeAmpl=new Date(`${desde}T00:00:00-03:00`);desdeAmpl.setUTCDate(desdeAmpl.getUTCDate()-15);
      const hastaAmpl=new Date(`${hasta}T00:00:00-03:00`);hastaAmpl.setUTCDate(hastaAmpl.getUTCDate()+15);
      const desdeGas=desdeAmpl.toISOString().slice(0,10);
      const hastaGas=hastaAmpl.toISOString().slice(0,10);
      let gasQ=db.from("gastos").select("id,fecha,categoria,subcategoria,detalle,monto,local_id,cuenta").gte("fecha",desdeGas).lte("fecha",hastaGas).order("fecha",{ascending:false}).limit(2000);
      gasQ=applyLocalScope(gasQ,user,localActivo);
      // mp_movimientos ya conciliados a un gasto — para excluirlos del combobox
      // del tab F. Trae solo ids para minimizar payload.
      let mpJustifQ=db.from("mp_movimientos").select("justificativo_id").eq("justificativo_tipo","gasto").not("justificativo_id","is",null).limit(20000);
      mpJustifQ=applyLocalScope(mpJustifQ,user,localActivo);
      const [credRes,movRes,saldoRes,porCobrarRes,facRes,remRes,gasRes,mpJustifRes]=await Promise.all([
        // tenant_id es requerido para el WHERE compuesto del UPDATE de
        // saldo_inicial (defensa-en-profundidad sobre RLS). saldo_inicial /
        // saldo_inicial_at son las que el card del header lee.
        db.from("mp_credenciales").select("id, local_id, tenant_id, activo, ultima_sync, access_token_last8, saldo_inicial, saldo_inicial_at, saldo_disponible, por_acreditar, balance_at, locales(nombre)"),
        movQ,
        saldoMovsQ,
        porCobrarQ,
        facQ,
        remQ,
        gasQ,
        mpJustifQ,
      ]);
      if(credRes.error)console.warn("mp_credenciales load error:",credRes.error);
      if(movRes.error)console.warn("mp_movimientos load error:",movRes.error);
      if(saldoRes.error)console.warn("saldo movs load error:",saldoRes.error);
      if(porCobrarRes.error)console.warn("por cobrar load error:",porCobrarRes.error);
      if(facRes.error)console.warn("facturas load error:",facRes.error);
      if(remRes.error)console.warn("remitos load error:",remRes.error);
      if(gasRes.error)console.warn("gastos load error:",gasRes.error);
      if(mpJustifRes.error)console.warn("mp justif load error:",mpJustifRes.error);
      const c=credRes.data||[], m=movRes.data||[], saldoRows=saldoRes.data||[], pcAll=porCobrarRes.data||[], f=facRes.data||[], r=remRes.data||[], g=gasRes.data||[];
      console.log("[MP] load:",c.length,"credenciales /",m.length,"movimientos /",pcAll.length,"por cobrar (todos) /",saldoRows.length,"pay-* para saldo /",f.length,"facturas /",r.length,"remitos /",g.length,"gastos");
      // Supabase tipa el nested-select locales(nombre) como { nombre }[]
      // (FK genérica), pero en runtime devuelve objeto plano para 1:1.
      // Cast vía unknown — patrón estándar en este codebase para FKs 1-1.
      setCredenciales((c as unknown as MpCredencial[]).filter(x=>!localActivo||x.local_id===localActivo));
      setMovimientos(m as MpMovimiento[]);
      setSaldoMovs(saldoRows as MovParaSaldo[]);
      setPorCobrarAll(pcAll as MpMovimiento[]);
      setFacturas((f as FacturaSlim[]).filter(x=>!localActivo||x.local_id===localActivo));
      setRemitos((r as RemitoSlim[]).filter(x=>!localActivo||x.local_id===localActivo));
      setGastos((g as GastoSlim[]).filter(x=>!localActivo||x.local_id===localActivo));
      setGastosConciliadosIds(new Set(((mpJustifRes.data||[]) as {justificativo_id:string|null}[]).map(x=>String(x.justificativo_id||"")).filter(Boolean)));
    }catch(e){
      console.error("ConciliacionMP load error:",e);
    }finally{
      setLoading(false);
    }
  };

  // Patrón fetch-on-dep-change. No agregar load a deps (re-fetch infinito).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{load();},[desde,hasta,localActivo]);

  const showToast=(kind: "ok"|"err", msg: string)=>{
    setToast({kind,msg});
    setTimeout(()=>setToast(t=>t&&t.msg===msg?null:t),5000);
  };

  const [syncCountdown,setSyncCountdown]=useState(0);

  // Devuelve los headers de auth para los endpoints /api/mp-*. El backend
  // (api/_cron-auth.js) valida el JWT contra Supabase Auth + tabla usuarios
  // y solo deja pasar dueno/admin/cajero/superadmin.
  // DEBUG TEMPORAL — logs de runtime para diagnosticar reportes de "POST sin
  // header authorization en DevTools". Quitar una vez confirmado que llega
  // siempre el JWT al backend (tracking en console del navegador).
  const authHeader = async (): Promise<Record<string, string>> => {
    const { data, error } = await db.auth.getSession();
    console.log("[authHeader] session:", data?.session ? "OK" : "NULL", "error:", error);
    const token = data?.session?.access_token;
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  };

  const sincronizar=async()=>{
    setSincronizando(true);
    setSyncCountdown(120);
    try{
      const auth = await authHeader();
      console.log("[sincronizar] headers a /api/mp-generate:", auth);
      if(!auth.Authorization){
        showToast("err","⚠ Sesión expirada. Recargá la página y volvé a entrar.");
        setSincronizando(false);
        setSyncCountdown(0);
        return;
      }
      // Paso 1: generar CSV (< 5s)
      const genRes=await fetch("/api/mp-generate",{method:"POST",headers:auth});
      const genData=await genRes.json().catch(()=>({ok:false}));
      // TODO(lint-cleanup): Date.now() está dentro de un async event handler
      // (sincronizar()), no durante render — falso positivo del linter.
      // eslint-disable-next-line react-hooks/purity
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
      const procHeaders={"Content-Type":"application/json",...auth};
      console.log("[sincronizar] headers a /api/mp-process:", procHeaders);
      const procRes=await fetch("/api/mp-process",{method:"POST",headers:procHeaders,body:JSON.stringify({ts})});
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
        const totalMovs=(d.resultados||[]).reduce((s: number,x: MpProcessResultado)=>s+(Number(x.movimientos)||0),0);
        const saldoTotal=(d.resultados||[]).reduce((s: number,x: MpProcessResultado)=>s+(Number(x.saldo_disponible)||0),0);
        const csvNoEncontrado=(d.resultados||[]).some((x: MpProcessResultado)=>x.release_error&&x.release_error.includes("CSV no encontrado"));
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
  const resetearLocal=async(localId: number, nombre: string | undefined)=>{
    if(!confirm(`Borrar todos los movimientos MP de ${nombre||"este local"} y re-sincronizar? Esta acción no se puede deshacer.`))return;
    setSincronizando(true);
    try{
      const auth = await authHeader();
      console.log("[resetearLocal] headers a /api/mp-sync:", auth);
      if(!auth.Authorization){
        showToast("err","⚠ Sesión expirada. Recargá la página y volvé a entrar.");
        setSincronizando(false);
        return;
      }
      const r=await fetch("/api/mp-sync?reset="+encodeURIComponent(localId),{method:"POST",headers:auth});
      const d=await r.json();
      console.log("[MP] reset response:",d);
      if(d.ok){
        const resetInfo=(d.reset||[]).map((x: MpResetResultado)=>x.local_id+": "+(x.deleted??x.error)).join(", ");
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
  const dedupedMovs: MpMovimiento[] = (() => {
    const groups = new Map<string, MpMovimiento[]>();
    const sinId: MpMovimiento[] = [];
    for (const m of movimientos) {
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
    const winners: MpMovimiento[] = [];
    for (const arr of groups.values()) {
      arr.sort((a, b) => prio(String(a.id)) - prio(String(b.id)));
      // arr siempre tiene >=1 elemento (lo armamos en el for de arriba con
      // arr.push(m) antes de groups.set). El non-null assertion satisface a TS.
      const w = { ...arr[0]!, _fuentes: arr.map(m => tag(String(m.id))) };
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
  const inRange = (iso: string | null | undefined): boolean => {
    if (!iso) return false;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= desdeMs && t < hastaMsExcl;
  };

  // Tab Ventas — pay-* con fecha (date_created) en rango AR, no anulados.
  // Mitigación M7: filas con money_release_status=NULL aparecen acá igual
  // (no filtramos por release_status), pero NO en Por cobrar / Ingresos.
  //
  // BUG 6 — defensa contra "total bruto inflado":
  //   Tipos en pay-*:
  //     'liquidacion'   → ingreso/venta (collector=ours, monto_bruto>0)
  //     'bank_transfer' → egreso/compra desde MP (monto_bruto<0 post-fix
  //                       36a5716 + migration 202605030100)
  //   Si la migration historica no se corrió, los egresos viejos pueden
  //   tener monto_bruto>0 e inflar SUM. Excluimos tipo='bank_transfer' para
  //   que esto no afecte el total — Tab "Ventas" debe ser solo ventas.
  const ventasMovs = movimientos.filter(m =>
    String(m.id || '').startsWith('pay-') &&
    m.tipo !== 'bank_transfer' &&
    inRange(m.fecha) &&
    m.anulado !== true
  );
  // Bug 1 fix C — solo sumamos rows con monto_bruto poblado. Las que tienen
  // NULL se cuentan separadas en ventasSinBrutoCount para mostrar warning.
  const ventasConBruto = ventasMovs.filter(m => m.monto_bruto != null);
  const ventasSinBrutoCount = ventasMovs.length - ventasConBruto.length;
  const ventasBruto = ventasConBruto.reduce((s, m) => s + (Number(m.monto_bruto) || 0), 0);
  const ventasNeto = ventasMovs.reduce((s, m) => s + (Number(m.monto) || 0), 0);
  const ventasCount = ventasMovs.length;
  const ventasTicketProm = ventasConBruto.length > 0 ? ventasBruto / ventasConBruto.length : 0;

  // Tab Por cobrar — Bug 2 fix: usa porCobrarAll (query separada en load(),
  // SIN filtro de fecha) en lugar de filtrar `movimientos` por inRange. El
  // datepicker NO afecta este tab — se muestra el cronograma completo.
  const porCobrarMovs = porCobrarAll;
  const porCobrarTotal = porCobrarMovs.reduce((s, m) => s + (Number(m.monto) || 0), 0);
  const proximaFechaRelease = porCobrarMovs
    .map(m => m.money_release_date)
    .filter(Boolean)
    .sort()[0] || null;

  // Tab Ingresos al saldo — pay-* released con money_release_date en rango
  const ingresosMovs = movimientos.filter(m =>
    String(m.id || '').startsWith('pay-') &&
    m.money_release_status === 'released' &&
    inRange(m.money_release_date) &&
    m.anulado !== true
  );
  const ingresosTotal = ingresosMovs.reduce((s, m) => s + (Number(m.monto) || 0), 0);
  const ingresosCount = ingresosMovs.length;

  // Egresos manuales en rango (no anulados, no automáticos). Es la base
  // del nuevo tab "Egresos" — independiente de si están justificados o no.
  const egresosManuales = dedupedMovs.filter(m =>
    Number(m.monto) < 0 &&
    !ES_AUTOMATICO(m.tipo) &&
    m.anulado !== true &&
    inRange(m.fecha)
  ).sort((a,b)=>String(b.fecha||'').localeCompare(String(a.fecha||'')));

  // Subconjunto sin justificar — alimenta KPI header + filtro del tab.
  const egresosPendientesList = egresosManuales.filter(m => !m.justificativo_tipo);
  const pendientesCount = egresosPendientesList.length;

  const porAcreditarTotal = credenciales.reduce((s, c) => s + (Number(c.por_acreditar) || 0), 0);

  // ─── Saldo MP del header ───────────────────────────────────────────────
  // Lógica:
  //   1. visibleLocalIds = creds que el user ve (RLS ya filtró).
  //   2. effectiveLocalId = el local activo a mostrar (ver pickEffectiveLocalId).
  //   3. Si null y >1 local visible → "Seleccioná un local primero".
  //   4. Si la cred no tiene saldo_inicial_at → "Fijar saldo inicial".
  //   5. Si la cred lo tiene → saldo_inicial + SUM(monto WHERE fecha > corte).
  const visibleLocalIds = credenciales.map(c => Number(c.local_id)).filter(Number.isFinite);
  const effectiveLocalId = pickEffectiveLocalId(localActivo, visibleLocalIds);
  const credActiva = effectiveLocalId != null
    ? credenciales.find(c => c.local_id === effectiveLocalId)
    : null;
  const saldoCalc = credActiva
    ? computeSaldoMP({
        saldoInicial: credActiva.saldo_inicial,
        saldoInicialAt: credActiva.saldo_inicial_at,
        movs: saldoMovs,
        localId: effectiveLocalId as number,
      })
    : null;
  const necesitaSeleccionLocal = effectiveLocalId == null && visibleLocalIds.length > 1;
  const necesitaFijarInicial = credActiva != null && saldoCalc != null && saldoCalc.motivo === 'sin_corte';

  const guardarSaldoInicial=async()=>{
    if(!saldoInicialModal||saldoInicialModal.monto===""||saldoInicialModal.monto==null)return;
    if(!saldoInicialModal.local_id)return;
    const monto=parseFloat(String(saldoInicialModal.monto));
    if(Number.isNaN(monto))return;
    // El corte se fija EN ESTE PRECISO MOMENTO (timestamp del clic). El
    // usuario debe haber visto el saldo en MP UI antes de abrir el modal
    // para garantizar coherencia. Refijar más tarde mueve el corte y
    // reinicia automáticamente la suma (filtro fecha > saldo_inicial_at
    // descarta movs previos sin tocarlos).
    const corteIso=new Date().toISOString();
    // Defensa-en-profundidad: tenant_id + local_id en el WHERE además de
    // RLS. Si por alguna razón RLS no estuviese activo o el user tuviese
    // scope ampliado, esto evita que se sobrescriba un saldo de otro
    // tenant accidentalmente.
    const credSel=credenciales.find(c=>c.local_id===saldoInicialModal.local_id);
    if(!credSel){
      alert("No se encontró la credencial del local seleccionado.");
      return;
    }
    const {error}=await db.from("mp_credenciales").update({
      saldo_inicial:monto,
      saldo_inicial_at:corteIso,
    })
      .eq("local_id",saldoInicialModal.local_id)
      .eq("tenant_id",credSel.tenant_id);
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

  // ─── Wrappers de las RPCs fn_conciliar_mp_con_* ───────────────────────────
  // Cada wrapper cierra el modal + recarga al éxito; en error muestra toast
  // y deja el modal abierto para reintento.
  const cerrarConciliar=()=>{
    setConciliarModal(null);
    setVinculoSel("");
    setNuevoGastoForm({categoria:"",detalle:"",tipo:"variable"});
    setEgresoManualForm({detalle:"",cat:""});
    setMovInternoForm({destino:"",detalle:""});
    setConciliarTab("gasto");
  };

  const justificarConExistente=async(tipo:"factura"|"remito"|"gasto",justifId:string)=>{
    if(!conciliarModal||!justifId)return;
    setConciliando(true);
    const {error}=await db.rpc("fn_conciliar_mp_con_existente",{
      p_mp_mov_id:conciliarModal.id, p_tipo:tipo, p_justif_id:justifId,
    });
    setConciliando(false);
    if(error){showToast("err","No se pudo conciliar: "+error.message);return;}
    showToast("ok","Egreso justificado contra "+tipo);
    cerrarConciliar(); load();
  };

  const justificarConGastoNuevo=async()=>{
    if(!conciliarModal||!nuevoGastoForm.categoria)return;
    setConciliando(true);
    const {error}=await db.rpc("fn_conciliar_mp_con_gasto",{
      p_mp_mov_id:conciliarModal.id,
      p_gasto_data:{categoria:nuevoGastoForm.categoria, detalle:nuevoGastoForm.detalle, tipo:nuevoGastoForm.tipo},
    });
    setConciliando(false);
    if(error){showToast("err","No se pudo crear el gasto: "+error.message);return;}
    showToast("ok","Gasto creado y conciliado");
    cerrarConciliar(); load();
  };

  const justificarConEgresoManual=async()=>{
    if(!conciliarModal)return;
    setConciliando(true);
    const {error}=await db.rpc("fn_conciliar_mp_con_egreso_manual",{
      p_mp_mov_id:conciliarModal.id,
      p_egreso_data:{detalle:egresoManualForm.detalle, cat:egresoManualForm.cat},
    });
    setConciliando(false);
    if(error){showToast("err","No se pudo crear el egreso: "+error.message);return;}
    showToast("ok","Egreso manual creado y conciliado");
    cerrarConciliar(); load();
  };

  const justificarConGastoExistente=async(gastoId:string)=>{
    if(!conciliarModal||!gastoId)return;
    setConciliando(true);
    const {data,error}=await db.rpc("fn_conciliar_mp_con_gasto_existente",{
      p_mp_mov_id:conciliarModal.id, p_gasto_id:gastoId,
    });
    setConciliando(false);
    if(error){showToast("err","No se pudo vincular: "+error.message);return;}
    // RPC devuelve {warning:string|null}. Si hay warning de monto, lo
    // mostramos como info en lugar de éxito plano — la conciliación
    // sí ocurrió, Lucas debe estar consciente de la diferencia.
    const warning=(data as {warning?:string|null}|null)?.warning||null;
    showToast(warning?"err":"ok",warning?("Vinculado con discrepancia: "+warning):"Egreso vinculado al gasto existente");
    cerrarConciliar(); load();
  };

  const justificarConMovimientoInterno=async()=>{
    if(!conciliarModal||!movInternoForm.destino)return;
    setConciliando(true);
    const {error}=await db.rpc("fn_conciliar_mp_con_movimiento_interno",{
      p_mp_mov_id:conciliarModal.id,
      p_destino_cuenta:movInternoForm.destino,
      p_detalle:movInternoForm.detalle||null,
    });
    setConciliando(false);
    if(error){showToast("err","No se pudo registrar la transferencia: "+error.message);return;}
    showToast("ok","Transferencia registrada");
    cerrarConciliar(); load();
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
          <button className="btn btn-ghost" onClick={()=>setSaldoInicialModal({local_id:effectiveLocalId??(credenciales[0]?.local_id||0),monto:""})}>⚙ Fijar saldo inicial</button>
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
        {/* Saldo MP — saldo_inicial + SUM(monto WHERE fecha > saldo_inicial_at).
            Valor relativo al corte fijado por el user, no acumulado histórico. */}
        <div className="kpi">
          <div className="kpi-label" style={{color:"var(--muted)"}}>Saldo MP</div>
          {loading ? (
            <div className="kpi-value" style={{color:"var(--muted2)",fontSize:18,fontWeight:500,opacity:0.4}}>—</div>
          ) : necesitaSeleccionLocal ? (
            <>
              <div className="kpi-value" style={{color:"var(--muted2)",fontSize:13,fontWeight:500}}>
                Seleccioná un local
              </div>
              <div className="kpi-sub">Cambiá de local en el sidebar para ver su saldo</div>
            </>
          ) : !credActiva ? (
            <>
              <div className="kpi-value" style={{color:"var(--muted2)",fontSize:13,fontWeight:500}}>
                Sin credencial MP
              </div>
              <div className="kpi-sub">Configurá la cuenta MP del local primero</div>
            </>
          ) : necesitaFijarInicial ? (
            <>
              <div className="kpi-value" style={{color:"var(--muted2)",fontSize:13,fontWeight:500}}>
                Fijar saldo inicial primero
              </div>
              <button
                className="btn btn-ghost btn-sm"
                style={{fontSize:10,marginTop:6}}
                onClick={()=>setSaldoInicialModal({local_id:credActiva.local_id,monto:""})}
              >
                ⚙ Fijar saldo inicial
              </button>
            </>
          ) : (
            <>
              <div className="kpi-value" style={{color:"var(--muted2)",fontFamily:"'Inter',sans-serif",fontSize:18,fontWeight:500}}>
                {fmt_mp(saldoCalc?.total ?? 0)}
              </div>
              <div className="kpi-sub" style={{fontSize:10,color:"var(--muted2)"}}>
                Inicial {fmt_mp(Number(credActiva.saldo_inicial)||0)} fijado el {fmt_dt_ar(credActiva.saldo_inicial_at)}
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          className="kpi"
          style={{cursor:pendientesCount>0?"pointer":"default",textAlign:"left",border:pendientesCount>0?"1px solid var(--bd2)":undefined,background:"transparent",padding:"inherit"}}
          onClick={()=>{ if(pendientesCount>0){ setTab("egresos"); setFiltroSinJustif(true); } }}
          aria-label={pendientesCount>0?"Ir a tab Egresos con filtro sin justificar":undefined}
        >
          <div className="kpi-label">Egresos sin justificar</div>
          <div className={`kpi-value ${pendientesCount>0?"kpi-danger":""}`} style={{fontFamily:"'Inter',sans-serif",fontSize:18,fontWeight:500}}>{pendientesCount}</div>
          <div className="kpi-sub">{pendientesCount===0?"Todos conciliados ✓":"Click para revisar"}</div>
        </button>
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
          ["egresos","Egresos"],
          ["comisiones","Comisiones MP"],
        ] as [string, string][]).map(([id,l])=>(
          <div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}{id==="egresos"&&pendientesCount>0?<span className="badge b-danger" style={{marginLeft:6,fontSize:9}}>{pendientesCount}</span>:null}</div>
        ))}
      </div>

      {loading?<div className="loading">Cargando...</div>:tab==="ventas"?(
        // ─── Tab VENTAS — pay-* con date_created en rango AR (M2 etiqueta bruto) ─
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Ventas — {ventasCount} cobros</span>
            <span style={{fontSize:11,color:"var(--muted2)"}}>Filtra por fecha de venta · monto en bruto</span>
          </div>
          {ventasSinBrutoCount > 0 && (
            <div className="alert alert-warn" style={{margin:"12px 16px",fontSize:11}}>
              ⚠ {ventasSinBrutoCount} {ventasSinBrutoCount===1?"venta sin":"ventas sin"} monto bruto en el período — esperá próximo cron diario
            </div>
          )}
          <div style={{padding:"16px 20px",display:"grid",gap:10,gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))"}}>
            <div className="kpi">
              <div className="kpi-label">Total bruto</div>
              <div className="kpi-value kpi-success" style={{fontSize:16}}>{fmt_mp(ventasBruto)}</div>
              <div className="kpi-sub">{ventasSinBrutoCount>0?`Excluye ${ventasSinBrutoCount} sin bruto`:"Cobrado del cliente"}</div>
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
                  <td style={{textAlign:"right"}}>
                    {m.monto_bruto != null
                      ? <span className="num kpi-success">{fmt_mp(Number(m.monto_bruto)||0)}</span>
                      : <span style={{color:"var(--muted)",fontSize:11}} title="Falta monto bruto — esperá próximo cron">—</span>}
                  </td>
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
        // ─── Tab POR COBRAR — TODOS los pay-* pending (Bug 2 fix) ─────────────
        // No filtra por rango del datepicker. Cronograma completo de cobros
        // pendientes de liberación, ordenado ASC por fecha de release.
        <div className="panel">
          <div className="panel-hd">
            <span className="panel-title">Por cobrar — {porCobrarMovs.length} cobros pendientes de liberación</span>
            <span style={{fontSize:11,color:"var(--muted2)"}}>Cronograma completo · ignora datepicker · monto neto</span>
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
              <div className="kpi-sub">Fecha más cercana</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Cantidad</div>
              <div className="kpi-value" style={{fontSize:16}}>{porCobrarMovs.length}</div>
              <div className="kpi-sub">Pagos pending</div>
            </div>
          </div>
          {porCobrarMovs.length===0?<div className="empty">Sin pagos pendientes. Todo está liberado al saldo ✓</div>:(
            <table>
              <thead><tr>
                <th>Release</th><th>Fecha venta</th><th>Local</th><th>Medio</th>
                <th>Descripción</th><th style={{textAlign:"right"}}>Neto</th>
              </tr></thead>
              <tbody>{porCobrarMovs.map(m=>(
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
              <tbody>{ingresosMovs.sort((a,b)=>String(b.money_release_date).localeCompare(String(a.money_release_date))).map(m=>(
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
      ):tab==="egresos"?(
        // ─── Tab EGRESOS — egresos manuales en rango (sin fee/tax) ────────────
        // El brief: cualquier usuario con acceso al módulo puede conciliar.
        // Cada fila tiene botón "Conciliar" si justificativo_tipo es null.
        // Si está justificado, badge con tipo en la última columna.
        (()=>{
          const lista = filtroSinJustif ? egresosManuales.filter(m=>!m.justificativo_tipo) : egresosManuales;
          const totalLista = lista.reduce((s,m)=>s+Math.abs(Number(m.monto)||0),0);
          return (
            <div className="panel">
              <div className="panel-hd" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  <span className="panel-title">Egresos — {lista.length} {lista.length===1?"egreso":"egresos"}{filtroSinJustif?" sin justificar":""}</span>
                  <span style={{fontSize:11,color:"var(--muted2)"}}>Transferencias y pagos del período · monto neto</span>
                </div>
                <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,cursor:"pointer",userSelect:"none",color:"var(--muted2)"}}>
                  <input type="checkbox" checked={filtroSinJustif} onChange={e=>setFiltroSinJustif(e.target.checked)} style={{cursor:"pointer"}}/>
                  Solo sin justificar
                </label>
              </div>
              <div style={{padding:"16px 20px",display:"grid",gap:10,gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))"}}>
                <div className="kpi">
                  <div className="kpi-label">Total egresado</div>
                  <div className="kpi-value kpi-danger" style={{fontSize:16}}>{fmt_mp(totalLista)}</div>
                  <div className="kpi-sub">{filtroSinJustif?"Solo sin justificar":"Manuales (sin comisiones)"}</div>
                </div>
                <div className="kpi">
                  <div className="kpi-label">Sin justificar</div>
                  <div className="kpi-value kpi-warn" style={{fontSize:16}}>{pendientesCount}</div>
                  <div className="kpi-sub">{pendientesCount===0?"Todos justificados ✓":"Requieren conciliación"}</div>
                </div>
              </div>
              {lista.length===0?<div className="empty">{filtroSinJustif?"Sin egresos pendientes. Todo justificado ✓":"Sin egresos manuales en el período."}</div>:(
                <table>
                  <thead><tr>
                    <th>Fecha</th><th>Local</th><th>Tipo</th><th>Descripción</th>
                    <th style={{textAlign:"right"}}>Monto</th><th>Justif.</th><th></th>
                  </tr></thead>
                  <tbody>{lista.map(m=>(
                    <tr key={m.id}>
                      <td className="mono" style={{fontSize:11}}>{fmt_d(String(m.fecha||"").slice(0,10))}</td>
                      <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>l.id===m.local_id)?.nombre||"—"}</td>
                      <td><span className="badge b-muted" style={{fontSize:9}}>{TIPO_LABELS[m.tipo]||m.tipo}</span></td>
                      <td style={{fontSize:11,maxWidth:240,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.descripcion||"—"}</td>
                      <td style={{textAlign:"right"}}><span className="num kpi-danger">{fmt_mp(Number(m.monto)||0)}</span></td>
                      <td>{m.justificativo_tipo
                        ?<span className="badge b-success" style={{fontSize:9}}>{m.justificativo_tipo.replace('_',' ')}</span>
                        :<span className="badge b-danger" style={{fontSize:9}}>sin justificar</span>}</td>
                      <td>{!m.justificativo_tipo && <button className="btn btn-acc btn-sm" style={{fontSize:10,padding:"4px 10px"}} onClick={()=>setConciliarModal(m)}>Conciliar</button>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
            </div>
          );
        })()
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
          const porPaymentId=new Map<string, MpMovimiento>();
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
        return (
        <div className="overlay" onClick={()=>setSaldoInicialModal(null)}><div className="modal" style={{width:560}} onClick={e=>e.stopPropagation()}>
          <div className="modal-hd"><div className="modal-title">Fijar saldo inicial MP</div><button className="close-btn" onClick={()=>setSaldoInicialModal(null)}>✕</button></div>
          <div className="modal-body">
            <div className="alert alert-warn" style={{marginBottom:12,fontSize:12,lineHeight:1.5}}>
              <strong>Este es el saldo de MP en este preciso momento.</strong> PASE va a sumar/restar todos los movimientos posteriores. Si en MP UI faltan ingresos/egresos del día por mostrar, esperá a que aparezcan antes de fijar.
            </div>
            <div className="field">
              <label>Local</label>
              <select value={saldoInicialModal.local_id} onChange={e=>setSaldoInicialModal({...saldoInicialModal,local_id:parseInt(e.target.value)||0})}>
                <option value="">Seleccioná...</option>
                {credenciales.map(c=><option key={c.id} value={c.local_id}>{c.locales?.nombre||`Local ${c.local_id}`}</option>)}
              </select>
            </div>

            <div className="field">
              <label>Saldo real en MP $</label>
              <input type="number" autoFocus value={saldoInicialModal.monto} onChange={e=>setSaldoInicialModal({...saldoInicialModal,monto:e.target.value})} placeholder="0"/>
            </div>

            {credSel&&credSel.saldo_inicial_at&&(
              <div style={{fontSize:11,color:"var(--muted2)",marginTop:4,padding:"8px 10px",background:"var(--s2)",borderRadius:"var(--r)"}}>
                Saldo previo: {fmt_mp(Number(credSel.saldo_inicial)||0)} fijado el {fmt_dt_ar(credSel.saldo_inicial_at)}. Al guardar se reemplaza y el corte se mueve a este momento.
              </div>
            )}
          </div>
          <div className="modal-ft">
            <button className="btn btn-sec" onClick={()=>setSaldoInicialModal(null)}>Cancelar</button>
            <button className="btn btn-acc" disabled={!saldoInicialModal.local_id||saldoInicialModal.monto===""} onClick={guardarSaldoInicial}>Guardar</button>
          </div>
        </div></div>
        );
      })()}

      {conciliarModal&&(<div className="overlay" onClick={cerrarConciliar}><div className="modal" style={{width:680}} onClick={e=>e.stopPropagation()}>
        <div className="modal-hd"><div className="modal-title">Conciliar egreso MP</div><button className="close-btn" onClick={cerrarConciliar}>✕</button></div>
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
          <div className="tabs" style={{marginBottom:12,flexWrap:"wrap"}}>
            {([
              ["factura","A · Factura existente"],
              ["remito","B · Remito existente"],
              ["gasto","C · Gasto nuevo"],
              ["egreso_manual","D · Egreso manual"],
              ["movimiento_interno","E · Mov. interno"],
              ["gasto_existente","F · Gasto existente"],
            ] as [typeof conciliarTab, string][]).map(([id,l])=>(
              <div key={id} className={`tab ${conciliarTab===id?"active":""}`} onClick={()=>{setConciliarTab(id);setVinculoSel("");setTabFQuery("");}}>{l}</div>
            ))}
          </div>
          {conciliarTab==="factura"&&(
            <div>
              <div className="field"><label>Seleccioná la factura</label>
                <select value={vinculoSel} onChange={e=>setVinculoSel(e.target.value)}>
                  <option value="">— Elegir factura —</option>
                  {facturas.map(f=><option key={f.id} value={f.id}>{fmt_d(f.fecha)} · #{f.nro} · {fmt_$(f.total)} · {f.estado}</option>)}
                </select>
              </div>
              {facturas.length===0&&<div style={{fontSize:11,color:"var(--muted2)"}}>No hay facturas cargadas en el período. Probá con remito, gasto nuevo o egreso manual.</div>}
            </div>
          )}
          {conciliarTab==="remito"&&(
            <div>
              <div className="field"><label>Seleccioná el remito</label>
                <select value={vinculoSel} onChange={e=>setVinculoSel(e.target.value)}>
                  <option value="">— Elegir remito —</option>
                  {remitos.map(r=><option key={r.id} value={r.id}>{fmt_d(r.fecha)} · #{r.nro||r.id.slice(-6)} · {fmt_$(r.monto)} · {r.estado||""}</option>)}
                </select>
              </div>
              {remitos.length===0&&<div style={{fontSize:11,color:"var(--muted2)"}}>No hay remitos cargados en el período.</div>}
            </div>
          )}
          {conciliarTab==="gasto_existente"&&(()=>{
            // Tab F — Vincular a un gasto ya cargado en PASE. La RPC
            // fn_conciliar_mp_con_gasto_existente devuelve warning si los
            // montos no coinciden (no bloquea). El combobox sugiere por
            // monto similar (±5%) y fecha cercana (±7d) cuando el toggle
            // "Sugerir similares" está activo.
            const mpMonto=Math.abs(Number(conciliarModal.monto)||0);
            const mpFechaTs=conciliarModal.fecha?new Date(conciliarModal.fecha).getTime():0;
            const SIETE_DIAS_MS=7*24*60*60*1000;
            const tol=mpMonto*0.05;
            const q=tabFQuery.trim().toLowerCase();
            const lista=gastos
              .filter(g=>!tabFSoloNoConciliados||!gastosConciliadosIds.has(g.id))
              .filter(g=>{
                if(!q)return true;
                const hay=(g.detalle||"")+" "+g.categoria+" "+(g.subcategoria||"")+" "+(g.cuenta||"");
                return hay.toLowerCase().includes(q);
              })
              .map(g=>{
                // Score: cercanía de monto y fecha. Solo se usa para ordenar
                // si "Sugerir similares" está activo. 0 = match exacto.
                const dMonto=Math.abs(Number(g.monto)-mpMonto);
                const dFecha=mpFechaTs?Math.abs(new Date(g.fecha).getTime()-mpFechaTs):Infinity;
                const cercanoMonto=dMonto<=tol;
                const cercanoFecha=dFecha<=SIETE_DIAS_MS;
                const score=(cercanoMonto?0:1000)+(cercanoFecha?0:100)+dMonto/Math.max(mpMonto,1);
                return {...g,_score:score,_cercanoMonto:cercanoMonto,_cercanoFecha:cercanoFecha};
              })
              .sort((a,b)=>tabFSugerirSimilares?(a._score-b._score):(String(b.fecha).localeCompare(String(a.fecha))))
              .slice(0,200);
            const sugeridos=lista.filter(g=>g._cercanoMonto&&g._cercanoFecha).length;
            return (
              <div>
                <div className="alert alert-warn" style={{marginBottom:12}}>Linkea este egreso MP de {fmt_$(mpMonto)} a un gasto ya cargado. Si el monto no coincide queda warning pero la conciliación se aplica igual.</div>
                <div className="field"><label>Buscar por categoría / detalle / cuenta</label>
                  <input value={tabFQuery} onChange={e=>setTabFQuery(e.target.value)} placeholder="Aysa, Metrogas, sueldo..."/>
                </div>
                <div style={{display:"flex",gap:14,marginBottom:8,fontSize:11,color:"var(--muted2)"}}>
                  <label style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer"}}>
                    <input type="checkbox" checked={tabFSoloNoConciliados} onChange={e=>setTabFSoloNoConciliados(e.target.checked)}/>
                    Solo gastos no conciliados
                  </label>
                  <label style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer"}}>
                    <input type="checkbox" checked={tabFSugerirSimilares} onChange={e=>setTabFSugerirSimilares(e.target.checked)}/>
                    Sugerir similares (±5% monto / ±7d fecha)
                  </label>
                  {sugeridos>0&&<span className="badge b-success" style={{fontSize:9}}>{sugeridos} sugeridos</span>}
                </div>
                <div className="field"><label>Gasto a vincular</label>
                  <select value={vinculoSel} onChange={e=>setVinculoSel(e.target.value)} size={Math.min(8,Math.max(3,lista.length))} style={{height:"auto"}}>
                    {lista.length===0?<option value="" disabled>— Sin gastos disponibles —</option>:lista.map(g=>{
                      const flag=g._cercanoMonto&&g._cercanoFecha?"⭐ ":g._cercanoMonto?"💲 ":g._cercanoFecha?"📅 ":"";
                      return <option key={g.id} value={g.id}>{flag}{fmt_d(g.fecha)} · {g.categoria}{g.subcategoria?" / "+g.subcategoria:""} · {fmt_$(g.monto)} · {g.cuenta||"—"} · {g.detalle||""}</option>;
                    })}
                  </select>
                </div>
                {gastos.length===0&&<div style={{fontSize:11,color:"var(--muted2)"}}>No hay gastos cargados en el período (incluye ±15 días). Probá ampliando el datepicker o cargando el gasto desde la pestaña Gastos.</div>}
              </div>
            );
          })()}
          {conciliarTab==="gasto"&&(
            <div>
              <div className="alert alert-warn" style={{marginBottom:12}}>Crea un gasto por {fmt_$(Math.abs(conciliarModal.monto||0))} (cuenta MercadoPago) y lo vincula. Movimiento contable atómico.</div>
              <div className="field"><label>Categoría *</label>
                <select value={nuevoGastoForm.categoria} onChange={e=>setNuevoGastoForm({...nuevoGastoForm,categoria:e.target.value})}>
                  <option value="">Seleccioná...</option>
                  {[...GASTOS_VARIABLES,...GASTOS_FIJOS,...GASTOS_PUBLICIDAD,...COMISIONES_CATS].map(c=><option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="field"><label>Tipo</label>
                <select value={nuevoGastoForm.tipo} onChange={e=>setNuevoGastoForm({...nuevoGastoForm,tipo:e.target.value})}>
                  <option value="variable">Variable</option>
                  <option value="fijo">Fijo</option>
                  <option value="publicidad">Publicidad</option>
                  <option value="comision">Comisión</option>
                </select>
              </div>
              <div className="field"><label>Detalle</label><input value={nuevoGastoForm.detalle} onChange={e=>setNuevoGastoForm({...nuevoGastoForm,detalle:e.target.value})} placeholder={conciliarModal.descripcion||"Descripción..."}/></div>
            </div>
          )}
          {conciliarTab==="egreso_manual"&&(
            <div>
              <div className="alert alert-warn" style={{marginBottom:12}}>Crea solo un movimiento contable (sin gasto categorizado) por {fmt_$(Math.abs(conciliarModal.monto||0))}. Para egresos sueltos sin imputación específica.</div>
              <div className="field"><label>Categoría / etiqueta libre</label><input value={egresoManualForm.cat} onChange={e=>setEgresoManualForm({...egresoManualForm,cat:e.target.value})} placeholder="EGRESO_MANUAL"/></div>
              <div className="field"><label>Detalle</label><input value={egresoManualForm.detalle} onChange={e=>setEgresoManualForm({...egresoManualForm,detalle:e.target.value})} placeholder={conciliarModal.descripcion||"Descripción..."}/></div>
            </div>
          )}
          {conciliarTab==="movimiento_interno"&&(
            <div>
              <div className="alert alert-warn" style={{marginBottom:12}}>Refleja una transferencia entre cuentas propias: baja MercadoPago y sube la cuenta destino. Crea 2 movimientos atómicamente.</div>
              <div className="field"><label>Cuenta destino *</label>
                <select value={movInternoForm.destino} onChange={e=>setMovInternoForm({...movInternoForm,destino:e.target.value})}>
                  <option value="">Seleccioná la cuenta receptora...</option>
                  {(()=>{const op=cuentasOperablesFn(user); const list=op===null?CUENTAS:op; return list.filter(c=>c!=="MercadoPago").map(c=><option key={c} value={c}>{c}</option>);})()}
                </select>
              </div>
              <div className="field"><label>Detalle</label><input value={movInternoForm.detalle} onChange={e=>setMovInternoForm({...movInternoForm,detalle:e.target.value})} placeholder={`Transferencia MP → ${movInternoForm.destino||"…"}`}/></div>
            </div>
          )}
        </div>
        <div className="modal-ft">
          <button className="btn btn-sec" onClick={cerrarConciliar} disabled={conciliando}>Cancelar</button>
          {conciliarTab==="factura"||conciliarTab==="remito"?
            <button className="btn btn-acc" disabled={!vinculoSel||conciliando} onClick={()=>justificarConExistente(conciliarTab,vinculoSel)}>{conciliando?"Conciliando...":"Vincular"}</button>
          :conciliarTab==="gasto_existente"?
            <button className="btn btn-acc" disabled={!vinculoSel||conciliando} onClick={()=>justificarConGastoExistente(vinculoSel)}>{conciliando?"Vinculando...":"Vincular y conciliar"}</button>
          :conciliarTab==="gasto"?
            <button className="btn btn-acc" disabled={!nuevoGastoForm.categoria||conciliando} onClick={justificarConGastoNuevo}>{conciliando?"Creando...":"Crear gasto y conciliar"}</button>
          :conciliarTab==="egreso_manual"?
            <button className="btn btn-acc" disabled={conciliando} onClick={justificarConEgresoManual}>{conciliando?"Creando...":"Registrar egreso y conciliar"}</button>
          :
            <button className="btn btn-acc" disabled={!movInternoForm.destino||conciliando} onClick={justificarConMovimientoInterno}>{conciliando?"Registrando...":"Registrar transferencia"}</button>
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