import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasVisibles as cuentasVisiblesFn, cuentasOperables as cuentasOperablesFn, cuentasVisiblesParaListados, localesVisibles, tienePermiso } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { useCategorias } from "../lib/useCategorias";
import { useRealtimeTable } from "../lib/useRealtimeTable";
import { useDebouncedValue } from "@pase/shared/utils";
import { CUENTAS, CUENTAS_OCULTAS_TEMPORAL } from "../lib/constants";
import { toISO, fmt_d, fmt_$, toLocalISO } from '@pase/shared/utils';
import { today } from '../lib/utils';
import { RightSubNav, type SubNavSection, PageHeader, EmptyState, LocalLockedChip, Modal, ColumnFilter, useColumnFilters, DateRangeFilter } from "../components/ui";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import { ManagerOverrideModal } from "../components/ManagerOverrideModal";
import { exportCSV } from "../lib/exportCSV";
import { CajaCardsRow } from "./caja/CajaCardsRow";
import type { Usuario, Local } from "../types/auth";
import { origenMovimiento, type Movimiento } from "../types/finanzas";

// Sub-sección 'Conciliación MP' del módulo Caja (2026-05-13): la pantalla
// suelta de Conciliación MP se integra como sub-sección. Lazy para no
// inflar el bundle de Caja cuando se entra a Movimientos.
const ConciliacionMP = lazy(() => import("./ConciliacionMP"));

type SubSectionCaja = "movimientos" | "conciliacion";

// Tamaño de página de Tesorería. 80 cubre ~1 semana en un local con
// volumen alto, ~1 mes en uno de volumen bajo. Botón "Cargar más" trae
// otros 80 cuando hace falta.
const TESORERIA_PAGE_SIZE = 80;

// Extrae la fecha de creación real desde el id del movimiento. Los ids
// tienen formato MOV-<unix>-<rand>: 10 dígitos = segundos, 13 dígitos = ms
// (formato viejo). Si el id no matchea, devuelve null y la UI muestra "—".
function fechaCargaFromId(id: string): Date | null {
  const m = /^MOV-(\d+)-/.exec(id);
  if (!m || !m[1]) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const ms = m[1].length === 13 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Formatea Date como "DD/MM HH:mm" en hora ART. Compact para la columna.
function fmtFechaCarga(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  }).replace(",", "");
}

interface CajaProps {
  user: Usuario | null;
  locales?: Local[];
  localActivo: number | null;
}

// Movimiento en edición: extiende Movimiento con justificativo (obligatorio
// en el modal) y permite que importe sea string mientras el usuario tipea
// — el input numérico devuelve string en e.target.value y parseFloat lo
// convierte al guardar.
interface EditMovDraft extends Omit<Movimiento, "importe"> {
  justificativo: string;
  importe: number | string;
}

// Detalle JSON-parseado de la fila auditoria de tipo EDICION. antes/despues
// son la fila movimiento serializada — se renderiza vía Object.entries
// genérico, por eso Record<string, unknown>.
interface AuditDetalle {
  id: string;
  antes: Record<string, unknown> | null;
  despues: Record<string, unknown> | null;
  justificativo: string;
}

// ─── TESORERÍA ────────────────────────────────────────────────────────────────
export default function Caja({ user, locales = [], localActivo }: CajaProps) {
  const { toast, showToast, showError } = useToast();
  // Sub-section del módulo madre Caja (2026-05-13). Switch entre la vista
  // Movimientos (default, todo el contenido actual) y Conciliación MP
  // (pantalla embebida). Sidebar ya no tiene 'mp' como top-level.
  const [subSection, setSubSection] = useState<SubSectionCaja>("movimientos");

  // searchParams para acoplar acciones del header del módulo madre con el
  // embed ConciliacionMP vía ?action=sync|cuentas (mismo patrón que
  // /compras/proveedores?action=nuevo).
  const [searchParams, setSearchParams] = useSearchParams();
  const triggerMPAction = (action: "sync" | "cuentas") => {
    const next = new URLSearchParams(searchParams);
    next.set("action", action);
    setSearchParams(next, { replace: true });
  };

  const {
    CATEGORIAS_COMPRA, GASTOS_FIJOS, GASTOS_VARIABLES,
    GASTOS_PUBLICIDAD, GASTOS_IMPUESTOS, COMISIONES_CATS,
  } = useCategorias();

  // Deriva tipo del movimiento a partir de cat + dirección. Movimientos
  // nuevos siempre llegan con cat="" (el dropdown se eliminó del modal),
  // por lo que esta función solo aporta valor en guardarEditMov() cuando
  // cambia el signo de un movimiento que ya tenía cat seteada (legacy o
  // creada por el sistema vía RPC).
  const deriveTipoMov = (cat: string, esEgreso: boolean): string => {
    if (!esEgreso) {
      // Ingresos
      if (!cat) return "Ingreso Manual";
      if (cat.startsWith("Liquidación")) return "Liquidación Plataforma";
      if (cat === "Ingreso Socio") return "Aporte Socio";
      if (cat === "Devolución Proveedor") return "Devolución Proveedor";
      if (cat === "Transferencia Varios") return "Transferencia";
      return "Ingreso Manual"; // Otro Ingreso o no mapeado
    }
    // Egresos: según grupo al que pertenece la categoría
    if (GASTOS_FIJOS.includes(cat)) return "Gasto fijo";
    if (GASTOS_VARIABLES.includes(cat)) return "Gasto variable";
    if (GASTOS_PUBLICIDAD.includes(cat)) return "Gasto publicidad";
    if (GASTOS_IMPUESTOS.includes(cat)) return "Gasto impuesto";
    if (COMISIONES_CATS.includes(cat)) return "Gasto comision";
    if (CATEGORIAS_COMPRA.includes(cat)) return "Pago Proveedor";
    return "Egreso Manual";
  };

  // cuentas_visibles del usuario (null = todas) — para CARDS DE SALDO.
  // Filtramos CUENTAS_OCULTAS_TEMPORAL acá (no en el array maestro CUENTAS)
  // para que las cards NO muestren MercadoPago/Banco mientras los saldos no
  // sean reales, pero los dropdowns operables sí las ofrezcan (Lucas 2026-05-18).
  const vis = cuentasVisiblesFn(user);
  const cuentasVisibles = (vis === null ? CUENTAS : vis).filter(c => !CUENTAS_OCULTAS_TEMPORAL.includes(c));
  // cuentas_operables del usuario (null = todas) — para los DROPDOWNS de
  // "Nuevo Movimiento" y "Editar". Es separable de cuentas_visibles: un
  // user puede operar contra MP sin ver su saldo. NO se filtra con
  // CUENTAS_OCULTAS_TEMPORAL — hay que poder pagar facturas con Banco/MP.
  const op = cuentasOperablesFn(user);
  const cuentasOperablesList = op === null ? CUENTAS : op;
  // cuentas_visibles ∪ cuentas_operables — para LISTADO de movimientos
  // (tabla principal) y filtro de cuenta. NO se filtra: el user debe ver
  // los movimientos contra Banco/MP que registró (aunque el saldo este oculto).
  const visParaListado = cuentasVisiblesParaListados(user);
  const cuentasParaListado = visParaListado === null ? CUENTAS : visParaListado;

  // Locales accesibles: dueno/admin = todos; encargado = los asignados.
  const visLocs = localesVisibles(user);
  const locsDisp: Local[] = visLocs === null ? (locales || []) : (locales || []).filter((l: Local) => visLocs.includes(l.id));
  // local_id implícito: si hay localActivo seteado o el usuario tiene un único local, no se pide selector.
  const lidImplicito: number | null = localActivo != null
    ? Number(localActivo)
    : locsDisp.length === 1 ? Number(locsDisp[0]!.id) : null;

  const [movimientos, setMovimientos] = useState<Movimiento[]>([]);
  const [saldos, setSaldos] = useState<Record<string, number>>({});
  const [modal, setModal] = useState(false);
  const [editMov, setEditMov] = useState<EditMovDraft | null>(null);
  // Idempotency key (regla C1) — anti doble-click en el modal de editar mov.
  // Se regenera cada vez que se abre el modal.
  const [idempKeyEditMov, setIdempKeyEditMov] = useState<string>(() => crypto.randomUUID());
  // filtCuenta eliminado — reemplazado por ColumnFilter en el header de Cuenta.
  const [mostrarAnulados, setMostrarAnulados] = useState(false);
  // Orden de los movimientos:
  //  - "fecha": fecha del hecho económico (default, igual que histórico). El
  //    user puede haber cargado hoy un mov con fecha de la semana pasada.
  //  - "carga": orden de creación real, derivado del id del mov (formato
  //    MOV-<unix>-<rand>). Ordenar por id DESC equivale a fecha de carga DESC
  //    porque el timestamp del id se compara correctamente lexicográficamente.
  //    Sirve para detectar cargas tardías que descuadran un saldo de hoy.
  // Default: por carga (los últimos ingresados primero). Antes era "fecha"
  // pero combinado con filtro fecha=hoy, los pagos con fecha futura (típico
  // sueldos fin de mes) quedaban ocultos. Default "carga" muestra siempre
  // lo último cargado, independiente de la fecha del movimiento.
  const [ordenPor, setOrdenPor] = useState<"fecha" | "carga">("carga");
  const [loading, setLoading] = useState(true);
  // F4 (sunny-creek): filtros de fecha + paginación cursor. Default 90d
  // (consistente con Compras/Gastos/ConciliacionMP). hasMore=true mientras
  // la última query devolvió exactamente PAGE_SIZE filas.
  // Defaults VACÍOS: por default NO se filtra por fecha — se muestran los
  // últimos cargados (ordenados por carga). El usuario aplica filtro de
  // fecha SOLO si quiere acotar rango. Decisión Lucas 2026-05-20: antes
  // los movimientos con fecha futura (típico pagos con fecha fin de mes)
  // quedaban ocultos por el default `hasta=hoy`. Sin filtro default,
  // siempre aparece todo lo último cargado.
  const [filtDesde, setFiltDesde] = useState<string>("");
  const [filtHasta, setFiltHasta] = useState<string>("");
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Debounce: evita disparar fetch en cada keystroke del datepicker.
  const debDesde = useDebouncedValue(filtDesde, 300);
  const debHasta = useDebouncedValue(filtHasta, 300);
  const [detalleEdicion, setDetalleEdicion] = useState<Movimiento | null>(null);
  const [auditLog, setAuditLog] = useState<AuditDetalle | null>(null);
  // Bug Caja-1 (4-mayo): el default cuenta="Caja Chica" pisaba la elección
  // del usuario cuando la cuenta no estaba en cuentasVisibles (encargados
  // con cuentas restringidas). Anti-pattern de controlled <select>: value
  // que no aparece en options → browser muestra el primer option visualmente
  // pero el state queda con el default y el RPC persiste contra la cuenta
  // invisible. Default vacío fuerza la elección consciente.
  const emptyForm = {fecha:toISO(today),cuenta:"",tipo:"Pago Gasto",importe:"",detalle:"",esEgreso:true};
  const [form, setForm] = useState(emptyForm);

  // Defensive: si form.cuenta queda con un valor que no está en
  // cuentasOperablesList (edge cases de regression o cambio de scope), resetea
  // a "" para que el placeholder del <select> aparezca y el user tenga que
  // elegir. NO borrar — previene la regresión del bug Caja-1.
  useEffect(() => {
    if (form.cuenta && !cuentasOperablesList.includes(form.cuenta)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(f => ({ ...f, cuenta: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.cuenta, cuentasOperablesList.join("|")]);
  // BUG 5: al abrir el modal de nuevo movimiento, resetear todos los campos
  // a estado vacío (antes quedaban pre-llenados con el último movimiento).
  const abrirNuevoMovimiento = () => {
    setForm({...emptyForm, fecha: toISO(today)});
    setModal(true);
  };
  // Selector de local en el modal cuando no hay localActivo y hay >1 local visible.
  const [localFormId, setLocalFormId] = useState<string>(lidImplicito != null ? String(lidImplicito) : "");
  // Sincroniza el local del form modal cuando cambia el localActivo del
  // sidebar. Patrón "derived form state from outer prop" — refactor a
  // key-reset del modal sería más React-correcto pero requiere mover
  // el modal al árbol bajo el local-prop.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalFormId(lidImplicito != null ? String(lidImplicito) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localActivo, locsDisp.length]);
  // Al cambiar dirección (egreso↔ingreso), resetear cat porque el dropdown
  // cambia de opciones — dejar un valor de egreso cuando está en ingreso
  // sería incompatible.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(f => ({ ...f, cat: "" }));
  }, [form.esEgreso]);
  // Transferencia entre cuentas: misma direccion (no afecta saldo total),
  // genera 2 movimientos (egreso en origen, ingreso en destino) vía RPC
  // transferencia_cuentas.
  const [transfModal, setTransfModal] = useState(false);
  // transfForm: ahora soporta cross-local (Lucas 22-may noche).
  // local_destino_id null = same-local (el origen). Si se setea distinto,
  // la transferencia es cross-local.
  const [transfForm, setTransfForm] = useState<{
    fecha: string; origen: string; destino: string; monto: string; detalle: string;
    local_destino_id: number | null;
  }>({fecha:toISO(today),origen:"",destino:"",monto:"",detalle:"",local_destino_id:null});
  const [transfSaving, setTransfSaving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const necesitaSelectorLocal = lidImplicito == null && locsDisp.length > 1;

  // Query reutilizable para movimientos con filtros + paginación.
  // offset/limit usa .range(from, to) que en supabase-js es [from, to]
  // inclusivo. PAGE_SIZE filas: range(0, PAGE-1), range(PAGE, 2*PAGE-1), etc.
  const queryMovimientos = (offset: number, limit: number) => {
    // Optimización egress 2026-05-17: proyectar campos específicos
    // (saca payload ~40% vs SELECT *). Movimientos puede tener tenant_id,
    // created_at, otros campos que la tabla NO necesita renderizar.
    let q = db.from("movimientos")
      .select("id, fecha, cuenta, tipo, cat, importe, detalle, local_id, fact_id, remito_id_ref, liquidacion_id, adelanto_id_ref, pago_especial_id_ref, gasto_id_ref, anulado, anulado_motivo, editado, editado_motivo, editado_at, created_at");
    // Filtro de fecha SOLO si el usuario lo aplicó (campos no vacíos).
    if (debDesde) q = q.gte("fecha", debDesde);
    if (debHasta) q = q.lte("fecha", debHasta);
    if (ordenPor === "carga") {
      // Orden por timestamp real de inserción. Bug fix 2026-06-04 (Lucas):
      // antes se ordenaba por `id` lexicográfico, pero los ids de ajustes
      // tienen formato "MOV-AJUSTE-..." que es alfabéticamente mayor que
      // "MOV-1780...", entonces los AJUSTE quedaban siempre arriba aunque
      // fueran viejos. La columna `created_at` (migration 202606040900)
      // es timestamptz real → orden correcto.
      q = q.order("created_at", { ascending: false });
    } else {
      q = q.order("fecha", { ascending: false }).order("created_at", { ascending: false });
    }
    q = q.range(offset, offset + limit - 1);
    q = applyLocalScope(q, user, localActivo);
    if (visParaListado !== null) {
      if (visParaListado.length === 0) {
        q = q.eq("cuenta", "___NONE___");
      } else {
        q = q.in("cuenta", visParaListado);
      }
    }
    return q;
  };

  // Count de movimientos fuera del rango (fechas futuras > filtHasta) —
  // para banner que avisa al usuario que existen movimientos "ocultos".
  // Caso típico: pagos de sueldo con fecha fin de mes futura.
  const [movsFueraRango, setMovsFueraRango] = useState(0);
  // Cuántos movimientos hay cargados (incluye los traídos con "Ver más"). Lo usa
  // la recarga por realtime para NO resetear a la primera página (queja Anto
  // 09-jun: "vuelvo de otra pestaña y el historial se va al principio de todo").
  const cargadosRef = useRef(TESORERIA_PAGE_SIZE);

  // Mapa gasto_id → "APELLIDO, NOMBRE" para movs con tipo='empleado'. El
  // gasto no guarda empleado_id directo; se liga via rrhh_adelantos.gasto_id
  // (mismo patrón que Gastos.tsx). Lucas 10-jun: "anto me pidio ver de qué
  // empleado son esos movimientos, deberia mostrarlo por algun lado".
  const [empPorGasto, setEmpPorGasto] = useState<Record<string, string>>({});

  const load = async (preservarPaginas = false) => {
    setLoading(true);
    const cantidad = preservarPaginas ? Math.max(TESORERIA_PAGE_SIZE, cargadosRef.current) : TESORERIA_PAGE_SIZE;
    const mQ = queryMovimientos(0, cantidad);
    let sq = db.from("saldos_caja").select("cuenta, saldo, local_id");
    sq = applyLocalScope(sq, user, localActivo);
    if (vis !== null) {
      if (vis.length === 0) {
        sq = sq.eq("cuenta", "___NONE___");
      } else {
        sq = sq.in("cuenta", vis);
      }
    }
    // Count de movimientos con fecha > filtHasta — SOLO si hay filtro hasta
    // activo. Si no hay filtro, no hay "fuera de rango" porque mostramos todo.
    let futurosCount = 0;
    if (debHasta) {
      let countQ = db.from("movimientos")
        .select("id", { count: 'exact', head: true })
        .gt("fecha", debHasta);
      countQ = applyLocalScope(countQ, user, localActivo);
      if (visParaListado !== null && visParaListado.length > 0) {
        countQ = countQ.in("cuenta", visParaListado);
      }
      const { count } = await countQ;
      futurosCount = count ?? 0;
    }
    const [{data:m},{data:s}] = await Promise.all([mQ, sq]);
    const movs = (m as Movimiento[]) || [];
    setMovimientos(movs);
    cargadosRef.current = movs.length;
    setHasMore(movs.length === cantidad);
    setMovsFueraRango(futurosCount);
    const obj: Record<string, number> = {};
    (s||[]).forEach(x=> { obj[x.cuenta] = (obj[x.cuenta]||0) + (x.saldo||0); });
    setSaldos(obj);
    // Lucas 10-jun: para movs vinculados a un gasto tipo='empleado',
    // mostrar el nombre del empleado. Lookup en rrhh_adelantos por gasto_id
    // (mismo patrón que Gastos.tsx).
    void cargarEmpPorGasto(movs);
    setLoading(false);
  };

  // Trae nombre del empleado para los movs cuyo gasto_id_ref apunta a un
  // gasto tipo='empleado' (que se liga via rrhh_adelantos.gasto_id).
  // Se llama después de cargar movs — la actualización es asíncrona y no
  // bloquea el render del listado.
  async function cargarEmpPorGasto(movs: Movimiento[]) {
    const gastoIds = movs.map(m => m.gasto_id_ref).filter((x): x is string => !!x);
    if (gastoIds.length === 0) return;
    const { data: adel } = await db.from("rrhh_adelantos")
      .select("gasto_id, empleado_id").in("gasto_id", gastoIds);
    if (!adel || adel.length === 0) return;
    const empIds = [...new Set((adel as Array<{empleado_id: number|null}>).map(a => a.empleado_id).filter((x): x is number => !!x))];
    if (empIds.length === 0) return;
    const { data: emps } = await db.from("rrhh_empleados")
      .select("id, apellido, nombre").in("id", empIds);
    const nombrePorEmp: Record<number, string> = {};
    (emps || []).forEach((e: { id: number; apellido: string | null; nombre: string | null }) => {
      nombrePorEmp[e.id] = `${(e.apellido || "").toUpperCase()}, ${e.nombre || ""}`.trim();
    });
    const nuevo: Record<string, string> = {};
    (adel as Array<{gasto_id: string; empleado_id: number|null}>).forEach(a => {
      if (!a.empleado_id) return;
      const nm = nombrePorEmp[a.empleado_id];
      if (nm) nuevo[a.gasto_id] = nm;
    });
    setEmpPorGasto(prev => ({ ...prev, ...nuevo }));
  }

  // Pagination forward: trae el siguiente bloque y lo concatena. No resetea
  // el listado actual ni los saldos.
  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const { data: m } = await queryMovimientos(movimientos.length, TESORERIA_PAGE_SIZE);
    const nuevos = (m as Movimiento[]) || [];
    setMovimientos(prev => { const all = [...prev, ...nuevos]; cargadosRef.current = all.length; return all; });
    setHasMore(nuevos.length === TESORERIA_PAGE_SIZE);
    void cargarEmpPorGasto(nuevos);
    setLoadingMore(false);
  };

  // Patrón fetch-on-dep-change. Re-fetch al cambiar local, rango de fechas
  // u orden seleccionado.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{load();},[localActivo, debDesde, debHasta, ordenPor]);

  // Sprint Realtime: cualquier cambio remoto en movimientos o saldos_caja
  // del mismo tenant dispara reload. Refresca la card de saldos + lista
  // de movimientos sin necesidad de F5.
  useRealtimeTable({ table: 'movimientos', onChange: () => load() });
  useRealtimeTable({ table: 'saldos_caja', onChange: () => load() });

  // Carga el auditoría log cuando el usuario clickea "Ver edición" en
  // un movimiento. setAuditLog es derivada del detalleEdicion.
  // AUDIT F3A#9: antes esta query traía TODA la auditoria histórica de
  // EDICION movimientos (3.5k hoy, crece linealmente). Con 50k filas el
  // browser se cuelga parseando JSONs. Ahora filtramos por mov_id en el
  // server vía operador JSON `detalle::jsonb ->> 'id'` y agregamos LIMIT.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!detalleEdicion) { setAuditLog(null); return; }
    db.from("auditoria")
      .select("detalle")
      .eq("tabla", "movimientos")
      .eq("accion", "EDICION")
      .ilike("detalle", `%"id":"${detalleEdicion.id}"%`)
      .order("fecha", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        const log = (data || []).find(l => {
          try { return JSON.parse(l.detalle)?.id === detalleEdicion.id; } catch { return false; }
        });
        setAuditLog(log ? (JSON.parse(log.detalle) as AuditDetalle) : null);
      });
  }, [detalleEdicion]);

  const mFiltBase = movimientos
    .filter(m => mostrarAnulados ? true : !m.anulado);

  const mColFilters = useColumnFilters<Movimiento>(mFiltBase, {
    cuenta: (m) => m.cuenta || "—",
    tipo: (m) => m.tipo || "—",
    categoria: (m) => m.cat || "—",
  });
  const mFilt = mColFilters.filtered;

  // Ref-based guard contra doble-click (fix sistémico 2026-05-18). El state
  // `saving` por sí solo tiene race condition: dos clicks rápidos ven
  // `saving===false` antes del re-render. La ref es sincrónica.
  const savingRef = useRef(false);
  const guardar = async () => {
    if (savingRef.current || saving) return;
    if(!form.importe) return;
    if (!form.cuenta) { showError("Elegí una cuenta"); return; }
    const lid = lidImplicito != null ? lidImplicito : parseInt(localFormId);
    if (!Number.isFinite(lid)) return;
    const importe = parseFloat(form.importe)*(form.esEgreso?-1:1);
    const tipoEfectivo = deriveTipoMov("", form.esEgreso);
    savingRef.current = true;
    setSaving(true);
    try {
      const { error } = await db.rpc("crear_movimiento_caja", {
        p_fecha: form.fecha,
        p_cuenta: form.cuenta,
        p_tipo: tipoEfectivo,
        p_cat: null,
        p_importe: importe,
        p_detalle: form.detalle || tipoEfectivo,
        p_local_id: lid,
      });
      if (error) { showError(translateRpcError(error)); return; }
      showToast("Movimiento registrado");
      setModal(false);
      setForm({...emptyForm, fecha: toISO(today)});
      load();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const transfSavingRef = useRef(false);
  const guardarTransferencia = async () => {
    if (transfSavingRef.current || transfSaving) return;
    const lid = lidImplicito != null ? lidImplicito : parseInt(localFormId);
    if (!Number.isFinite(lid)) { showError("Elegí un local"); return; }
    if (!transfForm.origen || !transfForm.destino) { showError("Elegí cuenta origen y destino"); return; }
    // Validación: si es same-local (destino null o igual al origen) y misma cuenta → error.
    // Si es cross-local, misma cuenta es OK (ej: Caja Efectivo VC → Caja Efectivo Belgrano).
    const localDst = transfForm.local_destino_id ?? lid;
    if (localDst === lid && transfForm.origen === transfForm.destino) {
      showError("Las cuentas deben ser distintas dentro del mismo local");
      return;
    }
    const monto = parseFloat(transfForm.monto);
    if (!Number.isFinite(monto) || monto <= 0) { showError("Monto inválido"); return; }
    transfSavingRef.current = true;
    setTransfSaving(true);
    try {
      const { error } = await db.rpc("transferencia_cuentas", {
        p_local_id: lid,
        p_cuenta_origen: transfForm.origen,
        p_cuenta_destino: transfForm.destino,
        p_monto: monto,
        p_fecha: transfForm.fecha,
        p_detalle: transfForm.detalle || null,
        // Si destino != origen, lo pasamos. Si es same-local, mandamos null
        // (el RPC interpreta NULL = same-local, backward compat).
        p_local_destino_id: localDst !== lid ? localDst : null,
      });
      if (error) { showError(translateRpcError(error)); return; }
      showToast("Transferencia registrada");
      setTransfModal(false);
      setTransfForm({fecha:toISO(today),origen:"",destino:"",monto:"",detalle:"",local_destino_id:null});
      load();
    } finally {
      transfSavingRef.current = false;
      setTransfSaving(false);
    }
  };

  // Pending override: si el user no tiene 'compras_anular', guardamos el
  // mov/motivo y abrimos el modal de código. Mismo patrón que anular_factura,
  // anular_remito, anular_gasto.
  const [pendingAnularMov, setPendingAnularMov] = useState<{ mov: Movimiento; motivo: string } | null>(null);
  // Pending para edición de movimiento sin permiso caja_anular.
  const [pendingEditarMov, setPendingEditarMov] = useState<typeof editMov>(null);

  async function ejecutarAnularMov(m: Movimiento, motivo: string, overrideCode?: string) {
    const { error } = await db.rpc("anular_movimiento", {
      p_mov_id: m.id,
      p_motivo: motivo,
      ...(overrideCode ? { p_override_code: overrideCode } : {}),
    });
    if (error) { showError(translateRpcError(error)); return; }
    showToast("Movimiento anulado");
    load();
  }

  const eliminarMov = async (m: Movimiento) => {
    const motivo = prompt("¿Por qué anulás este movimiento? (obligatorio)");
    if (!motivo?.trim()) return;
    if (tienePermiso(user, "compras_anular")) {
      await ejecutarAnularMov(m, motivo);
    } else {
      setPendingAnularMov({ mov: m, motivo });
    }
  };

  async function ejecutarEditMov(em: typeof editMov, overrideCode?: string) {
    if (!em) return;
    const original = movimientos.find(m => m.id === em.id);
    setSavingEdit(true);
    try {
      const nuevoImporte = parseFloat(String(em.importe)) || original?.importe || 0;
      const signoOriginal = (original?.importe || 0) >= 0 ? 1 : -1;
      const signoNuevo = nuevoImporte >= 0 ? 1 : -1;
      const cambioSigno = signoOriginal !== signoNuevo;
      const catCambio = em.cat !== original?.cat;
      const tipoNuevo = (cambioSigno || catCambio)
        ? deriveTipoMov(em.cat || "", signoNuevo < 0)
        : original?.tipo;

      const args: Record<string, unknown> = {
        p_mov_id: em.id,
        p_fecha: em.fecha,
        p_detalle: em.detalle,
        p_cat: em.cat || null,
        p_importe: nuevoImporte,
        p_cuenta: em.cuenta,
        p_tipo: tipoNuevo,
        p_justificativo: em.justificativo,
        p_idempotency_key: idempKeyEditMov,
      };
      if (overrideCode) args.p_override_code = overrideCode;
      const { error } = await db.rpc("editar_movimiento_caja", args);
      if (error) { showError(translateRpcError(error)); return; }
      showToast("Movimiento editado");
      setEditMov(null); load();
    } finally {
      setSavingEdit(false);
    }
  }

  const guardarEditMov = async () => {
    if (savingEdit) return;
    if (!editMov) return;
    if (!editMov.justificativo?.trim()) { showError("El justificativo es obligatorio"); return; }
    // Lucas 2026-05-19: si NO tiene caja_anular, guardamos los args y
    // abrimos modal de Manager Override pidiendo código TOTP del dueño.
    // El handler del modal llama a ejecutarEditMov(em, codigo) cuando
    // el código valida.
    if (!tienePermiso(user, "caja_anular")) {
      setPendingEditarMov(editMov);
      return;
    }
    await ejecutarEditMov(editMov);
  };

  const cc = (_c: string) => "var(--pase-text-muted)";

  // Sub-nav del módulo madre Caja. 2 items, ambos siempre visibles.
  const subNavSections: SubNavSection[] = [
    {
      header: "Sección",
      activeId: subSection,
      onSelect: (id) => setSubSection(id as SubSectionCaja),
      items: [
        { id: "movimientos",  label: "Movimientos" },
        { id: "conciliacion", label: "Conciliación MP" },
      ],
    },
  ];

  return (
    <div>
      <PageHeader
        title="Caja"
        subtitle={subSection === "movimientos" ? "movimientos" : "conciliación MP"}
        info={subSection === "movimientos"
          ? <>Cuentas y movimientos del local: efectivo, MercadoPago, banco. Los movimientos se generan automáticamente al cargar ventas en efectivo, gastos, facturas pagadas y otros flujos.</>
          : <>Reconcilía los movimientos de MercadoPago contra tus facturas, gastos y movimientos de caja. Sincronización automática cada 30 min vía GitHub Actions.</>
        }
        actions={subSection === "movimientos" ? (
          <>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const filename = `movimientos_caja_${filtDesde || 'inicio'}_${filtHasta || 'hoy'}.csv`;
                const headers = ["Fecha", "Cuenta", "Tipo", "Categoría", "Detalle", "Importe", "Estado"];
                const rows = mFilt.map(m => [
                  m.fecha?.slice(0, 10) || "",
                  m.cuenta,
                  m.tipo || "",
                  m.cat || "",
                  m.detalle || "",
                  Number(m.importe ?? 0),
                  m.anulado ? "Anulado" : "OK",
                ]);
                exportCSV(filename, headers, rows);
              }}
              disabled={mFilt.length === 0}
              title="Exportar movimientos visibles a CSV (abre en Excel)"
            >⬇ Exportar</button>
            <button data-tour="caja-transfer" className="btn btn-sec" onClick={()=>setTransfModal(true)} disabled={cuentasOperablesList.length<2}>↔ Transferir</button>
            <button data-tour="caja-nuevo-mov" className="btn btn-acc" onClick={abrirNuevoMovimiento}>+ Movimiento</button>
          </>
        ) : (
          <>
            <button className="btn btn-sec" onClick={() => triggerMPAction("cuentas")}>⚙ Cuentas MP</button>
            <button className="btn btn-acc" onClick={() => triggerMPAction("sync")}>↻ Sincronizar ahora</button>
          </>
        )}
      />

      {/* Layout dual por sub-sección (refactor 2026-05-23 v2):
          - MOVIMIENTOS: 2 bandas. Arriba cards + aside, abajo tabla full-width
            (la tabla necesita full-width porque tiene muchas columnas + Editar/Anular).
          - CONCILIACIÓN: 1 banda grid (contenido + aside). El componente
            ConciliacionMP es más estrecho que la tabla de movs y coexiste bien
            con el aside de 168px → no deja espacio vacío arriba.
          Antes (v1) había una BANDA 1 vacía en conciliación porque las cards
          no se mostraban → la fila del grid se estiraba a la altura del aside,
          dejando un gap gigante arriba del ConciliacionMP. */}
      {subSection === "conciliacion" ? (
        <div className="module-with-aside">
          <div style={{ minWidth: 0 }}>
            <Suspense fallback={<div className="loading">Cargando conciliación MP…</div>}>
              <ConciliacionMP user={user as Usuario} locales={locales} localActivo={localActivo} embedded />
            </Suspense>
          </div>
          <RightSubNav sections={subNavSections} />
        </div>
      ) : (
        <>
      <div className="module-with-aside" style={{ marginBottom: 16 }}>
        <div style={{ minWidth: 0 }}>
          {cuentasVisibles.length === 0 ? (
            <div className="panel">
              <EmptyState
                icon="🔐"
                title="Sin cuentas asignadas"
                description="Pedile a un administrador que te habilite acceso a las cuentas de caja."
              />
            </div>
          ) : (() => {
            // Sprint v2 Commit 5: layout de 3 cards (anchor + 2 normales).
            // Caja Efectivo es el anchor celeste; Chica y Mayor son blancas.
            // Banco se removió de esta vista hasta que se concilie con MP.
            const orden = ["Caja Efectivo", "Caja Chica", "Caja Mayor"];
            const cardsVisibles = orden.filter(k => cuentasVisibles.includes(k));
            return (
              <div data-tour="caja-cards">
                <CajaCardsRow
                  cards={cardsVisibles.map((cuenta, i) => ({
                    cuenta,
                    label: cuenta,
                    saldo: saldos[cuenta] || 0,
                    variant: i === 0 && cuenta === "Caja Efectivo" ? "anchor" : "normal",
                  }))}
                />
              </div>
            );
          })()}
        </div>
        <RightSubNav sections={subNavSections} />
      </div>

      {/* BANDA 2: tabla full-width */}
      <div className="panel">
        <div className="panel-hd" style={{flexWrap:"wrap",gap:8}}>
          <span className="panel-title">Movimientos</span>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            {tienePermiso(user, "ver_anulados") && (
              <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--muted2)",cursor:"pointer"}}>
                <input type="checkbox" checked={mostrarAnulados} onChange={e => setMostrarAnulados(e.target.checked)}/>
                Ver anulados
              </label>
            )}
            <select
              className="search"
              style={{width:180}}
              value={ordenPor}
              onChange={e=>setOrdenPor(e.target.value as "fecha" | "carga")}
              title="Cómo ordenar la lista de movimientos"
            >
              <option value="fecha">Orden: Fecha del mov.</option>
              <option value="carga">Orden: Fecha de carga</option>
            </select>
          </div>
        </div>
        {/* Banner: movimientos con fecha posterior al filtro "hasta" activo.
            Solo aparece cuando el usuario aplicó manualmente un filtro hasta
            (defaults vacíos no filtran nada). Caso típico: usuario filtra
            "hasta hoy" y queda fuera el pago con fecha fin de mes. */}
        {movsFueraRango > 0 && filtHasta && (
          <div style={{
            padding: "10px 14px",
            background: "rgba(245, 158, 11, 0.1)",
            border: "1px solid rgba(245, 158, 11, 0.3)",
            borderRadius: 6,
            margin: "0 14px 12px",
            fontSize: 12,
            color: "var(--text)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}>
            <span style={{ fontSize: 16 }}>📅</span>
            <div style={{ flex: 1 }}>
              Hay <strong>{movsFueraRango} movimiento{movsFueraRango === 1 ? "" : "s"}</strong> con
              fecha posterior a <strong>{filtHasta}</strong>. No aparecen porque tenés filtro activo.
            </div>
            <button
              className="btn btn-sec"
              style={{ fontSize: 11, padding: "4px 12px" }}
              onClick={() => {
                // Quitar filtro hasta para verlos
                setFiltHasta("");
              }}
            >
              Quitar filtro
            </button>
          </div>
        )}
        {loading?<div className="loading">Cargando...</div>:(
          <div className="table-scroll-wrap">
          <table style={{minWidth: 720}}><thead><tr>
            <th className="col-fecha"><DateRangeFilter label="Fecha" desde={filtDesde} hasta={filtHasta} onDesdeChange={setFiltDesde} onHastaChange={setFiltHasta} /></th>
            {ordenPor === "carga" && <th className="col-fecha" title="Cuándo se cargó realmente al sistema (puede diferir de la fecha del movimiento)">Cargado</th>}
            <th><ColumnFilter label="Cuenta" values={mColFilters.uniqueValues("cuenta")} selected={mColFilters.getFilter("cuenta")} onChange={s => mColFilters.setFilter("cuenta", s)} /></th><th><ColumnFilter label="Tipo" values={mColFilters.uniqueValues("tipo")} selected={mColFilters.getFilter("tipo")} onChange={s => mColFilters.setFilter("tipo", s)} /></th><th><ColumnFilter label="Categoría" values={mColFilters.uniqueValues("categoria")} selected={mColFilters.getFilter("categoria")} onChange={s => mColFilters.setFilter("categoria", s)} /></th><th>Detalle</th><th className="num-right">Importe</th><th></th>
          </tr></thead>
          {mFilt.length===0?(
            <tbody><tr><td colSpan={ordenPor === "carga" ? 8 : 7} style={{padding:0}}>
              <EmptyState
                icon="📋"
                title="Sin movimientos"
                description={mColFilters.hasActiveFilters ? "No hay movimientos con los filtros seleccionados. Usá los filtros de columna para ampliar la búsqueda." : "No hay movimientos en el rango de fechas seleccionado. Probá ampliar el rango o cargar un movimiento manual."}
              />
            </td></tr></tbody>
          ):(
          <tbody>{mFilt.map(m=>{
            // Bug fix 2026-06-04: usar created_at si está disponible
            // (movimientos.created_at agregado migration 202606040900).
            // Fallback al parser legacy fechaCargaFromId solo si por
            // algún motivo el campo viene null (caso edge transitorio).
            const fCarga = m.created_at
              ? new Date(m.created_at as unknown as string)
              : fechaCargaFromId(m.id);
            const fMovISO = m.fecha?.slice(0,10) || "";
            const fCargaISO = fCarga ? toLocalISO(fCarga) : "";
            // Si la fecha de carga difiere de la fecha del mov, lo destacamos
            // sutilmente para alertar al user (cargada con fecha vieja).
            const fechasDifieren = fCargaISO && fMovISO && fCargaISO !== fMovISO;
            return (
            <tr key={m.id} style={{opacity: m.anulado ? 0.5 : 1, textDecoration: m.anulado ? "line-through" : "none"}}>
              <td className="mono" title={fechasDifieren ? `Fecha del mov.: ${fmt_d(m.fecha)}\nCargado: ${fmtFechaCarga(fCarga)}` : undefined}>
                {fmt_d(m.fecha)}
                {fechasDifieren && <span style={{marginLeft:4,color:"var(--warn)",fontSize:9}} title="Cargado con fecha distinta a la de creación">⚠</span>}
              </td>
              {ordenPor === "carga" && <td className="mono" style={{fontSize:11,color:"var(--muted2)"}}>{fmtFechaCarga(fCarga)}</td>}
              <td><span className="badge b-muted">{m.cuenta}</span></td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>
                <span>{m.tipo}</span>
                {/* Badges sutiles: borde + texto, sin fondo. Coherente con
                    Gastos. Lucas 2026-05-19: minimalista. */}
                {m.anulado && (
                  <span
                    title={m.anulado_motivo ?? undefined}
                    style={{
                      marginLeft: 6,
                      fontSize: 9,
                      padding: "1px 5px",
                      borderRadius: 3,
                      color: "var(--danger)",
                      border: "0.5px solid var(--danger)",
                      background: "transparent",
                      letterSpacing: 0.3,
                      fontWeight: 400,
                      textTransform: "lowercase",
                    }}
                  >anulado</span>
                )}
                {m.editado && !m.anulado && (
                  <span
                    onClick={() => setDetalleEdicion(m)}
                    title="Ver detalle de edición"
                    style={{
                      marginLeft: 6,
                      fontSize: 9,
                      padding: "1px 5px",
                      borderRadius: 3,
                      color: "var(--muted2)",
                      border: "0.5px solid var(--bd)",
                      background: "transparent",
                      letterSpacing: 0.3,
                      fontWeight: 400,
                      textTransform: "lowercase",
                      cursor: "pointer",
                    }}
                  >editado</span>
                )}
              </td>
              <td>{m.cat?<span className="badge b-muted">{m.cat}</span>:"—"}</td>
              <td style={{fontSize:11,maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {(() => {
                  const origen = origenMovimiento(m);
                  if (!origen) return null;
                  return (
                    <span
                      style={{
                        fontSize: 9, marginRight: 6,
                        padding: "1px 6px",
                        borderRadius: 4,
                        color: "var(--pase-text-muted)",
                        background: "var(--pase-bg-out)",
                        border: "0.5px solid var(--pase-border)",
                        letterSpacing: "var(--pase-ls-snug)",
                        fontWeight: 400,
                        whiteSpace: "nowrap",
                      }}
                      title={origen.tooltip}
                    >{origen.label}</span>
                  );
                })()}
                {/* Nombre del empleado para gastos tipo='empleado' (Lucas 10-jun). */}
                {m.gasto_id_ref && empPorGasto[m.gasto_id_ref] && (
                  <span
                    style={{
                      fontSize: 10, marginRight: 6,
                      padding: "1px 6px",
                      borderRadius: 4,
                      color: "var(--pase-text)",
                      background: "rgba(117,170,219,0.12)",
                      border: "0.5px solid rgba(117,170,219,0.3)",
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                    }}
                  >{empPorGasto[m.gasto_id_ref]}</span>
                )}
                {m.detalle}
              </td>
              <td className="num-right"><span>{fmt_$(m.importe)}</span></td>
              <td>
                <div style={{display:"flex",gap:4,justifyContent:"flex-end"}}>
                  {!m.anulado && <button className="btn btn-ghost btn-sm" onClick={() => { setEditMov({...m, justificativo: ""}); setIdempKeyEditMov(crypto.randomUUID()); }}>Editar</button>}
                  {/* Botón siempre visible. Si el user no tiene caja_anular, el
                      handler eliminarMov abre el modal de Manager Override
                      pidiendo código del dueño. Decisión Lucas 2026-05-19:
                      ausencia de permiso NO oculta la acción. */}
                  {!m.anulado && <button className="btn btn-danger btn-sm" onClick={() => eliminarMov(m)}>Anular</button>}
                </div>
              </td>
            </tr>
            );
          })}</tbody>
        )}
          </table>
          </div>
        )}
        {/* Contador + paginación. Total exacto del rango lo trae el conteo
            del último query (proxy con movimientos.length + hasMore=true ⇒
            "X+"). Si hasMore, botón "Cargar más" trae otro bloque. */}
        {!loading && movimientos.length > 0 && (
          <div style={{padding:"8px 12px",borderTop:"1px solid var(--bd)",display:"flex",alignItems:"center",justifyContent:"space-between",fontSize:11,color:"var(--muted2)"}}>
            <span>Mostrando {mFilt.length} de {movimientos.length}{hasMore ? "+" : ""} movimientos en el rango</span>
            {hasMore && (
              <button className="btn btn-ghost btn-sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Cargando..." : "Cargar más"}
              </button>
            )}
          </div>
        )}
      </div>
        </>
      )}

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal>. */}
      <Modal
        isOpen={editMov !== null}
        onClose={() => setEditMov(null)}
        title="Editar Movimiento"
        maxWidth={600}
        preventCloseOnOverlay={savingEdit}
        footer={<>
          <button className="btn btn-sec" onClick={() => setEditMov(null)}>Cancelar</button>
          <button className="btn btn-acc" onClick={guardarEditMov} disabled={savingEdit}>{savingEdit ? "Guardando..." : "Guardar"}</button>
        </>}
      >
        {editMov && (() => {
          // Lucas 10-jun: en Caja-Editar quiero poder modificar TODOS los
          // campos (como en Gastos). Antes solo fecha/cuenta/importe/detalle.
          // Ahora agregamos también tipo + categoría (el tipo se re-deriva
          // automático según la cat para mantener consistencia EERR).
          const esEgreso = (parseFloat(String(editMov.importe)) || 0) < 0;
          // Listado de categorías por bucket EERR (mismo orden que en
          // ModalCargarFactura/Conciliación, para que el dropdown sea
          // consistente entre módulos).
          const allCats = esEgreso
            ? [
                ...CATEGORIAS_COMPRA.map(c => ({ value: c, label: c, group: "Mercadería (CMV)" })),
                ...GASTOS_FIJOS.map(c => ({ value: c, label: c, group: "Gastos Fijos" })),
                ...GASTOS_VARIABLES.map(c => ({ value: c, label: c, group: "Gastos Variables" })),
                ...GASTOS_PUBLICIDAD.map(c => ({ value: c, label: c, group: "Publicidad" })),
                ...COMISIONES_CATS.map(c => ({ value: c, label: c, group: "Comisiones" })),
                ...GASTOS_IMPUESTOS.map(c => ({ value: c, label: c, group: "Impuestos" })),
              ]
            : []; // ingresos sin catálogo cerrado — texto libre
          // Agrupar para <optgroup>
          const groups = allCats.reduce<Record<string, typeof allCats>>((acc, o) => {
            (acc[o.group] = acc[o.group] || []).push(o); return acc;
          }, {});
          return (<>
          <div className="form2">
            <div className="field"><label>Fecha</label>
              <input type="date" value={editMov.fecha} onChange={e => setEditMov({...editMov, fecha: e.target.value})}/>
            </div>
            <div className="field"><label>Cuenta</label>
              <select value={editMov.cuenta} onChange={e => setEditMov({...editMov, cuenta: e.target.value})}>
                {cuentasOperablesList.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="form2">
            <div className="field"><label>Importe $</label>
              <input type="number" value={editMov.importe}
                onChange={e => setEditMov({...editMov, importe: e.target.value})}/>
              <div style={{fontSize:10,color:"var(--muted2)",marginTop:2}}>
                Si cambiás el signo, el tipo se re-deriva automático.
              </div>
            </div>
            <div className="field"><label>Categoría EERR</label>
              {esEgreso ? (
                <select value={editMov.cat || ""} onChange={e => setEditMov({...editMov, cat: e.target.value || null})}>
                  <option value="">(sin categoría — Egreso Manual)</option>
                  {Object.entries(groups).map(([g, opts]) => (
                    <optgroup key={g} label={g}>
                      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              ) : (
                <input value={editMov.cat || ""} onChange={e => setEditMov({...editMov, cat: e.target.value || null})}
                  placeholder="Liquidación Rappi, Ingreso Socio, etc."/>
              )}
            </div>
          </div>
          <div className="field"><label>Detalle</label>
            <input value={editMov.detalle||""} onChange={e => setEditMov({...editMov, detalle: e.target.value})}/>
          </div>
          <div className="field"><label>Justificativo de la edición *</label>
            <input value={editMov.justificativo||""}
              onChange={e => setEditMov({...editMov, justificativo: e.target.value})}
              placeholder="Motivo de la modificación..."/>
          </div>
          </>);
        })()}
      </Modal>

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal>. */}
      <Modal
        isOpen={detalleEdicion !== null}
        onClose={() => setDetalleEdicion(null)}
        title="Detalle de edición"
        maxWidth={480}
        footer={<button className="btn btn-sec" onClick={() => setDetalleEdicion(null)}>Cerrar</button>}
      >
        {auditLog ? (<>
          <div style={{marginBottom:12,fontSize:11,color:"var(--muted2)"}}>
            Justificativo: <strong style={{color:"var(--txt)"}}>{auditLog.justificativo || "—"}</strong>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            <div>
              <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:1,color:"var(--muted)",marginBottom:8}}>Antes</div>
              {auditLog.antes && Object.entries(auditLog.antes).map(([k, v]) => (
                <div key={k} style={{fontSize:11,marginBottom:4}}>
                  <span style={{color:"var(--muted2)"}}>{k}:</span> <span style={{color:"var(--danger)"}}>{String(v??'—')}</span>
                </div>
              ))}
            </div>
            <div>
              <div style={{fontSize:9,textTransform:"uppercase",letterSpacing:1,color:"var(--muted)",marginBottom:8}}>Después</div>
              {auditLog.despues && Object.entries(auditLog.despues).map(([k, v]) => (
                <div key={k} style={{fontSize:11,marginBottom:4}}>
                  <span style={{color:"var(--muted2)"}}>{k}:</span> <span style={{color:"var(--success)"}}>{String(v??'—')}</span>
                </div>
              ))}
            </div>
          </div>
        </>) : (
          <div className="empty">Sin detalle de auditoría disponible</div>
        )}
      </Modal>

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal>. */}
      <Modal
        isOpen={modal}
        onClose={() => setModal(false)}
        title="Nuevo Movimiento"
        maxWidth={600}
        preventCloseOnOverlay={saving}
        footer={<>
          <button className="btn btn-sec" onClick={() => setModal(false)}>Cancelar</button>
          <button className="btn btn-acc" onClick={guardar} disabled={saving || !form.importe || !form.cuenta || (necesitaSelectorLocal && !localFormId)}>{saving ? "Guardando..." : "Guardar"}</button>
        </>}
      >
        {/* Local: 3 estados (acordado 2026-05-17):
            - lidImplicito !== null → sucursal locked por sidebar → chip 🔒.
            - lidImplicito null + locsDisp > 1 → selector obligatorio.
            - locsDisp === 1 → no se muestra (el único se usa implícito). */}
        {lidImplicito !== null ? (
          <div className="field">
            <label>Local</label>
            <div style={{ paddingTop: 4 }}>
              <LocalLockedChip nombre={locales.find((l: Local) => l.id === lidImplicito)?.nombre ?? "—"} />
            </div>
          </div>
        ) : necesitaSelectorLocal && (
          <div className="field">
            <label>Local *</label>
            <select value={localFormId} onChange={e=>setLocalFormId(e.target.value)} required>
              <option value="">Seleccioná el local...</option>
              {locsDisp.map((l: Local)=><option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
        )}
        <div className="form2">
          <div className="field"><label>Cuenta *</label><select value={form.cuenta} onChange={e=>setForm({...form,cuenta:e.target.value})}><option value="">Seleccioná una cuenta…</option>{cuentasOperablesList.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
          <div className="field"><label>Dirección</label><select value={form.esEgreso?"egreso":"ingreso"} onChange={e=>setForm({...form,esEgreso:e.target.value==="egreso"})}><option value="egreso">Egreso (sale plata)</option><option value="ingreso">Ingreso (entra plata)</option></select></div>
        </div>
        <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e=>setForm({...form,fecha:e.target.value})}/></div>
        <div className="field"><label>Importe $</label><input type="number" value={form.importe} onChange={e=>setForm({...form,importe:e.target.value})} placeholder="0"/></div>
        <div className="field"><label>Detalle</label><input value={form.detalle} onChange={e=>setForm({...form,detalle:e.target.value})} placeholder="Descripción..."/></div>
      </Modal>
      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal>. */}
      <Modal
        isOpen={transfModal}
        onClose={() => setTransfModal(false)}
        title="Transferir entre cuentas"
        maxWidth={600}
        preventCloseOnOverlay={transfSaving}
        footer={<>
          <button className="btn btn-sec" onClick={() => setTransfModal(false)} disabled={transfSaving}>Cancelar</button>
          <button
            className="btn btn-acc"
            onClick={guardarTransferencia}
            disabled={
              transfSaving ||
              !transfForm.origen ||
              !transfForm.destino ||
              // Same-local con misma cuenta = inválido. Cross-local con misma cuenta = válido.
              (transfForm.local_destino_id == null && transfForm.origen === transfForm.destino) ||
              !transfForm.monto ||
              (necesitaSelectorLocal && !localFormId)
            }
          >
            {transfSaving?"Transfiriendo…":"Transferir"}
          </button>
        </>}
      >
        {lidImplicito !== null ? (
          <div className="field">
            <label>Local</label>
            <div style={{ paddingTop: 4 }}>
              <LocalLockedChip nombre={locales.find((l: Local) => l.id === lidImplicito)?.nombre ?? "—"} />
            </div>
          </div>
        ) : necesitaSelectorLocal && (
          <div className="field">
            <label>Local *</label>
            <select value={localFormId} onChange={e=>setLocalFormId(e.target.value)} required>
              <option value="">Seleccioná el local...</option>
              {locsDisp.map((l: Local)=><option key={l.id} value={l.id}>{l.nombre}</option>)}
            </select>
          </div>
        )}
        {/* Bloque CROSS-LOCAL: si hay más de un local visible, mostrar
            selector "Local destino" para permitir transferir entre
            cuentas de distintas sucursales (Lucas 22-may noche).
            Default: null = same local. */}
        {locsDisp.length > 1 && (
          <div className="field">
            <label>Local destino (opcional)</label>
            <select
              value={transfForm.local_destino_id ?? ""}
              onChange={e=>setTransfForm({...transfForm,local_destino_id: e.target.value ? Number(e.target.value) : null})}
            >
              <option value="">Mismo local (default)</option>
              {locsDisp.filter((l: Local)=> l.id !== (lidImplicito ?? parseInt(localFormId || "0"))).map((l: Local) => (
                <option key={l.id} value={l.id}>→ {l.nombre}</option>
              ))}
            </select>
          </div>
        )}
        <div className="form2">
          <div className="field"><label>Cuenta origen</label><select value={transfForm.origen} onChange={e=>setTransfForm({...transfForm,origen:e.target.value})}><option value="">— elegí cuenta —</option>{cuentasOperablesList.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
          <div className="field">
            <label>Cuenta destino</label>
            {/* Si es cross-local, NO filtramos por cuenta distinta (se permite
                misma cuenta en otro local, ej: Caja Efectivo VC → Caja Efectivo Belgrano). */}
            <select value={transfForm.destino} onChange={e=>setTransfForm({...transfForm,destino:e.target.value})}>
              <option value="">— elegí cuenta —</option>
              {(transfForm.local_destino_id != null
                ? cuentasOperablesList
                : cuentasOperablesList.filter(c=>c!==transfForm.origen)
              ).map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div className="form2">
          <div className="field"><label>Monto $</label><input type="number" value={transfForm.monto} onChange={e=>setTransfForm({...transfForm,monto:e.target.value})} placeholder="0"/></div>
          <div className="field"><label>Fecha</label><input type="date" value={transfForm.fecha} onChange={e=>setTransfForm({...transfForm,fecha:e.target.value})}/></div>
        </div>
        <div className="field"><label>Detalle (opcional)</label><input value={transfForm.detalle} onChange={e=>setTransfForm({...transfForm,detalle:e.target.value})} placeholder="Motivo de la transferencia..."/></div>
        <div style={{fontSize:11,color:"var(--muted)",marginTop:8}}>
          {transfForm.local_destino_id != null ? (
            <>
              Transferencia <b>cross-local</b>: egresa <b>{transfForm.origen||"origen"}</b> del local actual
              e ingresa en <b>{transfForm.destino||"destino"}</b> de <b>{locales.find((l: Local) => l.id === transfForm.local_destino_id)?.nombre ?? "—"}</b>.
            </>
          ) : (
            <>Genera 2 movimientos: egreso en <b>{transfForm.origen||"origen"}</b> e ingreso en <b>{transfForm.destino||"destino"}</b>. No afecta el saldo total.</>
          )}
        </div>
      </Modal>

      {/* MODAL MANAGER OVERRIDE — para anular movimiento sin permiso compras_anular */}
      <ManagerOverrideModal
        open={pendingAnularMov !== null}
        permiso="caja_anular"
        accion="anular_movimiento"
        context={pendingAnularMov ? {
          movimiento_id: pendingAnularMov.mov.id,
          total: Math.abs(pendingAnularMov.mov.importe || 0),
          motivo: pendingAnularMov.motivo,
        } : undefined}
        descripcion={pendingAnularMov ? `Anular movimiento de ${fmt_$(Math.abs(pendingAnularMov.mov.importe || 0))}` : undefined}
        onClose={() => setPendingAnularMov(null)}
        onValidated={async (codigo) => {
          if (!pendingAnularMov) return;
          const { mov, motivo } = pendingAnularMov;
          setPendingAnularMov(null);
          await ejecutarAnularMov(mov, motivo, codigo);
        }}
      />
      {/* MODAL MANAGER OVERRIDE — para editar movimiento sin permiso caja_anular.
          Lucas 10-jun: el context lleva TODOS los valores nuevos así cuando
          el dueño aprueba, fn_aprobar_solicitud aplica la edición sin
          depender de que el empleado vuelva a esta pantalla. */}
      <ManagerOverrideModal
        open={pendingEditarMov !== null}
        permiso="caja_anular"
        accion="editar_movimiento"
        context={pendingEditarMov ? {
          movimiento_id: pendingEditarMov.id,
          total: Math.abs(parseFloat(String(pendingEditarMov.importe)) || 0),
          // valores nuevos (snapshot del draft de Agos):
          nuevo_fecha: pendingEditarMov.fecha,
          nuevo_cuenta: pendingEditarMov.cuenta,
          nuevo_importe: parseFloat(String(pendingEditarMov.importe)) || 0,
          nuevo_detalle: pendingEditarMov.detalle ?? "",
          nuevo_cat: pendingEditarMov.cat ?? null,
          justificativo: pendingEditarMov.justificativo,
        } : undefined}
        descripcion={pendingEditarMov ? `Editar movimiento de ${fmt_$(Math.abs(parseFloat(String(pendingEditarMov.importe)) || 0))}` : undefined}
        onClose={() => setPendingEditarMov(null)}
        onValidated={async (codigo) => {
          if (!pendingEditarMov) return;
          const em = pendingEditarMov;
          setPendingEditarMov(null);
          await ejecutarEditMov(em, codigo);
        }}
      />

      <ToastComponent toast={toast} />
    </div>
  );
}
