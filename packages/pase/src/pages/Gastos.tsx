import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { applyLocalScope, cuentasOperables, localesVisibles, tienePermiso } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { useCategorias } from "../lib/useCategorias";
import { CUENTAS } from "../lib/constants";
import { toISO, today, fmt_d, fmt_$ } from "../lib/utils";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import { Combobox } from "../components/Combobox";
import { PageHeader, TipoPill, EmptyState, LocalLockedChip, LocalSelectorObligatorio } from "../components/ui";
import { ManagerOverrideModal } from "../components/ManagerOverrideModal";
import { exportCSV } from "../lib/exportCSV";
import type { Usuario, Local } from "../types";
import type { Gasto } from "../types/finanzas";

// Gasto extendido con campos de auditoría (anulado_*/editado_*) agregados en
// migration 202605122300. El tipo base Gasto no los incluye todavía.
type GastoExt = Gasto & {
  estado?: string | null;
  anulado_motivo?: string | null;
  anulado_at?: string | null;
  editado?: boolean | null;
  editado_motivo?: string | null;
  editado_at?: string | null;
};

interface GastosProps {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

// Plantilla recurrente de gasto (rrhh: rrhh_plantillas, gasto: gastos_plantillas).
// Tabla gastos_plantillas creada en migration 202604281209 con tenant_id y RLS.
interface GastoPlantilla {
  id: number;
  nombre: string;
  tipo: string;
  categoria: string;
  local_id: number | null;
  activo: boolean;
  tenant_id?: string;
}

const TIPOS = [
  { id: "todos", label: "Todos" },
  { id: "fijo", label: "Fijos" },
  { id: "variable", label: "Variables" },
  { id: "publicidad", label: "Publicidad" },
  { id: "impuesto", label: "Impuestos" },
  { id: "comision", label: "Comisiones" },
  { id: "retiro_socio", label: "Retiro de Socios" },
  // Feature 1 (2026-05-20): pago anticipado a empleado. Va a rrhh_adelantos
  // con concepto. Se descuenta del sueldo final.
  { id: "empleado", label: "Empleados" },
];

// Conceptos para tipo=empleado. Mapean a rrhh_adelantos.concepto.
const CONCEPTOS_EMPLEADO = [
  { id: "adelanto",     label: "Adelanto" },
  { id: "dia_doble",    label: "Día doble" },
  { id: "horas_extras", label: "Horas extra" },
  { id: "feriado",      label: "Feriado trabajado" },
  { id: "comida",       label: "Comida / refrigerio" },
  { id: "viatico",      label: "Viático" },
  { id: "otros",        label: "Otros" },
];

interface EmpleadoVisible {
  id: string;
  nombre: string;
  apellido?: string;
  local_principal_id: number;
  locales_ids?: number[] | null;
}
export default function Gastos({ user, locales, localActivo }: GastosProps) {
  const { GASTOS_FIJOS, GASTOS_VARIABLES, GASTOS_PUBLICIDAD, GASTOS_IMPUESTOS, COMISIONES_CATS, RETIROS_SOCIOS } = useCategorias();
  const ALL_CATS = [...GASTOS_FIJOS, ...GASTOS_VARIABLES, ...GASTOS_PUBLICIDAD, ...GASTOS_IMPUESTOS, ...COMISIONES_CATS, ...RETIROS_SOCIOS];
  const catsByTipo = (t: string) =>
    t === "fijo" ? GASTOS_FIJOS :
    t === "variable" ? GASTOS_VARIABLES :
    t === "publicidad" ? GASTOS_PUBLICIDAD :
    t === "impuesto" ? GASTOS_IMPUESTOS :
    t === "comision" ? COMISIONES_CATS :
    t === "retiro_socio" ? RETIROS_SOCIOS :
    ALL_CATS;
  // Cuentas para el dropdown "Cuenta de egreso" — filtra por cuentas_operables
  // (no visibles): un usuario puede pagar contra una cuenta cuyo saldo no ve.
  const opCuentas = cuentasOperables(user);
  const cuentasUsables = opCuentas === null ? CUENTAS : CUENTAS.filter(c => opCuentas.includes(c));
  // Locales del dropdown — solo los que el usuario tiene autorizados.
  // Reportado 2026-05-06: el cajero veía locales ajenos en el dropdown
  // del modal de gasto (encima del local activo del sidebar). Patrón
  // canónico: localesVisibles(user) devuelve null para dueño/admin
  // (acceso total) o array para encargado.
  const visLocs = localesVisibles(user);
  const locsDisp: Local[] = visLocs === null ? locales : locales.filter((l: Local) => visLocs.includes(l.id));
  const [search, setSearch] = useState("");
  // Default: últimos 90 días (consistente con Compras y demás filtros del admin).
  const [desde, setDesde] = useState(() => { const d = new Date(today); d.setDate(d.getDate() - 90); return toISO(d); });
  const [hasta, setHasta] = useState(toISO(today));
  const [tipoFiltro, setTipoFiltro] = useState("todos");
  const [gastos, setGastos] = useState<GastoExt[]>([]);
  const [mostrarAnulados, setMostrarAnulados] = useState(false);
  // Modal de editar gasto
  const [editModal, setEditModal] = useState<(GastoExt & { justificativo: string }) | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [idempKeyEditGasto, setIdempKeyEditGasto] = useState<string>(() => crypto.randomUUID());
  // Lucas 2026-05-19: ya no usamos puedeEditarAnular para ocultar botones.
  // Los botones quedan siempre visibles; si el user no tiene permiso, los
  // handlers (anularGasto / abrirEditar→guardar) abren el modal de Manager
  // Override TOTP.
  const puedeVerAnulados = tienePermiso(user, "ver_anulados");
  const { toast, showToast } = useToast();
  const [plantillas, setPlantillas] = useState<GastoPlantilla[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [pagarModal, setPagarModal] = useState<GastoPlantilla | null>(null);
  // Idempotency keys (convención C1) — anti doble-click en los dos modales
  // que invocan crear_gasto. Se regeneran al abrir cada modal.
  const [idempKeyCrearGasto, setIdempKeyCrearGasto] = useState<string>(() => crypto.randomUUID());
  const [idempKeyPagarPlant, setIdempKeyPagarPlant] = useState<string>(() => crypto.randomUUID());
  const [gestionarModal, setGestionarModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pagandoPlant, setPagandoPlant] = useState(false);

  // Bug Caja-1 (4-mayo): el default cuenta="MercadoPago" pisaba la elección
  // del usuario cuando "MercadoPago" no estaba en cuentasUsables (encargados
  // con cuentas_visibles restringidas). Anti-pattern de controlled <select>:
  // value que no aparece en options → el browser muestra el primer option
  // visualmente, pero el state sigue con el default y el RPC persiste contra
  // la cuenta invisible. Default vacío fuerza la elección consciente.
  // Si el usuario tiene un solo local autorizado, default a ese (aunque el
  // sidebar no haya seteado localActivo). Encargados no pueden cargar gastos
  // con local_id NULL (= todos), así que NO sirve dejar "" en ese caso.
  const lidImplicito: number | null = localActivo != null
    ? Number(localActivo)
    : (locsDisp.length === 1 ? Number(locsDisp[0]!.id) : null);
  const emptyForm = {
    fecha: toISO(today),
    local_id: lidImplicito != null ? String(lidImplicito) : "",
    categoria: "", tipo: "fijo", monto: "", detalle: "", cuenta: "",
    plantilla_id: null as number | null,
    // Feature 1: campos extra cuando tipo='empleado'
    empleado_id: "",
    concepto: "adelanto",
  };

  // Empleados visibles para el usuario.
  //
  // Bug fix 2026-05-20: antes este array traía TODOS los empleados visibles
  // (sin filtrar por local activo). Estando en Cantina René (que no tiene
  // empleados propios ni cesiones), aparecían los 54 empleados de todos
  // los locales de Neko. El fix filtra por el local efectivo del formulario:
  // si el sidebar tiene un local activo o el form lo eligió manualmente,
  // mostramos solo empleados cuyo `locales_ids` contiene ese local.
  // (El filtro RLS de defense-in-depth ya está en la vista server-side —
  // migration 202605211300.)
  const [empleadosVisibles, setEmpleadosVisibles] = useState<EmpleadoVisible[]>([]);
  useEffect(() => {
    (async () => {
      const { data } = await db.from('v_rrhh_empleados_visible')
        .select('id, nombre, local_principal_id, locales_ids')
        .eq('activo', true)
        .order('nombre');
      // Joineamos con rrhh_empleados para traer apellido
      if (data && data.length > 0) {
        const ids = data.map((e: { id: string }) => e.id);
        const { data: emps } = await db.from('rrhh_empleados')
          .select('id, apellido')
          .in('id', ids);
        const apMap = new Map((emps ?? []).map((e: { id: string; apellido: string }) => [e.id, e.apellido]));
        setEmpleadosVisibles(data.map((e: { id: string; nombre: string; local_principal_id: number; locales_ids: number[] | null }) => ({
          ...e,
          apellido: apMap.get(e.id),
        })));
      } else {
        setEmpleadosVisibles([]);
      }
    })();
  }, []);
  const [form, setForm] = useState(emptyForm);

  const emptyPagoPlant = { monto: "", fecha: toISO(today), cuenta: "" };
  const [pagoPlantForm, setPagoPlantForm] = useState(emptyPagoPlant);

  // Defensive: si por alguna razón form.cuenta queda con un valor que no
  // está en cuentasUsables (default viejo persistido en sessionStorage,
  // future regression, etc.), reseteamos a "" para que el placeholder
  // del <select> aparezca y el user tenga que elegir. NO borrar — esto
  // previene el retorno del bug Caja-1.
  useEffect(() => {
    if (form.cuenta && !cuentasUsables.includes(form.cuenta)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setForm(f => ({ ...f, cuenta: "" }));
    }
    if (pagoPlantForm.cuenta && !cuentasUsables.includes(pagoPlantForm.cuenta)) {
      setPagoPlantForm(p => ({ ...p, cuenta: "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.cuenta, pagoPlantForm.cuenta, cuentasUsables.join("|")]);

  const emptyPlantForm = { nombre: "", categoria: "", tipo: "fijo", local_id: "" };
  const [plantForm, setPlantForm] = useState(emptyPlantForm);

  const load = async () => {
    setLoading(true);
    // Optimización egress 2026-05-17: proyectar campos + limit 1000.
    let q = db.from("gastos")
      .select("id, fecha, local_id, categoria, tipo, monto, detalle, cuenta, estado, anulado_motivo, anulado_at, editado, editado_motivo, editado_at, plantilla_id")
      .gte("fecha", desde)
      .lte("fecha", hasta)
      .order("fecha", { ascending: false })
      .limit(1000);
    q = applyLocalScope(q, user, localActivo);
    const { data: g } = await q;
    let pq = db.from("gastos_plantillas")
      .select("id, nombre, categoria, tipo, local_id")
      .eq("activo", true)
      .order("nombre");
    pq = applyLocalScope(pq, user, localActivo);
    const { data: p } = await pq;
    setGastos(((g as GastoExt[]) || []).filter(g => g.categoria !== "SUELDOS"));
    setPlantillas((p as GastoPlantilla[]) || []);
    setLoading(false);
  };
  // Debounce de date pickers (C6) — evita fetches en cada tecla al editar.
  const debDesde = useDebouncedValue(desde, 300);
  const debHasta = useDebouncedValue(hasta, 300);
  // Patrón fetch-on-dep-change. No agregar load a deps (re-fetch infinito).
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [debDesde, debHasta, localActivo]);

  const histFiltrado = gastos.filter(g => {
    // Anulados: solo se ven si el toggle "Mostrar anulados" está activo y
    // el usuario tiene permiso ver_anulados.
    if (g.estado === "anulado" && !(mostrarAnulados && puedeVerAnulados)) return false;
    const matchTipo = tipoFiltro === "todos" || g.tipo === tipoFiltro;
    const matchSearch = !search ||
      g.categoria?.toLowerCase().includes(search.toLowerCase()) ||
      g.detalle?.toLowerCase().includes(search.toLowerCase());
    return matchTipo && matchSearch;
  });

  const totalPeriodo = histFiltrado.reduce((s, g) => s + (g.monto || 0), 0);

  const getEstadoPlantilla = (plantilla: GastoPlantilla) => {
    const pago = gastos.find(g => g.plantilla_id === plantilla.id);
    return pago ? { pagado: true, monto: pago.monto, fecha: pago.fecha } : { pagado: false };
  };

  const plantillasFiltradas = plantillas.filter(p => tipoFiltro === "todos" || p.tipo === tipoFiltro);
  const esPasado = hasta < toISO(today);

  const getTipo = () => tipoFiltro === "todos" ? form.tipo : tipoFiltro;

  // ─── ACCIONES ──────────────────────────────────────────────────────────────
  const guardar = async () => {
    if (saving) return;
    // ─── Validación amistosa con mensajes claros ────────────────────────
    // Bug fix 22-may noche (Anto): antes el botón hacía `return` silencioso
    // si !form.categoria → para tipo='empleado' (que usa `concepto` y no
    // categoria) el botón quedaba muerto sin avisar nada al user.
    const tipo = getTipo();
    if (!form.monto) { alert("Falta el monto"); return; }
    if (tipo === 'empleado') {
      if (!form.empleado_id) { alert("Seleccioná el empleado"); return; }
      if (!form.concepto) { alert("Seleccioná el concepto del pago"); return; }
    } else {
      if (!form.categoria) { alert("Seleccioná una categoría"); return; }
    }
    if (!form.cuenta) { alert("Elegí una cuenta de egreso"); return; }
    setSaving(true);
    try {
      const lid = form.local_id ? parseInt(form.local_id) : null;
      if (!lid) { alert("Seleccioná un local"); return; }

      // ─── Feature 1: tipo=empleado va por RPC dedicada que también escribe
      //     en rrhh_adelantos para que se descuente del sueldo. ──────────
      if (tipo === 'empleado') {
        if (!form.empleado_id) { alert("Seleccioná el empleado"); return; }
        if (!form.concepto) { alert("Seleccioná el concepto"); return; }
        const { error } = await db.rpc("crear_gasto_empleado", {
          p_local_id: lid,
          p_empleado_id: form.empleado_id,
          p_concepto: form.concepto,
          p_monto: parseFloat(form.monto),
          p_cuenta: form.cuenta,
          p_fecha: form.fecha,
          p_detalle: form.detalle || null,
          p_idempotency_key: idempKeyCrearGasto,
        });
        if (error) throw error;
        setModal(false); setForm(emptyForm); load();
        return;
      }

      const { error } = await db.rpc("crear_gasto", {
        p_fecha: form.fecha,
        p_local_id: lid,
        p_categoria: form.categoria,
        p_tipo: tipo,
        p_monto: parseFloat(form.monto),
        p_detalle: form.detalle || form.categoria,
        p_cuenta: form.cuenta,
        p_plantilla_id: form.plantilla_id || null,
        p_idempotency_key: idempKeyCrearGasto,
      });
      if (error) throw error;
      setModal(false); setForm(emptyForm); load();
    } catch (err) {
      console.error("Error guardando gasto:", err);
      alert(translateRpcError(err));
    } finally {
      setSaving(false);
    }
  };

  // ─── EDITAR / ANULAR GASTO (migration 202605122300) ──────────────────────
  const abrirEditar = (g: GastoExt) => {
    setEditModal({ ...g, justificativo: "" });
    setIdempKeyEditGasto(crypto.randomUUID());
  };

  // Pending override de editar gasto: si el user no tiene permiso
  // compras_anular, guardamos los args y abrimos el Manager Override
  // modal. Igual patrón que pendingAnularGasto.
  async function ejecutarEditarGasto(gasto: GastoExt & { justificativo: string }, overrideCode?: string) {
    const { error } = await db.rpc("editar_gasto", {
      p_gasto_id: gasto.id,
      p_fecha: gasto.fecha,
      p_categoria: gasto.categoria,
      p_tipo: gasto.tipo,
      p_monto: typeof gasto.monto === "number" ? gasto.monto : parseFloat(String(gasto.monto)),
      p_cuenta: gasto.cuenta,
      p_detalle: gasto.detalle || "",
      p_justificativo: gasto.justificativo,
      p_idempotency_key: idempKeyEditGasto,
      ...(overrideCode ? { p_override_code: overrideCode } : {}),
    });
    if (error) { alert(translateRpcError(error)); return; }
    showToast("Gasto editado · saldos actualizados");
    setEditModal(null);
    load();
  }

  const guardarEdit = async () => {
    if (savingEdit || !editModal) return;
    if (!editModal.justificativo?.trim()) { alert("El motivo de la edición es obligatorio"); return; }
    if (!editModal.cuenta || !editModal.categoria || !editModal.monto) {
      alert("Cuenta, categoría y monto son obligatorios"); return;
    }
    setSavingEdit(true);
    try {
      if (tienePermiso(user, "compras_anular")) {
        await ejecutarEditarGasto(editModal);
      } else {
        // No tiene permiso → abrir modal de Manager Override TOTP.
        setPendingEditarGasto(editModal);
      }
    } finally {
      setSavingEdit(false);
    }
  };

  // Pending override de anular gasto. Misma pattern que en Compras.
  const [pendingAnularGasto, setPendingAnularGasto] = useState<{ gasto: GastoExt; motivo: string } | null>(null);
  // Pending override de editar gasto (encargado sin permiso compras_anular).
  const [pendingEditarGasto, setPendingEditarGasto] = useState<GastoExt & { justificativo: string } | null>(null);

  async function ejecutarAnularGasto(g: GastoExt, motivo: string, overrideCode?: string) {
    const { error } = await db.rpc("anular_gasto", {
      p_gasto_id: g.id,
      p_motivo: motivo,
      ...(overrideCode ? { p_override_code: overrideCode } : {}),
    });
    if (error) { alert(translateRpcError(error)); return; }
    showToast("Gasto anulado · movimiento revertido");
    load();
  }

  const anularGasto = async (g: GastoExt) => {
    const motivo = prompt(`¿Por qué anulás el gasto ${g.categoria} de ${fmt_$(g.monto || 0)}? (obligatorio)`);
    if (!motivo?.trim()) return;
    if (tienePermiso(user, "compras_anular")) {
      await ejecutarAnularGasto(g, motivo);
    } else {
      setPendingAnularGasto({ gasto: g, motivo });
    }
  };

  const abrirPagarPlantilla = (p: GastoPlantilla) => {
    setPagarModal(p);
    setPagoPlantForm({ ...emptyPagoPlant, fecha: toISO(today) });
    setIdempKeyPagarPlant(crypto.randomUUID());
  };

  const confirmarPagoPlantilla = async () => {
    if (pagandoPlant || !pagarModal || !pagoPlantForm.monto) return;
    if (!pagoPlantForm.cuenta) { alert("Elegí una cuenta de egreso"); return; }
    setPagandoPlant(true);
    try {
      const monto = parseFloat(pagoPlantForm.monto);
      const { error } = await db.rpc("crear_gasto", {
        p_fecha: pagoPlantForm.fecha,
        p_local_id: pagarModal.local_id || null,
        p_categoria: pagarModal.categoria,
        p_tipo: pagarModal.tipo,
        p_monto: monto,
        p_detalle: pagarModal.nombre,
        p_cuenta: pagoPlantForm.cuenta,
        p_plantilla_id: pagarModal.id,
        p_idempotency_key: idempKeyPagarPlant,
      });
      if (error) throw error;
      setPagarModal(null); setPagoPlantForm(emptyPagoPlant); load();
    } catch (err) {
      console.error("Error pago plantilla:", err);
      alert(translateRpcError(err));
    } finally {
      setPagandoPlant(false);
    }
  };

  const guardarPlantilla = async () => {
    if (!plantForm.nombre || !plantForm.categoria) return;
    const payload: Omit<GastoPlantilla, "id"> = {
      nombre: plantForm.nombre,
      tipo: plantForm.tipo,
      categoria: plantForm.categoria,
      local_id: plantForm.local_id ? parseInt(plantForm.local_id) : null,
      activo: true,
    };
    await db.from("gastos_plantillas").insert([payload]);
    setPlantForm(emptyPlantForm); load();
  };

  const eliminarPlantilla = async (id: number) => {
    if (!confirm("¿Eliminar esta plantilla recurrente?")) return;
    await db.from("gastos_plantillas").update({ activo: false }).eq("id", id);
    load();
  };

  return (
    <div>
      <PageHeader
        title="Gastos"
        info={<>
          Egresos del local: fijos (alquiler, servicios), variables, publicidad, comisiones, impuestos
          y retiros de socios. Cada gasto crea un movimiento en caja y descuenta del saldo.
        </>}
        actions={
          <>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const headers = ["Fecha", "Local", "Categoría", "Tipo", "Cuenta", "Detalle", "Monto", "Estado"];
                const rows = gastos.map(g => [
                  g.fecha?.slice(0, 10) || "",
                  locales.find((l: Local) => l.id === g.local_id)?.nombre || "",
                  g.categoria || "",
                  g.tipo || "",
                  (g as { cuenta?: string }).cuenta || "",
                  g.detalle || "",
                  Number(g.monto ?? 0),
                  (g as { estado?: string; anulado_at?: string | null }).anulado_at ? "Anulado" : "OK",
                ]);
                exportCSV(`gastos_${debDesde}_${debHasta}.csv`, headers, rows);
              }}
              disabled={gastos.length === 0}
              title="Exportar gastos visibles a CSV"
            >⬇ Exportar</button>
            <button data-tour="gastos-nuevo" className="btn btn-acc" onClick={() => { setForm(emptyForm); setModal(true); setIdempKeyCrearGasto(crypto.randomUUID()); }}>
              + Cargar Gasto
            </button>
          </>
        }
      />

      {/* Filtros: búsqueda + rango fechas (con labels Desde/Hasta) + dropdown de tipo. */}
      <div style={{display:"flex",gap:8,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
        <input className="search" placeholder="Buscar..." value={search} onChange={e=>setSearch(e.target.value)} style={{width:140}}/>
        <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--muted2)"}}>
          Desde
          <input type="date" className="search" value={desde} onChange={e=>setDesde(e.target.value)} style={{width:130}}/>
        </label>
        <span style={{fontSize:11,color:"var(--muted)"}}>→</span>
        <label style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--muted2)"}}>
          Hasta
          <input type="date" className="search" value={hasta} onChange={e=>setHasta(e.target.value)} style={{width:130}}/>
        </label>
        <div style={{width:1,height:14,background:"var(--bd)",margin:"0 4px"}}/>
        <div style={{width:200}}>
          <Combobox
            value={tipoFiltro==="todos"?"":tipoFiltro}
            onChange={v=>setTipoFiltro(v||"todos")}
            options={TIPOS.filter(t=>t.id!=="todos").map(t=>({value:t.id,label:t.label}))}
            placeholder="Todos los tipos"
            clearable
          />
        </div>
      </div>

      {/* Recurrentes del período */}
      {!search && plantillasFiltradas.length > 0 && (
        <div className="section">
          <div className="section-hd">
            <span className="section-title">Recurrentes del período</span>
            <span className="section-total">{plantillasFiltradas.filter(p => getEstadoPlantilla(p).pagado).length} de {plantillasFiltradas.length} pagados</span>
          </div>
          <div className="panel">
            {plantillasFiltradas.map(p => {
              const estado = getEstadoPlantilla(p);
              return (
                <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 14px", borderBottom: "1px solid var(--bd)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ width: 15, height: 15, borderRadius: 4, border: "1px solid var(--bd2)", background: estado.pagado ? "var(--s3)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {estado.pagado && <div style={{ width: 7, height: 7, borderRadius: 2, background: "var(--acc)" }} />}
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: estado.pagado ? "var(--muted2)" : esPasado && !estado.pagado ? "var(--danger)" : "var(--txt)", textDecoration: estado.pagado ? "line-through" : "none" }}>{p.nombre}</div>
                      <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 1 }}>{p.categoria}{p.local_id ? " · " + locales.find((l: Local) => l.id === p.local_id)?.nombre : " · Todos"}</div>
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {estado.pagado && <span style={{ fontSize: 12, fontWeight: 500, color: "var(--muted2)" }}>{fmt_$(estado.monto)}</span>}
                    {!estado.pagado && esPasado && <span style={{ fontSize: 11, color: "var(--danger)" }}>No registrado</span>}
                    {!estado.pagado && !esPasado && <button className="btn btn-ghost btn-sm" onClick={() => abrirPagarPlantilla(p)}>Pagar</button>}
                  </div>
                </div>
              );
            })}
            <div data-tour="gastos-plantillas" style={{ padding: "9px 14px", fontSize: 11, color: "var(--muted2)", cursor: "pointer", borderTop: "1px solid var(--bd)" }} onClick={() => setGestionarModal(true)}>
              + Gestionar recurrentes
            </div>
          </div>
        </div>
      )}

      {/* Historial */}
      <div className="section">
        <div className="section-hd">
          <span className="section-title">Historial</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {puedeVerAnulados && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted2)", cursor: "pointer" }}>
                <input type="checkbox" checked={mostrarAnulados} onChange={e => setMostrarAnulados(e.target.checked)} />
                Mostrar anulados
              </label>
            )}
            <span className="section-total">{histFiltrado.length} movimientos · {fmt_$(totalPeriodo)}</span>
          </div>
        </div>
        <div className="panel">
          {loading ? <div className="loading">Cargando...</div> : histFiltrado.length === 0 ? (
            <EmptyState
              icon="📭"
              title="Sin movimientos en el período"
              description="No hay gastos cargados en el rango de fechas. Probá ampliar el rango o cargar un gasto."
            />
          ) : (
            <table>
              <thead><tr><th className="col-fecha">Fecha</th><th>Tipo</th><th>Categoría</th><th>Detalle</th><th>Local</th><th>Cuenta</th><th className="num-right">Monto</th><th></th></tr></thead>
              <tbody>{histFiltrado.map(g => {
                const anulado = g.estado === "anulado";
                return (
                <tr key={g.id} style={anulado ? { opacity: 0.5, textDecoration: "line-through" } : undefined}>
                  <td className="mono">{fmt_d(g.fecha)}</td>
                  <td>
                    <TipoPill tipo={g.tipo} />
                    {/* Badges sutiles: solo borde + texto, sin fondo lleno.
                        Lucas 2026-05-19: minimalista, que no compita visualmente
                        con el badge del tipo. */}
                    {anulado && (
                      <span
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
                    {g.editado && !anulado && (
                      <span
                        title={g.editado_motivo || ""}
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
                        }}
                      >editado</span>
                    )}
                  </td>
                  <td style={{ fontSize: 11 }}>{g.categoria}</td>
                  <td style={{ fontSize: 11, color: "var(--muted2)" }}>{g.detalle || "—"}</td>
                  <td style={{ fontSize: 11, color: "var(--muted2)" }}>{locales.find((l: Local) => String(l.id) === String(g.local_id))?.nombre || "Todos"}</td>
                  <td style={{ fontSize: 11, color: "var(--muted2)" }}>{g.cuenta || "—"}</td>
                  <td className="num-right">{fmt_$(g.monto)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                      {/* Botones siempre visibles. Si el user no tiene
                          compras_anular, los handlers abren el modal de
                          Manager Override pidiendo código TOTP del dueño.
                          Decisión Lucas 2026-05-19: la ausencia de permiso
                          NO oculta la acción, solo la gatea con código. */}
                      {!anulado && <button className="btn btn-ghost btn-sm" onClick={() => abrirEditar(g)}>Editar</button>}
                      {!anulado && <button className="btn btn-danger btn-sm" onClick={() => anularGasto(g)}>Anular</button>}
                    </div>
                  </td>
                </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
      </div>

      {/* MODAL EDITAR GASTO */}
      {editModal && (
        <div className="overlay" onClick={() => setEditModal(null)}>
          <div className="modal" style={{ width: 480 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">Editar gasto</div>
              <button className="close-btn" onClick={() => setEditModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="alert alert-warn" style={{ marginBottom: 12 }}>
                Cambiar cuenta o monto ajusta automáticamente los saldos en Tesorería (revierte el viejo + aplica el nuevo).
              </div>
              <div className="field"><label>Fecha</label>
                <input type="date" value={editModal.fecha || ""} onChange={e => setEditModal({ ...editModal, fecha: e.target.value })} />
              </div>
              <div className="field"><label>Categoría</label>
                <Combobox
                  value={editModal.categoria || ""}
                  onChange={v => setEditModal({ ...editModal, categoria: v })}
                  options={ALL_CATS.map(c => ({ value: c, label: c }))}
                  placeholder="Buscar..."
                  clearable
                />
              </div>
              <div className="field"><label>Monto</label>
                <input type="number" step="0.01" value={editModal.monto || ""} onChange={e => setEditModal({ ...editModal, monto: parseFloat(e.target.value) || 0 })} />
              </div>
              <div className="field"><label>Cuenta de egreso</label>
                <select value={editModal.cuenta || ""} onChange={e => setEditModal({ ...editModal, cuenta: e.target.value })}>
                  <option value="" disabled>Seleccionar...</option>
                  {cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="field"><label>Detalle</label>
                <input value={editModal.detalle || ""} onChange={e => setEditModal({ ...editModal, detalle: e.target.value })} />
              </div>
              <div className="field"><label>Motivo de la edición *</label>
                <input value={editModal.justificativo} onChange={e => setEditModal({ ...editModal, justificativo: e.target.value })} placeholder="Por qué editás (queda en auditoría)..." />
              </div>
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setEditModal(null)} disabled={savingEdit}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardarEdit} disabled={savingEdit}>{savingEdit ? "Guardando..." : "Guardar cambios"}</button>
            </div>
          </div>
        </div>
      )}

      <ToastComponent toast={toast} />

      {/* Modal cargar gasto manual */}
      {modal && (
        <div className="overlay" onClick={() => setModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Cargar Gasto</div><button className="close-btn" onClick={() => setModal(false)}>✕</button></div>
            <div className="modal-body">
              <div style={{fontSize:11,color:"var(--muted2)",padding:"8px 10px",background:"var(--s2)",borderRadius:"var(--r)",marginBottom:12,lineHeight:1.5}}>
                Al cargar acá se registra el gasto <b>y</b> el movimiento de caja correspondiente. No lo cargues también desde Tesorería.
              </div>
              <div className="form2">
                {tipoFiltro === "todos" && (
                  <div className="field"><label>Tipo *</label>
                    <select value={form.tipo} onChange={e => setForm({ ...form, tipo: e.target.value, categoria: "" })}>
                      {TIPOS.filter(t => t.id !== "todos").map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                )}
                {/* Tipo "empleado" → dropdowns específicos. Otros tipos → categoría normal. */}
                {(tipoFiltro === "todos" ? form.tipo : tipoFiltro) === 'empleado' ? (
                  <>
                    <div className="field"><label>Concepto *</label>
                      <select value={form.concepto} onChange={e => setForm({ ...form, concepto: e.target.value })}>
                        {CONCEPTOS_EMPLEADO.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </div>
                    <div className="field"><label>Empleado *</label>
                      {(() => {
                        // Local efectivo del form: el activo del sidebar > el elegido en el form.
                        const localEff: number | null = localActivo != null
                          ? Number(localActivo)
                          : (form.local_id ? Number(form.local_id) : null);
                        // Si hay local seleccionado, mostrar solo empleados que trabajan
                        // en ese local (principal o cesión). Si no hay local (caso
                        // "Todos"), mostrar todos los visibles.
                        const empsFiltrados = localEff != null
                          ? empleadosVisibles.filter(emp =>
                              (emp.locales_ids ?? [emp.local_principal_id]).includes(localEff),
                            )
                          : empleadosVisibles;
                        return (
                          <>
                            <select value={form.empleado_id} onChange={e => setForm({ ...form, empleado_id: e.target.value })}>
                              <option value="">Seleccioná…</option>
                              {empsFiltrados.map(emp => (
                                <option key={emp.id} value={emp.id}>
                                  {emp.apellido ? `${emp.apellido}, ${emp.nombre}` : emp.nombre}
                                  {/* Si es cesión (no su local principal): marca visual */}
                                  {localEff !== null && localEff !== emp.local_principal_id ? ' ◆ cedido' : ''}
                                </option>
                              ))}
                            </select>
                            {empsFiltrados.length === 0 && (
                              <div style={{ fontSize: 11, color: 'var(--warn, #d29922)', marginTop: 4 }}>
                                Este local no tiene empleados asignados ni cedidos. Si necesitás
                                cargar un gasto de un empleado de otro local, asignalo desde
                                RRHH → Legajo del empleado → Cesiones.
                              </div>
                            )}
                            {empsFiltrados.length > 0 && (
                              <div style={{ fontSize: 11, color: 'var(--muted2)', marginTop: 4 }}>
                                Se cargará en Novedades y se descontará del próximo sueldo automáticamente.
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                  </>
                ) : (
                  <div className="field"><label>Categoría *</label>
                    <select value={form.categoria} onChange={e => setForm({ ...form, categoria: e.target.value })}>
                      <option value="">Seleccioná...</option>
                      {catsByTipo(tipoFiltro === "todos" ? form.tipo : tipoFiltro).map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                )}
                {/* Sucursal: 3 estados (acordado Lucas 2026-05-17):
                    1) User con 1 solo local → input fijo (sin elección).
                    2) Sidebar tiene sucursal seleccionada → chip LOCKED.
                    3) Sidebar "Todas" → selector OBLIGATORIO (no permite vacío).
                    Para mantener compat con el resto del save (que usa form.local_id
                    string), el chip y el selector escriben acá igual. */}
                {locsDisp.length === 1 ? (
                  <div className="field"><label>Local</label>
                    <input type="text" value={locsDisp[0]!.nombre} disabled readOnly />
                  </div>
                ) : localActivo !== null ? (
                  <div className="field"><label>Local</label>
                    <div style={{ paddingTop: 4 }}>
                      <LocalLockedChip nombre={locales.find(l => l.id === localActivo)?.nombre ?? "—"} />
                    </div>
                  </div>
                ) : (
                  <div className="field"><label>Local *</label>
                    <LocalSelectorObligatorio
                      value={form.local_id ? Number(form.local_id) : null}
                      onChange={id => setForm({ ...form, local_id: id !== null ? String(id) : "" })}
                      locales={locsDisp}
                    />
                  </div>
                )}
              </div>
              <div className="form2">
                <div className="field"><label>Fecha</label><input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} /></div>
                <div className="field"><label>Cuenta de egreso *</label>
                  <select value={form.cuenta} onChange={e => setForm({ ...form, cuenta: e.target.value })}>
                    <option value="">Seleccioná una cuenta…</option>
                    {cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div className="field"><label>Monto $</label><input type="number" value={form.monto} onChange={e => setForm({ ...form, monto: e.target.value })} placeholder="0" /></div>
              <div className="field"><label>Detalle (opcional)</label><input value={form.detalle} onChange={e => setForm({ ...form, detalle: e.target.value })} placeholder="Descripción..." /></div>
            </div>
            {/* Hint visible si el botón está disabled — Anto no entendía por qué
                no respondía al tocar Guardar. Acordado 22-may noche con Lucas. */}
            {(() => {
              const tEff = tipoFiltro === "todos" ? form.tipo : tipoFiltro;
              const faltantes: string[] = [];
              if (!form.cuenta) faltantes.push("cuenta de egreso");
              if (!form.monto) faltantes.push("monto");
              if (locsDisp.length > 1 && localActivo === null && !form.local_id) faltantes.push("local");
              if (tEff === 'empleado') {
                if (!form.concepto) faltantes.push("concepto");
                if (!form.empleado_id) faltantes.push("empleado");
              } else {
                if (!form.categoria) faltantes.push("categoría");
              }
              if (faltantes.length === 0) return null;
              return (
                <div style={{
                  margin: "0 14px 8px",
                  padding: "8px 12px",
                  background: "rgba(210,150,30,0.1)",
                  border: "1px solid rgba(210,150,30,0.3)",
                  borderRadius: 6,
                  fontSize: 12,
                  color: "var(--warn, #d29922)",
                }}>
                  ⚠️ Falta completar: <strong>{faltantes.join(", ")}</strong>
                  {tEff === 'empleado' && !form.empleado_id && (
                    <div style={{ fontSize: 11, marginTop: 4, color: "var(--muted2)" }}>
                      ¿Es un gasto general de RRHH (juicios, abogados, indemnizaciones genéricas)?
                      Cambiá <strong>Tipo</strong> a <em>Gastos Fijos</em> y elegí la categoría correspondiente.
                    </div>
                  )}
                </div>
              );
            })()}
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setModal(false)}>Cancelar</button><button
              className="btn btn-acc"
              onClick={guardar}
              disabled={(() => {
                if (saving || !form.cuenta || !form.monto) return true;
                if (locsDisp.length > 1 && localActivo === null && !form.local_id) return true;
                const tEff = tipoFiltro === "todos" ? form.tipo : tipoFiltro;
                if (tEff === 'empleado') {
                  return !form.empleado_id || !form.concepto;
                }
                return !form.categoria;
              })()}
            >{saving ? "Guardando..." : "Guardar"}</button></div>
          </div>
        </div>
      )}

      {/* Modal pagar recurrente */}
      {pagarModal && (
        <div className="overlay" onClick={() => setPagarModal(null)}>
          <div className="modal" style={{ width: 460 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Pagar — {pagarModal.nombre}</div><button className="close-btn" onClick={() => setPagarModal(null)}>✕</button></div>
            <div className="modal-body">
              <div className="alert alert-info" style={{ marginBottom: 14 }}>
                {pagarModal.categoria} · {pagarModal.tipo} · {pagarModal.local_id ? locales.find((l: Local) => l.id === pagarModal.local_id)?.nombre : "Todas las sucursales"}
              </div>
              <div className="form2">
                <div className="field"><label>Monto $ *</label><input type="number" value={pagoPlantForm.monto} onChange={e => setPagoPlantForm({ ...pagoPlantForm, monto: e.target.value })} placeholder="0" /></div>
                <div className="field"><label>Fecha</label><input type="date" value={pagoPlantForm.fecha} onChange={e => setPagoPlantForm({ ...pagoPlantForm, fecha: e.target.value })} /></div>
              </div>
              <div className="field"><label>Cuenta de egreso *</label>
                <select value={pagoPlantForm.cuenta} onChange={e => setPagoPlantForm({ ...pagoPlantForm, cuenta: e.target.value })}>
                  <option value="">Seleccioná una cuenta…</option>
                  {cuentasUsables.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setPagarModal(null)}>Cancelar</button><button className="btn btn-acc" onClick={confirmarPagoPlantilla} disabled={pagandoPlant || !pagoPlantForm.cuenta || !pagoPlantForm.monto}>{pagandoPlant ? "Procesando..." : "Confirmar pago"}</button></div>
          </div>
        </div>
      )}

      {/* Modal gestionar recurrentes */}
      {gestionarModal && (
        <div className="overlay" onClick={() => setGestionarModal(false)}>
          <div className="modal" style={{ width: 620 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd"><div className="modal-title">Gestionar recurrentes</div><button className="close-btn" onClick={() => setGestionarModal(false)}>✕</button></div>
            <div className="modal-body">
              {plantillas.length > 0 && (
                <table style={{ marginBottom: 16 }}>
                  <thead><tr><th>Nombre</th><th>Tipo</th><th>Categoría</th><th>Local</th><th></th></tr></thead>
                  <tbody>{plantillas.map(p => (
                    <tr key={p.id}>
                      <td style={{ fontSize: 12 }}>{p.nombre}</td>
                      <td><TipoPill tipo={p.tipo} /></td>
                      <td style={{ fontSize: 11, color: "var(--muted2)" }}>{p.categoria}</td>
                      <td style={{ fontSize: 11, color: "var(--muted2)" }}>{locales.find((l: Local) => l.id === p.local_id)?.nombre || "Todos"}</td>
                      <td><button className="btn btn-danger btn-sm" onClick={() => eliminarPlantilla(p.id)}>X</button></td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
              <div style={{ borderTop: "1px solid var(--bd)", paddingTop: 14 }}>
                <div className="section-title" style={{ marginBottom: 10 }}>Nueva plantilla</div>
                <div className="form2">
                  <div className="field"><label>Nombre *</label><input value={plantForm.nombre} onChange={e => setPlantForm({ ...plantForm, nombre: e.target.value })} placeholder="Ej: Alquiler local" /></div>
                  <div className="field"><label>Tipo *</label>
                    <select value={plantForm.tipo} onChange={e => setPlantForm({ ...plantForm, tipo: e.target.value, categoria: "" })}>
                      {TIPOS.filter(t => t.id !== "todos").map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                </div>
                <div className="form2">
                  <div className="field"><label>Categoría *</label>
                    <select value={plantForm.categoria} onChange={e => setPlantForm({ ...plantForm, categoria: e.target.value })}>
                      <option value="">Seleccioná...</option>
                      {catsByTipo(plantForm.tipo).map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="field"><label>Local</label>
                    <select value={plantForm.local_id} onChange={e => setPlantForm({ ...plantForm, local_id: e.target.value })}>
                      <option value="">Todos</option>
                      {locsDisp.map((l: Local) => <option key={l.id} value={l.id}>{l.nombre}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button className="btn btn-acc btn-sm" onClick={guardarPlantilla}>Agregar</button>
                </div>
              </div>
            </div>
            <div className="modal-ft"><button className="btn btn-sec" onClick={() => setGestionarModal(false)}>Cerrar</button></div>
          </div>
        </div>
      )}

      {/* MODAL MANAGER OVERRIDE — para anular gasto sin permiso compras_anular */}
      <ManagerOverrideModal
        open={pendingAnularGasto !== null}
        descripcion={pendingAnularGasto ? `Anular gasto ${pendingAnularGasto.gasto.categoria} de ${fmt_$(pendingAnularGasto.gasto.monto || 0)}` : undefined}
        onClose={() => setPendingAnularGasto(null)}
        onValidated={async (codigo) => {
          if (!pendingAnularGasto) return;
          const { gasto, motivo } = pendingAnularGasto;
          setPendingAnularGasto(null);
          await ejecutarAnularGasto(gasto, motivo, codigo);
        }}
      />

      {/* MODAL MANAGER OVERRIDE — para editar gasto sin permiso compras_anular */}
      <ManagerOverrideModal
        open={pendingEditarGasto !== null}
        descripcion={pendingEditarGasto
          ? `Editar gasto ${pendingEditarGasto.categoria} → ${fmt_$(typeof pendingEditarGasto.monto === 'number' ? pendingEditarGasto.monto : parseFloat(String(pendingEditarGasto.monto)) || 0)}`
          : undefined}
        onClose={() => setPendingEditarGasto(null)}
        onValidated={async (codigo) => {
          if (!pendingEditarGasto) return;
          const gasto = pendingEditarGasto;
          setPendingEditarGasto(null);
          await ejecutarEditarGasto(gasto, codigo);
        }}
      />
    </div>
  );
}