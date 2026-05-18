import { useState, useEffect, lazy, Suspense } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasOperables, localesVisibles, tienePermiso } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { useCategorias } from "../lib/useCategorias";
import { useRealtimeTable } from "../lib/useRealtimeTable";
import { CUENTAS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$, genId, parseMonto, estadoFactura } from "../lib/utils";
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

// Wrapper común para botones icon-only: 26x26, radius 6, hover bg-soft.
function IconBtn(props: { title: string; onClick: () => void; tone?: "default" | "success" | "danger"; disabled?: boolean; children: React.ReactNode }) {
  const tone = props.tone || "default";
  const color =
    tone === "success" ? "var(--pase-celeste)" :
    tone === "danger"  ? "var(--pase-text-muted)" :
    "var(--pase-text-muted)";
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        width: 26, height: 26, padding: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "transparent",
        border: "0.5px solid var(--pase-border-strong)",
        borderRadius: 6,
        color,
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.4 : 1,
        transition: "background 0.12s, color 0.12s, border-color 0.12s",
      }}
      onMouseEnter={e => { if (!props.disabled) e.currentTarget.style.background = "var(--pase-bg-soft)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
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
  // Idempotency keys (convención C1): se regeneran al abrir cada modal de
  // pago. Si el operador hace doble-click en "Confirmar", la 2da llamada
  // con la misma key devuelve el resultado cacheado (no duplica el pago).
  const [idempKeyPagarFac, setIdempKeyPagarFac] = useState<string>(() => crypto.randomUUID());
  const [idempKeyPagarRem, setIdempKeyPagarRem] = useState<string>(() => crypto.randomUUID());
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

  const emptyForm: FormFactura = { prov_id: "", local_id: localActivo ? String(localActivo) : "", nro: "", fecha: toISO(today), venc: "", neto: 0, iva21: 0, iva105: 0, iibb: 0, perc_iva: 0, otros_cargos: 0, descuentos: 0, cat: "", detalle: "", tipo: "factura" };
  const [form, setForm] = useState<FormFactura>(emptyForm);
  const [items, setItems] = useState<ItemFactura[]>([]);
  // Bug Caja-1: el default cuenta="MercadoPago" pisaba la elección del
  // usuario cuando MP no estaba en cuentasUsables (encargados con cuentas
  // restringidas). Default vacío fuerza la elección consciente.
  const [pagoForm, setPagoForm] = useState<{ cuenta: string; monto: number; fecha: string }>({ cuenta: "", monto: 0, fecha: toISO(today) });

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
  const calcTotal = () =>
    form.neto + form.iva21 + form.iva105 + form.iibb + form.perc_iva +
    form.otros_cargos - form.descuentos;

  const load = async () => {
    setLoading(true);
    // Optimización egress 2026-05-17: proyectar campos específicos en vez
    // de SELECT * + limit 1000 + filtro fecha default 365 días. Las facturas
    // muy viejas se ven con el date range picker manual del usuario.
    const haceUnAnio = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let fq = db.from("facturas")
      .select("id, prov_id, local_id, nro, fecha, venc, neto, iva21, iva105, iibb, total, cat, estado, detalle, pagos, tipo, perc_iva, otros_cargos, descuentos")
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
    const [{ data: f }, { data: r }, { data: p }, { data: na }] = await Promise.all([
      fq,
      rq,
      db.from("proveedores").select("id, nombre, cuit, cat, saldo, estado").eq("estado", "Activo").order("nombre"),
      naq,
    ]);
    setFacturas((f as Factura[]) || []);
    setRemitos((r as Remito[]) || []);
    setProveedores((p as Proveedor[]) || []);
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
    if (!form.prov_id) { alert("Seleccioná un proveedor"); return; }
    if (!form.nro) { alert("Ingresá el número de factura"); return; }
    if (form.neto <= 0) { alert("Ingresá el neto gravado"); return; }
    if (!form.local_id) { alert("Seleccioná un local"); return; }
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
      const nueva = { ...form, id, prov_id: parseInt(form.prov_id), local_id: parseInt(form.local_id), total, estado: "pendiente", pagos: [], tipo: form.tipo, fecha: form.fecha || null, venc: form.venc || null, bucket };
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
      alert("Error al guardar: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  const pagar = async () => {
    if (pagando || !pagarModal) return;
    setPagando(true);
    try {
      const f = pagarModal;
      const prov = proveedores.find(p => String(p.id) === String(f.prov_id));
      const detalle = `Pago ${prov?.nombre || ""} - Fact ${f.nro}`;

      // 1) Aplicar NCs seleccionadas. Cada una en su propia llamada RPC para
      //    que el error de una no rompa las otras (la transacción de cada
      //    aplicación es atómica del lado servidor).
      const ncEntries = Object.entries(ncsAplicar).filter(([, m]) => m > 0);
      const totalNcAplicado = ncEntries.reduce((s, [, m]) => s + m, 0);
      for (const [nc_id, monto] of ncEntries) {
        const { error: ncErr } = await db.rpc("aplicar_nc_a_factura", {
          p_nc_id: nc_id,
          p_factura_id: f.id,
          p_monto: monto,
          p_fecha: pagoForm.fecha,
        });
        if (ncErr) throw ncErr;
      }

      // 2) Pagar el resto con plata si queda saldo. Si solo se aplicaron NCs
      //    y la factura ya queda saldada, se omite pagar_factura.
      const restanteAPagar = pagoForm.monto > 0 ? pagoForm.monto : Math.max(0, f.total - totalNcAplicado);
      if (restanteAPagar > 0) {
        if (!pagoForm.cuenta) {
          alert("Elegí una cuenta de egreso para el saldo restante");
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
        });
        if (error) throw error;
      } else if (totalNcAplicado === 0) {
        // Ni NCs ni plata → nada que hacer.
        alert("Indicá un pago con plata o aplicá una NC");
        setPagando(false);
        return;
      }

      setPagarModal(null);
      setNcsAplicar({});
      load();
    } catch (err) {
      console.error("Error en pagar:", err);
      alert(translateRpcError(err));
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
    if (error) { alert(translateRpcError(error)); return; }
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
    // eslint-disable-next-line pase-local/no-direct-financiera-write -- deuda C4-F12: vincular remito↔factura debe pasar por RPC vincular_remito que valide consistencia (proveedor, monto) atomicamente.
    await db.from("remitos").update({ estado: "vinculado", factura_id: fid }).eq("id", r.id);
    setVincModal(null); load();
  };

  const pagarRemito = async () => {
    if (pagandoRem || !pagarRemModal) return;
    if (!remPagoForm.cuenta) { alert("Elegí una cuenta de egreso"); return; }
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
      setPagarRemModal(null); load();
    } catch (err) {
      console.error("Error pagando remito:", err);
      alert(translateRpcError(err));
    } finally {
      setPagandoRem(false);
    }
  };

  const anularRemito = async (r: Remito) => {
    if (!confirm(`¿Anular remito ${r.nro}?`)) return;
    const motivo = prompt("Motivo (opcional):") || "Anulado desde UI";
    const { error } = await db.rpc("anular_remito", { p_remito_id: r.id, p_motivo: motivo });
    if (error) { alert(translateRpcError(error)); return; }
    load();
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
                    const headers = ["Fecha", "Nº Factura", "Proveedor", "Local", "Categoría", "Total", "Vencimiento", "Estado"];
                    const rows = fFilt.map(f => [
                      f.fecha?.slice(0, 10) || "",
                      f.nro || "",
                      proveedores.find(p => p.id === f.prov_id)?.nombre || "",
                      locales.find(l => l.id === f.local_id)?.nombre || "",
                      f.cat || "",
                      Number(f.total ?? 0),
                      f.venc?.slice(0, 10) || "",
                      estadoFactura(f),
                    ]);
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
            {subSection === "facturas" && puedeFacturas && <button className="btn btn-sec" onClick={() => setLectorModal(true)}>Lector IA</button>}
            {subSection === "facturas" && puedeRemitos && (
              <button className="btn btn-sec" onClick={() => { setRemForm({ ...emptyRemForm, local_id: localActivo ? String(localActivo) : "" }); setRemModal(true); }}>+ Cargar remito</button>
            )}
            {subSection === "facturas" && puedeFacturas && (
              <button className="btn btn-acc" onClick={() => { setForm({ ...emptyForm, local_id: localActivo ? String(localActivo) : "" }); setItems([]); setModal(true); }}>+ Cargar factura</button>
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
                      {r.estado === "sin_factura" && <span className="badge b-warn">Sin Factura</span>}
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
                            <IconBtn title="Registrar pago" tone="success" onClick={() => { setPagarRemModal(r); setRemPagoForm({ cuenta: "", monto: r.monto, fecha: toISO(today) }); setIdempKeyPagarRem(crypto.randomUUID()); }}>{IconPay}</IconBtn>
                          )}
                          {r.estado !== "pagado" && tienePermiso(user, "compras_anular") && (
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
                      {!isNC && f.estado !== "pagada" && (
                        <IconBtn title="Registrar pago" tone="success" onClick={() => { setPagarModal(f); setPagoForm({ cuenta: "", monto: Number(f.total) || 0, fecha: toISO(today) }); setIdempKeyPagarFac(crypto.randomUUID()); }}>{IconPay}</IconBtn>
                      )}
                      {tienePermiso(user, "compras_anular") && (
                        <IconBtn title="Anular" tone="danger" onClick={() => anular(f)}>{IconX}</IconBtn>
                      )}
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

      {/* MODAL CARGAR FACTURA */}
      <ModalCargarFactura
        abierto={modal} onClose={() => setModal(false)}
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
        descripcion={pendingAnular ? `Anular factura ${pendingAnular.factura.nro}` : undefined}
        onClose={() => setPendingAnular(null)}
        onValidated={async (codigo) => {
          if (!pendingAnular) return;
          const { factura, motivo } = pendingAnular;
          setPendingAnular(null);
          await ejecutarAnular(factura, motivo, codigo);
        }}
      />
    </div>
  );
}