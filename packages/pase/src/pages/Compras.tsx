import { useState, useEffect, lazy, Suspense } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasOperables, localesVisibles, tienePermiso } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { useCategorias } from "../lib/useCategorias";
import { useRealtimeTable } from "../lib/useRealtimeTable";
import { CUENTAS } from "../lib/constants";
import { toISO, fmt_d, fmt_$, genId, parseMonto, toLocalISO } from '@pase/shared/utils';
import { today, estadoFactura } from '../lib/utils';
import { RightSubNav, type SubNavSection, PageHeader, EmptyState, BoxIcon, ReceiptIcon } from "../components/ui";
import { ManagerOverrideModal } from "../components/ManagerOverrideModal";
import { exportCSV } from "../lib/exportCSV";
import type { Usuario, Local } from "../types";
import type { Proveedor, Factura } from "../types/finanzas";
import { aplicacionesPorNc, saldoNcRestante } from "../lib/saldoProveedor";
import type { Remito, FormFactura, FormRemito, FormPagoRemito, ItemFactura } from "./compras/types";
import { estadoDot } from "./compras/helpers";
import { ModalPagarFactura } from "./compras/ModalPagarFactura";
import { ModalLectorIA } from "./compras/ModalLectorIA";
import { ModalVerFactura } from "./compras/ModalVerFactura";
import { ModalCargarFactura } from "./compras/ModalCargarFactura";
import { ModalCargarRemito } from "./compras/ModalCargarRemito";
import { ModalVincularRemito } from "./compras/ModalVincularRemito";
import { ModalPagarRemitoDirecto } from "./compras/ModalPagarRemitoDirecto";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";

// Sub-sección 'Proveedores' del módulo Compras (2026-05-13): la pantalla
// suelta de Proveedores se integra acá. Lazy para no inflar el bundle de
// Compras cuando se entra a otra sub-sección.
const Proveedores = lazy(() => import("./Proveedores"));

type SubSection = "facturas" | "proveedores" | "remitos" | "notas";

// Iconos para botones de acción de las tablas. Compactos para que la columna
// 'Acciones' no se corte cuando el sub-nav lateral le come ancho a la tabla.
// Reemplazan los antiguos botones con texto (Ver / Pagar / Anular / Vincular).
const iconStroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const IconEye = (
  <svg width="13" height="13" viewBox="0 0 16 16" {...iconStroke}><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2.2"/></svg>
);
const IconPay = (
  <svg width="13" height="13" viewBox="0 0 16 16" {...iconStroke}><rect x="1.5" y="4" width="13" height="9" rx="1.5"/><line x1="1.5" y1="7" x2="14.5" y2="7"/></svg>
);
const IconX = (
  <svg width="13" height="13" viewBox="0 0 16 16" {...iconStroke}><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>
);
const IconLink = (
  <svg width="13" height="13" viewBox="0 0 16 16" {...iconStroke}><path d="M7 5a3 3 0 0 0 0 6h2"/><path d="M9 11a3 3 0 0 0 0-6H7"/></svg>
);
const IconEdit = (
  <svg width="13" height="13" viewBox="0 0 16 16" {...iconStroke}><path d="M12 2l2 2-9 9H3v-2z"/><path d="M11 3l2 2"/></svg>
);

// Wrapper común para botones icon-only: 26x26, radius 6, hover bg-soft.
function IconBtn(props: { title: string; onClick: () => void; tone?: "default" | "success" | "danger"; disabled?: boolean; children: React.ReactNode }) {
  const tone = props.tone || "default";
  const color =
    tone === "success" ? "var(--pase-celeste)" :
    tone === "danger"  ? "#DC2626" :
    "var(--pase-text-muted)";
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        width: 28, height: 28, padding: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "transparent",
        border: "none",
        borderRadius: 6,
        color,
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.35 : 0.6,
        transition: "opacity 0.15s, background 0.15s, color 0.15s",
      }}
      onMouseEnter={e => { if (!props.disabled) { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "var(--pase-celeste-100)"; } }}
      onMouseLeave={e => { e.currentTarget.style.opacity = props.disabled ? "0.35" : "0.6"; e.currentTarget.style.background = "transparent"; }}
    >
      {props.children}
    </button>
  );
}

interface ComprasProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

export default function Compras({ user, locales, localActivo }: ComprasProps) {
  const { toast, showToast, showError } = useToast();
  const { CATEGORIAS_COMPRA, GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, COMISIONES_CATS, GASTOS_IMPUESTOS, categoriaToBucket } = useCategorias();
  // Cuentas para el dropdown de "Cuenta de egreso" en el modal de pago.
  // Filtra por cuentas_operables (no por cuentas_visibles): un encargado
  // puede tener permiso de pagar contra una cuenta cuyo saldo no ve.
  const opCuentas = cuentasOperables(user);
  const cuentasUsables = opCuentas === null ? CUENTAS : CUENTAS.filter(c => opCuentas.includes(c));
  const puedeFacturas = tienePermiso(user, "compras");
  const puedeRemitos  = tienePermiso(user, "remitos");
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [remitos, setRemitos] = useState<Remito[]>([]);
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  // T-19 auditoría: aplicaciones de NC para calcular saldo restante real
  // (facturas.pagos de las NCs siempre está vacío — la RPC modifica pagos
  // de la factura destino, no de la NC).
  const [ncAplicaciones, setNcAplicaciones] = useState<Array<{ nc_id: string; monto: number | string }>>([]);
  const [search, setSearch] = useState("");
  // Default: últimos 90 días. Antes era inicio del mes (~15 días promedio)
  // pero los usuarios reportaron faltarles facturas viejas — mejor mostrar
  // 3 meses por default y que filtren manual si quieren ventana más chica.
  const [desde, setDesde] = useState(() => { const d = new Date(today); d.setDate(d.getDate() - 90); return toISO(d); });
  const [hasta, setHasta] = useState(toISO(today));
  const [provFiltro, setProvFiltro] = useState("");
  // ──────────────────────────────────────────────────────────────────
  // Sub-section + filtro de estado controlados por URL (sprint v2 Commit 4).
  //   /compras                    → sub=facturas (default)
  //   /compras/facturas?estado=X  → sub=facturas, filtro estado
  //   /compras/proveedores        → sub=proveedores
  //   /compras/remitos            → sub=remitos
  //   /compras/notas-credito      → sub=notas
  //
  // pillEstado se deriva de ?estado= en la URL. setPillEstado actualiza
  // searchParams (no state). Cambiar sub-sección navega a la URL nueva.
  // ──────────────────────────────────────────────────────────────────
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const pathTail = location.pathname.replace(/^\/compras\/?/, "");
  const subSection: SubSection =
    pathTail.startsWith("proveedores")   ? "proveedores" :
    pathTail.startsWith("remitos")       ? "remitos" :
    pathTail.startsWith("notas-credito") ? "notas" :
    pathTail.startsWith("notas")         ? "notas" :
    "facturas";

  // Mapeo URL → pillEstado (compat con la lógica de filtros interna).
  const urlEstado = searchParams.get("estado");
  const defaultEstadoForSub = (sec: SubSection): string => {
    if (sec === "facturas") return puedeFacturas ? "todas" : "remitos";
    if (sec === "remitos")  return "remitos";
    if (sec === "notas")    return "nc";
    return "proveedores"; // sub === proveedores
  };
  const pillEstado: string = (() => {
    if (subSection === "proveedores") return "proveedores";
    if (subSection === "remitos")     return "remitos";  // tabla siempre completa por ahora
    if (subSection === "notas") {
      // urlEstado: todas|disponibles|aplicadas. La lógica interna usa "nc"
      // como flag de sub-sección y filtra runtime por estado de cada NC.
      return "nc";
    }
    // facturas: urlEstado → pillEstado.
    if (urlEstado === "pendientes") return "pendiente";
    if (urlEstado === "vencidas")   return "vencida";
    if (urlEstado === "pagadas")    return "pagada";
    if (urlEstado === "todas")      return "todas";
    return defaultEstadoForSub("facturas");
  })();

  const setPillEstado = (estado: string) => {
    // Mapeo pillEstado → URL estado (inverso). Solo aplica para facturas.
    if (subSection !== "facturas") return;
    let urlValue: string | null = null;
    if (estado === "pendiente") urlValue = "pendientes";
    else if (estado === "vencida")   urlValue = "vencidas";
    else if (estado === "pagada")    urlValue = "pagadas";
    else if (estado === "todas")     urlValue = "todas";
    const next = new URLSearchParams(searchParams);
    if (urlValue) next.set("estado", urlValue);
    else next.delete("estado");
    setSearchParams(next, { replace: true });
  };

  const setSubSection = (sec: SubSection) => {
    const pathMap: Record<SubSection, string> = {
      facturas:    "/compras/facturas",
      proveedores: "/compras/proveedores",
      remitos:     "/compras/remitos",
      notas:       "/compras/notas-credito",
    };
    navigate(pathMap[sec]);
  };

  // Helper genérico para escribir ?estado= en la URL desde los sub-filtros
  // de Remitos, Notas crédito y Proveedores (bug 2 fix, sprint v2 Commit 4).
  const setUrlEstado = (estado: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("estado", estado);
    setSearchParams(next, { replace: true });
  };

  const isProveedores = subSection === "proveedores";
  // Estados para los flows de remito (modales y form).
  const [remModal, setRemModal] = useState(false);
  const [vincModal, setVincModal] = useState<Remito | null>(null);
  const [pagarRemModal, setPagarRemModal] = useState<Remito | null>(null);
  const [pagandoRem, setPagandoRem] = useState(false);
  // monto: number con CurrencyInput (sprint CurrencyInput).
  const emptyRemForm: FormRemito = { prov_id: "", local_id: localActivo ? String(localActivo) : "", nro: "", fecha: toISO(today), monto: 0, cat: "", detalle: "" };
  const [remForm, setRemForm] = useState<FormRemito>(emptyRemForm);
  const [remPagoForm, setRemPagoForm] = useState<FormPagoRemito>({ cuenta: "", monto: 0, fecha: toISO(today) });

  useEffect(() => {
    if (remPagoForm.cuenta && !cuentasUsables.includes(remPagoForm.cuenta)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRemPagoForm(p => ({ ...p, cuenta: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remPagoForm.cuenta, cuentasUsables.join("|")]);
  const [lectorModal, setLectorModal] = useState(false);
  const [modal, setModal] = useState(false);
  const [pagarModal, setPagarModal] = useState<Factura | null>(null);
  // Idempotency keys (convención C1 + C10): persistidos en sessionStorage
  // por factura/remito. Si el operador hace doble-click → mismo key, RPC
  // cachea. Fix auditoría 2026-05-21 ALTO-12: si el browser muere a mitad,
  // al recargar el modal con la misma factura se REUSA el mismo key del
  // sessionStorage → el server detecta retry y no duplica el pago.
  // El key se borra recién cuando la operación termina exitosa.
  const [idempKeyPagarFac, setIdempKeyPagarFac] = useState<string>(() => crypto.randomUUID());
  const [idempKeyPagarRem, setIdempKeyPagarRem] = useState<string>(() => crypto.randomUUID());

  // Cuando se abre el modal de pagar factura/remito, asegurar que el idempKey
  // está persistido (se reusa si ya existía un intento previo). Fix ALTO-12.
  useEffect(() => {
    if (!pagarModal) return;
    const storageKey = `pase_idemp_pagarfac_${pagarModal.id}`;
    const existing = sessionStorage.getItem(storageKey);
    if (existing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIdempKeyPagarFac(existing);
    } else {
      const fresh = crypto.randomUUID();
      sessionStorage.setItem(storageKey, fresh);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIdempKeyPagarFac(fresh);
    }
  }, [pagarModal]);

  useEffect(() => {
    if (!pagarRemModal) return;
    const storageKey = `pase_idemp_pagarrem_${pagarRemModal.id}`;
    const existing = sessionStorage.getItem(storageKey);
    if (existing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIdempKeyPagarRem(existing);
    } else {
      const fresh = crypto.randomUUID();
      sessionStorage.setItem(storageKey, fresh);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIdempKeyPagarRem(fresh);
    }
  }, [pagarRemModal]);
  // NCs disponibles del proveedor de la factura abierta + saldo restante de
  // cada una. Saldo viene del frontend: nc.total - SUM(pagos[]) — los pagos
  // ya incluyen las aplicaciones previas (tipo='nc').
  // El usuario marca cuáles aplicar y con qué monto. Al confirmar se llaman
  // las RPCs aplicar_nc_a_factura por cada una y pagar_factura por el resto.
  const [ncsAplicar, setNcsAplicar] = useState<Record<string, number>>({});
  const [verModal, setVerModal] = useState<Factura | null>(null);
  const [loading, setLoading] = useState(true);
  const [pagando, setPagando] = useState(false);
  const [saving, setSaving] = useState(false);
  // Edición de factura (Lucas 10-jun: "en compras capaz que también, con
  // los parámetros correspondientes"). Cuando NO es null, el modal de
  // cargar opera en "modo edición" y al guardar llama editar_factura en
  // vez de crear_factura_completa.
  const [editandoFactura, setEditandoFactura] = useState<Factura | null>(null);
  const [editandoMotivo, setEditandoMotivo] = useState("");
  const [idempKeyEditFact, setIdempKeyEditFact] = useState<string>(() => crypto.randomUUID());

  const emptyForm: FormFactura = {
    prov_id: "", local_id: localActivo ? String(localActivo) : "",
    nro: "", fecha: toISO(today), venc: "",
    neto: 0, iva21: 0, iva105: 0, iibb: 0,
    perc_iva: 0, otros_cargos: 0, descuentos: 0,
    cat: "", detalle: "", tipo: "factura",
    // Discriminación fiscal AR (Lucas 10-jun) — todos 0 por default.
    iva27: 0, no_gravado: 0, exento: 0,
    iibb_caba: 0, iibb_ba: 0, iibb_otros: 0, iibb_otros_jurisdiccion: "",
    perc_ganancias: 0, retencion_suss: 0,
  };
  const [form, setForm] = useState<FormFactura>(emptyForm);
  const [items, setItems] = useState<ItemFactura[]>([]);
  // Bug Caja-1: el default cuenta="MercadoPago" pisaba la elección del
  // usuario cuando MP no estaba en cuentasUsables (encargados con cuentas
  // restringidas). Default vacío fuerza la elección consciente.
  const [pagoForm, setPagoForm] = useState<{ cuenta: string; monto: number; fecha: string }>({ cuenta: "", monto: 0, fecha: toISO(today) });
  // F03-jun: saldo a favor/en contra cuando pago != saldo factura.
  const [generarSaldo, setGenerarSaldo] = useState(false);
  const [cerrarFactura, setCerrarFactura] = useState(false);
  // F03-jun paso 2: monto del saldo a favor a aplicar como crédito.
  const [aplicarSaldoFavor, setAplicarSaldoFavor] = useState(0);

  // Defensive: si form.cuenta queda con un valor que no está en
  // cuentasUsables (regression future, scope change), reseteamos a ""
  // para que el placeholder del <select> aparezca. NO borrar — previene
  // el retorno del bug Caja-1.
  useEffect(() => {
    if (pagoForm.cuenta && !cuentasUsables.includes(pagoForm.cuenta)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPagoForm(p => ({ ...p, cuenta: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagoForm.cuenta, cuentasUsables.join("|")]);
  // Reportado 2026-05-06: el filtro `user.rol === "dueno"` excluía admin/
  // superadmin. Ahora usa el helper canónico que cubre todos los casos.
  const visLocs = localesVisibles(user);
  const localesDisp = visLocs === null ? locales : locales.filter((l: Local) => visLocs.includes(l.id));
  // CurrencyInput entrega number directo — no necesita parseMonto.
  // IIBB total = suma de las 3 jurisdicciones discriminadas (CABA + BA +
  // otros). El campo legacy `form.iibb` queda como cache para compat con
  // queries históricas — el INSERT lo setea al guardar.
  const calcTotal = () => {
    const iibbTotal = form.iibb_caba + form.iibb_ba + form.iibb_otros;
    return form.neto + form.no_gravado + form.exento +
      form.iva21 + form.iva105 + form.iva27 +
      iibbTotal + form.perc_iva + form.perc_ganancias + form.retencion_suss +
      form.otros_cargos - form.descuentos;
  };

  const load = async () => {
    setLoading(true);
    // Optimización egress 2026-05-17: proyectar campos específicos en vez
    // de SELECT * + limit 1000 + filtro fecha default 365 días. Las facturas
    // muy viejas se ven con el date range picker manual del usuario.
    const haceUnAnio = toLocalISO(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000));
    let fq = db.from("facturas")
      // imagen_url: path del comprobante en Storage (Lector IA). Se perdió
      // en la optimización de egress del 28-may (SELECT * → columnas
      // explícitas) y el modal Ver Factura nunca recibía el dato (bug
      // Lucas 10-jun). Es un path corto, no pesa.
      .select("id, prov_id, local_id, nro, fecha, venc, neto, iva21, iva105, iibb, total, cat, estado, detalle, pagos, tipo, perc_iva, otros_cargos, descuentos, imagen_url")
      .gte("fecha", haceUnAnio)
      .order("fecha", { ascending: false })
      .limit(1000);
    fq = applyLocalScope(fq, user, localActivo);
    let rq = db.from("remitos")
      .select("id, prov_id, local_id, nro, fecha, monto, cat, estado, detalle, factura_id")
      .gte("fecha", haceUnAnio)
      .order("fecha", { ascending: false })
      .limit(1000);
    rq = applyLocalScope(rq, user, localActivo);
    const naq = db.from("nc_aplicaciones").select("nc_id, monto");
    // Fix 2026-06-03: query proveedores con fallback. Si la migration
    // 202606031400 (saldo_a_favor) no está aplicada todavía, el SELECT
    // tira error y la pantalla queda con proveedores=[] (bug reportado
    // por Lucas: "Proveedores 0" + lista vacía). Intentamos con la
    // columna nueva; si falla por columna inexistente, fallback sin ella.
    const pqFull = db.from("proveedores")
      .select("id, nombre, cuit, cat, saldo, saldo_a_favor, estado")
      .eq("estado", "Activo").order("nombre");
    const [{ data: f }, { data: r }, pRes, { data: na }] = await Promise.all([
      fq,
      rq,
      pqFull,
      naq,
    ]);
    let pData: Proveedor[] | null = (pRes.data as Proveedor[] | null);
    if (pRes.error && /saldo_a_favor|column.*does not exist/i.test(pRes.error.message)) {
      // Migration no aplicada — fallback al SELECT viejo (sin saldo_a_favor).
      const pFallback = await db.from("proveedores")
        .select("id, nombre, cuit, cat, saldo, estado")
        .eq("estado", "Activo").order("nombre");
      pData = (pFallback.data as Proveedor[] | null);
    }
    setFacturas((f as Factura[]) || []);
    setRemitos((r as Remito[]) || []);
    setProveedores(pData || []);
    setNcAplicaciones((na as Array<{ nc_id: string; monto: number | string }>) || []);
    setLoading(false);
  };
  // Patrón fetch-on-dep-change.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [localActivo]);

  // Sprint Realtime: cambios remotos en facturas, remitos o proveedores
  // del mismo tenant disparan reload. Cubre el flow de "carga manual de
  // factura en una compu, otra debe ver el cambio sin F5".
  useRealtimeTable({ table: 'facturas', onChange: () => load() });
  useRealtimeTable({ table: 'remitos', onChange: () => load() });
  useRealtimeTable({ table: 'proveedores', onChange: () => load() });

  // BUG 1: Lector IA modal solo cierra con X o ESC, no con click en backdrop.
  useEffect(() => {
    if (!lectorModal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLectorModal(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lectorModal]);

  // Map<nc_id, monto_aplicado> derivado de nc_aplicaciones. Necesario para
  // saber el saldo real de las NCs en el listado y modal pagar (la columna
  // facturas.pagos de las NCs siempre está vacía — bug T-19).
  const ncAplicMap = aplicacionesPorNc(ncAplicaciones);

  // Sub-filtros URL-driven para Remitos / Notas / Proveedores (bug 2 fix).
  // Se declaran ANTES de fFilt/rFilt porque ambos los referencian al filtrar.
  const remitoEstadoFiltro = (subSection === "remitos" ? (urlEstado || "todos") : "todos");
  const notaEstadoFiltro   = (subSection === "notas"   ? (urlEstado || "todas") : "todas");
  const proveedorEstadoFiltro = (subSection === "proveedores" ? (urlEstado || "activos") : "activos");
  // Filtro de NCs por estado (disponibles | aplicadas | todas). Aplica solo
  // cuando estamos en sub-sección Notas crédito.
  const filtrarNotaPorEstado = (f: Factura): boolean => {
    if (subSection !== "notas") return true;
    const consumida = f.estado === "pagada" || saldoNcRestante(f, ncAplicMap) <= 0;
    if (notaEstadoFiltro === "disponibles") return !consumida;
    if (notaEstadoFiltro === "aplicadas") return consumida;
    return true; // 'todas'
  };

  const fFilt = facturas.filter(f => {
    if (f.estado === "anulada") return false;
    const isNC = (f.tipo || "factura") === "nota_credito";
    // Tab semantics:
    //  - "todas": facturas + NC mezcladas por fecha
    //  - "pendiente"/"vencida"/"pagada": solo facturas con ese estado
    //  - "nc": solo notas de crédito
    // Bug #32: antes la sección filtraba NC siempre, dejándolas invisibles
    // del listado de Compras aunque en Proveedores → Estado de Cuenta
    // aparecían en "NC Disponibles". Anto cargaba una NC y creía que se
    // había perdido.
    if (pillEstado === "nc") {
      if (!isNC) return false;
      // Sub-filtro URL-driven dentro de Notas crédito (bug 2).
      if (!filtrarNotaPorEstado(f)) return false;
    } else if (pillEstado === "todas") {
      // pasa todo (factura o NC)
    } else {
      if (isNC) return false;
      // estadoFactura() deriva "vencida" cuando estado=pendiente y la fecha
      // de vencimiento ya pasó. Permite filtrar correctamente sin depender
      // de un trigger SQL que mantenga el campo estado actualizado.
      if (estadoFactura(f) !== pillEstado) return false;
    }
    if (localActivo && String(f.local_id) !== String(localActivo)) return false;
    if (provFiltro && String(f.prov_id) !== String(provFiltro)) return false;
    if (desde && f.fecha < desde) return false;
    if (hasta && f.fecha > hasta) return false;
    if (search) {
      const prov = proveedores.find(p => String(p.id) === String(f.prov_id));
      const matchProv = prov?.nombre.toLowerCase().includes(search.toLowerCase());
      const matchNro = (f.nro || "").toLowerCase().includes(search.toLowerCase());
      if (!matchProv && !matchNro) return false;
    }
    return true;
  });

  const onProvChange = (prov_id: string) => {
    const prov = proveedores.find(p => String(p.id) === String(prov_id));
    setForm(f => ({ ...f, prov_id, cat: prov?.cat || f.cat }));
  };

  const addItem = () => setItems([...items, { producto: "", cantidad: "", unidad: "kg", precio_unitario: "", subtotal: 0 }]);
  const updateItem = (i: number, field: keyof ItemFactura, val: string | number) => {
    const current = items[i];
    if (!current) return;
    // materia_prima_id: 0 → null (modo "sin vincular" desde select vacío)
    let newVal: ItemFactura[keyof ItemFactura] = val;
    if (field === "materia_prima_id") {
      newVal = (typeof val === "number" && val > 0) ? val : null;
    }
    const updated: ItemFactura = { ...current, [field]: newVal };
    if (field === "cantidad" || field === "precio_unitario") {
      const q = parseMonto(field === "cantidad" ? val : updated.cantidad);
      const p = parseMonto(field === "precio_unitario" ? val : updated.precio_unitario);
      updated.subtotal = q * p;
    }
    const newItems = [...items];
    newItems[i] = updated;
    setItems(newItems);
  };
  const removeItem = (i: number) => setItems(items.filter((_, idx) => idx !== i));

  const guardar = async () => {
    if (saving) return;
    if (!form.prov_id) { showError("Seleccioná un proveedor"); return; }
    if (!form.nro) { showError("Ingresá el número de factura"); return; }
    if (form.neto <= 0) { showError("Ingresá el neto gravado"); return; }
    if (!form.local_id) { showError("Seleccioná un local"); return; }
    const isNC = form.tipo === "nota_credito";
    const totalAbs = calcTotal();
    const total = isNC ? -Math.abs(totalAbs) : totalAbs;

    // Warning de duplicados (bug #29): mismo proveedor, misma fecha, total
    // dentro de ±1%. Detecta dupes por typo (ej: "00003-00015" vs
    // "00003-00000515"). El chequeo respeta RLS — si el user tiene scope
    // de locales restringido, sólo ve las suyas.
    if (form.fecha && form.prov_id) {
      const { data: posibles } = await db.from("facturas")
        .select("nro, fecha, total, estado, tipo")
        .eq("prov_id", parseInt(form.prov_id))
        .eq("fecha", form.fecha)
        .neq("estado", "anulada");
      const dup = (posibles || []).find(p => {
        const diff = Math.abs(Number(p.total || 0) - total);
        const tol = Math.max(1, Math.abs(total) * 0.01);
        return diff <= tol && (p.tipo || "factura") === form.tipo;
      });
      if (dup) {
        const prov = proveedores.find(p => p.id === parseInt(form.prov_id));
        const ok = confirm(
          `Ya existe una factura similar:\n\n` +
          `  ${dup.nro} · ${fmt_d(dup.fecha)} · ${fmt_$(Number(dup.total))}\n` +
          `  ${prov?.nombre || ""}\n\n` +
          `¿Querés cargar esta igualmente?`,
        );
        if (!ok) return;
      }
    }

    // Check FUERTE por número exacto (caso 10-jun: factura cargada 3 veces
    // pese al aviso blando). Mismo nro + mismo proveedor = misma factura.
    if (form.nro && form.prov_id) {
      // eslint-disable-next-line pase-local/require-apply-local-scope -- dup check cross-local intencional
      const { data: mismoNro } = await db.from("facturas")
        .select("nro, fecha, total, estado")
        .eq("prov_id", parseInt(form.prov_id))
        .eq("nro", form.nro)
        .neq("estado", "anulada")
        .limit(1);
      if (mismoNro && mismoNro.length > 0) {
        const d = mismoNro[0]!;
        const dTotal = Number(d.total) || 0;
        const fTotal = calcTotal();
        const totalCoincide = fTotal > 0 && Math.abs(dTotal - fTotal) <= Math.max(1, dTotal * 0.005);
        const fechaCoincide = !!form.fecha && d.fecha === form.fecha;
        const ok = confirm(
          `⚠️ FACTURA DUPLICADA ⚠️\n\n` +
          `Estás cargando:\n` +
          `  Nº ${form.nro}\n` +
          `  ${form.fecha ? fmt_d(form.fecha) : "(sin fecha)"} · ${fTotal > 0 ? fmt_$(fTotal) : "(sin total)"}\n\n` +
          `Ya existe con ese mismo Nº:\n` +
          `  Nº ${d.nro}\n` +
          `  ${d.fecha ? fmt_d(d.fecha) : "?"} · ${fmt_$(dTotal)} · estado: ${String(d.estado).toUpperCase()}\n\n` +
          (totalCoincide && fechaCoincide
            ? `Coinciden Nº, fecha y total → es la MISMA factura. Cargarla de nuevo DUPLICA el gasto.\n\n¿Cancelar la carga? (OK = cargar igual)`
            : `OJO: el total ${totalCoincide ? "coincide" : "NO coincide"} y la fecha ${fechaCoincide ? "coincide" : "NO coincide"}.\n` +
              `Si NO COINCIDEN total o fecha, revisá el recibo: ¿el Nº que pusiste es realmente el del recibo o te equivocaste tipeando?\n\n` +
              `¿Cargar igual (es otra factura con el mismo Nº)?`),
        );
        if (!ok) return;
      }
    }

    setSaving(true);
    try {
      const id = genId(isNC ? "NC" : "FACT");
      // Campos date: "" → null. Postgres rechaza string vacío en columnas
      // date con "invalid input syntax for type date: \"\"". Común en NC
      // que no siempre tienen vencimiento.
      // CurrencyInput entrega number directo — no necesita parseMonto.
      // bucket: deriva del tipo crudo de la cat en config_categorias
      // (cat_compra | gasto_fijo | gasto_variable | gasto_publicidad |
      // gasto_comision | gasto_impuesto). Si la cat no está mapeada (libre
      // o legacy), bucket queda null y EERR la trata como CMV.
      const bucket = form.cat ? (categoriaToBucket[form.cat] ?? null) : null;
      // iibb legacy = cache de suma de jurisdicciones (compat con queries
      // viejas que leen ese campo plano).
      const iibbTotal = form.iibb_caba + form.iibb_ba + form.iibb_otros;
      const nueva = {
        ...form, id,
        prov_id: parseInt(form.prov_id), local_id: parseInt(form.local_id),
        iibb: iibbTotal,
        total, estado: "pendiente", pagos: [], tipo: form.tipo,
        fecha: form.fecha || null, venc: form.venc || null, bucket,
        iibb_otros_jurisdiccion: form.iibb_otros_jurisdiccion.trim() || null,
      };
      // Mapeo explícito a columnas de factura_items. materia_prima_id es opcional;
      // si el cajero lo vinculó, dispara trigger SQL que actualiza el precio_actual
      // de esa MP y recalcula el costo del insumo unificado (CMV refactor 15-may).
      const itemsToInsert = items.length > 0
        ? items.filter(it => it.producto).map(it => ({
            producto: it.producto,
            cantidad: parseMonto(it.cantidad),
            unidad: it.unidad,
            precio_unitario: parseMonto(it.precio_unitario),
            subtotal: it.subtotal,
            materia_prima_id: it.materia_prima_id ?? null,
          }))
        : [];
      // Modo edición (Lucas 10-jun): si hay una factura en editandoFactura,
      // llamamos editar_factura RPC en vez de crear_factura_completa.
      if (editandoFactura) {
        const motivo = editandoMotivo.trim();
        if (!motivo) { showError("Necesitás justificar la edición."); return; }
        const { error: editErr } = await db.rpc("editar_factura", {
          p_factura_id: editandoFactura.id,
          p_motivo: motivo,
          p_nro: form.nro,
          p_fecha: form.fecha || null,
          p_venc: form.venc || null,
          p_cat: form.cat || null,
          p_detalle: form.detalle || null,
          p_neto: form.neto,
          p_iva21: form.iva21,
          p_iva105: form.iva105,
          p_iva27: form.iva27,
          p_no_gravado: form.no_gravado,
          p_exento: form.exento,
          p_iibb_caba: form.iibb_caba,
          p_iibb_ba: form.iibb_ba,
          p_iibb_otros: form.iibb_otros,
          p_iibb_otros_jurisdiccion: form.iibb_otros_jurisdiccion.trim() || null,
          p_perc_iva: form.perc_iva,
          p_perc_ganancias: form.perc_ganancias,
          p_retencion_suss: form.retencion_suss,
          p_otros_cargos: form.otros_cargos,
          p_descuentos: form.descuentos,
          p_idempotency_key: idempKeyEditFact,
        });
        if (editErr) throw new Error("Error editando factura: " + (editErr.message || editErr));
        setModal(false); setForm(emptyForm); setItems([]);
        setEditandoFactura(null); setEditandoMotivo("");
        setIdempKeyEditFact(crypto.randomUUID());
        load();
        return;
      }
      // RPC atómica (deuda C4-F12 cerrada): INSERT factura + INSERT items en
      // una sola TX con idempotency key. Antes podía quedar factura sin items
      // si el segundo INSERT fallaba.
      const { error: factErr } = await db.rpc("crear_factura_completa", {
        p_factura: nueva,
        p_items: itemsToInsert,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (factErr) throw new Error("Error guardando factura: " + (factErr.message || factErr));
      // El trigger trg_saldo_prov_facturas (migration 202605070900) recalcula
      // proveedores.saldo automáticamente al insertar la factura/NC.
      setModal(false); setForm(emptyForm); setItems([]); load();
    } catch (err) {
      console.error("Error guardando factura:", err);
      showError("Error al guardar: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // Lucas 10-jun: abre el modal de cargar factura en modo edición —
  // pre-llena form con los valores de la factura, marca editandoFactura,
  // el guardar despacha a editar_factura en vez de crear_factura_completa.
  const abrirEditarFactura = (f: Factura) => {
    setEditandoFactura(f);
    setEditandoMotivo("");
    setIdempKeyEditFact(crypto.randomUUID());
    setForm({
      prov_id: String(f.prov_id),
      local_id: String(f.local_id),
      nro: f.nro || "",
      fecha: f.fecha ? toLocalISO(new Date(f.fecha)) : toISO(today),
      venc: f.venc ? toLocalISO(new Date(f.venc)) : "",
      neto: Number(f.neto) || 0,
      iva21: Number(f.iva21) || 0,
      iva105: Number(f.iva105) || 0,
      iibb: Number(f.iibb) || 0,
      perc_iva: Number(f.perc_iva) || 0,
      otros_cargos: Number(f.otros_cargos) || 0,
      descuentos: Number(f.descuentos) || 0,
      cat: f.cat || "",
      detalle: f.detalle || "",
      tipo: f.tipo || "factura",
      iva27: Number(f.iva27 ?? 0),
      no_gravado: Number(f.no_gravado ?? 0),
      exento: Number(f.exento ?? 0),
      iibb_caba: Number(f.iibb_caba ?? 0),
      iibb_ba: Number(f.iibb_ba ?? 0),
      iibb_otros: Number(f.iibb_otros ?? 0),
      iibb_otros_jurisdiccion: f.iibb_otros_jurisdiccion ?? "",
      perc_ganancias: Number(f.perc_ganancias ?? 0),
      retencion_suss: Number(f.retencion_suss ?? 0),
    });
    setItems([]);
    setModal(true);
  };

  const pagar = async () => {
    if (pagando || !pagarModal) return;
    setPagando(true);
    try {
      const f = pagarModal;
      const prov = proveedores.find(p => String(p.id) === String(f.prov_id));
      const detalle = `Pago ${prov?.nombre || ""} - Fact ${f.nro}`;

      // 0) Aplicar saldo a favor del proveedor si el user lo eligió (F03-jun
      //    paso 2). No mueve plata — solo consume crédito acumulado.
      //    Se hace ANTES de NCs y pago para que el saldo factura quede al día.
      if (aplicarSaldoFavor > 0) {
        const { error: sfErr } = await db.rpc("aplicar_saldo_a_favor_proveedor", {
          p_factura_id: f.id,
          p_monto: aplicarSaldoFavor,
          p_fecha: pagoForm.fecha,
          p_idempotency_key: idempKeyPagarFac + "-sf",
        });
        if (sfErr) throw sfErr;
      }

      // 1) Aplicar NCs seleccionadas. AUDIT F3A#7: 1 RPC batch (antes había
      //    un loop con for+await que generaba N round-trips secuenciales).
      //    La batch es atómica por NC adentro (cada aplicación es su propia
      //    transacción server-side); el response trae detalles por NC.
      const ncEntries = Object.entries(ncsAplicar).filter(([, m]) => m > 0);
      const totalNcAplicado = ncEntries.reduce((s, [, m]) => s + m, 0);
      if (ncEntries.length > 0) {
        const ncsPayload = ncEntries.map(([nc_id, monto]) => ({
          nc_id,
          monto,
          fecha: pagoForm.fecha,
        }));
        const { data: batchRes, error: ncErr } = await db.rpc("aplicar_ncs_a_factura", {
          p_factura_id: f.id,
          p_ncs: ncsPayload,
        });
        if (ncErr) throw ncErr;
        // Si alguna NC individual falló, propagar el primer error.
        const fallidas = (batchRes as { fallidas?: number; detalles?: Array<{ ok: boolean; error?: string; nc_id: string }> } | null);
        if (fallidas && (fallidas.fallidas ?? 0) > 0) {
          const primeraFalla = (fallidas.detalles || []).find(d => !d.ok);
          throw new Error(`NC ${primeraFalla?.nc_id} falló: ${primeraFalla?.error || "error desconocido"}`);
        }
      }

      // 2) Pagar el resto con plata si queda saldo. Si solo se aplicaron NCs
      //    + saldo a favor y la factura ya queda saldada, se omite pagar_factura.
      const restanteAPagar = pagoForm.monto > 0
        ? pagoForm.monto
        : Math.max(0, f.total - totalNcAplicado - aplicarSaldoFavor);
      if (restanteAPagar > 0) {
        if (!pagoForm.cuenta) {
          showError("Elegí una cuenta de egreso para el saldo restante");
          setPagando(false);
          return;
        }
        const { error } = await db.rpc("pagar_factura", {
          p_factura_id: f.id,
          p_monto: restanteAPagar,
          p_cuenta: pagoForm.cuenta,
          p_fecha: pagoForm.fecha,
          p_detalle: detalle,
          p_idempotency_key: idempKeyPagarFac,
          p_generar_saldo: generarSaldo,
          p_cerrar_factura: cerrarFactura,
        });
        if (error) throw error;
      } else if (totalNcAplicado === 0) {
        // Ni NCs ni plata → nada que hacer.
        showError("Indicá un pago con plata o aplicá una NC");
        setPagando(false);
        return;
      }

      // Operación exitosa — borrar el idempKey persistido para esta factura.
      // Si el operador vuelve a abrir el modal (mismo o distinto), va a
      // recibir un key fresco (sería un pago parcial nuevo).
      sessionStorage.removeItem(`pase_idemp_pagarfac_${pagarModal.id}`);

      setPagarModal(null);
      setNcsAplicar({});
      setGenerarSaldo(false);
      setCerrarFactura(false);
      setAplicarSaldoFavor(0);
      load();
    } catch (err) {
      console.error("Error en pagar:", err);
      showError(translateRpcError(err));
    } finally {
      setPagando(false);
    }
  };

  // Pending override: cuando el user no tiene `compras_anular` y se intenta
  // anular, guardamos la factura/motivo acá y abrimos el modal. Cuando llega
  // el código válido, llamamos a la RPC con p_override_code.
  const [pendingAnular, setPendingAnular] = useState<{ factura: Factura; motivo: string } | null>(null);

  async function ejecutarAnular(f: Factura, motivo: string, overrideCode?: string) {
    const { error } = await db.rpc("anular_factura", {
      p_factura_id: f.id,
      p_motivo: motivo,
      ...(overrideCode ? { p_override_code: overrideCode } : {}),
    });
    if (error) { showError(translateRpcError(error)); return; }
    showToast("Factura anulada");
    load();
  }

  const anular = async (f: Factura) => {
    if (!confirm(`¿Anular factura ${f.nro}? Esta acción queda registrada.`)) return;
    const motivo = prompt("Motivo (opcional):") || "Anulada desde UI";
    // Si el user tiene permiso, ejecuta directo. Si no, abre modal de override.
    if (tienePermiso(user, "compras_anular")) {
      await ejecutarAnular(f, motivo);
    } else {
      setPendingAnular({ factura: f, motivo });
    }
  };

  // ─── Remitos ────────────────────────────────────────────────────────────
  // Lógica heredada de Remitos.tsx (eliminado 2026-05-07). Mismas RPCs:
  // pagar_remito y anular_remito. La inserción es un INSERT directo; los
  // triggers de migration 202605070900 actualizan proveedores.saldo.

  const onRemProvChange = (prov_id: string) => {
    const prov = proveedores.find(p => p.id === parseInt(prov_id));
    setRemForm(f => ({ ...f, prov_id, cat: prov?.cat || f.cat }));
  };

  const guardarRemito = async () => {
    if (remForm.monto <= 0 || !remForm.local_id) return;
    const nro = remForm.nro || `REM-${Date.now().toString().slice(-6)}`;
    const nuevo = {
      ...remForm, id: genId("REM"),
      prov_id: remForm.prov_id ? parseInt(remForm.prov_id) : null,
      local_id: parseInt(String(remForm.local_id)),
      nro, monto: remForm.monto,
      estado: "sin_factura", factura_id: null,
    };
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F12: cargar remito debe ir por RPC crear_remito atómica. Hoy el trigger trg_saldo_proveedor cubre proveedor.saldo, pero el control de duplicados queda client-side.
    await db.from("remitos").insert([nuevo]);
    setRemModal(false); setRemForm(emptyRemForm); load();
  };

  const vincularRemitoAFactura = async (fid: string) => {
    const r = vincModal;
    if (!r) return;
    // Fix bug Anto 21-may: si el remito ya estaba pagado, la RPC propaga
    // el pago a la factura (estado='pagada' si cubre total). Antes el UPDATE
    // directo dejaba la factura como pendiente aunque el dinero ya hubiera
    // salido por el pago del remito. Migration 202605213100.
    const { error } = await db.rpc("vincular_remito_factura", {
      p_remito_id: r.id,
      p_factura_id: fid,
    });
    if (error) {
      showError("Error al vincular: " + translateRpcError(error));
      return;
    }
    setVincModal(null); load();
  };

  const pagarRemito = async () => {
    if (pagandoRem || !pagarRemModal) return;
    if (!remPagoForm.cuenta) { showError("Elegí una cuenta de egreso"); return; }
    setPagandoRem(true);
    try {
      const r = pagarRemModal;
      const monto = remPagoForm.monto > 0 ? remPagoForm.monto : r.monto;
      const { error } = await db.rpc("pagar_remito", {
        p_remito_id: r.id, p_monto: monto,
        p_cuenta: remPagoForm.cuenta, p_fecha: remPagoForm.fecha,
        p_idempotency_key: idempKeyPagarRem,
      });
      if (error) throw error;
      // Limpiar idempKey persistido — operación exitosa.
      sessionStorage.removeItem(`pase_idemp_pagarrem_${pagarRemModal.id}`);
      setPagarRemModal(null); load();
    } catch (err) {
      console.error("Error pagando remito:", err);
      showError(translateRpcError(err));
    } finally {
      setPagandoRem(false);
    }
  };

  // Pending override de remito (mismo patrón que pendingAnular para facturas).
  const [pendingAnularRemito, setPendingAnularRemito] = useState<{ remito: Remito; motivo: string } | null>(null);

  async function ejecutarAnularRemito(r: Remito, motivo: string, overrideCode?: string) {
    const { error } = await db.rpc("anular_remito", {
      p_remito_id: r.id,
      p_motivo: motivo,
      ...(overrideCode ? { p_override_code: overrideCode } : {}),
    });
    if (error) { showError(translateRpcError(error)); return; }
    showToast("Remito anulado");
    load();
  }

  const anularRemito = async (r: Remito) => {
    if (!confirm(`¿Anular remito ${r.nro}?`)) return;
    const motivo = prompt("Motivo (opcional):") || "Anulado desde UI";
    if (tienePermiso(user, "compras_anular")) {
      await ejecutarAnularRemito(r, motivo);
    } else {
      setPendingAnularRemito({ remito: r, motivo });
    }
  };

  // Filtro de remitos respeta el local activo del sidebar y el provFiltro.
  const rFilt = remitos.filter(r => {
    if (localActivo && String(r.local_id) !== String(localActivo)) return false;
    if (provFiltro && String(r.prov_id) !== String(provFiltro)) return false;
    if (search) {
      const prov = proveedores.find(p => String(p.id) === String(r.prov_id));
      const matchProv = prov?.nombre.toLowerCase().includes(search.toLowerCase());
      const matchNro = (r.nro || "").toLowerCase().includes(search.toLowerCase());
      if (!matchProv && !matchNro) return false;
    }
    if (desde && r.fecha < desde) return false;
    if (hasta && r.fecha > hasta) return false;
    // Filtro por estado del sub-nav cuando estamos en sub-sección Remitos.
    if (subSection === "remitos") {
      if (r.estado === "anulado") return false;
      if (remitoEstadoFiltro === "sin_aplicar" && r.estado !== "sin_factura") return false;
      if (remitoEstadoFiltro === "aplicados" && !(r.estado === "facturado" || r.estado === "pagado" || r.estado === "vinculado")) return false;
    }
    return true;
  });


  // ─── Conteos para el RightSubNav ─────────────────────────────────────
  // Sub-secciones: contadores siempre visibles, calculados sobre el array
  // completo no filtrado.
  const countFacturas = facturas.filter(f => f.estado !== "anulada" && (f.tipo || "factura") === "factura").length;
  const countRemitosTotal = remitos.filter(r => r.estado !== "anulado").length;
  const countNotas = facturas.filter(f => (f.tipo || "factura") === "nota_credito" && f.estado !== "anulada").length;
  const countProveedores = proveedores.filter(p => p.estado !== "Inactivo").length;

  // Estado contextual: contadores según sub-sección activa.
  let estadoSection: SubNavSection | null = null;
  if (subSection === "facturas") {
    const facsActivas = facturas.filter(f => f.estado !== "anulada" && (f.tipo || "factura") === "factura");
    const cTodas    = facsActivas.length;
    const cPend     = facsActivas.filter(f => estadoFactura(f) === "pendiente").length;
    const cVenc     = facsActivas.filter(f => estadoFactura(f) === "vencida").length;
    const cPag      = facsActivas.filter(f => f.estado === "pagada").length;
    estadoSection = {
      header: "Estado",
      activeId: pillEstado,
      onSelect: (id) => setPillEstado(id),
      items: [
        { id: "todas",     label: "Todas",      count: cTodas },
        { id: "pendiente", label: "Pendientes", count: cPend },
        { id: "vencida",   label: "Vencidas",   count: cVenc },
        { id: "pagada",    label: "Pagadas",    count: cPag },
      ],
    };
  } else if (subSection === "remitos") {
    const remActivos = remitos.filter(r => r.estado !== "anulado");
    const cTodos    = remActivos.length;
    const cSinApl   = remActivos.filter(r => r.estado === "sin_factura").length;
    const cAplic    = remActivos.filter(r => r.estado === "facturado" || r.estado === "pagado" || r.estado === "vinculado").length;
    estadoSection = {
      header: "Estado",
      activeId: remitoEstadoFiltro,
      onSelect: setUrlEstado,
      items: [
        { id: "todos",       label: "Todos",       count: cTodos },
        { id: "sin_aplicar", label: "Sin aplicar", count: cSinApl },
        { id: "aplicados",   label: "Aplicados",   count: cAplic },
      ],
    };
  } else if (subSection === "notas") {
    const ncs = facturas.filter(f => (f.tipo || "factura") === "nota_credito" && f.estado !== "anulada");
    const cTodas       = ncs.length;
    const cDisponibles = ncs.filter(f => f.estado !== "pagada" && saldoNcRestante(f, ncAplicMap) > 0).length;
    const cAplicadas   = ncs.filter(f => f.estado === "pagada" || saldoNcRestante(f, ncAplicMap) <= 0).length;
    estadoSection = {
      header: "Estado",
      activeId: notaEstadoFiltro,
      onSelect: setUrlEstado,
      items: [
        { id: "todas",       label: "Todas",       count: cTodas },
        { id: "disponibles", label: "Disponibles", count: cDisponibles },
        { id: "aplicadas",   label: "Aplicadas",   count: cAplicadas },
      ],
    };
  } else if (subSection === "proveedores") {
    const cActivos    = proveedores.filter(p => p.estado !== "Inactivo").length;
    const cInactivos  = proveedores.filter(p => p.estado === "Inactivo").length;
    estadoSection = {
      header: "Estado",
      activeId: proveedorEstadoFiltro,
      onSelect: setUrlEstado,
      items: [
        { id: "activos",   label: "Activos",   count: cActivos },
        { id: "inactivos", label: "Inactivos", count: cInactivos },
      ],
    };
  }

  const subNavSections: SubNavSection[] = [
    {
      header: "Sección",
      activeId: subSection,
      onSelect: (id) => setSubSection(id as SubSection),
      items: [
        ...(puedeFacturas ? [{ id: "facturas",    label: "Facturas",     count: countFacturas }] : []),
        ...(puedeFacturas ? [{ id: "proveedores", label: "Proveedores",  count: countProveedores }] : []),
        ...(puedeRemitos  ? [{ id: "remitos",     label: "Remitos",      count: countRemitosTotal }] : []),
        ...(puedeFacturas ? [{ id: "notas",       label: "Notas crédito",count: countNotas }] : []),
      ],
    },
    ...(estadoSection ? [estadoSection] : []),
  ];

  return (
    <div>
      <PageHeader
        title="Compras"
        subtitle={
          subSection === "facturas"    ? "facturas" :
          subSection === "proveedores" ? "proveedores" :
          subSection === "remitos"     ? "remitos" :
          subSection === "notas"       ? "notas de crédito" : undefined
        }
        info={
          subSection === "facturas"    ? <>Facturas de proveedores. Podés cargarlas a mano o usar el <strong>Lector IA</strong> (sacá foto y Claude la lee). Cada factura paga descuenta de la cuenta de caja elegida.</> :
          subSection === "proveedores" ? <>Catálogo de proveedores. El saldo se actualiza solo al cargar/pagar facturas. Mantené los CUITs al día para el listado del contador.</> :
          subSection === "remitos"     ? <>Remitos pendientes de facturación. Cada remito se asocia a una factura cuando llega.</> :
          subSection === "notas"       ? <>Notas de crédito de proveedores. Se aplican contra facturas pendientes para reducir el saldo.</> :
          undefined
        }
        actions={
          <>
            {(subSection === "facturas" || subSection === "remitos") && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  if (subSection === "facturas") {
                    // Pedido Carolina 02-jun: el contador necesita el
                    // desglose completo de la factura (libro IVA Compras
                    // estándar AR), no solo el total. Columnas en orden
                    // que usa la mayoría de los contadores AR para cargar
                    // en su software (Tango, Bejerman, Holistor).
                    const headers = [
                      "Fecha", "Tipo", "Nº Comprobante", "CUIT Proveedor", "Razón Social",
                      "Local", "Categoría",
                      "Neto Gravado", "IVA 21%", "IVA 10,5%",
                      "Percep. IVA", "Percep. IIBB", "Otros Cargos", "Descuentos",
                      "Total", "Vencimiento", "Estado de Pago",
                    ];
                    const rows = fFilt.map(f => {
                      const prov = proveedores.find(p => p.id === f.prov_id);
                      return [
                        f.fecha?.slice(0, 10) || "",
                        f.tipo || "factura",
                        f.nro || "",
                        prov?.cuit || "",
                        prov?.nombre || "",
                        locales.find(l => l.id === f.local_id)?.nombre || "",
                        f.cat || "",
                        Number(f.neto ?? 0),
                        Number(f.iva21 ?? 0),
                        Number(f.iva105 ?? 0),
                        Number(f.perc_iva ?? 0),
                        Number(f.iibb ?? 0),
                        Number(f.otros_cargos ?? 0),
                        Number(f.descuentos ?? 0),
                        Number(f.total ?? 0),
                        f.venc?.slice(0, 10) || "",
                        estadoFactura(f),
                      ];
                    });
                    exportCSV(`facturas_${desde}_${hasta}.csv`, headers, rows);
                  } else {
                    const headers = ["Fecha", "Nº Remito", "Proveedor", "Local", "Categoría", "Monto", "Detalle", "Estado"];
                    const rows = rFilt.map(r => [
                      r.fecha?.slice(0, 10) || "",
                      r.nro || "",
                      proveedores.find(p => p.id === r.prov_id)?.nombre || "(sin proveedor)",
                      locales.find(l => l.id === r.local_id)?.nombre || "",
                      r.cat || "",
                      Number(r.monto ?? 0),
                      r.detalle || "",
                      r.estado,
                    ]);
                    exportCSV(`remitos_${desde}_${hasta}.csv`, headers, rows);
                  }
                }}
                disabled={subSection === "facturas" ? fFilt.length === 0 : rFilt.length === 0}
                title={`Exportar ${subSection} a CSV`}
              >⬇ Exportar</button>
            )}
            {subSection === "facturas" && puedeFacturas && <button data-tour="compras-lector-ia" className="btn btn-sec" onClick={() => setLectorModal(true)}>Lector IA</button>}
            {subSection === "facturas" && puedeRemitos && (
              <button data-tour="compras-remito" className="btn btn-sec" onClick={() => { setRemForm({ ...emptyRemForm, local_id: localActivo ? String(localActivo) : "" }); setRemModal(true); }}>+ Cargar remito</button>
            )}
            {subSection === "facturas" && puedeFacturas && (
              <button data-tour="compras-cargar" className="btn btn-acc" onClick={() => { setForm({ ...emptyForm, local_id: localActivo ? String(localActivo) : "" }); setItems([]); setModal(true); }}>+ Cargar factura</button>
            )}
            {subSection === "remitos" && puedeRemitos && (
              <button className="btn btn-acc" onClick={() => { setRemForm({ ...emptyRemForm, local_id: localActivo ? String(localActivo) : "" }); setRemModal(true); }}>+ Cargar remito</button>
            )}
            {subSection === "notas" && puedeFacturas && (
              <button className="btn btn-acc" onClick={() => { setForm({ ...emptyForm, local_id: localActivo ? String(localActivo) : "", tipo: "nota_credito" }); setItems([]); setModal(true); }}>+ Cargar nota</button>
            )}
            {subSection === "proveedores" && (
              <button
                className="btn btn-acc"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.set("action", "nuevo");
                  setSearchParams(next, { replace: true });
                }}
              >
                + Nuevo proveedor
              </button>
            )}
          </>
        }
      />

      {/* Layout módulo madre: contenido a la izquierda + RightSubNav derecha.
          Clase global .module-with-aside (Layout.tsx) maneja el grid + media
          query mobile <900px que mueve el sub-nav arriba para que las tablas
          del contenido principal no queden apretadas. */}
      <div className="module-with-aside">
        <div style={{ minWidth: 0 }}>

      {/* Filtros */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center", flexWrap: "wrap" }}>
        <input className="search" placeholder="Buscar proveedor o Nº..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: 200 }} />
        <div style={{ width: 1, height: 22, background: "var(--bd)" }} />
        <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--muted2)"}}>
          Desde
          <input type="date" className="search" value={desde} onChange={e => setDesde(e.target.value)} style={{ width: 140 }} />
        </label>
        <span style={{ fontSize: 12, color: "var(--muted2)" }}>→</span>
        <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--muted2)"}}>
          Hasta
          <input type="date" className="search" value={hasta} onChange={e => setHasta(e.target.value)} style={{ width: 140 }} />
        </label>
        <div style={{ width: 1, height: 22, background: "var(--bd)" }} />
        <select className="search" value={provFiltro} onChange={e => setProvFiltro(e.target.value)} style={{ width: 200 }}>
          <option value="">Todos los proveedores</option>
          {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </div>

      {/* Banner de deuda acumulada cuando hay proveedor filtrado (Bug #25) */}
      {provFiltro && (() => {
        const prov = proveedores.find(p => String(p.id) === String(provFiltro));
        const deuda = facturas.filter(f =>
          String(f.prov_id) === String(provFiltro) &&
          (f.tipo || "factura") === "factura" &&
          (f.estado === "pendiente" || f.estado === "vencida"),
        );
        const pendientes = deuda.filter(f => estadoFactura(f) === "pendiente");
        const vencidas = deuda.filter(f => estadoFactura(f) === "vencida");
        const totalPend = pendientes.reduce((s, f) => s + Number(f.total || 0), 0);
        const totalVenc = vencidas.reduce((s, f) => s + Number(f.total || 0), 0);
        const totalAll = totalPend + totalVenc;
        if (deuda.length === 0) {
          return (
            <div className="alert alert-info" style={{ marginBottom: 14, fontSize: 12 }}>
              {prov?.nombre || "Proveedor"} sin facturas pendientes.
            </div>
          );
        }
        return (
          <div className="alert alert-warn" style={{ marginBottom: 14, fontSize: 12, display: "flex", gap: 20, flexWrap: "wrap", alignItems: "baseline" }}>
            <span><strong>{prov?.nombre || "Proveedor"}</strong> — deuda pendiente: <strong style={{ color: "var(--warn)" }}>{fmt_$(totalAll)}</strong> ({deuda.length} factura{deuda.length === 1 ? "" : "s"})</span>
            <span style={{ color: "var(--muted2)" }}>
              Pendientes: <span style={{ color: "var(--warn)" }}>{fmt_$(totalPend)}</span> ({pendientes.length})
              {vencidas.length > 0 && <> · Vencidas: <span style={{ color: "var(--danger)" }}>{fmt_$(totalVenc)}</span> ({vencidas.length})</>}
            </span>
          </div>
        );
      })()}

      {/* Las pills viejas (todas/pendiente/vencida/pagada/nc/remitos) se
          reemplazaron por el RightSubNav del módulo madre (2026-05-13).
          El sub-nav controla pillEstado vía setSubSection() + estadoSection. */}

      {/* Tabla — switch entre facturas, remitos y proveedores embebido. */}
      {isProveedores ? (
        <Suspense fallback={<div className="loading">Cargando proveedores…</div>}>
          {/* Embed de la pantalla Proveedores. Renderiza su propio header
              "Proveedores" + filtros + tabla. El header del módulo madre
              ya mostró "Compras · proveedores" arriba, así que esto queda
              algo redundante visualmente — refactor: extraer body de
              Proveedores a un sub-componente sin header. Por ahora aceptado. */}
          <Proveedores user={user} locales={locales} localActivo={localActivo} embedded embeddedFilter={proveedorEstadoFiltro as "activos" | "inactivos"} />
        </Suspense>
      ) : pillEstado === "remitos" ? (
        <div className="panel">
          {loading ? <div className="loading">Cargando...</div> : rFilt.length === 0 ? (
            <EmptyState
              icon={<BoxIcon size={36} tone="muted" />}
              title="Sin remitos con esos filtros"
              description="Probá cambiar el rango de fechas o limpiar el filtro de proveedor."
            />
          ) : (
            <table>
              <thead><tr>
                <th>Proveedor · Nº</th>
                {!localActivo && <th>Local</th>}
                <th>Fecha</th>
                <th>Categoría</th>
                <th>Descripción</th>
                <th style={{ textAlign: "right" }}>Monto</th>
                <th>Estado</th>
                <th></th>
              </tr></thead>
              <tbody>{rFilt.map(r => {
                const prov = proveedores.find(p => String(p.id) === String(r.prov_id));
                const isAnulado = r.estado === "anulado";
                return (
                  <tr key={r.id} className={isAnulado ? "anulada-row" : ""}>
                    <td>
                      <div style={{ fontSize: 12, fontWeight: 500, color: "var(--txt)" }}>{prov?.nombre || "—"}</div>
                      <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 1 }}>{r.nro}</div>
                    </td>
                    {!localActivo && (
                      <td><span className="badge b-muted" style={{ fontSize: 10 }}>{locales.find((l: Local) => l.id === r.local_id)?.nombre || "—"}</span></td>
                    )}
                    <td className="mono">{fmt_d(r.fecha)}</td>
                    <td><span className="badge b-muted">{r.cat || "—"}</span></td>
                    <td style={{ fontSize: 11, color: "var(--muted2)", maxWidth: 240 }} title={r.detalle || ""}>
                      {r.detalle
                        ? (r.detalle.length > 60 ? r.detalle.slice(0, 60) + "…" : r.detalle)
                        : <span style={{ color: "var(--muted)" }}>—</span>}
                    </td>
                    <td style={{ textAlign: "right" }}><span className="num kpi-warn">{fmt_$(r.monto)}</span></td>
                    <td>
                      {r.estado === "sin_factura" && <span className="badge b-warn" title="Mercadería recibida, pendiente de pago (sin factura cargada)">Pendiente</span>}
                      {(r.estado === "facturado" || r.estado === "vinculado") && <span className="badge b-success">Vinculado</span>}
                      {r.estado === "pagado" && <span className="badge b-info">Pagado</span>}
                      {r.estado === "anulado" && <span className="badge b-anulada">Anulado</span>}
                    </td>
                    <td>
                      {!isAnulado && (
                        <div style={{ display: "flex", gap: 4, alignItems: "center", justifyContent: "flex-end" }}>
                          {r.estado === "sin_factura" && (
                            <IconBtn title="Vincular factura" onClick={() => setVincModal(r)}>{IconLink}</IconBtn>
                          )}
                          {r.factura_id && <span className="mono" style={{ fontSize: 10, color: "var(--info)" }}>→ {facturas.find(f => f.id === r.factura_id)?.nro || r.factura_id}</span>}
                          {r.estado === "sin_factura" && (
                            <IconBtn title="Registrar pago" tone="success" onClick={() => { setPagarRemModal(r); setRemPagoForm({ cuenta: "", monto: r.monto, fecha: toISO(today) }); /* idempKey se setea via useEffect según sessionStorage */ }}>{IconPay}</IconBtn>
                          )}
                          {/* Siempre visible. Si no tiene permiso, anularRemito
                              abre modal de Manager Override pidiendo código TOTP. */}
                          {r.estado !== "pagado" && (
                            <IconBtn title="Anular" tone="danger" onClick={() => anularRemito(r)}>{IconX}</IconBtn>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
      ) : (
      <div className="panel">
        {loading ? <div className="loading">Cargando...</div> : fFilt.length === 0 ? (
          <EmptyState
            icon={<ReceiptIcon size={36} tone="muted" />}
            title="Sin facturas con esos filtros"
            description="Probá cambiar el rango de fechas, el filtro de proveedor o el estado."
          />
        ) : (
          <table>
            <thead><tr>
              <th>Proveedor · Nº</th>
              {!localActivo && <th>Local</th>}
              <th>Fecha</th>
              <th>Vencimiento</th>
              <th>Categoría</th>
              <th style={{ textAlign: "right" }}>Total</th>
              <th>Estado</th>
              <th></th>
            </tr></thead>
            <tbody>{fFilt.map(f => {
              const prov = proveedores.find(p => String(p.id) === String(f.prov_id));
              const isNC = (f.tipo || "factura") === "nota_credito";
              return (
                <tr key={f.id}>
                  <td>
                    <div style={{ fontSize: 12, fontWeight: 500, color: "var(--txt)" }}>{prov?.nombre || "—"}</div>
                    <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 1, display: "flex", alignItems: "center", gap: 6 }}>
                      <span>{f.nro}</span>
                      {/* Pill 'NC' solo aparece cuando estamos en la vista 'Facturas'
                          (donde NCs y facturas se mezclan). En la sub-sección
                          'Notas crédito' es redundante — se removió 2026-05-13. */}
                      {isNC && subSection !== "notas" && <span className="badge b-info" style={{ fontSize: 8, letterSpacing: 0.5 }}>NC</span>}
                    </div>
                  </td>
                  {!localActivo && (
                    <td><span className="badge b-muted" style={{ fontSize: 10 }}>{locales.find((l: Local) => l.id === f.local_id)?.nombre || "—"}</span></td>
                  )}
                  <td>
                    <span style={{ fontSize: 11, color: "var(--txt)" }}>{fmt_d(f.fecha)}</span>
                  </td>
                  <td>
                    {f.venc
                      ? <span style={{ fontSize: 11, color: estadoFactura(f) === "vencida" ? "var(--danger)" : "var(--muted2)" }}>{fmt_d(f.venc)}</span>
                      : <span style={{ fontSize: 11, color: "var(--muted)" }}>—</span>}
                  </td>
                  <td><span className="badge b-muted">{f.cat || "—"}</span></td>
                  <td style={{ textAlign: "right" }}><span className="num" style={isNC ? { color: "var(--info)" } : undefined}>{fmt_$(f.total)}</span></td>
                  <td>{isNC
                    ? (() => {
                        if (f.estado === "anulada") return <span className="badge b-muted">NC anulada</span>;
                        // T-19: usar saldo real desde nc_aplicaciones, no f.pagos
                        // (que siempre está vacío para NCs).
                        const saldoNc = saldoNcRestante(f, ncAplicMap);
                        if (f.estado === "pagada" || saldoNc <= 0) return <span className="badge b-muted">NC consumida</span>;
                        return <span className="badge b-info">NC disponible</span>;
                      })()
                    : estadoDot(estadoFactura(f))}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      <IconBtn title="Ver detalle" onClick={() => setVerModal(f)}>{IconEye}</IconBtn>
                      {/* Editar (Lucas 10-jun): solo si está pendiente/revisión
                          — la RPC editar_factura rechaza pagadas/anuladas. */}
                      {f.estado !== "pagada" && f.estado !== "anulada" && (
                        <IconBtn title="Editar" onClick={() => abrirEditarFactura(f)}>{IconEdit}</IconBtn>
                      )}
                      {!isNC && f.estado !== "pagada" && (
                        <IconBtn title="Registrar pago" tone="success" onClick={() => { setPagarModal(f); setPagoForm({ cuenta: "", monto: Number(f.total) || 0, fecha: toISO(today) }); setIdempKeyPagarFac(crypto.randomUUID()); }}>{IconPay}</IconBtn>
                      )}
                      {/* Siempre visible. Si no tiene permiso, anular() abre
                          modal de Manager Override pidiendo código del dueño. */}
                      <IconBtn title="Anular" tone="danger" onClick={() => anular(f)}>{IconX}</IconBtn>
                    </div>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      )}
        </div>
        {/* RightSubNav del módulo madre — controla subSection + estado contextual */}
        <RightSubNav sections={subNavSections} />
      </div>

      {/* MODAL LECTOR IA */}
      <ModalLectorIA
        abierto={lectorModal} user={user} locales={locales} localActivo={localActivo}
        onClose={() => setLectorModal(false)}
        onSaved={() => { load(); setLectorModal(false); }}
      />

      {/* MODAL CARGAR / EDITAR FACTURA. En modo edición pasamos también
          editandoFactura y editandoMotivo para que el modal muestre el
          input de justificativo + título distinto. */}
      <ModalCargarFactura
        abierto={modal} onClose={() => { setModal(false); setEditandoFactura(null); setEditandoMotivo(""); }}
        editandoFactura={editandoFactura}
        editandoMotivo={editandoMotivo}
        setEditandoMotivo={setEditandoMotivo}
        user={user}
        form={form} setForm={setForm}
        proveedores={proveedores} localesDisp={localesDisp} localActivo={localActivo}
        categorias={{
          compra: CATEGORIAS_COMPRA, fijos: GASTOS_FIJOS, variables: GASTOS_VARIABLES,
          publicidad: GASTOS_PUBLICIDAD, comisiones: COMISIONES_CATS, impuestos: GASTOS_IMPUESTOS,
          bucketMap: categoriaToBucket,
        }}
        onProvChange={onProvChange} calcTotal={calcTotal}
        items={items} addItem={addItem} updateItem={updateItem} removeItem={removeItem}
        guardar={guardar} saving={saving}
      />

      {/* MODAL VER FACTURA */}
      <ModalVerFactura
        factura={verModal} onClose={() => setVerModal(null)}
        proveedores={proveedores} locales={locales}
      />

      {/* MODAL PAGAR */}
      <ModalPagarFactura
        pagarModal={pagarModal} setPagarModal={setPagarModal}
        facturas={facturas}
        ncAplicaciones={ncAplicaciones}
        ncsAplicar={ncsAplicar} setNcsAplicar={setNcsAplicar}
        pagoForm={pagoForm} setPagoForm={setPagoForm}
        generarSaldo={generarSaldo} setGenerarSaldo={setGenerarSaldo}
        cerrarFactura={cerrarFactura} setCerrarFactura={setCerrarFactura}
        saldoAFavorProveedor={Number(
          proveedores.find(p => String(p.id) === String(pagarModal?.prov_id))?.saldo_a_favor ?? 0
        )}
        aplicarSaldoFavor={aplicarSaldoFavor} setAplicarSaldoFavor={setAplicarSaldoFavor}
        cuentasUsables={cuentasUsables} pagar={pagar} pagando={pagando}
      />

      {/* MODAL CARGAR REMITO — portado de Remitos.tsx (eliminado 2026-05-07) */}
      <ModalCargarRemito
        abierto={remModal} onClose={() => setRemModal(false)}
        form={remForm} setForm={setRemForm}
        proveedores={proveedores} localesDisp={localesDisp} localActivo={localActivo}
        categoriasCompra={CATEGORIAS_COMPRA}
        onProvChange={onRemProvChange} guardar={guardarRemito}
      />

      {/* MODAL VINCULAR REMITO A FACTURA */}
      <ModalVincularRemito
        remito={vincModal} onClose={() => setVincModal(null)}
        facturas={facturas} onVincular={vincularRemitoAFactura}
      />

      {/* MODAL PAGAR REMITO DIRECTO */}
      <ModalPagarRemitoDirecto
        remito={pagarRemModal} onClose={() => setPagarRemModal(null)}
        form={remPagoForm} setForm={setRemPagoForm}
        cuentasUsables={cuentasUsables} pagar={pagarRemito} pagando={pagandoRem}
      />

      {/* MODAL MANAGER OVERRIDE — para anular factura sin permiso compras_anular */}
      <ManagerOverrideModal
        open={pendingAnular !== null}
        permiso="compras_anular"
        accion="anular_factura"
        context={pendingAnular ? {
          factura_id: pendingAnular.factura.id,
          factura_nro: pendingAnular.factura.nro,
          total: pendingAnular.factura.total,
          motivo: pendingAnular.motivo,
        } : undefined}
        descripcion={pendingAnular ? `Anular factura ${pendingAnular.factura.nro}` : undefined}
        onClose={() => setPendingAnular(null)}
        onValidated={async (codigo) => {
          if (!pendingAnular) return;
          const { factura, motivo } = pendingAnular;
          setPendingAnular(null);
          await ejecutarAnular(factura, motivo, codigo);
        }}
      />

      {/* MODAL MANAGER OVERRIDE — para anular remito sin permiso compras_anular */}
      <ManagerOverrideModal
        open={pendingAnularRemito !== null}
        permiso="compras_anular"
        accion="anular_remito"
        context={pendingAnularRemito ? {
          remito_id: pendingAnularRemito.remito.id,
          remito_nro: pendingAnularRemito.remito.nro,
          total: pendingAnularRemito.remito.monto,
          motivo: pendingAnularRemito.motivo,
        } : undefined}
        descripcion={pendingAnularRemito ? `Anular remito ${pendingAnularRemito.remito.nro}` : undefined}
        onClose={() => setPendingAnularRemito(null)}
        onValidated={async (codigo) => {
          if (!pendingAnularRemito) return;
          const { remito, motivo } = pendingAnularRemito;
          setPendingAnularRemito(null);
          await ejecutarAnularRemito(remito, motivo, codigo);
        }}
      />

      <ToastComponent toast={toast} />
    </div>
  );
}