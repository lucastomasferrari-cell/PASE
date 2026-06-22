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
import { refsDevueltas } from "../lib/conciliacionDevueltas";
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
  ya_matcheados_ext?: Array<{ idx: number; fecha: string; monto: number; descripcion: string; estado: string }>;
  ya_matcheados_pase?: Array<{ id: string; fecha: string; importe: number; detalle: string }>;
  total_completo_ext?: number;
  total_completo_pase?: number;
  total_completo_dif?: number;
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

interface AlertaCercana {
  mov_id: string;
  mov_fecha: string;
  mov_importe: number;
  mov_detalle: string;
  mov_prov: string | null;
  ext_idx: number;
  ext_fecha: string;
  ext_monto: number;
  ext_descripcion: string;
  dias_fuera: number;
}

interface CruceResultado {
  extracto: FilaExtracto[];
  sobrantes: Sobrante[];
  alertas?: AlertaCercana[];
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
  const [checkedLines, setCheckedLines] = useState<Set<string>>(new Set());
  const toggleLine = (key: string) => setCheckedLines(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
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
  // "Crear como Gasto" — para sueltos que son gastos operativos (Edenor,
  // suscripciones, etc.) y no pertenecen a un proveedor. Usa crear_gasto
  // RPC que crea gasto + movimiento → aparece en EERR correctamente.
  const [crearGastoFila, setCrearGastoFila] = useState<FilaExtracto | null>(null);
  // Tipo y categoría para el mov a crear desde el modal. Se setean al abrirlo
  // (Lucas 10-jun: "no te pide poner ni tipo ni categoria como corresponde"
  // — antes los mov creados quedaban con tipo="Egreso Manual"/null cat,
  // descuadrando el EERR).
  const [crearTipo, setCrearTipo] = useState<string>("");
  const [crearCat, setCrearCat] = useState<string>("");
  const { GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, COMISIONES_CATS, GASTOS_IMPUESTOS, GASTOS_MANO_OBRA, GASTOS_JUICIOS, CATEGORIAS_COMPRA, CATEGORIAS_INGRESO } = useCategorias();
  // Tipos/categorías de gasto = MISMA fuente que el reporte (EERR) y la
  // pantalla Gastos (useCategorias), no una lista personalizada (Lucas 16-jun:
  // "deberían aparecer todos los conceptos del reporte"). Incluye Juicios y
  // Demandas; las categorías de cada tipo salen del catálogo (Cargas Sociales y
  // Boletas Sindicales viven dentro de Gasto Fijo). Retiro de Socios NO está acá
  // a propósito: se maneja por el módulo Utilidades (anti-mezcla).
  const GASTO_TIPOS_CONCIL: { label: string; cats: string[] }[] = [
    { label: "Gasto Fijo", cats: GASTOS_FIJOS },
    { label: "Gasto Variable", cats: GASTOS_VARIABLES },
    { label: "Publicidad", cats: GASTOS_PUBLICIDAD },
    { label: "Comisión", cats: COMISIONES_CATS },
    { label: "Impuesto", cats: GASTOS_IMPUESTOS },
    { label: "Mano de Obra", cats: GASTOS_MANO_OBRA },
    { label: "Juicios y Demandas", cats: GASTOS_JUICIOS },
  ];
  const catsDeTipoGasto = (label: string) => GASTO_TIPOS_CONCIL.find(t => t.label === label)?.cats ?? [];
  // Saving flags
  const [savingAccion, setSavingAccion] = useState(false);
  const [reabriendo, setReabriendo] = useState<string | null>(null);
  const [recolocando, setRecolocando] = useState<string | null>(null);
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

  // Forma del borrador (localStorage + base). `local_id` estampa a qué local
  // pertenece — al cargar se descarta el que no coincida (anti cruce de
  // archivos entre locales, Lucas 22-jun).
  type BorradorData = {
    local_id?: number;
    archivoNombre?: string;
    extractoMovs?: ExtractoMovimiento[];
    periodoDesde?: string;
    periodoHasta?: string;
    resumenExtracto?: { initial_balance: number; final_balance: number } | null;
    cruce?: CruceResultado | null;
    resueltos?: Record<string, string>;
  };
  const aplicarBorrador = (d: BorradorData) => {
    if (d.archivoNombre) setArchivoNombre(d.archivoNombre);
    if (d.extractoMovs) setExtractoMovs(d.extractoMovs);
    if (d.periodoDesde) setPeriodoDesde(d.periodoDesde);
    if (d.periodoHasta) setPeriodoHasta(d.periodoHasta);
    if (d.resumenExtracto !== undefined) setResumenExtracto(d.resumenExtracto);
    if (d.cruce) setCruce(d.cruce);
    if (d.resueltos) setResueltos(d.resueltos);
  };

  // Restaurar al montar / cambiar de local: localStorage (instantáneo) + base
  // (cross-device — si entrás desde otra compu, trae el progreso; gana el más
  // nuevo entre el de la base y el local).
  useEffect(() => {
    setExtractoMovs([]);
    setResumenExtracto(null);
    setCruce(null);
    setResueltos({});
    setCheckedLines(new Set());
    setArchivoNombre("");
    setPeriodoDesde("");
    setPeriodoHasta("");
    setCorridaCerrada(null);

    if (!BORRADOR_KEY || localActivo == null) return;
    let cancel = false;
    let localSavedAt = 0;
    try {
      const raw = localStorage.getItem(BORRADOR_KEY);
      if (raw) {
        const draft = JSON.parse(raw) as BorradorData & { savedAt?: number };
        // Solo confío en el borrador local si está estampado con ESTE local.
        // Los viejos (sin estampa) o contaminados se descartan y se limpian —
        // así no re-siembran el extracto de otro local en la base.
        if (draft.local_id === localActivo) {
          localSavedAt = draft.savedAt || 0;
          aplicarBorrador(draft);
        } else {
          localStorage.removeItem(BORRADOR_KEY);
        }
      }
    } catch (e) {
      console.warn("[Conciliación] error restaurando borrador local:", e);
    }
    (async () => {
      try {
        const { data } = await db.from("conciliacion_borradores")
          .select("data, updated_at").eq("local_id", localActivo).maybeSingle();
        if (cancel || !data?.data) return;
        const d = data.data as BorradorData;
        // Descarta el borrador de la base si está estampado con OTRO local
        // (dato contaminado de un cruce viejo). Sin estampa = legacy, se confía.
        if (d.local_id != null && d.local_id !== localActivo) return;
        const dbSavedAt = data.updated_at ? new Date(data.updated_at as string).getTime() : 0;
        if (dbSavedAt >= localSavedAt) aplicarBorrador(d);
      } catch (e) {
        console.warn("[Conciliación] error trayendo borrador de la base:", e);
      }
    })();
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localActivo]);

  // Guardar al cambiar cualquier pieza: localStorage (instantáneo) + base
  // (debounce 1.5s, sincroniza entre compus). Skip si no hay nada cargado
  // todavía (no pisar un borrador real con el state vacío del mount).
  useEffect(() => {
    if (!BORRADOR_KEY || localActivo == null) return;
    if (corridaCerrada) return; // ya cerrada — no guarda más borrador
    const hayCruce = !!cruce && cruce.extracto.length > 0;
    if (!hayCruce && extractoMovs.length === 0) return;
    const payload: BorradorData = { local_id: localActivo, archivoNombre, extractoMovs, periodoDesde, periodoHasta, resumenExtracto, cruce, resueltos };
    try {
      localStorage.setItem(BORRADOR_KEY, JSON.stringify({ ...payload, savedAt: Date.now() }));
    } catch (e) {
      // Quota exceeded u otra falla — no es crítico, la conciliación sigue in-memory.
      console.warn("[Conciliación] no se pudo guardar borrador local:", e);
    }
    const t = setTimeout(() => {
      db.from("conciliacion_borradores")
        .upsert({ local_id: localActivo, data: payload, updated_at: new Date().toISOString() }, { onConflict: "tenant_id,local_id" })
        .then(({ error }) => { if (error) console.warn("[Conciliación] no se pudo sincronizar borrador en la base:", error.message); });
    }, 1500);
    return () => clearTimeout(t);
  }, [BORRADOR_KEY, localActivo, corridaCerrada, archivoNombre, extractoMovs, periodoDesde, periodoHasta, resumenExtracto, cruce, resueltos]);

  // Limpiar al cerrar la conciliación o al usuario tocar "Empezar de cero".
  function limpiarBorrador() {
    if (BORRADOR_KEY) { try { localStorage.removeItem(BORRADOR_KEY); } catch { /* idempotente */ } }
    if (localActivo != null) {
      db.from("conciliacion_borradores").delete().eq("local_id", localActivo)
        .then(({ error }) => { if (error) console.warn("[Conciliación] no se pudo borrar borrador de la base:", error.message); });
    }
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
  const devueltasRefs = useMemo(() => refsDevueltas(extractoMovs), [extractoMovs]);
  const egresosExtracto = useMemo(
    () => extractoMovs.filter(
      m => m.monto < 0 && !(m.referencia_externa != null && devueltasRefs.has(m.referencia_externa)),
    ),
    [extractoMovs, devueltasRefs],
  );
  const egresosDevueltos = useMemo(
    () => extractoMovs.filter(
      m => m.monto < 0 && m.referencia_externa != null && devueltasRefs.has(m.referencia_externa),
    ),
    [extractoMovs, devueltasRefs],
  );
  const ingresosReales = useMemo(
    () => extractoMovs.filter(
      m => m.monto > 0 && !(m.referencia_externa != null && devueltasRefs.has(m.referencia_externa)),
    ),
    [extractoMovs, devueltasRefs],
  );

  // Para AUDITAR: por cada PAGO de PASE que cruzó, contra qué TRANSFERENCIA del
  // banco lo hizo. Se reconstruye desde el resultado global del cruce con el
  // mismo criterio que usa la confirmación al cerrar. Solo display.
  const movAtransferencia = useMemo(() => {
    const map = new Map<string, { fecha: string; descripcion: string; monto: number }>();
    for (const fila of cruce?.extracto ?? []) {
      const r = resueltos[`ext:${fila.idx}`];
      let movIds: string[] = [];
      if (r && r.startsWith("matcheado:")) movIds = [r.slice("matcheado:".length)];
      else if (r && r.startsWith("combo:")) movIds = fila.combinaciones[Number(r.slice("combo:".length))]?.movs.map(m => m.id) ?? [];
      else if (fila.estado === "verde" && fila.candidatos.length === 1) movIds = [fila.candidatos[0]!.id];
      else if (fila.estado === "verde_agrupado" && fila.combinaciones.length === 1) movIds = fila.combinaciones[0]!.movs.map(m => m.id);
      else if ((fila.estado === "verde_bloque" || fila.estado === "bloque_diferencia") && fila.bloque) movIds = (fila.bloque.movs ?? []).map(m => m.id);
      for (const id of movIds) map.set(id, { fecha: fila.fecha, descripcion: fila.descripcion, monto: fila.monto });
    }
    return map;
  }, [cruce, resueltos]);

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

  async function refrescarCruce(silent = false) {
    if (!egresosExtracto.length || !periodoDesde || !periodoHasta) return;
    if (!silent) setCruzando(true);
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
      if (error) { if (!silent) showError(translateRpcError(error)); return; }
      setCruce(data as CruceResultado);
      if (!silent) showToast("Datos actualizados — tus resoluciones se mantienen");
    } finally {
      if (!silent) setCruzando(false);
    }
  }

  // "Traer a este mes": el pago está cargado en PASE con fecha de otro mes
  // (lo cargaste días después de la transferencia real). Le pone la fecha de
  // la transferencia del extracto y re-cruza, así matchea en el mes correcto.
  // No mueve plata — solo la fecha. El usuario confirma cada uno (no es masivo).
  async function traerAlMes(a: AlertaCercana) {
    setRecolocando(a.mov_id);
    try {
      const { error } = await db.rpc("fn_recolocar_mov_fecha", {
        p_mov_id: a.mov_id,
        p_nueva_fecha: a.ext_fecha,
      });
      if (error) { showError(translateRpcError(error)); return; }
      showToast(`Pago traído al ${fmt_d(a.ext_fecha)} — re-cruzando…`);
      await refrescarCruce();
    } finally {
      setRecolocando(null);
    }
  }

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible" && cruce && !cruzando) {
        void refrescarCruce(true);
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

  // Crea UN gasto (crear_gasto → impacta EERR + Caja) a partir de una fila del
  // extracto. Reusada por el modal individual y por el lote. Devuelve true si OK.
  // crear_gasto retorna {gasto_id, mov_id} → usamos mov_id directo (sin lookup).
  async function crearGastoDeFila(fila: FilaExtracto, tipo: string, cat: string): Promise<boolean> {
    const detalle = `[Concil. ${periodoDesde.slice(0, 7)}] ${fila.descripcion}${fila.referencia_externa ? ` · ref ${fila.referencia_externa}` : ""}`;
    const { data, error } = await db.rpc("crear_gasto", {
      p_fecha: fila.fecha,
      p_local_id: localActivo,
      p_categoria: cat,
      p_tipo: tipo,
      p_monto: Math.abs(fila.monto),
      p_detalle: detalle,
      p_cuenta: "MercadoPago",
      p_plantilla_id: null,
      p_idempotency_key: crypto.randomUUID(),
    });
    if (error) {
      showError(`${fila.descripcion.slice(0, 40)}: ${translateRpcError(error)}`);
      return false;
    }
    if (data && (data as { mov_id?: string }).mov_id) {
      movsSesionRef.current.add((data as { mov_id: string }).mov_id);
    }
    // Aprender: este titular MP = gasto de esta categoría. La próxima
    // conciliación lo reconoce y lo pre-clasifica como "conocido" (Lucas
    // 16-jun: que aprenda como "pertenece a proveedor"). Best-effort.
    void db.rpc("fn_aprender_gasto_alias", {
      p_local_id: localActivo,
      p_descripcion: fila.descripcion,
      p_categoria: cat,
      p_tipo: tipo,
    }).then(({ error }) => {
      if (error) console.warn("[Concil] no se aprendió alias de gasto:", error.message);
    });
    setResueltos(p => ({ ...p, [`ext:${fila.idx}`]: "creado" }));
    return true;
  }

  async function ejecutarCrearGasto() {
    if (!crearGastoFila) return;
    if (!crearTipo) { showError("Elegí un tipo"); return; }
    if (!crearCat) { showError("Elegí una categoría"); return; }
    setSavingAccion(true);
    try {
      const ok = await crearGastoDeFila(crearGastoFila, crearTipo, crearCat);
      if (ok) {
        setCrearGastoFila(null);
        setCrearTipo("");
        setCrearCat("");
        showToast("Gasto creado");
      }
    } finally {
      setSavingAccion(false);
    }
  }

  // ─── Creación EN LOTE (Lucas 10-jun: "siguen siendo muchos") ────────────
  // La mayoría de los faltantes son gastos reales no cargados. Crearlos de
  // a uno (35 clicks + 35 confirmaciones) es un dolor: checkboxes + un solo
  // botón que los crea todos.
  //
  // Lucas 16-jun: el lote ahora pide TIPO + CATEGORÍA y crea GASTOS (crear_gasto
  // → impactan EERR + Caja), no movimientos sueltos "Egreso Manual" (que solo
  // tocaban la caja y NO figuraban en el balance). El tipo/categoría elegido se
  // aplica a TODAS las seleccionadas — pensado para tandas del mismo concepto
  // (ej: los impuestos de extracción de MP).
  const [seleccionados, setSeleccionados] = useState<Set<number>>(new Set());
  const [confirmarLote, setConfirmarLote] = useState(false);
  const [progresoLote, setProgresoLote] = useState<string | null>(null);
  const [loteTipo, setLoteTipo] = useState<string>("");
  const [loteCat, setLoteCat] = useState<string>("");
  // Gastos "conocidos": filas rojas cuyo titular MP ya fue clasificado como
  // gasto en una conciliación anterior (fn_clasificar_gastos_conocidos). Map
  // descripcion → {categoria, tipo}. Permite crear de un clic / todos juntos.
  const [gastosConocidos, setGastosConocidos] = useState<Record<string, { categoria: string; tipo: string }>>({});

  function toggleSeleccion(idx: number) {
    setSeleccionados(p => {
      const n = new Set(p);
      if (n.has(idx)) n.delete(idx); else n.add(idx);
      return n;
    });
  }

  // Cuando carga/cambia el cruce, preguntar al backend qué filas rojas ya son
  // gastos "conocidos" (titular aprendido antes) para pre-clasificarlas.
  useEffect(() => {
    if (!cruce || localActivo == null) return;
    const descrs = Array.from(new Set(
      cruce.extracto.filter(f => f.estado === "rojo_falta").map(f => f.descripcion),
    ));
    if (descrs.length === 0) return;
    let cancel = false;
    void db.rpc("fn_clasificar_gastos_conocidos", { p_local_id: localActivo, p_descripciones: descrs })
      .then(({ data, error }) => {
        if (cancel || error || !data) return;
        const map: Record<string, { categoria: string; tipo: string }> = {};
        for (const row of data as Array<{ descripcion: string; categoria: string; tipo: string | null }>) {
          map[row.descripcion] = { categoria: row.categoria, tipo: row.tipo ?? "" };
        }
        setGastosConocidos(map);
      });
    return () => { cancel = true; };
  }, [cruce, localActivo]);

  async function ejecutarCrearLote() {
    if (!cruce) return;
    if (!loteTipo) { showError("Elegí un tipo"); return; }
    if (!loteCat) { showError("Elegí una categoría"); return; }
    const filas = cruce.extracto.filter(f => seleccionados.has(f.idx) && !resueltos[`ext:${f.idx}`]);
    if (filas.length === 0) return;
    setSavingAccion(true);
    setConfirmarLote(false);
    let creados = 0;
    try {
      for (let i = 0; i < filas.length; i++) {
        setProgresoLote(`Creando ${i + 1} de ${filas.length}…`);
        const ok = await crearGastoDeFila(filas[i]!, loteTipo, loteCat);
        if (ok) creados++;
        // Si falla uno, seguimos con el resto (el error ya se mostró).
      }
      showToast(`${creados} de ${filas.length} gastos creados`);
      setSeleccionados(new Set());
      setLoteTipo("");
      setLoteCat("");
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
      // Resolver factura_sin_pagar filas que tengan esta factura/remito
      // en sus candidatos — evita que queden huérfanas en la UI.
      if (cruce) {
        for (const fila of cruce.extracto) {
          if (fila.estado !== "factura_sin_pagar") continue;
          if (resueltos[`ext:${fila.idx}`]) continue;
          const match = (fila.facturas_pendientes ?? []).some(fp =>
            fp.id === pend.id || (fp.tipo === "tanda" && (fp.facturas ?? []).some(tf => tf.id === pend.id))
          );
          if (match) setResueltos(p => ({ ...p, [`ext:${fila.idx}`]: "pagada" }));
        }
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
    // Integrar factura_sin_pagar en bloques de proveedor (Lucas 11-jun:
    // "no debería cargarla directamente en la parte de arriba donde están
    // los consolidados por proveedor?"). Agrupamos por proveedor y las
    // insertamos en el bloque correspondiente.
    for (const fila of cruce.extracto) {
      if (fila.estado !== "factura_sin_pagar") continue;
      if (resueltos[`ext:${fila.idx}`]) continue;
      for (const cand of (fila.facturas_pendientes ?? [])) {
        const provName = cand.proveedor ?? "Sin proveedor";
        if (!map.has(provName)) {
          map.set(provName, {
            bloque: {
              proveedor: provName,
              n_transferencias: 0,
              suma_extracto: 0,
              n_pagos: 0,
              suma_pase: 0,
              dif: 0,
              movs: [],
              facturas_pendientes: [],
            },
            filas: [],
            resuelto: false,
          });
        }
        const entry = map.get(provName)!;
        if (!entry.filas.some(f => f.idx === fila.idx)) {
          entry.filas.push(fila);
          entry.bloque.n_transferencias++;
          entry.bloque.suma_extracto += fila.monto;
          entry.bloque.dif = entry.bloque.suma_extracto - (Number(entry.bloque.suma_pase) || 0);
        }
        if (!entry.bloque.facturas_pendientes) entry.bloque.facturas_pendientes = [];
        if (cand.tipo !== "tanda") {
          const existing = entry.bloque.facturas_pendientes!;
          if (!existing.some(p => p.id === cand.id)) {
            existing.push({ tipo: cand.tipo as "factura" | "remito", id: cand.id!, nro: cand.nro ?? null, fecha: cand.fecha ?? "", total: Number(cand.total ?? 0) });
          }
        }
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

  // Reabrir una conciliación cerrada: la desmarca (libera los movimientos +
  // borra la corrida) para corregirla y volver a cerrarla. No toca saldos.
  async function reabrirCorrida(corridaId: string) {
    if (!window.confirm("¿Reabrir esta conciliación?\n\nSe va a desmarcar: los movimientos vuelven a quedar sin conciliar y vas a poder cargar el extracto de nuevo, corregir y volver a cerrarla. No se pierde ningún saldo.")) return;
    setReabriendo(corridaId);
    try {
      const { error } = await db.rpc("fn_reabrir_conciliacion", { p_corrida_id: corridaId });
      if (error) { showError(translateRpcError(error)); return; }
      setHistorial(hs => hs.filter(c => c.id !== corridaId));
      showToast("Conciliación reabierta — cargá el extracto de nuevo para corregirla");
    } finally {
      setReabriendo(null);
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
          onReabrir={reabrirCorrida}
          reabriendo={reabriendo}
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
                ({ingresosReales.length} ingresos del extracto se ignoran — vienen por otra vía)
              </div>
              {egresosDevueltos.length > 0 && (
                <div style={{ fontSize: 12, color: "var(--muted2)", marginTop: 2 }}>
                  ↩️ {egresosDevueltos.length} {egresosDevueltos.length === 1 ? "transferencia devuelta" : "transferencias devueltas"} (enviadas y reintegradas) — se ignoran
                </div>
              )}
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
                <button className="btn btn-outline" onClick={() => refrescarCruce()} disabled={cruzando}>
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
                Transferencias del extracto agrupadas por proveedor. Incluye diferencias de totales
                y facturas pendientes de pago. Abrí el detalle de cada proveedor para ver las
                transferencias, los pagos cargados, y las facturas que faltan marcar como pagadas.
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
                        Ver detalle ({filas.length + (bloque.ya_matcheados_ext?.length ?? 0)} transferencias + {(bloque.movs?.length ?? 0) + (bloque.ya_matcheados_pase?.length ?? 0)} pagos)
                      </summary>
                      <div style={{ marginTop: 6, fontSize: 11 }}>
                        <div style={{ color: "var(--muted2)", marginBottom: 2 }}>Transferencias del extracto:</div>
                        {filas.map(f => {
                          const ck = `ext-line:${f.idx}`;
                          const on = checkedLines.has(ck);
                          return (
                            <div key={f.idx} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0 2px 4px", opacity: on ? 0.4 : 1, textDecoration: on ? "line-through" : "none", cursor: "pointer" }} onClick={() => toggleLine(ck)}>
                              <input type="checkbox" checked={on} readOnly style={{ width: 13, height: 13, cursor: "pointer", flexShrink: 0 }} />
                              <span style={{ flex: 1 }}>{fmt_d(f.fecha)} · {f.descripcion.slice(0, 50)}</span>
                              <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(f.monto)}</span>
                            </div>
                          );
                        })}
                        <div style={{ color: "var(--muted2)", margin: "6px 0 2px" }}>Pagos cargados en PASE:</div>
                        {(bloque.movs ?? []).map(m => {
                          const ck = `pase-line:${m.id}`;
                          const on = checkedLines.has(ck);
                          return (
                            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0 2px 4px", opacity: on ? 0.4 : 1, textDecoration: on ? "line-through" : "none", cursor: "pointer" }} onClick={() => toggleLine(ck)}>
                              <input type="checkbox" checked={on} readOnly style={{ width: 13, height: 13, cursor: "pointer", flexShrink: 0 }} />
                              <span style={{ flex: 1 }}>{fmt_d(m.fecha)} · {(m.detalle ?? "").slice(0, 50)}</span>
                              <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(m.importe)}</span>
                            </div>
                          );
                        })}
                        {/* Contexto: transfers y pagos que YA matchearon individualmente */}
                        {(bloque.ya_matcheados_ext ?? []).length > 0 && (
                          <>
                            <div style={{ color: "var(--muted2)", margin: "8px 0 2px", fontStyle: "italic" }}>
                              Ya matcheadas individualmente ({bloque.ya_matcheados_ext!.length}):
                            </div>
                            {bloque.ya_matcheados_ext!.map((f, i) => (
                              <div key={`ctx-ext-${i}`} style={{ display: "flex", gap: 6, padding: "2px 0 2px 4px", opacity: 0.45, fontSize: 11 }}>
                                <span style={{ color: "var(--success)", flexShrink: 0 }}>✓</span>
                                <span style={{ flex: 1 }}>{fmt_d(f.fecha)} · {(f.descripcion ?? "").slice(0, 50)}</span>
                                <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(f.monto)}</span>
                              </div>
                            ))}
                          </>
                        )}
                        {(bloque.ya_matcheados_pase ?? []).length > 0 && (
                          <>
                            <div style={{ color: "var(--muted2)", margin: "8px 0 2px", fontStyle: "italic" }}>
                              Pagos ya cruzados — cada uno con su transferencia del banco ({bloque.ya_matcheados_pase!.length}):
                            </div>
                            {bloque.ya_matcheados_pase!.map((m) => {
                              const transf = movAtransferencia.get(m.id);
                              const difMonto = transf ? Math.abs(transf.monto) - Math.abs(m.importe) : 0;
                              return (
                                <div key={`ctx-pase-${m.id}`} style={{ padding: "4px 0 4px 4px", opacity: 0.7, fontSize: 11, borderBottom: "1px solid var(--bd)" }}>
                                  <div style={{ display: "flex", gap: 6 }}>
                                    <span style={{ color: "var(--success)", flexShrink: 0 }}>✓</span>
                                    <span style={{ flex: 1 }}><b>PASE</b> · {fmt_d(m.fecha)} · {(m.detalle ?? "").slice(0, 48)}</span>
                                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(m.importe)}</span>
                                  </div>
                                  {transf ? (
                                    <div style={{ display: "flex", gap: 6, paddingLeft: 16, color: "var(--muted2)" }}>
                                      <span style={{ flex: 1 }}>↳ <b>Banco</b> · {fmt_d(transf.fecha)} · {(transf.descripcion ?? "").slice(0, 44)}
                                        {Math.abs(difMonto) > 0.5 && <span style={{ color: "var(--danger)", marginLeft: 6 }}>⚠ dif {fmt_$(difMonto)}</span>}
                                      </span>
                                      <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(transf.monto)}</span>
                                    </div>
                                  ) : (
                                    <div style={{ paddingLeft: 16, color: "var(--muted)" }}>↳ Banco · (la transferencia figura en otra parte del extracto)</div>
                                  )}
                                </div>
                              );
                            })}
                          </>
                        )}
                        {/* Totales completos (matcheados + no matcheados) */}
                        {bloque.total_completo_ext != null && (
                          <div style={{
                            margin: "8px 0 4px", padding: "6px 8px",
                            background: "var(--s2)", borderRadius: 4, fontSize: 11,
                            display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 4,
                          }}>
                            <span>Total completo extracto: <b>{fmt_$(bloque.total_completo_ext)}</b></span>
                            <span>Total completo PASE: <b>{fmt_$(bloque.total_completo_pase)}</b></span>
                            <span style={{
                              fontWeight: 600,
                              color: Math.abs(Number(bloque.total_completo_dif)) <= 2 ? "var(--success)" : "var(--danger)",
                            }}>
                              Dif total: {fmt_$(bloque.total_completo_dif)}
                            </span>
                          </div>
                        )}
                        {/* Facturas pendientes del proveedor */}
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
                    {(() => {
                      const knownFilas = filasRojas.filter(f => gastosConocidos[f.descripcion]);
                      if (knownFilas.length === 0) return null;
                      return (
                        <button
                          className="btn btn-acc btn-sm"
                          disabled={savingAccion}
                          title="Crea de un saque todas las filas cuyo titular ya clasificaste antes como gasto"
                          onClick={async () => {
                            setSavingAccion(true);
                            let creados = 0;
                            try {
                              for (let i = 0; i < knownFilas.length; i++) {
                                const f = knownFilas[i]!;
                                const k = gastosConocidos[f.descripcion]!;
                                setProgresoLote(`Creando ${i + 1} de ${knownFilas.length}…`);
                                const ok = await crearGastoDeFila(f, k.tipo || "Impuesto", k.categoria);
                                if (ok) creados++;
                              }
                              showToast(`${creados} gastos conocidos creados`);
                            } finally {
                              setProgresoLote(null);
                              setSavingAccion(false);
                            }
                          }}
                        >
                          {progresoLote ?? `✓ Crear ${knownFilas.length} conocidos →`}
                        </button>
                      );
                    })()}
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
                              {gastosConocidos[fila.descripcion] && (
                                <button
                                  className="btn btn-acc btn-sm"
                                  disabled={savingAccion}
                                  title="Crear como gasto con la categoría que aprendió de antes"
                                  onClick={async () => {
                                    const k = gastosConocidos[fila.descripcion]!;
                                    setSavingAccion(true);
                                    try {
                                      const ok = await crearGastoDeFila(fila, k.tipo || "Impuesto", k.categoria);
                                      if (ok) showToast("Gasto creado");
                                    } finally { setSavingAccion(false); }
                                  }}
                                >
                                  ✓ Crear gasto · {gastosConocidos[fila.descripcion]!.categoria}
                                </button>
                              )}
                              <button
                                className={gastosConocidos[fila.descripcion] ? "btn btn-ghost btn-sm" : "btn btn-acc btn-sm"}
                                onClick={() => setCrearFaltante(fila)}
                              >
                                Crear en Caja
                              </button>
                              {fila.monto < 0 && (
                                <button
                                  className="btn btn-sec btn-sm"
                                  onClick={() => { setCrearGastoFila(fila); setCrearTipo(""); setCrearCat(""); }}
                                >
                                  Crear como Gasto
                                </button>
                              )}
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

          {/* Facturas sin pagar que NO pudieron agruparse en ningún bloque
              (sin proveedor asignado) — fallback individual */}
          {(() => {
            const sinProv = cruce.extracto.filter(f =>
              f.estado === "factura_sin_pagar" && !resueltos[`ext:${f.idx}`]
              && (f.facturas_pendientes ?? []).every(fp => !fp.proveedor)
            );
            if (sinProv.length === 0) return null;
            return (
              <SeccionFilas
                titulo="🔵 Facturas sin marcar como pagadas (sin proveedor)"
                descripcion="La transferencia salió de MP y hay facturas pendientes pero no se pudo identificar el proveedor."
                filas={sinProv}
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
                              ? <><strong>{cand.proveedor ?? "—"}</strong> · {cand.n} facturas pendientes suman {fmt_$(Number(cand.total_suma))} {Number(cand.dif) > 0.01 && <em>(dif {fmt_$(Number(cand.dif))})</em>}</>
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
            );
          })()}

          {/* Alertas: movimientos fuera del período que coinciden por monto */}
          {(cruce.alertas ?? []).length > 0 && (
            <Card>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--warn)" }}>
                  ⚠ {cruce.alertas!.length} movimiento{cruce.alertas!.length === 1 ? "" : "s"} fuera del período pero con monto coincidente
                </summary>
                <p style={{ color: "var(--muted2)", fontSize: 12, lineHeight: 1.5, marginTop: 8 }}>
                  Estos pagos cargados en PASE están fuera del rango del extracto (mes anterior o siguiente)
                  pero coinciden en monto con transferencias no matcheadas. Revisalos por si la fecha de carga
                  en PASE es distinta a la fecha real de la transferencia.
                </p>
                <div style={{ maxHeight: 300, overflowY: "auto", fontSize: 12, marginTop: 6 }}>
                  {cruce.alertas!.map((a, i) => (
                    <div key={i} style={{
                      padding: "8px 0", borderBottom: "1px solid var(--bd)",
                      display: "flex", flexDirection: "column", gap: 4,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                        <span>
                          <strong>Extracto:</strong> {fmt_d(a.ext_fecha)} · {a.ext_descripcion.slice(0, 50)} · {fmt_$(a.ext_monto)}
                        </span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, color: "var(--warn)" }}>
                        <span>
                          <strong>PASE:</strong> {fmt_d(a.mov_fecha)} · {(a.mov_detalle ?? "").slice(0, 50)} · {fmt_$(a.mov_importe)}
                          {a.mov_prov && <em> [{a.mov_prov}]</em>}
                        </span>
                        <span style={{ fontSize: 11 }}>
                          {a.dias_fuera} día{a.dias_fuera === 1 ? "" : "s"} fuera del período
                        </span>
                      </div>
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <button
                          type="button"
                          onClick={() => traerAlMes(a)}
                          disabled={recolocando === a.mov_id}
                          title="Ponerle la fecha de la transferencia del extracto para que entre en este mes"
                          style={{
                            fontSize: 11, padding: "3px 10px", borderRadius: 6,
                            border: "0.5px solid var(--warn)", background: "transparent",
                            color: "var(--warn)", cursor: recolocando === a.mov_id ? "default" : "pointer",
                          }}
                        >
                          {recolocando === a.mov_id ? "Trayendo…" : `↦ Traer al ${fmt_d(a.ext_fecha)}`}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            </Card>
          )}

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

          {/* VERDES — match automático. Muestra la PAREJA banco ↔ PASE para
              auditar cada cruce (antes solo se veía el lado banco). */}
          {stats.verdes > 0 && (
            <Card>
              <details>
                <summary style={{ cursor: "pointer", fontSize: 14, color: "var(--muted2)" }}>
                  🟢 Ver los {stats.verdes} movimientos que coinciden OK — banco ↔ PASE (no requieren acción)
                </summary>
                <div style={{ marginTop: 10, maxHeight: 360, overflowY: "auto" }}>
                  {cruce.extracto.filter(f => f.estado === "verde").map(fila => {
                    const pago = fila.candidatos[0]; // verde individual = 1 pago matcheado
                    const difMonto = pago ? Math.abs(fila.monto) - Math.abs(pago.importe) : 0;
                    return (
                      <div key={fila.idx} style={{ padding: "8px 0", borderBottom: "1px solid var(--bd)", fontSize: 12 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span><strong>Banco</strong> · {fmt_d(fila.fecha)} · {fila.descripcion}</span>
                          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{fmt_$(fila.monto)}</span>
                        </div>
                        {pago ? (
                          <div style={{ marginTop: 3, paddingLeft: 12, color: "var(--muted2)", display: "flex", justifyContent: "space-between" }}>
                            <span>↳ <strong>PASE</strong> · {fmt_d(pago.fecha)} · {pago.detalle}
                              {pago.dias_diff !== 0 && <span style={{ opacity: 0.7 }}> ({pago.dias_diff > 0 ? `+${pago.dias_diff}` : pago.dias_diff}d)</span>}
                              {Math.abs(difMonto) > 0.5 && <span style={{ color: "var(--danger)", marginLeft: 6 }}>⚠ dif {fmt_$(difMonto)}</span>}
                            </span>
                            <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(pago.importe)}</span>
                          </div>
                        ) : (
                          <div style={{ marginTop: 3, paddingLeft: 12, color: "var(--muted)" }}>↳ (sin pago asociado)</div>
                        )}
                      </div>
                    );
                  })}
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
      {confirmarLote && cruce && (() => {
        const filas = cruce.extracto.filter(f => seleccionados.has(f.idx) && !resueltos[`ext:${f.idx}`]);
        const suma = filas.reduce((s, f) => s + f.monto, 0);
        // Mismos tipos/categorías que el reporte (useCategorias), no lista propia.
        const tiposGasto = GASTO_TIPOS_CONCIL.map(t => t.label);
        const catsDisponibles = catsDeTipoGasto(loteTipo);
        return (
        <Modal isOpen={true} onClose={() => { setConfirmarLote(false); setLoteTipo(""); setLoteCat(""); }} title="Crear gastos en lote">
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            Se van a crear <strong>{filas.length} gastos</strong> con cuenta
            <strong> MercadoPago</strong> de <strong>{localNombre}</strong>, por un total
            de <strong>{fmt_$(suma)}</strong>. Todas con el <strong>mismo tipo y categoría</strong>
            {" "}— se cargan como gasto (impactan el balance/EERR, no solo la caja).
          </div>

          {/* Tipo + Categoría obligatorios — se aplican a TODAS las seleccionadas */}
          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: "var(--muted2)", display: "block", marginBottom: 4 }}>Tipo *</label>
              <select
                value={loteTipo}
                onChange={e => { setLoteTipo(e.target.value); setLoteCat(""); }}
                style={{ width: "100%", padding: "8px 10px", fontSize: 13, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--text)", borderRadius: 6 }}
              >
                <option value="">Seleccioná…</option>
                {tiposGasto.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--muted2)", display: "block", marginBottom: 4 }}>Categoría *</label>
              <select
                value={loteCat}
                onChange={e => setLoteCat(e.target.value)}
                disabled={!loteTipo}
                style={{ width: "100%", padding: "8px 10px", fontSize: 13, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--text)", borderRadius: 6 }}
              >
                <option value="">{loteTipo ? "Seleccioná…" : "(elegí tipo primero)"}</option>
                {catsDisponibles.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div style={{ marginTop: 12, maxHeight: 220, overflowY: "auto", fontSize: 11 }}>
            {filas.map(f => (
              <div key={f.idx} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px solid var(--bd)" }}>
                <span>{fmt_d(f.fecha)} · {f.descripcion.slice(0, 45)}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{fmt_$(f.monto)}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => { setConfirmarLote(false); setLoteTipo(""); setLoteCat(""); }} disabled={savingAccion}>Cancelar</button>
            <button className="btn btn-acc" onClick={ejecutarCrearLote} disabled={savingAccion || !loteTipo || !loteCat}>
              {savingAccion ? (progresoLote ?? "Creando…") : `Confirmar crear ${filas.length}`}
            </button>
          </div>
        </Modal>
        );
      })()}

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

      {/* Modal: crear como gasto (sueltos que son gastos operativos) */}
      {crearGastoFila && (() => {
        // Mismos tipos/categorías que el reporte (useCategorias), no lista propia.
        const tiposGasto = GASTO_TIPOS_CONCIL.map(t => t.label);
        const catsDisponibles = catsDeTipoGasto(crearTipo);
        return (
        <Modal isOpen={true} onClose={() => { setCrearGastoFila(null); setCrearTipo(""); setCrearCat(""); }} title="Crear como gasto">
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div>Fecha: <strong>{fmt_d(crearGastoFila.fecha)}</strong></div>
            <div>Monto: <strong>{fmt_$(Math.abs(crearGastoFila.monto))}</strong></div>
            <div>Cuenta: <strong>MercadoPago</strong></div>
            <div>Local: <strong>{localNombre}</strong></div>
            <div style={{ marginTop: 6 }}>Detalle: <em>{crearGastoFila.descripcion}</em></div>
          </div>
          <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: "var(--muted2)", display: "block", marginBottom: 4 }}>Tipo *</label>
              <select
                value={crearTipo}
                onChange={e => { setCrearTipo(e.target.value); setCrearCat(""); }}
                style={{ width: "100%", padding: "8px 10px", fontSize: 13, background: "var(--bg)", border: "1px solid var(--bd)", color: "var(--text)", borderRadius: 6 }}
              >
                <option value="">Seleccioná…</option>
                {tiposGasto.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "var(--muted2)", display: "block", marginBottom: 4 }}>Categoría *</label>
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
          {!crearTipo && (
            <div style={{ marginTop: 8, fontSize: 11, color: "var(--muted2)" }}>
              Mirá la descripción ("{crearGastoFila.descripcion.slice(0, 60)}") y elegí el tipo que aplique. Ej: "Pago de servicio Edenor" → Gasto Fijo / EDENOR.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => { setCrearGastoFila(null); setCrearTipo(""); setCrearCat(""); }} disabled={savingAccion}>Cancelar</button>
            <button className="btn btn-acc" onClick={ejecutarCrearGasto} disabled={savingAccion || !crearTipo || !crearCat}>
              {savingAccion ? "Creando…" : "Confirmar crear gasto"}
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
  onReabrir,
  reabriendo,
}: {
  corridas: CorridaHistorica[];
  loading: boolean;
  localNombre: string;
  onReabrir: (id: string) => void;
  reabriendo: string | null;
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
                  <th style={{ padding: "5px 4px" }}></th>
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
                    <td style={{ textAlign: "right", padding: "5px 4px" }}>
                      <button
                        type="button"
                        onClick={() => onReabrir(c.id)}
                        disabled={reabriendo === c.id}
                        title="Reabrir esta conciliación para corregirla"
                        style={{
                          fontSize: 10, padding: "2px 8px", borderRadius: 6,
                          border: "0.5px solid var(--bd)", background: "transparent",
                          color: "var(--muted)", cursor: reabriendo === c.id ? "default" : "pointer",
                        }}
                      >
                        {reabriendo === c.id ? "Reabriendo…" : "Reabrir"}
                      </button>
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
