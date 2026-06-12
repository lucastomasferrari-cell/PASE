import { useState, useMemo, useEffect, useRef } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import { PageHeader, PageContainer, EmptyState, Modal } from "../components/ui";
import { fmt_$, fmt_d } from "@pase/shared/utils";
import { useCategorias } from "../lib/useCategorias";
import {
  parseExtractoMP,
  parseExtractoMpExcel,
  esExtractoMpCsv,
  esExtractoMpExcel,
  type ExtractoMovimiento,
} from "../lib/mpExtractoParser";
import type { Usuario, Local } from "../types";

// Módulo NUEVO de conciliación de extracto MP (Lucas 10-jun).
//
// Flow: el dueño/admin descarga el extracto mensual de MP (XLSX/CSV) por
// local, lo sube acá, y el sistema cruza línea por línea contra los
// `movimientos` con `cuenta='MercadoPago'` del local activo. Reglas:
//   - Monto EXACTO (al centavo) — bloqueante
//   - Fecha en ventana ±15 días alrededor del período del extracto
// Semáforo: verde (1 match), amarillo (>1 candidato), rojo_falta
// (en extracto pero no en PASE), rojo_sobra (en PASE pero no en extracto).
//
// El user resuelve cada caso:
//   - rojo_falta → botón Crear (llama crear_movimiento_caja)
//   - rojo_sobra → botón Anular (llama anular_movimiento)
//   - amarillo  → dropdown "elegí cuál" + confirmar
// Y al final puede registrar la corrida en `conciliacion_corridas`.
//
// NO persiste el state intermedio del archivo: si recargás la página
// antes de cerrar la conciliación, perdés los progresos y hay que re-subir
// el extracto. Es aceptable porque el flow es "una sentada".

interface CandidatoPase {
  id: string;
  fecha: string;
  importe: number;
  detalle: string;
  dias_diff: number;
  ya_conciliado: boolean;
}

interface MovEnCombinacion {
  id: string;
  fecha: string;
  importe: number;
  detalle: string;
}

interface Combinacion {
  proveedor: string | null;
  num_movs: number;
  movs: MovEnCombinacion[];
}

interface BloqueProveedor {
  proveedor: string;
  n_transferencias: number;
  suma_extracto: number;
  n_pagos: number;
  suma_pase: number | null;
  dif: number;
  movs: MovEnCombinacion[];
  // Facturas/remitos PENDIENTES del proveedor — pista para resolver la
  // diferencia (suelen ser facturas que nadie marcó como pagadas).
  facturas_pendientes?: Array<{
    tipo: "factura" | "remito";
    id: string;
    nro: string | null;
    fecha: string;
    total: number;
  }>;
}

// Factura/remito cargado pero NO marcado como pagado, cuyo total coincide
// con la transferencia. tipo='tanda' agrupa varias facturas del proveedor.
interface FacturaPendiente {
  tipo: "factura" | "remito" | "tanda";
  id?: string;
  nro?: string | null;
  proveedor?: string | null;
  fecha?: string;
  total?: number;
  dif: number;
  // solo para tipo='tanda':
  n?: number;
  total_suma?: number;
  facturas?: Array<{ tipo: "factura"; id: string; nro: string | null; fecha: string; total: number }>;
}

interface FilaExtracto {
  idx: number;
  fecha: string;
  monto: number;
  descripcion: string;
  referencia_externa: string | null;
  estado: "verde" | "amarillo" | "verde_agrupado" | "amarillo_agrupado" | "verde_bloque" | "bloque_diferencia" | "factura_sin_pagar" | "ya_conciliada" | "rojo_falta";
  num_candidatos: number;
  candidatos: CandidatoPase[];
  combinaciones: Combinacion[];
  bloque: BloqueProveedor | null;
  facturas_pendientes: FacturaPendiente[];
}

interface Sobrante {
  id: string;
  fecha: string;
  importe: number;
  detalle: string;
  bloque_prov?: string | null;
  prov_id?: number | null;
  prov_nombre?: string | null;
}

// Fila histórica de conciliaciones ya cerradas (de conciliacion_corridas).
// Solo se usa para mostrar el listado al tope de la pantalla.
interface CorridaHistorica {
  id: string;
  periodo_desde: string;
  periodo_hasta: string;
  archivo_nombre: string | null;
  total_movs: number;
  verdes: number;
  amarillos: number;
  rojos_falta: number;
  rojos_sobra: number;
  cerrada_at: string | null;
}

interface Totales {
  extracto_total: number;
  verdes: number;
  amarillos: number;
  verdes_agrupados: number;
  amarillos_agrupados: number;
  verdes_bloque: number;
  bloques_diferencia: number;
  facturas_sin_pagar: number;
  ya_conciliadas: number;
  rojos_falta: number;
  rojos_sobra: number;
}

interface CruceResultado {
  extracto: FilaExtracto[];
  sobrantes: Sobrante[];
  totales: Totales;
}

interface ConciliacionExtractoProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

export default function ConciliacionExtracto({ user, locales, localActivo }: ConciliacionExtractoProps) {
  const { toast, showToast, showError } = useToast();
  const [parsing, setParsing] = useState(false);
  const [cruzando, setCruzando] = useState(false);
  const [archivoNombre, setArchivoNombre] = useState<string>("");
  const [extractoMovs, setExtractoMovs] = useState<ExtractoMovimiento[]>([]);
  const [periodoDesde, setPeriodoDesde] = useState<string>("");
  const [periodoHasta, setPeriodoHasta] = useState<string>("");
  const [resumenExtracto, setResumenExtracto] = useState<{
    initial_balance: number;
    final_balance: number;
  } | null>(null);
  const [cruce, setCruce] = useState<CruceResultado | null>(null);
  // Resoluciones del usuario:
  // - "ignorar": ya no aparece en pendientes (decisión del user)
  // - "creado:<movId>": el rojo_falta fue resuelto creando este mov
  // - "matcheado:<movId>": el amarillo fue resuelto eligiendo este mov
  // - "anulado": el sobrante fue anulado
  // - "prov:<prov_id>": Lucas 10-jun — el rojo_falta pertenece a un
  //   proveedor; al cerrar la conciliación se aprende el alias
  //   titular→proveedor para que la próxima vez vaya directo al bloque.
  const [resueltos, setResueltos] = useState<Record<string, string>>({});
  // Catálogo de proveedores del tenant — para el modal "Pertenece a..."
  // (interfaz de aprendizaje, Lucas 10-jun).
  const [proveedoresList, setProveedoresList] = useState<Array<{ id: number; nombre: string }>>([]);
  // Modal: asignar fila roja a un proveedor existente.
  const [asignarProvFila, setAsignarProvFila] = useState<FilaExtracto | null>(null);
  const [busquedaProv, setBusquedaProv] = useState<string>("");
  // Estados temporales para el modal de "elegir candidato" en amarillos
  const [pickCandidato, setPickCandidato] = useState<FilaExtracto | null>(null);
  // Modal: elegir entre varias combinaciones agrupadas
  const [pickCombinacion, setPickCombinacion] = useState<FilaExtracto | null>(null);
  // Estado temporal para confirmar anulación de sobrante
  const [anularSobrante, setAnularSobrante] = useState<Sobrante | null>(null);
  const [motivoAnular, setMotivoAnular] = useState<string>("");
  // Estado temporal para confirmar creación de mov faltante
  const [crearFaltante, setCrearFaltante] = useState<FilaExtracto | null>(null);
  // Tipo y categoría para el mov a crear desde el modal. Se setean al abrirlo
  // (Lucas 10-jun: "no te pide poner ni tipo ni categoria como corresponde"
  // — antes los mov creados quedaban con tipo="Egreso Manual"/null cat,
  // descuadrando el EERR).
  const [crearTipo, setCrearTipo] = useState<string>("");
  const [crearCat, setCrearCat] = useState<string>("");
  const { GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, COMISIONES_CATS, GASTOS_IMPUESTOS, CATEGORIAS_COMPRA, CATEGORIAS_INGRESO } = useCategorias();
  // Saving flags
  const [savingAccion, setSavingAccion] = useState(false);
  // Última corrida persistida (cerrada)
  const [corridaCerrada, setCorridaCerrada] = useState<{ id: string; created_at: string } | null>(null);
  // Historial de conciliaciones cerradas del local activo. Se carga al
  // montar la pantalla + al cambiar de local + al cerrar una conciliación
  // nueva (para que refresque sin recargar página).
  const [historial, setHistorial] = useState<CorridaHistorica[]>([]);
  const [historialLoading, setHistorialLoading] = useState(false);

  // ─── BORRADOR persistente en localStorage (Lucas 10-jun) ─────────────────
  // "se me cerro varias veces y tuve que empezar de 0, estaria bueno que se
  // pueda quedar en borrador". Serialize el estado crítico por local —
  // si recargás o cerrás la pestaña, al volver te aparece el cruce en el
  // punto donde lo dejaste.
  const BORRADOR_KEY = localActivo != null ? `pase_concil_borrador_local_${localActivo}` : "";

  // Restaurar al montar / cambiar de local
  useEffect(() => {
    if (!BORRADOR_KEY) return;
    try {
      const raw = localStorage.getItem(BORRADOR_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as {
        archivoNombre?: string;
        extractoMovs?: ExtractoMovimiento[];
        periodoDesde?: string;
        periodoHasta?: string;
        resumenExtracto?: {
          initial_balance: number; credits: number; debits: number; final_balance: number;
        } | null;
        cruce?: CruceResultado | null;
        resueltos?: Record<string, string>;
      };
      if (draft.archivoNombre) setArchivoNombre(draft.archivoNombre);
      if (draft.extractoMovs) setExtractoMovs(draft.extractoMovs);
      if (draft.periodoDesde) setPeriodoDesde(draft.periodoDesde);
      if (draft.periodoHasta) setPeriodoHasta(draft.periodoHasta);
      if (draft.resumenExtracto !== undefined) setResumenExtracto(draft.resumenExtracto);
      if (draft.cruce) setCruce(draft.cruce);
      if (draft.resueltos) setResueltos(draft.resueltos);
    } catch (e) {
      console.warn("[Conciliación] error restaurando borrador:", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localActivo]);

  // Guardar al cambiar cualquier pieza relevante. Skip si no hay nada
  // cargado todavía (no queremos pisar un borrador real con state vacío
  // del mount inicial).
  useEffect(() => {
    if (!BORRADOR_KEY) return;
    if (corridaCerrada) return; // ya cerrada — no guarda más borrador
    const hayCruce = !!cruce && cruce.extracto.length > 0;
    if (!hayCruce && extractoMovs.length === 0) return;
    try {
      localStorage.setItem(BORRADOR_KEY, JSON.stringify({
        archivoNombre, extractoMovs, periodoDesde, periodoHasta,
        resumenExtracto, cruce, resueltos,
      }));
    } catch (e) {
      // Quota exceeded u otra falla — no es crítico, la conciliación sigue
      // funcionando in-memory.
      console.warn("[Conciliación] no se pudo guardar borrador:", e);
    }
  }, [BORRADOR_KEY, corridaCerrada, archivoNombre, extractoMovs, periodoDesde, periodoHasta, resumenExtracto, cruce, resueltos]);

  // Limpiar al cerrar la conciliación o al usuario tocar "Empezar de cero".
  function limpiarBorrador() {
    if (!BORRADOR_KEY) return;
    try { localStorage.removeItem(BORRADOR_KEY); } catch { /* idempotente */ }
  }

  // ─── Cargar historial de conciliaciones cerradas ─────────────────────────
  useEffect(() => {
    if (localActivo == null) {
      setHistorial([]);
      return;
    }
    let cancelled = false;
    setHistorialLoading(true);
    (async () => {
      const { data, error } = await db
        .from("conciliacion_corridas")
        .select("id, periodo_desde, periodo_hasta, archivo_nombre, total_movs, verdes, amarillos, rojos_falta, rojos_sobra, cerrada_at")
        .eq("local_id", localActivo)
        .eq("cuenta", "MercadoPago")
        .not("cerrada_at", "is", null)
        .order("periodo_desde", { ascending: false })
        .limit(24);
      if (cancelled) return;
      if (error) {
        console.error("Error cargando historial:", error);
        setHistorial([]);
      } else {
        setHistorial((data ?? []) as CorridaHistorica[]);
      }
      setHistorialLoading(false);
    })();
    return () => { cancelled = true; };
    // Se recarga cuando cambia de local O cuando se cierra una nueva corrida
    // (corridaCerrada.id sirve como token de invalidación).
  }, [localActivo, corridaCerrada?.id]);

  // Catálogo de proveedores para el dropdown "Pertenece a..." (Lucas 10-jun).
  useEffect(() => {
    void db.from("proveedores")
      .select("id, nombre")
      .eq("estado", "Activo")
      .order("nombre")
      .limit(2000)
      .then(({ data }) => setProveedoresList((data ?? []) as Array<{ id: number; nombre: string }>));
  }, []);

  // localNombre se calcula SIEMPRE (default "—" si no hay local).
  // Se usa antes del early-return solo en sub-componentes que se renderizan
  // si localActivo != null (el early return de abajo nos protege).
  const localNombre = localActivo != null
    ? (locales.find(l => l.id === localActivo)?.nombre ?? `Local ${localActivo}`)
    : "—";

  // ─── Cargar archivo ──────────────────────────────────────────────────────
  async function onArchivoSeleccionado(file: File) {
    setArchivoNombre(file.name);
    setExtractoMovs([]);
    setResumenExtracto(null);
    setCruce(null);
    setResueltos({});
    setCorridaCerrada(null);
    setParsing(true);
    try {
      let resultado = null;
      if (esExtractoMpExcel(file)) {
        resultado = await parseExtractoMpExcel(file);
      } else if (await esExtractoMpCsv(file)) {
        const text = await file.text();
        resultado = parseExtractoMP(text);
      } else {
        showError("Formato no reconocido. Subí el .xlsx o .csv que descargás del panel MP. (PDF queda para más adelante)");
        return;
      }
      if (!resultado || resultado.movimientos.length === 0) {
        showError("No se pudo leer el archivo. ¿Es el extracto correcto de MP?");
        return;
      }
      setExtractoMovs(resultado.movimientos);
      setPeriodoDesde(resultado.rango_fechas.desde);
      setPeriodoHasta(resultado.rango_fechas.hasta);
      if (resultado.resumen) {
        setResumenExtracto({
          initial_balance: resultado.resumen.initial_balance,
          final_balance: resultado.resumen.final_balance,
        });
      }
      // Reglas del módulo (Lucas 10-jun): conciliamos SOLO egresos. Los
      // ingresos (liquidaciones de venta, rendimientos, transferencias
      // recibidas) son cientos y vienen por otra vía — no se cruzan acá.
      const egresos = resultado.movimientos.filter(m => m.monto < 0).length;
      const ingresos = resultado.movimientos.length - egresos;
      showToast(`Cargados ${egresos} egresos a conciliar (${ingresos} ingresos ignorados)`);
    } catch (e) {
      console.error(e);
      showError("Error al leer el archivo: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setParsing(false);
    }
  }

  // Solo egresos del extracto (Lucas 10-jun). El RPC también filtra los
  // movs de PASE para que los ingresos de PASE no aparezcan como
  // "sobrantes" (no tienen counterpart en el extracto filtrado).
  const egresosExtracto = useMemo(
    () => extractoMovs.filter(m => m.monto < 0),
    [extractoMovs],
  );

  // ─── Cruzar con PASE ─────────────────────────────────────────────────────
  async function cruzar() {
    if (!egresosExtracto.length || !periodoDesde || !periodoHasta) return;
    setCruzando(true);
    try {
      const payload = egresosExtracto.map(m => ({
        fecha: m.fecha,
        monto: m.monto,
        descripcion: m.descripcion,
        referencia_externa: m.referencia_externa,
      }));
      const { data, error } = await db.rpc("fn_cruzar_extracto_mp", {
        p_local_id: localActivo,
        p_periodo_desde: periodoDesde,
        p_periodo_hasta: periodoHasta,
        p_movs_extracto: payload,
        p_solo_egresos: true,
        p_match_agrupado: true,
      });
      if (error) { showError(translateRpcError(error)); return; }
      setCruce(data as CruceResultado);
      setResueltos({});
      showToast("Conciliación lista. Revisá el semáforo.");
    } finally {
      setCruzando(false);
    }
  }

  async function refrescarCruce() {
    if (!egresosExtracto.length || !periodoDesde || !periodoHasta) return;
    setCruzando(true);
    try {
      const payload = egresosExtracto.map(m => ({
        fecha: m.fecha,
        monto: m.monto,
        descripcion: m.descripcion,
        referencia_externa: m.referencia_externa,
      }));
      const { data, error } = await db.rpc("fn_cruzar_extracto_mp", {
        p_local_id: localActivo,
        p_periodo_desde: periodoDesde,
        p_periodo_hasta: periodoHasta,
        p_movs_extracto: payload,
        p_solo_egresos: true,
        p_match_agrupado: true,
      });
      if (error) { showError(translateRpcError(error)); return; }
      setCruce(data as CruceResultado);
      showToast("Datos actualizados — tus resoluciones se mantienen");
    } finally {
      setCruzando(false);
    }
  }

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && cruce && !cruzando) {
        void refrescarCruce();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  });

  // ─── Resolver cada caso ──────────────────────────────────────────────────
  // Borra la resolución (Lucas 10-jun: poder deshacer si se equivoca).
  function deshacerResolucion(idx: number) {
    setResueltos(p => { const n = { ...p }; delete n[`ext:${idx}`]; return n; });
  }
  function ignorarExtracto(idx: number) {
    setResueltos(p => ({ ...p, [`ext:${idx}`]: "ignorar" }));
  }
  function ignorarSobrante(id: string) {
    setResueltos(p => ({ ...p, [`sob:${id}`]: "ignorar" }));
  }
  function elegirCandidato(idx: number, movId: string) {
    setResueltos(p => ({ ...p, [`ext:${idx}`]: `matcheado:${movId}` }));
  }
  function elegirCombinacion(idx: number, comboIdx: number) {
    setResueltos(p => ({ ...p, [`ext:${idx}`]: `combo:${comboIdx}` }));
  }

  // Movimientos creados/pagados durante ESTA sesión de conciliación.
  // Se acumulan para marcarlos como conciliados al cerrar (tag invisible).
  const movsSesionRef = useRef<Set<string>>(new Set());

  // Crea UN movimiento en Caja a partir de una fila del extracto.
  // Devuelve true si se creó OK. Reusada por el modal individual y el lote.
  // Acepta tipo + cat opcionales (Lucas 10-jun): si vienen seteados, los usa;
  // si no, fallback a "Egreso/Ingreso Manual" + null (comportamiento viejo
  // para el flow de lote que aún no pide ambos).
  async function crearMovimientoDeFila(
    fila: FilaExtracto,
    tipoOverride?: string,
    catOverride?: string,
  ): Promise<boolean> {
    const esEgreso = fila.monto < 0;
    const tipoMov = tipoOverride && tipoOverride.trim() ? tipoOverride : (esEgreso ? "Egreso Manual" : "Ingreso Manual");
    const cat = catOverride && catOverride.trim() ? catOverride : null;
    const detalle = `[Concil. ${periodoDesde.slice(0, 7)}] ${fila.descripcion}${fila.referencia_externa ? ` · ref ${fila.referencia_externa}` : ""}`;
    const { error } = await db.rpc("crear_movimiento_caja", {
      p_fecha: fila.fecha,
      p_cuenta: "MercadoPago",
      p_tipo: tipoMov,
      p_cat: cat,
      p_importe: fila.monto,
      p_detalle: detalle,
      p_local_id: localActivo,
    });
    if (error) {
      showError(`${fila.descripcion.slice(0, 40)}: ${translateRpcError(error)}`);
      return false;
    }
    // Recuperar el id del mov recién creado para conciliarlo al cerrar.
    // crear_movimiento_caja no retorna el id — lookup por campos únicos.
    try {
      let q = db.from("movimientos")
        .select("id")
        .eq("cuenta", "MercadoPago")
        .eq("importe", fila.monto)
        .eq("detalle", detalle)
        .order("created_at", { ascending: false })
        .limit(1);
      q = applyLocalScope(q, user, localActivo);
      const { data: nuevo } = await q;
      if (nuevo && nuevo.length > 0) movsSesionRef.current.add(nuevo[0]!.id as string);
    } catch { /* tracking best-effort, no bloquea */ }
    setResueltos(p => ({ ...p, [`ext:${fila.idx}`]: "creado" }));
    return true;
  }

  async function ejecutarCrearFaltante() {
    if (!crearFaltante) return;
    if (!crearTipo) { showError("Elegí un tipo"); return; }
    if (!crearCat) { showError("Elegí una categoría"); return; }
    setSavingAccion(true);
    try {
      const ok = await crearMovimientoDeFila(crearFaltante, crearTipo, crearCat);
      if (ok) {
        setCrearFaltante(null);
        setCrearTipo("");
        setCrearCat("");
        showToast("Movimiento creado");
      }
    } finally {
      setSavingAccion(false);
    }
  }

  // ─── Creación EN LOTE (Lucas 10-jun: "siguen siendo muchos") ────────────
  // La mayoría de los faltantes son gastos reales no cargados. Crearlos de
  // a uno (35 clicks + 35 confirmaciones) es un dolor: checkboxes + un solo
  // botón que los crea todos secuencialmente.
  const [seleccionados, setSeleccionados] = useState<Set<number>>(new Set());
  const [confirmarLote, setConfirmarLote] = useState(false);
  const [progresoLote, setProgresoLote] = useState<string | null>(null);

  function toggleSeleccion(idx: number) {
    setSeleccionados(p => {
      const n = new Set(p);
      if (n.has(idx)) n.delete(idx); else n.add(idx);
      return n;
    });
  }

  async function ejecutarCrearLote() {
    if (!cruce) return;
    const filas = cruce.extracto.filter(f => seleccionados.has(f.idx) && !resueltos[`ext:${f.idx}`]);
    if (filas.length === 0) return;
    setSavingAccion(true);
    setConfirmarLote(false);
    let creados = 0;
    try {
      for (let i = 0; i < filas.length; i++) {
        setProgresoLote(`Creando ${i + 1} de ${filas.length}…`);
        const ok = await crearMovimientoDeFila(filas[i]!);
        if (ok) creados++;
        // Si falla uno, seguimos con el resto (el error ya se mostró).
      }
      showToast(`${creados} de ${filas.length} movimientos creados`);
      setSeleccionados(new Set());
    } finally {
      setProgresoLote(null);
      setSavingAccion(false);
    }
  }

  // ─── Marcar facturas/remitos como pagados (Lucas 10-jun) ────────────────
  // Caso: la factura está cargada pero el empleado se olvidó de marcarla
  // como pagada. La transferencia salió de MP. Acá la marcamos pagada con
  // cuenta MercadoPago y fecha de la transferencia REAL → crea el
  // movimiento → queda conciliado.
  async function marcarFacturaPagada(fila: FilaExtracto, cand: FacturaPendiente) {
    setSavingAccion(true);
    try {
      const items = cand.tipo === "tanda"
        ? (cand.facturas ?? []).map(f => ({ tipo: "factura" as const, id: f.id, total: f.total, nro: f.nro }))
        : [{ tipo: cand.tipo as "factura" | "remito", id: cand.id!, total: cand.total!, nro: cand.nro }];
      let pagadas = 0;
      for (const item of items) {
        const detalle = `[Concil. ${periodoDesde.slice(0, 7)}] ${fila.descripcion.slice(0, 80)}`;
        if (item.tipo === "factura") {
          const { error } = await db.rpc("pagar_factura", {
            p_factura_id: item.id,
            p_monto: item.total,
            p_cuenta: "MercadoPago",
            p_fecha: fila.fecha,
            p_detalle: detalle,
            p_idempotency_key: crypto.randomUUID(),
            p_generar_saldo: false,
            p_cerrar_factura: false,
          });
          if (error) { showError(`Factura ${item.nro ?? item.id}: ${translateRpcError(error)}`); continue; }
        } else {
          const { error } = await db.rpc("pagar_remito", {
            p_remito_id: item.id,
            p_monto: item.total,
            p_cuenta: "MercadoPago",
            p_fecha: fila.fecha,
            p_idempotency_key: crypto.randomUUID(),
          });
          if (error) { showError(`Remito ${item.nro ?? item.id}: ${translateRpcError(error)}`); continue; }
        }
        pagadas++;
        // Recuperar los movs generados por el pago para conciliarlos al cerrar.
        try {
          const col = item.tipo === "factura" ? "fact_id" : "remito_id_ref";
          let q = db.from("movimientos")
            .select("id")
            .eq(col, item.id)
            .eq("fecha", fila.fecha)
            .order("created_at", { ascending: false })
            .limit(3);
          q = applyLocalScope(q, user, localActivo);
          const { data: nuevos } = await q;
          (nuevos ?? []).forEach(n => movsSesionRef.current.add(n.id as string));
        } catch { /* tracking best-effort */ }
      }
      if (pagadas > 0) {
        setResueltos(p => ({ ...p, [`ext:${fila.idx}`]: "pagada" }));
        showToast(pagadas === 1 ? "Marcada como pagada" : `${pagadas} marcadas como pagadas`);
      }
    } finally {
      setSavingAccion(false);
    }
  }

  async function pagarPendienteDeBloque(
    filas: FilaExtracto[],
    pend: NonNullable<BloqueProveedor["facturas_pendientes"]>[number],
  ) {
    setSavingAccion(true);
    try {
      const fechasOrdenadas = filas.map(f => f.fecha).sort();
      const fechaPago = fechasOrdenadas[fechasOrdenadas.length - 1] ?? periodoHasta;
      const detalle = `[Concil. ${periodoDesde.slice(0, 7)}] pago dentro de transferencias agrupadas`;
      let yaEstabaPagada = false;
      if (pend.tipo === "factura") {
        const { error } = await db.rpc("pagar_factura", {
          p_factura_id: pend.id,
          p_monto: pend.total,
          p_cuenta: "MercadoPago",
          p_fecha: fechaPago,
          p_detalle: detalle,
          p_idempotency_key: crypto.randomUUID(),
          p_generar_saldo: false,
          p_cerrar_factura: false,
        });
        if (error) {
          if (error.message?.includes("FACTURA_YA_PAGADA")) {
            yaEstabaPagada = true;
          } else {
            showError(translateRpcError(error)); return;
          }
        }
      } else {
        const { error } = await db.rpc("pagar_remito", {
          p_remito_id: pend.id,
          p_monto: pend.total,
          p_cuenta: "MercadoPago",
          p_fecha: fechaPago,
          p_idempotency_key: crypto.randomUUID(),
        });
        if (error) {
          if (error.message?.includes("REMITO_YA_PAGADO")) {
            yaEstabaPagada = true;
          } else {
            showError(translateRpcError(error)); return;
          }
        }
      }
      // Fetch the payment movement (newly created, or existing if already paid).
      let nuevoMov: MovEnCombinacion | null = null;
      try {
        const col = pend.tipo === "factura" ? "fact_id" : "remito_id_ref";
        let q = db.from("movimientos").select("id, fecha, importe, detalle").eq(col, pend.id)
          .eq("cuenta", "MercadoPago").eq("anulado", false)
          .order("created_at", { ascending: false }).limit(1);
        q = applyLocalScope(q, user, localActivo);
        const { data: nuevos } = await q;
        if (nuevos?.[0]) {
          nuevoMov = nuevos[0] as MovEnCombinacion;
          movsSesionRef.current.add(nuevoMov.id);
        }
      } catch { /* best-effort */ }
      // Update cruce in memory so the payment moves up to "Pagos cargados en
      // PASE" immediately — no need to re-run the whole conciliación.
      const bloqueNombre = filas[0]?.bloque?.proveedor;
      if (bloqueNombre) {
        const importePago = nuevoMov?.importe ?? -Math.abs(pend.total);
        setCruce(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            extracto: prev.extracto.map(fila => {
              if (fila.bloque?.proveedor !== bloqueNombre) return fila;
              const newMovs = [...(fila.bloque.movs || [])];
              if (nuevoMov) newMovs.push(nuevoMov);
              const newFactPend = (fila.bloque.facturas_pendientes || []).filter(fp => fp.id !== pend.id);
              const newSumaPase = (Number(fila.bloque.suma_pase) || 0) + importePago;
              return {
                ...fila,
                bloque: {
                  ...fila.bloque,
                  movs: newMovs,
                  n_pagos: (fila.bloque.n_pagos || 0) + 1,
                  suma_pase: newSumaPase,
                  dif: Number(fila.bloque.suma_extracto) - newSumaPase,
                  facturas_pendientes: newFactPend,
                },
              };
            }),
          };
        });
      }
      showToast(yaEstabaPagada
        ? `${pend.tipo === "factura" ? "Factura" : "Remito"} ${pend.nro ?? ""} ya estaba pagada — vinculada al bloque`
        : `${pend.tipo === "factura" ? "Factura" : "Remito"} ${pend.nro ?? ""} marcada como pagada`);
    } finally {
      setSavingAccion(false);
    }
  }

  async function ejecutarAnularSobrante() {
    if (!anularSobrante) return;
    if (!motivoAnular.trim()) { showError("Tenés que poner un motivo"); return; }
    setSavingAccion(true);
    try {
      const { error } = await db.rpc("anular_movimiento", {
        p_mov_id: anularSobrante.id,
        p_motivo: `[Conciliación ${periodoDesde.slice(0, 7)}] ${motivoAnular.trim()}`,
      });
      if (error) { showError(translateRpcError(error)); return; }
      setResueltos(p => ({ ...p, [`sob:${anularSobrante.id}`]: "anulado" }));
      setAnularSobrante(null);
      setMotivoAnular("");
      showToast("Movimiento anulado");
    } finally {
      setSavingAccion(false);
    }
  }

  // Set de IDs de movs PASE que ya quedaron consumidos por una resolución
  // del usuario o por un match automático del cruce. Sirve para que la
  // sección "Sobran en PASE" NO los muestre — si Lucas resolvió una fila
  // amarilla eligiendo el mov X de PASE, X dejó de "sobrar".
  // (Lucas 10-jun: "algunos me aparecian en la parte de por elegir, y
  // ahora me aparecen aca, puede ser?".)
  const movsUsadosResueltos = useMemo(() => {
    const s = new Set<string>();
    if (!cruce) return s;
    for (const fila of cruce.extracto) {
      const r = resueltos[`ext:${fila.idx}`];
      // Resoluciones manuales del usuario sobre filas amarillas/agrupadas.
      if (r && r.startsWith("matcheado:")) {
        s.add(r.slice("matcheado:".length));
      } else if (r && r.startsWith("combo:")) {
        const idx = Number(r.slice("combo:".length));
        fila.combinaciones[idx]?.movs.forEach(m => s.add(m.id));
      } else if (!r) {
        // Sin resolución → cuentan los matches automáticos del cruce.
        if (fila.estado === "verde" && fila.candidatos.length === 1) {
          s.add(fila.candidatos[0]!.id);
        } else if (fila.estado === "verde_agrupado" && fila.combinaciones.length === 1) {
          fila.combinaciones[0]!.movs.forEach(m => s.add(m.id));
        } else if ((fila.estado === "verde_bloque" || fila.estado === "bloque_diferencia") && fila.bloque) {
          (fila.bloque.movs ?? []).forEach(m => s.add(m.id));
        }
      }
    }
    // Sobrantes consumidos por bloques virtuales (asignación manual a
    // proveedor): si una fila tiene resolución prov:X, todos los sobrantes
    // cuyo prov_id=X quedan consumidos y no deben aparecer en "Sobran".
    const provIdsAsignados = new Set<number>();
    for (const fila of cruce.extracto) {
      const r = resueltos[`ext:${fila.idx}`];
      if (r && r.startsWith("prov:")) provIdsAsignados.add(Number(r.slice("prov:".length)));
    }
    if (provIdsAsignados.size > 0) {
      for (const sob of cruce.sobrantes) {
        if (sob.prov_id && provIdsAsignados.has(sob.prov_id) && !sob.bloque_prov) {
          s.add(sob.id);
        }
      }
    }
    return s;
  }, [cruce, resueltos]);

  // ─── KPIs en vivo ────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!cruce) return null;
    let verdes = 0, amarillos = 0, verdesAgrupados = 0, amarillosAgrupados = 0,
      verdesBloque = 0, bloquesDif = 0, facturasSinPagar = 0, rojos_falta = 0, rojos_sobra = 0;
    let resueltos_count = 0;
    for (const fila of cruce.extracto) {
      const r = resueltos[`ext:${fila.idx}`];
      if (r && r.startsWith("prov:")) {
        bloquesDif++;
        continue;
      }
      if (r === "ignorar" || r === "creado" || r === "pagada" || (r && (r.startsWith("matcheado:") || r.startsWith("combo:")))) {
        resueltos_count++;
        continue;
      }
      if (fila.estado === "verde") verdes++;
      else if (fila.estado === "amarillo") amarillos++;
      else if (fila.estado === "verde_agrupado") verdesAgrupados++;
      else if (fila.estado === "amarillo_agrupado") amarillosAgrupados++;
      else if (fila.estado === "verde_bloque") verdesBloque++;
      else if (fila.estado === "bloque_diferencia") bloquesDif++;
      else if (fila.estado === "factura_sin_pagar") facturasSinPagar++;
      else if (fila.estado === "ya_conciliada") resueltos_count++; // conciliada en cierre anterior
      else if (fila.estado === "rojo_falta") rojos_falta++;
    }
    for (const sob of cruce.sobrantes) {
      const r = resueltos[`sob:${sob.id}`];
      if (r === "ignorar" || r === "anulado") { resueltos_count++; continue; }
      // Sobrantes que pertenecen a un bloque con diferencia NO cuentan como
      // "sobran": ya están explicados por el bloque naranja (la transferencia
      // agrupada del proveedor). Anular uno de estos sería un error.
      if (sob.bloque_prov) continue;
      // Si el sobrante quedó consumido por una resolución (matcheado/combo
      // de una amarilla, o verde/agrupado/bloque automático), tampoco
      // sobra — ya tiene contraparte en el extracto.
      if (movsUsadosResueltos.has(sob.id)) { resueltos_count++; continue; }
      rojos_sobra++;
    }
    return {
      verdes, amarillos, verdesAgrupados, amarillosAgrupados,
      verdesBloque, bloquesDif, facturasSinPagar, rojos_falta, rojos_sobra,
      // verdes (individuales + agrupados + bloque OK) NO son pendientes.
      // bloques_diferencia tampoco bloquean el cierre: son informativos
      // (la acción es cargar los pagos faltantes y re-conciliar).
      total_pendientes: amarillos + amarillosAgrupados + facturasSinPagar + rojos_falta + rojos_sobra,
      resueltos_count,
    };
  }, [cruce, resueltos, movsUsadosResueltos]);

  // Agrupar filas bloque_diferencia por proveedor para la sección naranja.
  // Lucas 10-jun: "si toco marcar como bloque revisado desaparece, lo mismo
  // con elegir entre varios candidatos". Antes filtrábamos las filas
  // resueltas (= cualquier fila con resueltos[...]) → bloque desaparecía.
  // Ahora dejamos visibles TODOS los bloques con bloque_diferencia y, si
  // todas sus filas están resueltas, mostramos check verde + Deshacer.
  const bloquesPorProveedor = useMemo(() => {
    if (!cruce) return [];
    const map = new Map<string, { bloque: BloqueProveedor; filas: FilaExtracto[]; resuelto: boolean }>();
    for (const fila of cruce.extracto) {
      if (fila.estado !== "bloque_diferencia" || !fila.bloque) continue;
      const key = fila.bloque.proveedor;
      if (!map.has(key)) map.set(key, { bloque: fila.bloque, filas: [], resuelto: true });
      map.get(key)!.filas.push(fila);
    }
    // Agregar sueltos asignados a proveedor via "Pertenece a proveedor":
    // aparecen inmediatamente en la sección "agrupado por proveedor".
    const provNames = new Map(proveedoresList.map(p => [p.id, p.nombre]));
    const virtualBloques = new Map<string, { provId: number; provNombre: string; filas: FilaExtracto[] }>();
    for (const fila of cruce.extracto) {
      if (fila.estado !== "rojo_falta") continue;
      const r = resueltos[`ext:${fila.idx}`];
      if (!r || !r.startsWith("prov:")) continue;
      const provId = Number(r.slice("prov:".length));
      const provNombre = provNames.get(provId) ?? `Proveedor #${provId}`;
      if (!virtualBloques.has(provNombre)) virtualBloques.set(provNombre, { provId, provNombre, filas: [] });
      virtualBloques.get(provNombre)!.filas.push(fila);
    }
    for (const [key, vb] of virtualBloques) {
      // Buscar sobrantes (pagos cargados en PASE) que pertenecen a este
      // proveedor — sin esto aparecían como "Sobran en PASE" en vez de
      // cruzarse contra las transferencias del extracto.
      const matchingSobrantes = cruce.sobrantes.filter(s =>
        s.prov_id === vb.provId && !s.bloque_prov
      );
      const movs: MovEnCombinacion[] = matchingSobrantes.map(s => ({
        id: s.id, fecha: s.fecha, importe: s.importe, detalle: s.detalle,
      }));
      const sumaPase = matchingSobrantes.reduce((s, m) => s + m.importe, 0);
      const sumaExt = vb.filas.reduce((s, f) => s + f.monto, 0);
      if (map.has(key)) {
        const entry = map.get(key)!;
        for (const f of vb.filas) entry.filas.push(f);
        // Also add matching sobrantes to existing bloque
        for (const m of movs) entry.bloque.movs.push(m);
        entry.bloque.n_pagos += matchingSobrantes.length;
        entry.bloque.suma_pase = (Number(entry.bloque.suma_pase) || 0) + sumaPase;
        entry.bloque.suma_extracto += sumaExt;
        entry.bloque.n_transferencias += vb.filas.length;
        entry.bloque.dif = entry.bloque.suma_extracto - entry.bloque.suma_pase;
      } else {
        map.set(key, {
          bloque: {
            proveedor: vb.provNombre,
            n_transferencias: vb.filas.length,
            suma_extracto: sumaExt,
            n_pagos: matchingSobrantes.length,
            suma_pase: sumaPase,
            dif: sumaExt - sumaPase,
            movs,
          },
          filas: vb.filas,
          resuelto: false,
        });
      }
    }
    for (const v of map.values()) {
      v.resuelto = v.filas.every(f => {
        const r = resueltos[`ext:${f.idx}`];
        return !!r && !r.startsWith("prov:");
      });
    }
    return [...map.values()];
  }, [cruce, resueltos, proveedoresList]);

  // ─── EARLY RETURN: tiene que ir DESPUÉS de TODOS los hooks ──────────────
  // React error #310 si los hooks se ejecutan en distinto orden entre
  // renders. Por eso este return va acá y no arriba del componente.
  if (localActivo == null) {
    return (
      <PageContainer>
        <PageHeader title="Conciliación · extracto MP" />
        <EmptyState
          icon="🏪"
          title="Elegí una sucursal"
          description="La conciliación de extracto MP se hace local por local. Elegí la sucursal en el selector del sidebar y volvé."
        />
      </PageContainer>
    );
  }

  // ─── Cerrar conciliación ─────────────────────────────────────────────────
  // Junta los movimientos que quedaron conciliados en esta sesión (verdes
  // automáticos, amarillos resueltos, combos, bloques, creados y pagados)
  // y los marca con el "tag invisible" via fn_cerrar_conciliacion. A partir
  // de ahí no vuelven a aparecer en cruces futuros.
  async function cerrarConciliacion() {
    if (!cruce || !stats) return;
    if (stats.total_pendientes > 0) {
      const ok = confirm(`Quedan ${stats.total_pendientes} casos sin resolver. ¿Cerrar igual?`);
      if (!ok) return;
    }
    setSavingAccion(true);
    try {
      // 1. Recolectar movs conciliados + estado final por fila del extracto
      const movIds = new Set<string>(movsSesionRef.current);
      const items: Array<{
        fecha: string; monto: number; descripcion: string;
        referencia_externa: string | null; estado_final: string; mov_ids: string[];
        prov_id?: number; // Lucas 10-jun: para aprender alias cuando se asignó manual
      }> = [];

      for (const fila of cruce.extracto) {
        const r = resueltos[`ext:${fila.idx}`];
        const filaMovs: string[] = [];
        let estadoFinal: string = fila.estado;
        let provAsignado: number | undefined = undefined;

        if (r === "ignorar") estadoFinal = "ignorada";
        else if (r === "creado") estadoFinal = "creado";
        else if (r === "pagada") estadoFinal = "pagada";
        else if (r && r.startsWith("matcheado:")) {
          estadoFinal = "matcheado";
          filaMovs.push(r.slice("matcheado:".length));
        } else if (r && r.startsWith("combo:")) {
          estadoFinal = "combo";
          const combo = fila.combinaciones[Number(r.slice("combo:".length))];
          combo?.movs.forEach(m => filaMovs.push(m.id));
        } else if (r && r.startsWith("prov:")) {
          // Lucas 10-jun — "Pertenece a proveedor X". La fila queda como
          // "asignada_prov" y al cerrar el server aprende el alias.
          estadoFinal = "asignada_prov";
          provAsignado = Number(r.slice("prov:".length));
        } else if (fila.estado === "verde" && fila.candidatos.length === 1) {
          filaMovs.push(fila.candidatos[0]!.id);
        } else if (fila.estado === "verde_agrupado" && fila.combinaciones.length === 1) {
          fila.combinaciones[0]!.movs.forEach(m => filaMovs.push(m.id));
        } else if ((fila.estado === "verde_bloque" || fila.estado === "bloque_diferencia") && fila.bloque) {
          // Bloques (verdes Y con diferencia): los pagos del bloque
          // pertenecen a las transferencias del mes — quedan conciliados.
          (fila.bloque.movs ?? []).forEach(m => filaMovs.push(m.id));
        }
        filaMovs.forEach(id => movIds.add(id));
        items.push({
          fecha: fila.fecha,
          monto: fila.monto,
          descripcion: fila.descripcion,
          referencia_externa: fila.referencia_externa,
          estado_final: estadoFinal,
          mov_ids: filaMovs,
          ...(provAsignado ? { prov_id: provAsignado } : {}),
        });
      }

      // 2. Cerrar atómicamente: corrida + tag en movimientos + items
      const { data, error } = await db.rpc("fn_cerrar_conciliacion", {
        p_local_id: localActivo,
        p_periodo_desde: periodoDesde,
        p_periodo_hasta: periodoHasta,
        p_archivo_nombre: archivoNombre,
        p_totales: {
          total_movs: cruce.totales.extracto_total,
          verdes: cruce.totales.verdes,
          amarillos: cruce.totales.amarillos,
          rojos_falta: cruce.totales.rojos_falta,
          rojos_sobra: cruce.totales.rojos_sobra,
        },
        p_saldo_inicial: resumenExtracto?.initial_balance ?? null,
        p_saldo_final: resumenExtracto?.final_balance ?? null,
        p_movs_conciliados: [...movIds],
        p_items: items,
      });
      if (error) { showError(translateRpcError(error)); return; }
      setCorridaCerrada(data as { id: string; created_at: string });
      limpiarBorrador(); // la corrida quedó persistida en DB — borrar borrador local
      showToast("Conciliación cerrada — los movimientos quedaron marcados como conciliados");
    } finally {
      setSavingAccion(false);
    }
  }

  function resetearTodo() {
    setExtractoMovs([]);
    setResumenExtracto(null);
    setCruce(null);
    setResueltos({});
    setArchivoNombre("");
    setPeriodoDesde("");
    setPeriodoHasta("");
    setCorridaCerrada(null);
    limpiarBorrador();
  }

  // ─── RENDER ──────────────────────────────────────────────────────────────
  return (
    <PageContainer>
      <PageHeader title={`Conciliación · MercadoPago · ${localNombre}`} />

      {toast && <ToastComponent toast={toast} />}

      {/* Historial de conciliaciones cerradas (visible siempre que no
          estés en pleno proceso de cruce). Sirve para ver qué meses
          ya cerraste y si hay gaps. */}
      {!cruce && (
        <Historial
          corridas={historial}
          loading={historialLoading}
          localNombre={localNombre}
        />
      )}

      {/* PASO 1: Cargar archivo */}
      {!extractoMovs.length && (
        <Card>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>Subí el extracto mensual de MercadoPago</h3>
          <p style={{ color: "var(--muted2)", fontSize: 13, lineHeight: 1.5 }}>
            En el panel de MP → Actividad → "Crear reporte" → Pesos → Período (mes completo).
            Te llega por mail un archivo <strong>.xlsx</strong> o <strong>.csv</strong>. Subilo acá.
          </p>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) void onArchivoSeleccionado(f);
            }}
            disabled={parsing}
            style={{ fontSize: 14, marginTop: 8 }}
          />
          {parsing && <div style={{ marginTop: 8, color: "var(--muted2)" }}>Leyendo archivo…</div>}
        </Card>
      )}

      {/* PASO 2: Resumen del extracto cargado, listo para cruzar */}
      {extractoMovs.length > 0 && !cruce && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, color: "var(--muted2)" }}>📄 {archivoNombre}</div>
              <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>
                {egresosExtracto.length} egresos a conciliar
              </div>
              <div style={{ fontSize: 12, color: "var(--muted2)", marginTop: 2 }}>
                ({extractoMovs.length - egresosExtracto.length} ingresos del extracto se ignoran — vienen por otra vía)
              </div>
              <div style={{ fontSize: 13, color: "var(--muted2)", marginTop: 6 }}>
                Período: {fmt_d(periodoDesde)} → {fmt_d(periodoHasta)}
              </div>
              {resumenExtracto && (
                <div style={{ fontSize: 12, color: "var(--muted2)", marginTop: 6 }}>
                  Saldo inicial: {fmt_$(resumenExtracto.initial_balance)} · Saldo final: {fmt_$(resumenExtracto.final_balance)}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost" onClick={resetearTodo}>Cancelar</button>
              <button className="btn btn-acc" onClick={cruzar} disabled={cruzando || egresosExtracto.length === 0}>
                {cruzando ? "Cruzando…" : "Cruzar con PASE →"}
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* PASO 3: Resultado del cruce con semáforo */}
      {cruce && stats && (
        <>
          {/* KPIs arriba */}
          <Card>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 10 }}>
              <Kpi label="Total" value={cruce.totales.extracto_total.toString()} color="var(--muted2)" />
              <Kpi label="🟢 Match" value={(stats.verdes + stats.verdesAgrupados + stats.verdesBloque).toString()} color="var(--success)" />
              <Kpi label="🟡 Por elegir" value={(stats.amarillos + stats.amarillosAgrupados).toString()} color="var(--warn)" />
              <Kpi label="🟠 Dif. proveedor" value={stats.bloquesDif.toString()} color="#f97316" />
              <Kpi label="🔵 Sin marcar pag." value={stats.facturasSinPagar.toString()} color="#3b82f6" />
              <Kpi label="🔴 Faltan" value={stats.rojos_falta.toString()} color="var(--danger)" />
              <Kpi label="🔴 Sobran" value={stats.rojos_sobra.toString()} color="var(--danger)" />
            </div>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 13, color: "var(--muted2)" }}>
                {stats.resueltos_count > 0 && <>✓ {stats.resueltos_count} resueltos · </>}
                <strong>{stats.total_pendientes}</strong> casos pendientes
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-ghost" onClick={resetearTodo}>Cancelar todo</button>
                <button className="btn btn-outline" onClick={refrescarCruce} disabled={cruzando}>
                  {cruzando ? "Actualizando…" : "↻ Refrescar"}
                </button>
                <button
                  className="btn btn-acc"
                  onClick={cerrarConciliacion}
                  disabled={savingAccion || !!corridaCerrada}
                >
                  {corridaCerrada ? "✓ Conciliación cerrada" : "Cerrar conciliación →"}
                </button>
              </div>
            </div>
            {corridaCerrada && (
              <div style={{
                marginTop: 10, padding: "8px 12px",
                background: "rgba(34,197,94,0.08)", color: "var(--success)",
                borderRadius: 6, fontSize: 13,
              }}>
                ✓ Quedó registrada la conciliación del {fmt_d(periodoDesde.slice(0, 10))} al {fmt_d(periodoHasta.slice(0, 10))}.
              </div>
            )}
          </Card>

          {/* BLOQUES POR PROVEEDOR CON DIFERENCIA — lo más accionable.
              Las transferencias y los pagos en PASE no se pueden aparear
              1-a-1 (Anto carga en tandas), pero la DIFERENCIA de totales
              dice exactamente cuánta plata falta (o sobra) cargar.
              Lucas 10-jun: unificado visualmente con "sueltos" abajo. */}
          {bloquesPorProveedor.length > 0 && (
            <Card>
              <h4 style={{ marginTop: 0, fontSize: 14 }}>
                🟠 Falta cargar en PASE · <span style={{ color: "var(--muted2)" }}>agrupado por proveedor</span> <span style={{ color: "var(--muted2)" }}>({bloquesPorProveedor.length})</span>
              </h4>
              <p style={{ color: "var(--muted2)", fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>
                El sistema encontró pagos cargados en PASE para estos proveedores y los agrupó con
                las transferencias del extracto. Lo que importa: la <strong>diferencia del total</strong>.
                Si es negativa, faltan cargar pagos en PASE. Si es positiva, hay pagos cargados que
                corresponden a transferencias de otro mes. <em>Abajo (🔴 sueltos) están las transferencias
                que no se pudieron agrupar con ningún proveedor.</em>
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {bloquesPorProveedor.map(({ bloque, filas, resuelto }) => (
                  <div key={bloque.proveedor} style={{
                    padding: 12,
                    background: resuelto ? "rgba(34,197,94,0.08)" : "rgba(249,115,22,0.06)",
                    border: resuelto ? "1px solid rgba(34,197,94,0.35)" : "1px solid rgba(249,115,22,0.25)",
                    borderRadius: 6,
                    opacity: resuelto ? 0.85 : 1,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                      <strong style={{ fontSize: 13 }}>
                        {resuelto && <span style={{ color: "var(--success)", marginRight: 6 }}>✓</span>}
                        {bloque.proveedor}
                      </strong>
                      <span style={{
                        fontSize: 13, fontWeight: 600, fontVariantNumeric: "tabular-nums",
                        color: Number(bloque.dif) < 0 ? "var(--danger)" : "var(--warn)",
                      }}>
                        {Number(bloque.dif) < 0
                          ? `Faltan cargar ${fmt_$(Math.abs(Number(bloque.dif)))} en PASE`
                          : `Hay ${fmt_$(Number(bloque.dif))} cargados de más (¿mes anterior?)`}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
                      Extracto: {fmt_$(Number(bloque.suma_extracto))} en {bloque.n_transferencias} transferencia{bloque.n_transferencias === 1 ? "" : "s"}
                      {" · "}PASE: {fmt_$(Number(bloque.suma_pase ?? 0))} en {bloque.n_pagos} pago{bloque.n_pagos === 1 ? "" : "s"}
                    </div>
                    <details style={{ marginTop: 6 }}>
                      <summary style={{ cursor: "pointer", fontSize: 11, color: "var(--muted2)" }}>
                        Ver detalle ({filas.length} transferencias + {bloque.movs?.length ?? 0} pagos)
                      </summary>
                      <div style={{ marginTop: 6, fontSize: 11 }}>
                        <div style={{ color: "var(--muted2)", marginBottom: 2 }}>Transferencias del extracto:</div>
                        {filas.map(f => (
                          <div key={f.idx} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0 2px 12px" }}>
                            <span>{fmt_d(f.fecha)} · {f.descripcion.slice(0, 50)}</span>
                            <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(f.monto)}</span>
                          </div>
                        ))}
                        <div style={{ color: "var(--muted2)", margin: "6px 0 2px" }}>Pagos cargados en PASE:</div>
                        {(bloque.movs ?? []).map(m => (
                          <div key={m.id} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0 2px 12px" }}>
                            <span>{fmt_d(m.fecha)} · {(m.detalle ?? "").slice(0, 50)}</span>
                            <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(m.importe)}</span>
                          </div>
                        ))}
                        {/* Facturas pendientes del proveedor — la pista para
                            cerrar la diferencia (caso "no la marcaron como
                            pagada"). Botón paga con cuenta MP + fecha de la
                            última transferencia del bloque. */}
                        {(bloque.facturas_pendientes ?? []).length > 0 && (
                          <>
                            <div style={{ color: "#3b82f6", margin: "8px 0 2px", fontWeight: 600 }}>
                              💡 Facturas de este proveedor SIN marcar como pagadas:
                            </div>
                            {(bloque.facturas_pendientes ?? []).map(p => (
                              <div key={p.id} style={{
                                display: "flex", justifyContent: "space-between", alignItems: "center",
                                gap: 8, padding: "3px 0 3px 12px",
                              }}>
                                <span>{fmt_d(p.fecha)} · {p.tipo} {p.nro ?? p.id}</span>
                                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(-Math.abs(Number(p.total)))}</span>
                                  <button
                                    className="btn btn-acc btn-sm"
                                    style={{ padding: "2px 8px", fontSize: 10 }}
                                    disabled={savingAccion}
                                    onClick={() => void pagarPendienteDeBloque(filas, p)}
                                  >
                                    Marcar pagada
                                  </button>
                                </span>
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    </details>
                    <div style={{ marginTop: 8 }}>
                      {/* Lucas 10-jun: "si toco marcar como bloque revisado
                          desaparece". Ahora el bloque queda visible con check
                          verde y este botón pasa a "Deshacer" para revertir. */}
                      {!resuelto ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setResueltos(p => {
                              const next = { ...p };
                              for (const f of filas) next[`ext:${f.idx}`] = "ignorar";
                              return next;
                            });
                          }}
                        >
                          Marcar bloque como revisado
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: "var(--muted2)" }}
                          onClick={() => {
                            setResueltos(p => {
                              const next = { ...p };
                              for (const f of filas) delete next[`ext:${f.idx}`];
                              return next;
                            });
                          }}
                        >
                          ↺ Deshacer revisado
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* ROJOS — sueltos sin agrupar. Inmediatamente después de los
              bloques porque son la misma información conceptual (faltan en
              PASE), solo que estos no se pudieron asociar con proveedor.
              Lucas 10-jun: "deberia estar todo junto y al principio los que
              son agrupados por proveedor y abajo los sueltos". */}
          {(() => {
            const filasRojas = cruce.extracto.filter(f =>
              f.estado === "rojo_falta" && !resueltos[`ext:${f.idx}`]
            );
            if (filasRojas.length === 0) return null;
            const numSel = filasRojas.filter(f => seleccionados.has(f.idx)).length;
            const sumaSel = filasRojas.filter(f => seleccionados.has(f.idx)).reduce((s, f) => s + f.monto, 0);
            return (
              <Card>
                <h4 style={{ marginTop: 0, fontSize: 14 }}>
                  🔴 Falta cargar en PASE · <span style={{ color: "var(--muted2)" }}>sueltos sin agrupar</span> <span style={{ color: "var(--muted2)" }}>({filasRojas.length})</span>
                </h4>
                <p style={{ color: "var(--muted2)", fontSize: 12, lineHeight: 1.5, marginBottom: 10 }}>
                  Son transferencias del extracto que no se pudieron asociar con ningún proveedor
                  (porque el proveedor no existe en PASE, no hay pagos cargados para él, o el sistema
                  no reconoció el nombre del titular MP). Tildalas para crear varias juntas, asignalas
                  a un proveedor existente para que se aprenda, o ignoralas si no aplican.
                </p>
                <div style={{
                  display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
                  padding: "8px 10px", background: "var(--s2)", borderRadius: 6, marginBottom: 10,
                }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      const todos = new Set(filasRojas.map(f => f.idx));
                      setSeleccionados(numSel === filasRojas.length ? new Set() : todos);
                    }}
                  >
                    {numSel === filasRojas.length ? "Destildar todos" : "Tildar todos"}
                  </button>
                  <span style={{ fontSize: 12, color: "var(--muted2)" }}>
                    {numSel > 0 ? <>{numSel} seleccionados · {fmt_$(sumaSel)}</> : "Nada seleccionado"}
                  </span>
                  <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={numSel === 0 || savingAccion}
                      onClick={() => {
                        setResueltos(p => {
                          const next = { ...p };
                          for (const f of filasRojas) if (seleccionados.has(f.idx)) next[`ext:${f.idx}`] = "ignorar";
                          return next;
                        });
                        setSeleccionados(new Set());
                      }}
                    >
                      Ignorar seleccionados
                    </button>
                    <button
                      className="btn btn-acc btn-sm"
                      disabled={numSel === 0 || savingAccion}
                      onClick={() => setConfirmarLote(true)}
                    >
                      {progresoLote ?? `Crear ${numSel > 0 ? numSel : ""} en Caja →`}
                    </button>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {filasRojas.map(fila => {
                    const r = resueltos[`ext:${fila.idx}`];
                    const resuelta = !!r;
                    let resumen = "";
                    if (r === "ignorar") resumen = "Ignorada";
                    else if (r === "creado") resumen = "Creada en Caja";
                    else if (r === "pagada") resumen = "Marcada como pagada";
                    else if (r && r.startsWith("prov:")) {
                      const pid = Number(r.slice(5));
                      const p = proveedoresList.find(x => x.id === pid);
                      resumen = `Asignada a ${p?.nombre ?? `proveedor #${pid}`} (se aprenderá al cerrar)`;
                    } else if (r) resumen = "Resuelta";
                    return (
                    <div key={fila.idx} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                      <input
                        type="checkbox"
                        checked={seleccionados.has(fila.idx)}
                        onChange={() => toggleSeleccion(fila.idx)}
                        disabled={resuelta}
                        style={{ marginTop: 14, width: 16, height: 16, cursor: resuelta ? "default" : "pointer" }}
                      />
                      <div style={{ flex: 1 }}>
                        <FilaCard
                          fecha={fila.fecha}
                          monto={fila.monto}
                          descripcion={fila.descripcion}
                          resuelta={resuelta}
                        >
                          {resuelta ? (
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <span style={{ color: "var(--success)", fontSize: 12 }}>✓ {resumen}</span>
                              <button className="btn btn-ghost btn-sm" style={{ color: "var(--muted2)" }} onClick={() => deshacerResolucion(fila.idx)}>
                                ↺ Deshacer
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button className="btn btn-acc btn-sm" onClick={() => setCrearFaltante(fila)}>
                                Crear en Caja
                              </button>
                              <button
                                className="btn btn-ghost btn-sm"
                                style={{ color: "var(--acc)" }}
                                onClick={() => { setAsignarProvFila(fila); setBusquedaProv(""); }}
                              >
                                Pertenece a proveedor…
                              </button>
                              <button className="btn btn-ghost btn-sm" onClick={() => ignorarExtracto(fila.idx)}>
                                Ignorar
                              </button>
                            </div>
                          )}
                        </FilaCard>
                      </div>
                    </div>
                    );
                  })}
                </div>
              </Card>
            );
          })()}

          {/* AMARILLOS — múltiples candidatos.
              Lucas 10-jun: "si toco marcar como bloque revisado desaparece,
              lo mismo con elegir entre varios candidatos". Ahora las filas
              resueltas se quedan visibles con borde verde + check + botón
              "Deshacer" — así si te equivocaste podés volver atrás. */}
          <SeccionFilas
            titulo="🟡 Por elegir (varios candidatos)"
            descripcion="El extracto tiene un mov con monto X y en PASE hay varios con ese mismo monto en la ventana ±15d. Elegí cuál es el que corresponde."
            filas={cruce.extracto.filter(f => f.estado === "amarillo")}
            renderFila={fila => {
              const r = resueltos[`ext:${fila.idx}`];
              const resuelta = !!r;
              const resumen =
                r === "ignorar" ? "Ignorada"
                : r && r.startsWith("matcheado:") ? `Matcheada con mov ${r.slice("matcheado:".length).slice(0, 8)}…`
                : "Resuelta";
              return (
                <FilaCard
                  key={fila.idx}
                  fecha={fila.fecha}
                  monto={fila.monto}
                  descripcion={fila.descripcion}
                  resuelta={resuelta}
                >
                  {resuelta ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ color: "var(--success)", fontSize: 12 }}>✓ {resumen}</span>
                      <button className="btn btn-ghost btn-sm" style={{ color: "var(--muted2)" }} onClick={() => deshacerResolucion(fila.idx)}>
                        ↺ Deshacer
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="btn btn-acc btn-sm" onClick={() => setPickCandidato(fila)}>
                        Elegir cuál es ({fila.num_candidatos} candidatos)
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => ignorarExtracto(fila.idx)}>
                        Ignorar
                      </button>
                    </div>
                  )}
                </FilaCard>
              );
            }}
          />

          {/* AMARILLOS AGRUPADOS — varias combinaciones que suman exacto */}
          <SeccionFilas
            titulo="🟡 Combos posibles (varias combinaciones de facturas suman este monto)"
            descripcion="El extracto tiene 1 transferencia y en PASE hay varias combinaciones de 2-5 facturas del mismo proveedor en ±30d que suman exacto. Elegí cuál es la correcta."
            filas={cruce.extracto.filter(f => f.estado === "amarillo_agrupado")}
            renderFila={fila => {
              const r = resueltos[`ext:${fila.idx}`];
              const resuelta = !!r;
              const resumen =
                r === "ignorar" ? "Ignorada"
                : r && r.startsWith("combo:") ? `Combo ${Number(r.slice("combo:".length)) + 1} elegido`
                : "Resuelta";
              return (
                <FilaCard
                  key={fila.idx}
                  fecha={fila.fecha}
                  monto={fila.monto}
                  descripcion={fila.descripcion}
                  resuelta={resuelta}
                >
                  {resuelta ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ color: "var(--success)", fontSize: 12 }}>✓ {resumen}</span>
                      <button className="btn btn-ghost btn-sm" style={{ color: "var(--muted2)" }} onClick={() => deshacerResolucion(fila.idx)}>
                        ↺ Deshacer
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="btn btn-acc btn-sm" onClick={() => setPickCombinacion(fila)}>
                        Elegir combo ({fila.combinaciones.length} opciones)
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => ignorarExtracto(fila.idx)}>
                        Ignorar
                      </button>
                    </div>
                  )}
                </FilaCard>
              );
            }}
          />

          {/* Transferencias ya conciliadas en cierres anteriores (tag invisible).
              Informativo — pasa cuando se re-sube un archivo ya procesado o
              un extracto que pisa un período ya cerrado. */}
          {cruce.extracto.some(f => f.estado === "ya_conciliada") && (
            <Card>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--muted2)" }}>
                  ✓ {cruce.extracto.filter(f => f.estado === "ya_conciliada").length} transferencias
                  ya conciliadas en cierres anteriores (no requieren acción)
                </summary>
                <div style={{ marginTop: 8, maxHeight: 280, overflowY: "auto", fontSize: 12 }}>
                  {cruce.extracto.filter(f => f.estado === "ya_conciliada").map(f => (
                    <div key={f.idx} style={{
                      display: "flex", justifyContent: "space-between",
                      padding: "5px 0", borderBottom: "1px solid var(--bd)", opacity: 0.7,
                    }}>
                      <span>{fmt_d(f.fecha)} · {f.descripcion.slice(0, 55)}</span>
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(f.monto)}</span>
                    </div>
                  ))}
                </div>
              </details>
            </Card>
          )}

          {/* 🔵 FACTURAS CARGADAS PERO SIN MARCAR COMO PAGADAS */}
          <SeccionFilas
            titulo="🔵 Facturas cargadas pero sin marcar como pagadas"
            descripcion="La transferencia salió de MP y la factura está en PASE, pero nadie tocó Pagar. Marcala como pagada acá mismo: se registra con cuenta MercadoPago y la fecha real de la transferencia."
            filas={cruce.extracto.filter(f =>
              f.estado === "factura_sin_pagar" && !resueltos[`ext:${f.idx}`]
            )}
            renderFila={fila => (
              <FilaCard
                key={fila.idx}
                fecha={fila.fecha}
                monto={fila.monto}
                descripcion={fila.descripcion}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(fila.facturas_pendientes ?? []).map((cand, ci) => (
                    <div key={ci} style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      gap: 8, flexWrap: "wrap", padding: "6px 8px",
                      background: "rgba(59,130,246,0.07)", borderRadius: 4, fontSize: 12,
                    }}>
                      <span>
                        {cand.tipo === "tanda"
                          ? <><strong>{cand.proveedor}</strong> · {cand.n} facturas pendientes suman {fmt_$(Number(cand.total_suma))} {Number(cand.dif) > 0.01 && <em>(dif {fmt_$(Number(cand.dif))})</em>}</>
                          : <><strong>{cand.proveedor ?? "—"}</strong> · {cand.tipo} {cand.nro ?? cand.id} · {cand.fecha ? fmt_d(cand.fecha) : ""} · {fmt_$(Number(cand.total))} {Number(cand.dif) > 0.01 && <em>(dif {fmt_$(Number(cand.dif))})</em>}</>}
                      </span>
                      <button
                        className="btn btn-acc btn-sm"
                        disabled={savingAccion}
                        onClick={() => void marcarFacturaPagada(fila, cand)}
                      >
                        {cand.tipo === "tanda" ? `Marcar las ${cand.n} como pagadas` : "Marcar como pagada"}
                      </button>
                    </div>
                  ))}
                  <div>
                    <button className="btn btn-ghost btn-sm" onClick={() => ignorarExtracto(fila.idx)}>
                      No es ninguna de estas — ignorar
                    </button>
                  </div>
                </div>
              </FilaCard>
            )}
          />

          {/* Sobrantes que pertenecen a un bloque — colapsados, informativos.
              NO se deben anular: están explicados por el bloque naranja. */}
          {cruce.sobrantes.some(s => s.bloque_prov && !resueltos[`sob:${s.id}`]) && (
            <Card>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--muted2)" }}>
                  🟠 {cruce.sobrantes.filter(s => s.bloque_prov && !resueltos[`sob:${s.id}`]).length} pagos
                  cargados que pertenecen a bloques de proveedor (no anular — ver Diferencias por proveedor)
                </summary>
                <div style={{ marginTop: 8, maxHeight: 280, overflowY: "auto", fontSize: 12 }}>
                  {cruce.sobrantes.filter(s => s.bloque_prov && !resueltos[`sob:${s.id}`]).map(s => (
                    <div key={s.id} style={{
                      display: "flex", justifyContent: "space-between",
                      padding: "5px 0", borderBottom: "1px solid var(--bd)",
                    }}>
                      <span>{fmt_d(s.fecha)} · {(s.detalle ?? "").slice(0, 55)} <em style={{ color: "var(--muted2)" }}>[{s.bloque_prov}]</em></span>
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(s.importe)}</span>
                    </div>
                  ))}
                </div>
              </details>
            </Card>
          )}

          {/* ROJOS — sobra en PASE (excluye los que están en bloques y los
              que el usuario ya consumió como match de una fila amarilla) */}
          <SeccionFilas
            titulo="🔴 Sobran en PASE (cargaste pero no están en el extracto)"
            descripcion="Probablemente un error humano: alguien cargó un mov MP que en realidad no entró. Tocá Anular y queda invalidado (con motivo)."
            filas={cruce.sobrantes.filter(s =>
              !resueltos[`sob:${s.id}`]
              && !s.bloque_prov
              && !movsUsadosResueltos.has(s.id)
            )}
            renderFila={(sob) => (
              <FilaCard
                key={sob.id}
                fecha={sob.fecha}
                monto={sob.importe}
                descripcion={(sob.detalle || "(sin detalle)") + (sob.bloque_prov ? ` 🟠 [parte del bloque ${sob.bloque_prov} — ver Diferencias por proveedor]` : "")}
              >
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    className="btn btn-sec btn-sm"
                    style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
                    onClick={() => { setAnularSobrante(sob); setMotivoAnular(""); }}
                  >
                    Anular
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => ignorarSobrante(sob.id)}>
                    Ignorar (es de otro mes / lo dejo)
                  </button>
                </div>
              </FilaCard>
            )}
          />

          {/* VERDES — match automático, solo informativo */}
          {stats.verdes > 0 && (
            <Card>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 14, color: "var(--muted2)" }}>
                  🟢 Ver los {stats.verdes} movimientos que coinciden OK (no requieren acción)
                </summary>
                <div style={{ marginTop: 10, maxHeight: 300, overflowY: "auto" }}>
                  {cruce.extracto.filter(f => f.estado === "verde").map(fila => (
                    <div key={fila.idx} style={{
                      padding: "6px 0", borderBottom: "1px solid var(--bd)",
                      fontSize: 12, display: "flex", justifyContent: "space-between",
                    }}>
                      <span>{fmt_d(fila.fecha)} · {fila.descripcion}</span>
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(fila.monto)}</span>
                    </div>
                  ))}
                </div>
              </details>
            </Card>
          )}

          {/* VERDES AGRUPADOS — combinación única, solo informativo */}
          {stats.verdesAgrupados > 0 && (
            <Card>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 14, color: "var(--muted2)" }}>
                  🟢 Ver los {stats.verdesAgrupados} movimientos agrupados que coinciden OK
                  <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.8 }}>
                    (1 transferencia = N facturas del mismo proveedor en ±30d)
                  </span>
                </summary>
                <div style={{ marginTop: 10, maxHeight: 400, overflowY: "auto" }}>
                  {cruce.extracto.filter(f => f.estado === "verde_agrupado").map(fila => {
                    const combo = fila.combinaciones[0]!;
                    return (
                      <div key={fila.idx} style={{
                        padding: "8px 0", borderBottom: "1px solid var(--bd)", fontSize: 12,
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span><strong>{fmt_d(fila.fecha)}</strong> · {fila.descripcion}</span>
                          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{fmt_$(fila.monto)}</span>
                        </div>
                        <div style={{ marginTop: 4, paddingLeft: 12, color: "var(--muted2)" }}>
                          ↳ {combo.proveedor ?? "—"} · {combo.num_movs} facturas:
                          {combo.movs.map((m, i) => (
                            <span key={m.id} style={{ marginLeft: 8 }}>
                              {fmt_d(m.fecha)} {fmt_$(m.importe)}{i < combo.movs.length - 1 ? " +" : ""}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>
            </Card>
          )}

          {/* TODO RESUELTO — mensaje feliz */}
          {stats.total_pendientes === 0 && !corridaCerrada && (
            <Card>
              <div style={{ textAlign: "center", padding: "20px 0" }}>
                <div style={{ fontSize: 36 }}>✅</div>
                <div style={{ fontSize: 16, marginTop: 8 }}>
                  No queda nada pendiente. Tocá <strong>Cerrar conciliación</strong> arriba para registrarla.
                </div>
              </div>
            </Card>
          )}
        </>
      )}

      {/* Modal: elegir candidato (para amarillos) */}
      {pickCandidato && (
        <Modal isOpen={true} onClose={() => setPickCandidato(null)} title="Elegí el movimiento que corresponde">
          <div style={{ marginBottom: 10, fontSize: 13 }}>
            Extracto: <strong>{fmt_d(pickCandidato.fecha)}</strong> · {fmt_$(pickCandidato.monto)} · {pickCandidato.descripcion}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {pickCandidato.candidatos.map(c => (
              <button
                key={c.id}
                className="btn btn-ghost"
                onClick={() => { elegirCandidato(pickCandidato.idx, c.id); setPickCandidato(null); }}
                style={{ textAlign: "left", padding: "10px 12px" }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span><strong>{fmt_d(c.fecha)}</strong> · {c.detalle || "(sin detalle)"}</span>
                  <span>{fmt_$(c.importe)}</span>
                </div>
                <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
                  Diferencia: {c.dias_diff} día{c.dias_diff === 1 ? "" : "s"}
                  {c.ya_conciliado && " · ⚠ ya conciliado antes"}
                </div>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {/* Modal: elegir combinación agrupada (para amarillos_agrupados) */}
      {pickCombinacion && (
        <Modal isOpen={true} onClose={() => setPickCombinacion(null)} title="Elegí qué facturas se pagaron juntas">
          <div style={{ marginBottom: 10, fontSize: 13 }}>
            Extracto: <strong>{fmt_d(pickCombinacion.fecha)}</strong> · {fmt_$(pickCombinacion.monto)} · {pickCombinacion.descripcion}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {pickCombinacion.combinaciones.map((combo, idx) => (
              <button
                key={idx}
                className="btn btn-ghost"
                onClick={() => { elegirCombinacion(pickCombinacion.idx, idx); setPickCombinacion(null); }}
                style={{ textAlign: "left", padding: "12px 14px", display: "block" }}
              >
                <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 6 }}>
                  Opción {idx + 1}: <strong style={{ color: "var(--text)" }}>{combo.proveedor ?? "—"}</strong> · {combo.num_movs} facturas
                </div>
                {combo.movs.map(m => (
                  <div key={m.id} style={{
                    display: "flex", justifyContent: "space-between",
                    padding: "3px 0", fontSize: 12,
                  }}>
                    <span>{fmt_d(m.fecha)} · {m.detalle || "(sin detalle)"}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(m.importe)}</span>
                  </div>
                ))}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {/* Modal: asignar fila roja a un proveedor (Lucas 10-jun, interfaz
          de aprendizaje). Al elegir, la fila queda marcada y al cerrar
          la conciliación se aprende el alias titular→proveedor para que
          la próxima vez vaya directo al bloque de ese proveedor. */}
      {asignarProvFila && (
        <Modal
          isOpen={true}
          onClose={() => { setAsignarProvFila(null); setBusquedaProv(""); }}
          title="¿De qué proveedor es esta transferencia?"
          maxWidth={560}
        >
          <div style={{ fontSize: 13, marginBottom: 12, color: "var(--muted2)" }}>
            <strong style={{ color: "var(--text)" }}>{asignarProvFila.descripcion}</strong>
            <br />
            {fmt_d(asignarProvFila.fecha)} · {fmt_$(asignarProvFila.monto)}
          </div>
          <input
            autoFocus
            type="text"
            placeholder="Buscar proveedor por nombre…"
            value={busquedaProv}
            onChange={e => setBusquedaProv(e.target.value)}
            style={{
              width: "100%", padding: "8px 10px", fontSize: 13,
              background: "var(--bg)", border: "1px solid var(--bd)",
              color: "var(--text)", borderRadius: 6, marginBottom: 10,
            }}
          />
          <div style={{ maxHeight: 340, overflowY: "auto", border: "1px solid var(--bd)", borderRadius: 6 }}>
            {(() => {
              const q = busquedaProv.trim().toLowerCase();
              const filtrados = q.length === 0
                ? proveedoresList
                : proveedoresList.filter(p => p.nombre.toLowerCase().includes(q));
              if (filtrados.length === 0) {
                return <div style={{ padding: 14, fontSize: 12, color: "var(--muted2)" }}>Sin resultados. Probá con otra parte del nombre, o creá el proveedor en Compras → Proveedores y volvé.</div>;
              }
              return filtrados.map(p => (
                <button
                  key={p.id}
                  className="btn btn-ghost"
                  onClick={() => {
                    const desc = asignarProvFila.descripcion;
                    setResueltos(prev => {
                      const next = { ...prev, [`ext:${asignarProvFila.idx}`]: `prov:${p.id}` };
                      if (cruce) {
                        for (const f of cruce.extracto) {
                          if (f.idx !== asignarProvFila.idx && f.estado === "rojo_falta" && f.descripcion === desc && !prev[`ext:${f.idx}`]) {
                            next[`ext:${f.idx}`] = `prov:${p.id}`;
                          }
                        }
                      }
                      return next;
                    });
                    setAsignarProvFila(null);
                    setBusquedaProv("");
                  }}
                  style={{ width: "100%", textAlign: "left", padding: "8px 12px", borderRadius: 0, borderBottom: "1px solid var(--bd)" }}
                >
                  {p.nombre}
                </button>
              ));
            })()}
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted2)" }}>
            Al elegir, todas las transferencias con la misma descripción se asignan automáticamente al proveedor y aparecen arriba en "agrupado por proveedor".
          </div>
        </Modal>
      )}

      {/* Modal: confirmar creación en lote */}
      {confirmarLote && cruce && (
        <Modal isOpen={true} onClose={() => setConfirmarLote(false)} title="Crear movimientos en lote">
          {(() => {
            const filas = cruce.extracto.filter(f => seleccionados.has(f.idx) && !resueltos[`ext:${f.idx}`]);
            const suma = filas.reduce((s, f) => s + f.monto, 0);
            return (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                  Se van a crear <strong>{filas.length} movimientos</strong> en Caja con cuenta
                  <strong> MercadoPago</strong> de <strong>{localNombre}</strong>, por un total
                  de <strong>{fmt_$(suma)}</strong>.
                </div>
                <div style={{ marginTop: 10, maxHeight: 240, overflowY: "auto", fontSize: 11 }}>
                  {filas.map(f => (
                    <div key={f.idx} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid var(--bd)" }}>
                      <span>{fmt_d(f.fecha)} · {f.descripcion.slice(0, 45)}</span>
                      <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(f.monto)}</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                  <button className="btn btn-ghost" onClick={() => setConfirmarLote(false)} disabled={savingAccion}>Cancelar</button>
                  <button className="btn btn-acc" onClick={ejecutarCrearLote} disabled={savingAccion}>
                    {savingAccion ? (progresoLote ?? "Creando…") : `Confirmar crear ${filas.length}`}
                  </button>
                </div>
              </>
            );
          })()}
        </Modal>
      )}

      {/* Modal: confirmar crear faltante (con tipo + categoría obligatorios
          desde el 10-jun para que el mov NO quede en "Otros" sin clasificar) */}
      {crearFaltante && (() => {
        const esEgreso = crearFaltante.monto < 0;
        // Tipos sugeridos para egresos vs ingresos. Para egresos respetamos
        // los buckets del EERR (CMV / Fijos / Variables / Publicidad /
        // Comisiones / Impuestos) — los empleados eligen el que aplica.
        const tiposEgreso = ["Mercadería (CMV)","Gasto Fijo","Gasto Variable","Publicidad","Comisión","Impuesto","Retiro Socio","Otros"];
        const tiposIngreso = ["Ingreso Manual","Devolución","Otros"];
        const tipos = esEgreso ? tiposEgreso : tiposIngreso;
        // Categorías según el tipo elegido — restringe el dropdown para
        // que la categoría siempre matchee con el bucket EERR.
        let catsDisponibles: string[] = [];
        if (esEgreso) {
          if (crearTipo === "Mercadería (CMV)") catsDisponibles = CATEGORIAS_COMPRA;
          else if (crearTipo === "Gasto Fijo") catsDisponibles = GASTOS_FIJOS;
          else if (crearTipo === "Gasto Variable") catsDisponibles = GASTOS_VARIABLES;
          else if (crearTipo === "Publicidad") catsDisponibles = GASTOS_PUBLICIDAD;
          else if (crearTipo === "Comisión") catsDisponibles = COMISIONES_CATS;
          else if (crearTipo === "Impuesto") catsDisponibles = GASTOS_IMPUESTOS;
          else if (crearTipo === "Retiro Socio") catsDisponibles = ["RETIRO SOCIO"];
          else if (crearTipo === "Otros") catsDisponibles = ["OTROS"];
        } else {
          catsDisponibles = CATEGORIAS_INGRESO.length > 0 ? CATEGORIAS_INGRESO : ["OTROS"];
        }
        return (
        <Modal isOpen={true} onClose={() => { setCrearFaltante(null); setCrearTipo(""); setCrearCat(""); }} title="Crear este movimiento en Caja">
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div>Fecha: <strong>{fmt_d(crearFaltante.fecha)}</strong></div>
            <div>Monto: <strong>{fmt_$(crearFaltante.monto)}</strong></div>
            <div>Cuenta: <strong>MercadoPago</strong></div>
            <div>Local: <strong>{localNombre}</strong></div>
            <div style={{ marginTop: 6 }}>Detalle: <em>[Concil. {periodoDesde.slice(0, 7)}] {crearFaltante.descripcion}{crearFaltante.referencia_externa ? ` · ref ${crearFaltante.referencia_externa}` : ""}</em></div>
          </div>

          {/* Tipo + Categoría obligatorios. Sin esto, los movs caen en
              "Otros" del EERR y descuadran el reporte mensual. */}
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: "var(--muted2)", display: "block", marginBottom: 4 }}>
                Tipo *
              </label>
              <select
                value={crearTipo}
                onChange={e => { setCrearTipo(e.target.value); setCrearCat(""); }}
                style={{ width: "100%", padding: "8px 10px", fontSize: 13, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--text)", borderRadius: 6 }}
              >
                <option value="">Seleccioná…</option>
                {tipos.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--muted2)", display: "block", marginBottom: 4 }}>
                Categoría *
              </label>
              <select
                value={crearCat}
                onChange={e => setCrearCat(e.target.value)}
                disabled={!crearTipo}
                style={{ width: "100%", padding: "8px 10px", fontSize: 13, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--text)", borderRadius: 6 }}
              >
                <option value="">{crearTipo ? "Seleccioná…" : "(elegí tipo primero)"}</option>
                {catsDisponibles.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          {esEgreso && !crearTipo && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted2)" }}>
              Mirá la descripción ("{crearFaltante.descripcion.slice(0, 60)}") y elegí el bucket EERR que aplique. Por ejemplo, "Pago de servicio AySA" → Gasto Fijo / AYSA.
            </div>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => { setCrearFaltante(null); setCrearTipo(""); setCrearCat(""); }} disabled={savingAccion}>Cancelar</button>
            <button className="btn btn-acc" onClick={ejecutarCrearFaltante} disabled={savingAccion || !crearTipo || !crearCat}>
              {savingAccion ? "Creando…" : "Confirmar crear"}
            </button>
          </div>
        </Modal>
        );
      })()}

      {/* Modal: confirmar anular sobrante */}
      {anularSobrante && (
        <Modal isOpen={true} onClose={() => setAnularSobrante(null)} title="Anular movimiento sobrante">
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div>Fecha: <strong>{fmt_d(anularSobrante.fecha)}</strong></div>
            <div>Monto: <strong>{fmt_$(anularSobrante.importe)}</strong></div>
            <div>Detalle: <em>{anularSobrante.detalle || "(sin detalle)"}</em></div>
          </div>
          <label style={{ display: "block", marginTop: 12, fontSize: 12, color: "var(--muted2)" }}>
            ¿Por qué lo anulás? (obligatorio)
          </label>
          <input
            type="text"
            value={motivoAnular}
            onChange={e => setMotivoAnular(e.target.value)}
            placeholder="ej: cargado por error, en realidad fue caja chica"
            style={{
              width: "100%", padding: "8px 10px", fontSize: 13,
              background: "var(--bg)", border: "1px solid var(--bd)",
              color: "var(--text)", borderRadius: 6, marginTop: 4,
            }}
            autoFocus
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setAnularSobrante(null)} disabled={savingAccion}>Cancelar</button>
            <button
              className="btn btn-sec"
              style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
              onClick={ejecutarAnularSobrante}
              disabled={savingAccion || !motivoAnular.trim()}
            >
              {savingAccion ? "Anulando…" : "Confirmar anular"}
            </button>
          </div>
        </Modal>
      )}
    </PageContainer>
  );
}

// ─── Sub-componentes locales ──────────────────────────────────────────────

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="panel" style={{ padding: 16, marginBottom: 12 }}>
      {children}
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 11, color: "var(--muted2)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function SeccionFilas<T>({
  titulo,
  descripcion,
  filas,
  renderFila,
}: {
  titulo: string;
  descripcion: string;
  filas: T[];
  renderFila: (f: T) => React.ReactNode;
}) {
  if (filas.length === 0) return null;
  return (
    <Card>
      <h4 style={{ marginTop: 0, fontSize: 14 }}>{titulo} <span style={{ color: "var(--muted2)" }}>({filas.length})</span></h4>
      <p style={{ color: "var(--muted2)", fontSize: 12, lineHeight: 1.5, marginBottom: 12 }}>{descripcion}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filas.map(renderFila)}
      </div>
    </Card>
  );
}

// ─── Historial de conciliaciones cerradas ────────────────────────────────
// Lucas 10-jun: "lo importante es la conciliación en sí, después del resto
// es tener un registro para ver que todos los meses se haya hecho."
// Muestra las últimas conciliaciones cerradas del local activo en una
// tabla compacta + un mini-strip de los últimos 6 meses con verde
// (cerrado) / rojo (sin cerrar) para detectar gaps visualmente.
function Historial({
  corridas,
  loading,
  localNombre,
}: {
  corridas: CorridaHistorica[];
  loading: boolean;
  localNombre: string;
}) {
  // Armar los últimos 6 meses (incluyendo el actual) y mapear cuáles tienen
  // conciliación cerrada. Match por inicio de mes (periodo_desde).
  const ultimos6Meses = useMemo(() => {
    const meses: Array<{ key: string; label: string; cerrada: boolean }> = [];
    const hoy = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const label = d.toLocaleDateString("es-AR", { month: "short", year: "2-digit" });
      const cerrada = corridas.some(c => c.periodo_desde.startsWith(key));
      meses.push({ key, label, cerrada });
    }
    return meses;
  }, [corridas]);

  if (loading) {
    return (
      <div className="panel" style={{ padding: 14, marginBottom: 12, fontSize: 12, color: "var(--muted2)" }}>
        Cargando historial…
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>
          Conciliaciones cerradas — {localNombre}
        </h3>
        <span style={{ fontSize: 11, color: "var(--muted2)" }}>
          {corridas.length === 0 ? "Sin historial todavía" : `${corridas.length} registradas`}
        </span>
      </div>

      {/* Strip últimos 6 meses */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {ultimos6Meses.map(m => (
          <div
            key={m.key}
            title={m.cerrada ? "Conciliada" : "Sin conciliar"}
            style={{
              flex: 1, padding: "6px 4px", borderRadius: 4,
              background: m.cerrada ? "rgba(34,197,94,0.15)" : "rgba(239,68,68,0.10)",
              border: `1px solid ${m.cerrada ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.3)"}`,
              textAlign: "center", fontSize: 10,
              color: m.cerrada ? "var(--success)" : "var(--danger)",
              textTransform: "uppercase", letterSpacing: 0.3, fontWeight: 600,
            }}
          >
            {m.cerrada ? "✓" : "—"} {m.label}
          </div>
        ))}
      </div>

      {/* Tabla con últimas conciliaciones (si hay) */}
      {corridas.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--muted2)" }}>
            Ver detalle de las últimas {Math.min(corridas.length, 24)} conciliaciones
          </summary>
          <div style={{ marginTop: 8, maxHeight: 280, overflowY: "auto", fontSize: 11 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--bd)", color: "var(--muted2)" }}>
                  <th style={{ textAlign: "left", padding: "5px 4px" }}>Período</th>
                  <th style={{ textAlign: "right", padding: "5px 4px" }}>Total</th>
                  <th style={{ textAlign: "right", padding: "5px 4px" }}>🟢</th>
                  <th style={{ textAlign: "right", padding: "5px 4px" }}>🟡</th>
                  <th style={{ textAlign: "right", padding: "5px 4px" }}>🔴 falta</th>
                  <th style={{ textAlign: "right", padding: "5px 4px" }}>🔴 sobra</th>
                  <th style={{ textAlign: "right", padding: "5px 4px" }}>Cerrada</th>
                </tr>
              </thead>
              <tbody>
                {corridas.map(c => (
                  <tr key={c.id} style={{ borderBottom: "1px solid var(--bd)" }}>
                    <td style={{ padding: "5px 4px" }}>
                      {fmt_d(c.periodo_desde)} → {fmt_d(c.periodo_hasta)}
                    </td>
                    <td style={{ textAlign: "right", padding: "5px 4px", fontVariantNumeric: "tabular-nums" }}>{c.total_movs}</td>
                    <td style={{ textAlign: "right", padding: "5px 4px", color: "var(--success)", fontVariantNumeric: "tabular-nums" }}>{c.verdes}</td>
                    <td style={{ textAlign: "right", padding: "5px 4px", color: "var(--warn)", fontVariantNumeric: "tabular-nums" }}>{c.amarillos}</td>
                    <td style={{ textAlign: "right", padding: "5px 4px", color: "var(--danger)", fontVariantNumeric: "tabular-nums" }}>{c.rojos_falta}</td>
                    <td style={{ textAlign: "right", padding: "5px 4px", color: "var(--danger)", fontVariantNumeric: "tabular-nums" }}>{c.rojos_sobra}</td>
                    <td style={{ textAlign: "right", padding: "5px 4px", color: "var(--muted2)" }}>
                      {c.cerrada_at ? fmt_d(c.cerrada_at.slice(0, 10)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function FilaCard({
  fecha,
  monto,
  descripcion,
  children,
  resuelta = false,
}: {
  fecha: string;
  monto: number;
  descripcion: string;
  children: React.ReactNode;
  /** Si true, la fila se renderiza atenuada con borde verde (Lucas 10-jun:
   *  filas resueltas siguen visibles para poder deshacer si te equivocaste). */
  resuelta?: boolean;
}) {
  return (
    <div style={{
      padding: 12,
      background: resuelta ? "rgba(34,197,94,0.06)" : "var(--s2)",
      border: resuelta ? "1px solid rgba(34,197,94,0.3)" : undefined,
      borderRadius: 6,
      display: "flex", flexDirection: "column", gap: 8,
      opacity: resuelta ? 0.85 : 1,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 13 }}>
          <span style={{ color: "var(--muted2)" }}>{fmt_d(fecha)}</span>
          <span style={{ marginLeft: 10 }}>{descripcion}</span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
          {fmt_$(monto)}
        </div>
      </div>
      {children}
    </div>
  );
}
