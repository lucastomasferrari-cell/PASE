import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasOperables as cuentasOperablesFn } from "../lib/auth";
import { CUENTAS } from "../lib/constants";
import { useCategorias } from "../lib/useCategorias";
import { toISO, today, fmt_d, fmt_$, fmt_dt_ar } from "../lib/utils";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { Combobox } from "../components/Combobox";
import type { Usuario, Local } from "../types";
import type { Proveedor } from "../types/finanzas";

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
  // Migration 202605111900: "ignorado" marca egresos que no requieren
  // conciliación (reverso, duplicado, etc.). Excluidos del KPI sin-justificar.
  ignorado?: boolean | null;
  ignorado_motivo?: string | null;
  ignorado_at?: string | null;
  ignorado_por?: number | null;
}

type JustifTipo =
  | 'factura' | 'remito' | 'gasto' | 'egreso_manual'
  | 'movimiento_interno' | 'comision_mp' | 'retiro_automatico'
  | 'multi_factura';

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
// prov_id se trae para mostrar el nombre del proveedor en el dropdown
// (mucho más útil que solo el número de factura).
interface FacturaSlim {
  id: string;
  nro: string;
  fecha: string;
  total: number;
  local_id: number;
  prov_id: number | null;
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
  prov_id: number | null;
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
  const { COMISIONES_CATS, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, GASTOS_IMPUESTOS, RETIROS_SOCIOS, categoriaToTipo } = useCategorias();
  const [credenciales,setCredenciales]=useState<MpCredencial[]>([]);
  const [movimientos,setMovimientos]=useState<MpMovimiento[]>([]);
  const [facturas,setFacturas]=useState<FacturaSlim[]>([]);
  const [remitos,setRemitos]=useState<RemitoSlim[]>([]);
  const [gastos,setGastos]=useState<GastoSlim[]>([]);
  const [proveedores,setProveedores]=useState<Proveedor[]>([]);
  // Sets de ids de entidades ya conciliadas con un mp_mov en el tenant.
  // Las usamos para ocultar gastos/facturas/remitos que ya están vinculados
  // a otro egreso MP — evitar listarlos dos veces y prevenir doble linkeo.
  const [gastosConciliadosIds,setGastosConciliadosIds]=useState<Set<string>>(new Set());
  const [facturasConciliadasIds,setFacturasConciliadasIds]=useState<Set<string>>(new Set());
  const [remitosConciliadosIds,setRemitosConciliadosIds]=useState<Set<string>>(new Set());
  // Buscador unificado del modal de conciliar (aplica a tabs gasto/factura/remito).
  const [busquedaModal,setBusquedaModal]=useState("");
  // Filtro "primero seleccioná proveedor" para los tabs Factura y Remito —
  // antes el dropdown listaba TODAS las facturas (pendientes y pagadas) lo
  // cual era ruido. Ahora dos pasos: proveedor → factura. "" = todos.
  const [provFiltro,setProvFiltro]=useState("");
  // Mismo patrón pero para Gasto: como no hay proveedor, filtramos por
  // categoría. "" = todas las categorías.
  const [catFiltro,setCatFiltro]=useState("");
  const [tabFSoloNoConciliados,setTabFSoloNoConciliados]=useState(true);
  const [tabFSugerirSimilares,setTabFSugerirSimilares]=useState(true);
  const [loading,setLoading]=useState(true);
  const [sincronizando,setSincronizando]=useState(false);
  const [conciliando,setConciliando]=useState(false);
  const [toast,setToast]=useState<ToastState | null>(null);
  const [tab,setTab]=useState("egresos");
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
  // Tabs del modal: cada tipo unifica "elegir existente" y "crear nuevo".
  // Mov. interno solo crea (no hay nada que linkear).
  const [conciliarTab,setConciliarTab]=useState<"gasto"|"factura"|"remito"|"movimiento_interno">("gasto");
  // "" en vinculoSel + nuevoGastoForm.categoria activado = modo "crear nuevo".
  const [nuevoGastoForm,setNuevoGastoForm]=useState({categoria:"",detalle:""});
  const [nuevaFacturaForm,setNuevaFacturaForm]=useState({prov_id:"",nro:"",fecha:"",cat:"",detalle:""});
  const [nuevoRemitoForm,setNuevoRemitoForm]=useState({prov_id:"",nro:"",fecha:"",cat:"",detalle:""});
  const [movInternoForm,setMovInternoForm]=useState({destino:"",detalle:""});
  // vinculoSel: id seleccionado en el dropdown. "__NUEVO__" activa form inline.
  // "__MULTI__" activa el modo multi-factura.
  const [vinculoSel,setVinculoSel]=useState("");
  // Multi-factura (Lucas 2026-05-11): array de {factura_id, monto_aplicado}.
  // Solo se usa cuando conciliarTab='factura' y vinculoSel='__MULTI__'.
  const [lineasMulti,setLineasMulti]=useState<{factura_id:string,monto:string}[]>([]);
  // Idempotency key (convención C1): se regenera al abrir el modal, evita
  // duplicar conciliación si el operador hace doble-click en Confirmar.
  const [idempKey,setIdempKey]=useState<string>(() => crypto.randomUUID());
  // Input para el motivo de "Ignorar" en el modal.
  const [motivoIgnorar,setMotivoIgnorar]=useState("");
  // Toggle del filtro "ver ignorados" (default: ocultos).
  const [mostrarIgnorados,setMostrarIgnorados]=useState(false);

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
      // mp_movimientos: trae filas cuya fecha cae en el rango. La pantalla
      // ya no muestra "Ingresos al saldo" → no necesitamos el OR con
      // money_release_date.
      let movQ=db.from("mp_movimientos")
        .select("*")
        .gte("fecha",desdeTs)
        .lt("fecha",hastaTs)
        .order("fecha",{ascending:false})
        .limit(5000);
      movQ=applyLocalScope(movQ,user,localActivo);
      let facQ=db.from("facturas").select("id,nro,fecha,total,local_id,prov_id,cat,estado").gte("fecha",desde).lte("fecha",hasta).order("fecha",{ascending:false});
      facQ=applyLocalScope(facQ,user,localActivo);
      let remQ=db.from("remitos").select("id,nro,fecha,monto,local_id,prov_id,estado").gte("fecha",desde).lte("fecha",hasta).order("fecha",{ascending:false});
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
      // mp_movimientos ya vinculados a un gasto/factura/remito — para excluirlos
      // del dropdown del modal y prevenir doble linkeo.
      let mpJustifQ=db.from("mp_movimientos")
        .select("justificativo_tipo,justificativo_id")
        .in("justificativo_tipo",["gasto","factura","remito"])
        .not("justificativo_id","is",null)
        .limit(20000);
      mpJustifQ=applyLocalScope(mpJustifQ,user,localActivo);
      const [credRes,movRes,facRes,remRes,gasRes,mpJustifRes,provRes]=await Promise.all([
        db.from("mp_credenciales").select("id, local_id, tenant_id, activo, ultima_sync, access_token_last8, saldo_inicial, saldo_inicial_at, saldo_disponible, por_acreditar, balance_at, locales(nombre)"),
        movQ,
        facQ,
        remQ,
        gasQ,
        mpJustifQ,
        db.from("proveedores").select("id, nombre, cuit, cat, saldo, estado").eq("estado","Activo").order("nombre"),
      ]);
      if(credRes.error)console.warn("mp_credenciales load error:",credRes.error);
      if(movRes.error)console.warn("mp_movimientos load error:",movRes.error);
      if(facRes.error)console.warn("facturas load error:",facRes.error);
      if(remRes.error)console.warn("remitos load error:",remRes.error);
      if(gasRes.error)console.warn("gastos load error:",gasRes.error);
      if(mpJustifRes.error)console.warn("mp justif load error:",mpJustifRes.error);
      if(provRes.error)console.warn("proveedores load error:",provRes.error);
      const c=credRes.data||[], m=movRes.data||[], f=facRes.data||[], r=remRes.data||[], g=gasRes.data||[], p=provRes.data||[];
      console.log("[MP] load:",c.length,"credenciales /",m.length,"movimientos /",f.length,"facturas /",r.length,"remitos /",g.length,"gastos /",p.length,"proveedores");
      // Supabase tipa el nested-select locales(nombre) como { nombre }[]
      // (FK genérica), pero en runtime devuelve objeto plano para 1:1.
      // Cast vía unknown — patrón estándar en este codebase para FKs 1-1.
      setCredenciales((c as unknown as MpCredencial[]).filter(x=>!localActivo||x.local_id===localActivo));
      setMovimientos(m as MpMovimiento[]);
      setFacturas((f as FacturaSlim[]).filter(x=>!localActivo||x.local_id===localActivo));
      setRemitos((r as RemitoSlim[]).filter(x=>!localActivo||x.local_id===localActivo));
      setGastos((g as GastoSlim[]).filter(x=>!localActivo||x.local_id===localActivo));
      setProveedores(p as Proveedor[]);
      // Splittear los justificativos por tipo en 3 sets independientes.
      const justifRows=(mpJustifRes.data||[]) as {justificativo_tipo:string|null,justificativo_id:string|null}[];
      const setG=new Set<string>(), setF=new Set<string>(), setR=new Set<string>();
      for(const j of justifRows){
        const id=String(j.justificativo_id||"");
        if(!id) continue;
        if(j.justificativo_tipo==="gasto") setG.add(id);
        else if(j.justificativo_tipo==="factura") setF.add(id);
        else if(j.justificativo_tipo==="remito") setR.add(id);
      }
      setGastosConciliadosIds(setG);
      setFacturasConciliadasIds(setF);
      setRemitosConciliadosIds(setR);
    }catch(e){
      console.error("ConciliacionMP load error:",e);
    }finally{
      setLoading(false);
    }
  };

  // Debounce de date pickers (C6) — evita fetches al editar manualmente.
  const debDesde = useDebouncedValue(desde, 300);
  const debHasta = useDebouncedValue(hasta, 300);
  // Patrón fetch-on-dep-change. No agregar load a deps (re-fetch infinito).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{load();},[debDesde,debHasta,localActivo]);

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

  // Egresos manuales en rango (no anulados, no automáticos). Es la base
  // del tab "Egresos" — independiente de si están justificados o no.
  const egresosManuales = dedupedMovs.filter(m =>
    Number(m.monto) < 0 &&
    !ES_AUTOMATICO(m.tipo) &&
    m.anulado !== true &&
    inRange(m.fecha)
  ).sort((a,b)=>String(b.fecha||'').localeCompare(String(a.fecha||'')));

  // Subconjunto sin justificar — alimenta KPI header + filtro del tab.
  // Excluye ignorados: los marcados a propósito no cuentan como "pendientes".
  const egresosPendientesList = egresosManuales.filter(m => !m.justificativo_tipo && !m.ignorado);
  const pendientesCount = egresosPendientesList.length;

  // ─── Header consolidado ────────────────────────────────────────────────
  // Saldo MP y Dinero a liberar son sumas sobre todas las credenciales del
  // scope visible (RLS ya filtró). El valor proviene del último sync —
  // mp-process actualiza saldo_disponible/por_acreditar en mp_credenciales.
  const saldoConsolidado = credenciales.reduce((s, c) => s + (Number(c.saldo_disponible) || 0), 0);
  const porAcreditarTotal = credenciales.reduce((s, c) => s + (Number(c.por_acreditar) || 0), 0);
  const ultimaSync = credenciales
    .map(c => c.balance_at || c.ultima_sync)
    .filter((x): x is string => !!x)
    .sort()
    .reverse()[0] || null;

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
    setBusquedaModal("");
    setProvFiltro("");
    setCatFiltro("");
    setNuevoGastoForm({categoria:"",detalle:""});
    setNuevaFacturaForm({prov_id:"",nro:"",fecha:"",cat:"",detalle:""});
    setNuevoRemitoForm({prov_id:"",nro:"",fecha:"",cat:"",detalle:""});
    setMovInternoForm({destino:"",detalle:""});
    setConciliarTab("gasto");
    setLineasMulti([]);
    setMotivoIgnorar("");
    // Nuevo idempotency_key para el próximo modal — si el operador reabre
    // a conciliar otro mp_mov, no debe reusar la key del anterior.
    setIdempKey(crypto.randomUUID());
  };

  // ── Multi-factura: pagar varias facturas con un solo MP. La suma puede
  // diferir del monto MP (Lucas pidió no bloquear): la UI muestra el delta.
  const justificarConMultiplesFacturas=async()=>{
    if(!conciliarModal)return;
    const lineasValidas=lineasMulti
      .filter(l=>l.factura_id && parseFloat(l.monto)>0)
      .map(l=>({factura_id:l.factura_id, monto_aplicado:parseFloat(l.monto)}));
    if(lineasValidas.length===0){
      showToast("err","Tenés que elegir al menos una factura con monto > 0");
      return;
    }
    setConciliando(true);
    const {error}=await db.rpc("fn_conciliar_mp_con_facturas",{
      p_mp_mov_id:conciliarModal.id,
      p_lineas:lineasValidas,
      p_idempotency_key:idempKey,
    });
    setConciliando(false);
    if(error){showToast("err","No se pudo conciliar: "+error.message);return;}
    showToast("ok",`Conciliado contra ${lineasValidas.length} factura${lineasValidas.length===1?"":"s"}`);
    cerrarConciliar(); load();
  };

  // ── Ignorar: marca el egreso como "no requiere conciliación". El KPI lo
  // excluye, pero el rastro queda con motivo + usuario + timestamp.
  const ignorarMP=async()=>{
    if(!conciliarModal)return;
    setConciliando(true);
    const {error}=await db.rpc("fn_ignorar_mp",{
      p_mp_mov_id:conciliarModal.id,
      p_motivo:motivoIgnorar.trim()||null,
    });
    setConciliando(false);
    if(error){showToast("err","No se pudo ignorar: "+error.message);return;}
    showToast("ok","Egreso ignorado");
    cerrarConciliar(); load();
  };

  // ── Des-ignorar: revertir un "ignorado" (típicamente porque fue error).
  const designorarMP=async(mp_mov_id:string)=>{
    setConciliando(true);
    const {error}=await db.rpc("fn_designorar_mp",{p_mp_mov_id:mp_mov_id});
    setConciliando(false);
    if(error){showToast("err","No se pudo des-ignorar: "+error.message);return;}
    showToast("ok","Egreso vuelto a pendiente");
    load();
  };

  const justificarConExistente=async(tipo:"factura"|"remito"|"gasto",justifId:string)=>{
    if(!conciliarModal||!justifId)return;
    setConciliando(true);
    const {data,error}=await db.rpc(tipo==="gasto"?"fn_conciliar_mp_con_gasto_existente":"fn_conciliar_mp_con_existente",
      tipo==="gasto"
        ? { p_mp_mov_id:conciliarModal.id, p_gasto_id:justifId }
        : { p_mp_mov_id:conciliarModal.id, p_tipo:tipo, p_justif_id:justifId }
    );
    setConciliando(false);
    if(error){showToast("err","No se pudo conciliar: "+error.message);return;}
    // fn_conciliar_mp_con_gasto_existente puede devolver {warning} si los
    // montos difieren — la conciliación se aplica igual.
    const warning=(data as {warning?:string|null}|null)?.warning||null;
    showToast(warning?"err":"ok",warning?("Vinculado con discrepancia: "+warning):("Egreso justificado contra "+tipo));
    cerrarConciliar(); load();
  };

  const justificarConGastoNuevo=async()=>{
    if(!conciliarModal||!nuevoGastoForm.categoria)return;
    // El tipo se deriva de la categoría via config_categorias. Si la cat
    // todavía no está mapeada (ej. legacy), defaulteamos a "variable".
    const tipoDerivado = categoriaToTipo[nuevoGastoForm.categoria] || "variable";
    setConciliando(true);
    const {error}=await db.rpc("fn_conciliar_mp_con_gasto",{
      p_mp_mov_id:conciliarModal.id,
      p_gasto_data:{categoria:nuevoGastoForm.categoria, detalle:nuevoGastoForm.detalle, tipo:tipoDerivado},
    });
    setConciliando(false);
    if(error){showToast("err","No se pudo crear el gasto: "+error.message);return;}
    showToast("ok","Gasto creado y conciliado");
    cerrarConciliar(); load();
  };

  const justificarConFacturaNueva=async()=>{
    if(!conciliarModal||!nuevaFacturaForm.prov_id||!nuevaFacturaForm.nro)return;
    setConciliando(true);
    const {error}=await db.rpc("fn_conciliar_mp_con_factura_nueva",{
      p_mp_mov_id:conciliarModal.id,
      p_factura_data:{
        prov_id:parseInt(nuevaFacturaForm.prov_id),
        nro:nuevaFacturaForm.nro,
        fecha:nuevaFacturaForm.fecha||null,
        // cat ya no se pasa: la RPC la deriva de proveedor.cat por default
        // (fallback a "Conciliación MP" si el proveedor no tiene cat seteada).
        detalle:nuevaFacturaForm.detalle,
      },
    });
    setConciliando(false);
    if(error){showToast("err","No se pudo crear la factura: "+error.message);return;}
    showToast("ok","Factura creada y conciliada");
    cerrarConciliar(); load();
  };

  const justificarConRemitoNuevo=async()=>{
    if(!conciliarModal||!nuevoRemitoForm.prov_id||!nuevoRemitoForm.nro)return;
    setConciliando(true);
    const {error}=await db.rpc("fn_conciliar_mp_con_remito_nuevo",{
      p_mp_mov_id:conciliarModal.id,
      p_remito_data:{
        prov_id:parseInt(nuevoRemitoForm.prov_id),
        nro:nuevoRemitoForm.nro,
        fecha:nuevoRemitoForm.fecha||null,
        cat:nuevoRemitoForm.cat,
        detalle:nuevoRemitoForm.detalle,
      },
    });
    setConciliando(false);
    if(error){showToast("err","No se pudo crear el remito: "+error.message);return;}
    showToast("ok","Remito creado y conciliado");
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
        {/* Header consolidado: suma de saldo_disponible y por_acreditar de
            todas las credenciales del scope visible. Valor del último sync —
            mp-process actualiza estos campos en mp_credenciales. */}
        <div className="kpi">
          <div className="kpi-label" style={{color:"var(--muted)"}}>Saldo MP</div>
          <div className="kpi-value" style={{color:"var(--muted2)",fontFamily:"'Inter',sans-serif",fontSize:18,fontWeight:500}}>
            {loading ? "—" : fmt_mp(saldoConsolidado)}
          </div>
          <div className="kpi-sub" style={{fontSize:10,color:"var(--muted2)"}}>
            {credenciales.length===0
              ? "Sin cuentas configuradas"
              : credenciales.length===1
                ? `${credenciales[0]?.locales?.nombre||"Local"} · último sync ${ultimaSync?fmt_dt_ar(ultimaSync):"—"}`
                : `${credenciales.length} locales · último sync ${ultimaSync?fmt_dt_ar(ultimaSync):"—"}`}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Dinero a liberar</div>
          <div className={`kpi-value ${porAcreditarTotal>0?"kpi-warn":""}`} style={{fontSize:18}}>
            {loading ? "—" : fmt_mp(porAcreditarTotal)}
          </div>
          <div className="kpi-sub">Pagos en proceso · se acreditan al saldo</div>
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
      </div>

      <div className="tabs">
        {([
          ["egresos","Egresos"],
          ["comisiones","Comisiones MP"],
        ] as [string, string][]).map(([id,l])=>(
          <div key={id} className={`tab ${tab===id?"active":""}`} onClick={()=>setTab(id)}>{l}{id==="egresos"&&pendientesCount>0?<span className="badge b-danger" style={{marginLeft:6,fontSize:9}}>{pendientesCount}</span>:null}</div>
        ))}
      </div>

      {loading?<div className="loading">Cargando...</div>:tab==="egresos"?(
        // ─── Tab EGRESOS — egresos manuales en rango (sin fee/tax) ────────────
        // El brief: cualquier usuario con acceso al módulo puede conciliar.
        // Cada fila tiene botón "Conciliar" si justificativo_tipo es null.
        // Si está justificado, badge con tipo en la última columna.
        (()=>{
          // Filtros: filtroSinJustif (solo pendientes) + mostrarIgnorados
          // (ocultos por default — el operador puede destildar para verlos
          // y eventualmente des-ignorar si fue un error).
          const baseLista = filtroSinJustif ? egresosManuales.filter(m=>!m.justificativo_tipo && !m.ignorado) : egresosManuales;
          const lista = mostrarIgnorados ? baseLista : baseLista.filter(m=>!m.ignorado);
          const totalLista = lista.reduce((s,m)=>s+Math.abs(Number(m.monto)||0),0);
          const cantIgnorados = egresosManuales.filter(m=>m.ignorado).length;
          return (
            <div className="panel">
              <div className="panel-hd" style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                <div style={{display:"flex",flexDirection:"column",gap:2}}>
                  <span className="panel-title">Egresos — {lista.length} {lista.length===1?"egreso":"egresos"}{filtroSinJustif?" sin justificar":""}</span>
                  <span style={{fontSize:11,color:"var(--muted2)"}}>Transferencias y pagos del período · monto neto</span>
                </div>
                <div style={{display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
                  <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,cursor:"pointer",userSelect:"none",color:"var(--muted2)"}}>
                    <input type="checkbox" checked={filtroSinJustif} onChange={e=>setFiltroSinJustif(e.target.checked)} style={{cursor:"pointer"}}/>
                    Solo sin justificar
                  </label>
                  {cantIgnorados>0&&(
                    <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,cursor:"pointer",userSelect:"none",color:"var(--muted2)"}}>
                      <input type="checkbox" checked={mostrarIgnorados} onChange={e=>setMostrarIgnorados(e.target.checked)} style={{cursor:"pointer"}}/>
                      Mostrar ignorados ({cantIgnorados})
                    </label>
                  )}
                </div>
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
                    <tr key={m.id} style={m.ignorado?{opacity:0.55}:undefined}>
                      <td className="mono" style={{fontSize:11}}>{fmt_d(String(m.fecha||"").slice(0,10))}</td>
                      <td style={{fontSize:11,color:"var(--muted2)"}}>{locales.find(l=>String(l.id)===String(m.local_id))?.nombre||"—"}</td>
                      <td><span className="badge b-muted" style={{fontSize:9}}>{TIPO_LABELS[m.tipo]||m.tipo}</span></td>
                      <td style={{fontSize:11,maxWidth:240,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.descripcion||"—"}</td>
                      <td style={{textAlign:"right"}}><span className="num kpi-danger">{fmt_mp(Number(m.monto)||0)}</span></td>
                      <td>{m.ignorado
                        ?<span className="badge b-muted" style={{fontSize:9}} title={m.ignorado_motivo?`Motivo: ${m.ignorado_motivo}`:"Sin motivo"}>ignorado</span>
                        :m.justificativo_tipo
                          ?<span className="badge b-success" style={{fontSize:9}}>{m.justificativo_tipo==='multi_factura'?'multi-factura':m.justificativo_tipo.replace('_',' ')}</span>
                          :<span className="badge b-danger" style={{fontSize:9}}>sin justificar</span>}</td>
                      <td>
                        {m.ignorado
                          ? <button className="btn btn-ghost btn-sm" style={{fontSize:10,padding:"4px 10px"}} onClick={()=>designorarMP(m.id)} disabled={conciliando}>Des-ignorar</button>
                          : !m.justificativo_tipo && <button className="btn btn-acc btn-sm" style={{fontSize:10,padding:"4px 10px"}} onClick={()=>setConciliarModal(m)}>Conciliar</button>}
                      </td>
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

      {conciliarModal&&(<div className="overlay" onClick={()=>{ if(!conciliando) cerrarConciliar(); }}><div className="modal" style={{width:680,position:"relative"}} onClick={e=>e.stopPropagation()}>
        {/* Overlay "Procesando..." — bloquea TODA interacción con el modal mientras
            la RPC corre. Antes solo cambiaba el label del botón y se confundía
            con un estado normal — Lucas terminaba clickeando 10 veces. */}
        {conciliando && (
          <div style={{position:"absolute",inset:0,background:"rgba(0,0,0,0.55)",zIndex:10,display:"flex",alignItems:"center",justifyContent:"center",borderRadius:"inherit",pointerEvents:"all"}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12,padding:"24px 32px",background:"var(--bg2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)",boxShadow:"0 8px 32px rgba(0,0,0,0.4)"}}>
              <div style={{width:36,height:36,border:"3px solid var(--bd2)",borderTopColor:"var(--acc)",borderRadius:"50%",animation:"mp-spin 0.7s linear infinite"}}/>
              <div style={{fontSize:13,fontWeight:500,color:"var(--text)"}}>Procesando...</div>
              <style>{`@keyframes mp-spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          </div>
        )}
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
              ["gasto","Gasto"],
              ["factura","Factura"],
              ["remito","Remito"],
              ["movimiento_interno","Mov. interno"],
            ] as [typeof conciliarTab, string][]).map(([id,l])=>(
              <div key={id} className={`tab ${conciliarTab===id?"active":""}`} onClick={()=>{setConciliarTab(id);setVinculoSel("");setBusquedaModal("");setProvFiltro("");setCatFiltro("");}}>{l}</div>
            ))}
          </div>

          {conciliarTab==="gasto"&&(()=>{
            // Tab unificado: el dropdown lista gastos existentes + opción
            // "+ Crear nuevo" al tope. Si el usuario elige __NUEVO__, abajo
            // aparece el form inline con tipo readonly derivado de la cat.
            const mpMonto=Math.abs(Number(conciliarModal.monto)||0);
            const mpFechaTs=conciliarModal.fecha?new Date(conciliarModal.fecha).getTime():0;
            const SIETE_DIAS_MS=7*24*60*60*1000;
            const tol=mpMonto*0.05;
            const q=busquedaModal.trim().toLowerCase();
            // Filtro por categoría tipo dropdown — análogo al filtro por
            // proveedor en Factura/Remito. "" = ver todas. Las categorías
            // mostradas en el select son SOLO las que tienen al menos un
            // gasto no-conciliado en la ventana cargada.
            const gastosNoConciliados=gastos.filter(g=>!tabFSoloNoConciliados||!gastosConciliadosIds.has(g.id));
            const categoriasDisponibles=Array.from(new Set(gastosNoConciliados.map(g=>g.categoria).filter(Boolean))).sort();
            const lista=gastosNoConciliados
              .filter(g=>!catFiltro||g.categoria===catFiltro)
              .filter(g=>{
                if(!q)return true;
                const hay=(g.detalle||"")+" "+g.categoria+" "+(g.subcategoria||"")+" "+(g.cuenta||"");
                return hay.toLowerCase().includes(q);
              })
              .map(g=>{
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
            const tipoDerivado=nuevoGastoForm.categoria?(categoriaToTipo[nuevoGastoForm.categoria]||"variable"):"";
            return (
              <div>
                <div className="alert alert-warn" style={{marginBottom:12}}>Egreso de {fmt_$(mpMonto)} → vincular a un gasto existente o crear uno nuevo.</div>
                <div className="field"><label>Categoría</label>
                  <Combobox
                    value={catFiltro}
                    onChange={v=>setCatFiltro(v)}
                    options={categoriasDisponibles.map(c=>({value:c,label:c}))}
                    placeholder="Todas las categorías"
                    clearable
                    emptyMessage="Sin categorías con gastos pendientes"
                  />
                  <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>{categoriasDisponibles.length===0?"Sin gastos pendientes en el período.":`${categoriasDisponibles.length} categoría${categoriasDisponibles.length===1?"":"s"} con gastos pendientes`}</div>
                </div>
                <div className="field"><label>Buscar por detalle / cuenta</label>
                  <input value={busquedaModal} onChange={e=>setBusquedaModal(e.target.value)} placeholder="Aysa, Metrogas, sueldo..."/>
                </div>
                <div style={{display:"flex",gap:14,marginBottom:8,fontSize:11,color:"var(--muted2)"}}>
                  <label style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer"}}>
                    <input type="checkbox" checked={tabFSoloNoConciliados} onChange={e=>setTabFSoloNoConciliados(e.target.checked)}/>
                    Solo gastos no conciliados
                  </label>
                  <label style={{display:"flex",alignItems:"center",gap:4,cursor:"pointer"}}>
                    <input type="checkbox" checked={tabFSugerirSimilares} onChange={e=>setTabFSugerirSimilares(e.target.checked)}/>
                    Sugerir similares (±5% / ±7d)
                  </label>
                  {sugeridos>0&&<span className="badge b-success" style={{fontSize:9}}>{sugeridos} sugeridos</span>}
                </div>
                {/* Patrón "botón + select separados": antes "+ Crear gasto nuevo"
                    vivía como primer <option> del <select size>. Bug: el browser
                    highlightea el primer option pero React state queda en "" —
                    clickear no disparaba onChange. Además el texto del option
                    heredaba colores que se veían mal contra el fondo oscuro. */}
                <button className="btn btn-acc btn-sm" style={{marginBottom:8}}
                  onClick={()=>setVinculoSel("__NUEVO__")}>+ Crear gasto nuevo</button>
                <div className="field"><label>O vincular a gasto existente</label>
                  <select value={vinculoSel} onChange={e=>setVinculoSel(e.target.value)} size={Math.min(8,Math.max(3,lista.length+1))} style={{height:"auto"}}>
                    <option value="" disabled>— Elegí un gasto —</option>
                    {lista.length===0?<option value="" disabled>— Sin gastos en el período —</option>:lista.map(g=>{
                      const flag=g._cercanoMonto&&g._cercanoFecha?"⭐ ":g._cercanoMonto?"💲 ":g._cercanoFecha?"📅 ":"";
                      return <option key={g.id} value={g.id}>{flag}{fmt_d(g.fecha)} · {g.categoria}{g.subcategoria?" / "+g.subcategoria:""} · {fmt_$(g.monto)} · {g.cuenta||"—"} · {g.detalle||""}</option>;
                    })}
                  </select>
                </div>
                {vinculoSel==="__NUEVO__"&&(
                  <div style={{marginTop:12,padding:14,background:"var(--s2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)"}}>
                    <div style={{fontSize:11,fontWeight:600,marginBottom:10,color:"var(--muted2)",letterSpacing:1}}>NUEVO GASTO · {fmt_$(mpMonto)}</div>
                    <div className="field"><label>Categoría *</label>
                      <Combobox
                        value={nuevoGastoForm.categoria}
                        onChange={v=>setNuevoGastoForm({...nuevoGastoForm,categoria:v})}
                        options={[
                          ...GASTOS_VARIABLES.map(c=>({value:c,label:c,group:"Variables"})),
                          ...GASTOS_FIJOS.map(c=>({value:c,label:c,group:"Fijos"})),
                          ...GASTOS_PUBLICIDAD.map(c=>({value:c,label:c,group:"Publicidad"})),
                          ...COMISIONES_CATS.map(c=>({value:c,label:c,group:"Comisiones"})),
                          ...GASTOS_IMPUESTOS.map(c=>({value:c,label:c,group:"Impuestos"})),
                          ...RETIROS_SOCIOS.map(c=>({value:c,label:c,group:"Retiros de Socios"})),
                        ]}
                        groupOrder={["Variables","Fijos","Publicidad","Comisiones","Impuestos","Retiros de Socios"]}
                        placeholder="Buscar o elegir categoría..."
                        clearable
                      />
                    </div>
                    <div className="field"><label>Tipo (auto, según categoría)</label>
                      <input type="text" readOnly value={tipoDerivado||"—"} style={{background:"var(--bg)",color:"var(--muted2)",cursor:"not-allowed"}}/>
                      <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>El tipo viene fijado desde Configuración → Conceptos. Si querés cambiarlo, editá la categoría desde ahí.</div>
                    </div>
                    <div className="field"><label>Detalle</label><input value={nuevoGastoForm.detalle} onChange={e=>setNuevoGastoForm({...nuevoGastoForm,detalle:e.target.value})} placeholder={conciliarModal.descripcion||"Descripción..."}/></div>
                  </div>
                )}
              </div>
            );
          })()}

          {conciliarTab==="factura"&&(()=>{
            // Patrón "primero proveedor, después factura": el dropdown de
            // facturas solo se llena cuando el usuario eligió un proveedor.
            // Antes listaba TODAS las facturas (pendientes + pagadas), lo cual
            // era ruido. Filtramos también las ya conciliadas con otro mp_mov
            // — no tiene sentido vincular dos veces la misma factura.
            const noConciliadas=facturas.filter(f=>!facturasConciliadasIds.has(f.id));
            const provIdsConFacturas=new Set(noConciliadas.map(f=>f.prov_id).filter((x):x is number=>x!=null));
            const provsActivos=proveedores.filter(p=>provIdsConFacturas.has(p.id));
            const provIdNum=provFiltro?parseInt(provFiltro):null;
            const lista=provIdNum!=null
              ? noConciliadas
                  .filter(f=>f.prov_id===provIdNum)
                  .sort((a,b)=>String(b.fecha).localeCompare(String(a.fecha)))
                  .slice(0,200)
              : [];
            return (
              <div>
                <div className="alert alert-warn" style={{marginBottom:12}}>Egreso de {fmt_$(Math.abs(conciliarModal.monto||0))} → vincular a una factura existente o crear una nueva.</div>
                <div className="field"><label>Proveedor</label>
                  <Combobox
                    value={provFiltro}
                    onChange={v=>{setProvFiltro(v);setVinculoSel("");}}
                    options={provsActivos.map(p=>({value:String(p.id),label:p.nombre}))}
                    placeholder="Buscar proveedor..."
                    clearable
                    emptyMessage="Sin proveedores con facturas pendientes"
                  />
                  <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>{provsActivos.length===0?"Ningún proveedor con facturas pendientes de conciliar en el período.":`${provsActivos.length} proveedor${provsActivos.length===1?"":"es"} con facturas pendientes de conciliar`}</div>
                </div>
                {provIdNum!=null&&(
                  <div className="field"><label>Factura a vincular ({lista.length} disponibles · más nueva arriba)</label>
                    <select value={vinculoSel} onChange={e=>{
                      const v=e.target.value; setVinculoSel(v);
                      // Al activar __MULTI__: precargar con una fila vacía.
                      if(v==="__MULTI__" && lineasMulti.length===0) setLineasMulti([{factura_id:"",monto:""}]);
                    }} size={Math.min(8,Math.max(3,lista.length+2))} style={{height:"auto"}}>
                      <option value="__NUEVO__">+ Crear factura nueva</option>
                      <option value="__MULTI__">⊕ Pagar varias facturas con este MP</option>
                      {lista.length===0?<option value="" disabled>— Sin facturas pendientes de este proveedor —</option>:lista.map(f=>(
                        <option key={f.id} value={f.id}>#{f.nro} · {fmt_d(f.fecha)} · {fmt_$(f.total)} · {f.estado}</option>
                      ))}
                    </select>
                  </div>
                )}
                {provIdNum==null&&(
                  <div style={{marginTop:8,padding:"10px 12px",background:"var(--s2)",borderRadius:"var(--r)",border:"1px dashed var(--bd2)",fontSize:11,color:"var(--muted2)"}}>
                    Elegí un proveedor arriba para ver sus facturas pendientes, o <button type="button" className="btn btn-link" style={{padding:0,fontSize:11,textDecoration:"underline"}} onClick={()=>{setVinculoSel("__NUEVO__");}}>crear una factura nueva directamente</button>.
                  </div>
                )}
                {vinculoSel==="__MULTI__"&&provIdNum!=null&&(()=>{
                  // Modo multi-factura: el operador elige N facturas del proveedor
                  // y reparte el monto MP entre ellas. La suma puede diferir del
                  // monto MP (Lucas) — la UI muestra el delta pero no bloquea.
                  const montoMp=Math.abs(conciliarModal.monto||0);
                  const totalAplicado=lineasMulti.reduce((s,l)=>s+(parseFloat(l.monto)||0),0);
                  const diferencia=montoMp-totalAplicado;
                  const facsElegibles=lista; // ya filtra por proveedor + no conciliadas
                  return (
                    <div style={{marginTop:12,padding:14,background:"var(--s2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)"}}>
                      <div style={{fontSize:11,fontWeight:600,marginBottom:10,color:"var(--muted2)",letterSpacing:1}}>VARIAS FACTURAS · MP {fmt_$(montoMp)}</div>
                      {lineasMulti.map((linea,i)=>{
                        const facIds=lineasMulti.filter((_,j)=>j!==i).map(l=>l.factura_id);
                        const facsDisp=facsElegibles.filter(f=>!facIds.includes(f.id));
                        return (
                          <div key={i} style={{display:"grid",gridTemplateColumns:"1fr 130px 28px",gap:8,alignItems:"center",marginBottom:6}}>
                            <select value={linea.factura_id} onChange={e=>{
                              const fac=facsElegibles.find(f=>f.id===e.target.value);
                              setLineasMulti(prev=>prev.map((l,j)=>j===i?{factura_id:e.target.value,monto:fac?String(fac.total):l.monto}:l));
                            }}>
                              <option value="">— Elegir factura —</option>
                              {facsDisp.map(f=><option key={f.id} value={f.id}>#{f.nro} · {fmt_d(f.fecha)} · {fmt_$(f.total)}</option>)}
                            </select>
                            <input type="number" step="0.01" placeholder="Monto a aplicar" value={linea.monto}
                              onChange={e=>setLineasMulti(prev=>prev.map((l,j)=>j===i?{...l,monto:e.target.value}:l))}/>
                            <button type="button" className="btn btn-ghost btn-sm" title="Quitar línea" style={{padding:"3px 8px"}}
                              onClick={()=>setLineasMulti(prev=>prev.filter((_,j)=>j!==i))}>✕</button>
                          </div>
                        );
                      })}
                      <button type="button" className="btn btn-sec btn-sm" style={{marginTop:4}}
                        onClick={()=>setLineasMulti(prev=>[...prev,{factura_id:"",monto:""}])}
                        disabled={lineasMulti.length>=facsElegibles.length}>+ Agregar otra factura</button>
                      <div style={{marginTop:14,padding:"10px 12px",background:"var(--bg)",borderRadius:"var(--r)",border:"1px solid var(--bd)",display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                        <div style={{fontSize:11,color:"var(--muted2)"}}>
                          Aplicado: <span className="num" style={{color:"var(--txt)"}}>{fmt_$(totalAplicado)}</span> · MP: <span className="num" style={{color:"var(--txt)"}}>{fmt_$(montoMp)}</span>
                        </div>
                        <div style={{fontSize:11}}>
                          {Math.abs(diferencia)<0.005
                            ? <span style={{color:"var(--success)"}}>✓ Cuadra exacto</span>
                            : diferencia>0
                              ? <span style={{color:"var(--warn)"}}>Falta aplicar {fmt_$(diferencia)}</span>
                              : <span style={{color:"var(--warn)"}}>Sobra {fmt_$(-diferencia)} (suma &gt; MP)</span>
                          }
                        </div>
                      </div>
                      <div style={{fontSize:10,color:"var(--muted)",marginTop:8,lineHeight:1.5}}>
                        El monto pre-cargado al elegir cada factura es el total de la factura. Editalo si la pagás solo en parte.
                        El saldo de Mercado&nbsp;Pago siempre baja por el monto real del MP ({fmt_$(montoMp)}), no por la suma aplicada.
                      </div>
                    </div>
                  );
                })()}
                {vinculoSel==="__NUEVO__"&&(
                  <div style={{marginTop:12,padding:14,background:"var(--s2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)"}}>
                    <div style={{fontSize:11,fontWeight:600,marginBottom:10,color:"var(--muted2)",letterSpacing:1}}>NUEVA FACTURA · total {fmt_$(Math.abs(conciliarModal.monto||0))}</div>
                    <div className="field"><label>Proveedor *</label>
                      <Combobox
                        value={nuevaFacturaForm.prov_id}
                        onChange={v=>setNuevaFacturaForm({...nuevaFacturaForm,prov_id:v})}
                        options={proveedores.map(p=>({value:String(p.id),label:p.nombre}))}
                        placeholder="Buscar proveedor..."
                        clearable
                      />
                    </div>
                    <div className="field"><label>Número *</label><input value={nuevaFacturaForm.nro} onChange={e=>setNuevaFacturaForm({...nuevaFacturaForm,nro:e.target.value})} placeholder="0001-00000123"/></div>
                    <div className="field"><label>Fecha</label><input type="date" value={nuevaFacturaForm.fecha} onChange={e=>setNuevaFacturaForm({...nuevaFacturaForm,fecha:e.target.value})}/>
                      <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>Si dejás vacío usa la fecha del egreso MP.</div>
                    </div>
                    {/* Sin field Categoría: la cat se deriva del proveedor.cat
                        (lookup en la RPC fn_conciliar_mp_con_factura_nueva). Si
                        querés editar después, se hace desde Compras. */}
                    <div className="field"><label>Detalle</label><input value={nuevaFacturaForm.detalle} onChange={e=>setNuevaFacturaForm({...nuevaFacturaForm,detalle:e.target.value})} placeholder={conciliarModal.descripcion||"Descripción..."}/></div>
                    <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>Categoría e IVA toman defaults del proveedor — editalos después en Compras si hace falta.</div>
                  </div>
                )}
              </div>
            );
          })()}

          {conciliarTab==="remito"&&(()=>{
            const noConciliados=remitos.filter(r=>!remitosConciliadosIds.has(r.id));
            const provIdsConRemitos=new Set(noConciliados.map(r=>r.prov_id).filter((x):x is number=>x!=null));
            const provsActivos=proveedores.filter(p=>provIdsConRemitos.has(p.id));
            const provIdNum=provFiltro?parseInt(provFiltro):null;
            const lista=provIdNum!=null
              ? noConciliados
                  .filter(r=>r.prov_id===provIdNum)
                  .sort((a,b)=>String(b.fecha).localeCompare(String(a.fecha)))
                  .slice(0,200)
              : [];
            return (
              <div>
                <div className="alert alert-warn" style={{marginBottom:12}}>Egreso de {fmt_$(Math.abs(conciliarModal.monto||0))} → vincular a un remito existente o crear uno nuevo.</div>
                <div className="field"><label>Proveedor</label>
                  <Combobox
                    value={provFiltro}
                    onChange={v=>{setProvFiltro(v);setVinculoSel("");}}
                    options={provsActivos.map(p=>({value:String(p.id),label:p.nombre}))}
                    placeholder="Buscar proveedor..."
                    clearable
                    emptyMessage="Sin proveedores con remitos pendientes"
                  />
                  <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>{provsActivos.length===0?"Ningún proveedor con remitos pendientes de conciliar en el período.":`${provsActivos.length} proveedor${provsActivos.length===1?"":"es"} con remitos pendientes de conciliar`}</div>
                </div>
                {provIdNum!=null&&(
                  <div className="field"><label>Remito a vincular ({lista.length} disponibles · más nuevo arriba)</label>
                    <select value={vinculoSel} onChange={e=>setVinculoSel(e.target.value)} size={Math.min(8,Math.max(3,lista.length+1))} style={{height:"auto"}}>
                      <option value="__NUEVO__">+ Crear remito nuevo</option>
                      {lista.length===0?<option value="" disabled>— Sin remitos pendientes de este proveedor —</option>:lista.map(r=>(
                        <option key={r.id} value={r.id}>#{r.nro||r.id.slice(-6)} · {fmt_d(r.fecha)} · {fmt_$(r.monto)} · {r.estado||""}</option>
                      ))}
                    </select>
                  </div>
                )}
                {provIdNum==null&&(
                  <div style={{marginTop:8,padding:"10px 12px",background:"var(--s2)",borderRadius:"var(--r)",border:"1px dashed var(--bd2)",fontSize:11,color:"var(--muted2)"}}>
                    Elegí un proveedor arriba para ver sus remitos pendientes, o <button type="button" className="btn btn-link" style={{padding:0,fontSize:11,textDecoration:"underline"}} onClick={()=>{setVinculoSel("__NUEVO__");}}>crear un remito nuevo directamente</button>.
                  </div>
                )}
                {vinculoSel==="__NUEVO__"&&(
                  <div style={{marginTop:12,padding:14,background:"var(--s2)",borderRadius:"var(--r)",border:"1px solid var(--bd2)"}}>
                    <div style={{fontSize:11,fontWeight:600,marginBottom:10,color:"var(--muted2)",letterSpacing:1}}>NUEVO REMITO · monto {fmt_$(Math.abs(conciliarModal.monto||0))}</div>
                    <div className="field"><label>Proveedor *</label>
                      <Combobox
                        value={nuevoRemitoForm.prov_id}
                        onChange={v=>setNuevoRemitoForm({...nuevoRemitoForm,prov_id:v})}
                        options={proveedores.map(p=>({value:String(p.id),label:p.nombre}))}
                        placeholder="Buscar proveedor..."
                        clearable
                      />
                    </div>
                    <div className="field"><label>Número *</label><input value={nuevoRemitoForm.nro} onChange={e=>setNuevoRemitoForm({...nuevoRemitoForm,nro:e.target.value})} placeholder="R-0001"/></div>
                    <div className="field"><label>Fecha</label><input type="date" value={nuevoRemitoForm.fecha} onChange={e=>setNuevoRemitoForm({...nuevoRemitoForm,fecha:e.target.value})}/>
                      <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>Si dejás vacío usa la fecha del egreso MP.</div>
                    </div>
                    <div className="field"><label>Categoría</label><input value={nuevoRemitoForm.cat} onChange={e=>setNuevoRemitoForm({...nuevoRemitoForm,cat:e.target.value})} placeholder="Insumos..."/></div>
                    <div className="field"><label>Detalle</label><input value={nuevoRemitoForm.detalle} onChange={e=>setNuevoRemitoForm({...nuevoRemitoForm,detalle:e.target.value})} placeholder={conciliarModal.descripcion||"Descripción..."}/></div>
                  </div>
                )}
              </div>
            );
          })()}

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
        <div className="modal-ft" style={{flexDirection:"column",alignItems:"stretch",gap:8}}>
          {/* Fila opcional "Ignorar" — sobre los botones principales. El operador
              puede marcar un egreso como ignorado en vez de conciliar (Lucas
              2026-05-11) cuando es un reverso, duplicado de banco, etc. */}
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",fontSize:11,color:"var(--muted2)"}}>
            <span style={{whiteSpace:"nowrap"}}>¿No querés conciliar?</span>
            <input value={motivoIgnorar} onChange={e=>setMotivoIgnorar(e.target.value)}
              placeholder="Motivo (opcional, ej: duplicado, reverso)..."
              style={{flex:1,minWidth:180,padding:"5px 8px",background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--txt)",fontSize:11,borderRadius:"var(--r)"}}
              disabled={conciliando}/>
            <button className="btn btn-ghost btn-sm" onClick={ignorarMP} disabled={conciliando}>Ignorar egreso</button>
          </div>
          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <button className="btn btn-sec" onClick={cerrarConciliar} disabled={conciliando}>Cancelar</button>
            {(()=>{
              if(conciliarTab==="gasto"){
                if(vinculoSel==="__NUEVO__")
                  return <button className="btn btn-acc" disabled={!nuevoGastoForm.categoria||conciliando} onClick={justificarConGastoNuevo}>Crear gasto y conciliar</button>;
                return <button className="btn btn-acc" disabled={!vinculoSel||conciliando} onClick={()=>justificarConExistente("gasto",vinculoSel)}>Vincular y conciliar</button>;
              }
              if(conciliarTab==="factura"){
                if(vinculoSel==="__NUEVO__")
                  return <button className="btn btn-acc" disabled={!nuevaFacturaForm.prov_id||!nuevaFacturaForm.nro||conciliando} onClick={justificarConFacturaNueva}>Crear factura y conciliar</button>;
                if(vinculoSel==="__MULTI__"){
                  const hayLineas=lineasMulti.some(l=>l.factura_id && parseFloat(l.monto)>0);
                  return <button className="btn btn-acc" disabled={!hayLineas||conciliando} onClick={justificarConMultiplesFacturas}>Conciliar contra {lineasMulti.filter(l=>l.factura_id).length} factura{lineasMulti.filter(l=>l.factura_id).length===1?"":"s"}</button>;
                }
                return <button className="btn btn-acc" disabled={!vinculoSel||conciliando} onClick={()=>justificarConExistente("factura",vinculoSel)}>Vincular y conciliar</button>;
              }
              if(conciliarTab==="remito"){
                if(vinculoSel==="__NUEVO__")
                  return <button className="btn btn-acc" disabled={!nuevoRemitoForm.prov_id||!nuevoRemitoForm.nro||conciliando} onClick={justificarConRemitoNuevo}>Crear remito y conciliar</button>;
                return <button className="btn btn-acc" disabled={!vinculoSel||conciliando} onClick={()=>justificarConExistente("remito",vinculoSel)}>Vincular y conciliar</button>;
              }
              return <button className="btn btn-acc" disabled={!movInternoForm.destino||conciliando} onClick={justificarConMovimientoInterno}>Registrar transferencia</button>;
            })()}
          </div>
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