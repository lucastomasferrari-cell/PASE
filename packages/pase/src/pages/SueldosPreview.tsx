// ─────────────────────────────────────────────────────────────────────────
// MOCKUP INTERACTIVO — Rediseño RRHH (sueldos unificados)
// ─────────────────────────────────────────────────────────────────────────
//
// Pantalla SANDBOX que reemplaza visualmente los 3 tabs actuales
// (Empleados / Novedades / Pagos) por UNA sola pantalla de Sueldos donde:
//   - Cada empleado es una card con su slot de cobro (Q1/Q2/Mes)
//   - Al expandir: novedades + adelantos + cálculo en vivo
//   - "Pagar" abre modal con líneas de pago + checkboxes de adelantos
//   - NO existe "confirmar novedad" — autosave silencioso (en este mockup,
//     los cambios solo viven en memoria del browser, NO persisten en DB).
//
// READ-ONLY: lee empleados/novedades/adelantos reales del tenant del user,
// pero las interacciones (cambiar inputs, tildar adelantos, "pagar") son
// solo client-side. Reset al recargar.
//
// Ruta: /sueldos-preview  (deliberadamente fuera del sidebar)
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { db } from "../lib/supabase";
import { fmt_$, fmt_d, toISO } from "@pase/shared/utils";
import { today } from "../lib/utils";
import { Modal } from "../components/ui";

// ── Tipos locales (mínimo necesario para el mockup) ────────────────────────
interface Emp {
  id: string;
  nombre: string;
  apellido: string;
  puesto: string;
  sueldo_mensual: number;
  modo_pago: "MENSUAL" | "QUINCENAL" | "SEMANAL";
  local_id: number | null;
  activo: boolean;
  alias_mp?: string | null;
}
interface Adel {
  id: string;
  empleado_id: string;
  fecha: string;
  monto: number;
  cuenta: string | null;
  descontado: boolean;
  auto_aplicar?: boolean;
  concepto?: string | null;
}
// En el sistema real: rrhh_liquidaciones se vincula a rrhh_novedades por
// novedad_id. mes/anio/cuota_num/cuotas_total viven en rrhh_novedades.
// Para el mockup unimos los datos abajo en la carga.
interface Liq {
  empleado_id: string;
  cuota_num: number;
  cuotas_total: number;
  estado: "pendiente" | "pagado";
}
interface Local {
  id: number;
  nombre: string;
}

// ── Helpers UI ──────────────────────────────────────────────────────────────
function fechaFinPeriodo(anio: number, mes: number, cuotaNum: number, cuotasTotal: number): string {
  if (cuotasTotal === 1) {
    const ult = new Date(anio, mes, 0).getDate();
    return `${anio}-${String(mes).padStart(2, "0")}-${String(ult).padStart(2, "0")}`;
  }
  if (cuotaNum === 1) return `${anio}-${String(mes).padStart(2, "0")}-15`;
  const ult = new Date(anio, mes, 0).getDate();
  return `${anio}-${String(mes).padStart(2, "0")}-${String(ult).padStart(2, "0")}`;
}
function fechaInicioPeriodo(anio: number, mes: number, cuotaNum: number, cuotasTotal: number): string {
  if (cuotasTotal === 1 || cuotaNum === 1) return `${anio}-${String(mes).padStart(2, "0")}-01`;
  return `${anio}-${String(mes).padStart(2, "0")}-16`;
}
function labelSlot(cuotaNum: number, cuotasTotal: number): string {
  if (cuotasTotal === 1) return "Mes";
  return cuotaNum === 1 ? "Q1" : "Q2";
}
function nombreMes(m: number): string {
  return ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"][m - 1] || "";
}

// State editable por slot (cuotaKey = `${empId}__${cuota}`)
interface NovEdit {
  inasistencias: number;
  horas_extras: number;
  dobles: number;
  feriados: number;
  presentismo_mantiene: boolean;
  otros_desc: number;
  obs: string;
}
const NOV_VACIA: NovEdit = {
  inasistencias: 0, horas_extras: 0, dobles: 0, feriados: 0,
  presentismo_mantiene: true, otros_desc: 0, obs: "",
};

function calcularTotal(emp: Emp, nov: NovEdit, cuotasTotal: number, adelantosATildar: number): number {
  const baseCuota = emp.sueldo_mensual / cuotasTotal;
  const diasMes = 30;
  const valorDia = emp.sueldo_mensual / diasMes / cuotasTotal;
  const valorHora = valorDia / 8;
  const valorDoble = valorDia * 1.5;

  const descInas = nov.inasistencias * valorDia;
  const ingrExtras = nov.horas_extras * valorHora * 1.5;
  const ingrDobles = nov.dobles * valorDoble;
  const ingrFeriados = nov.feriados * valorDia * 2;

  const subtotal1 = baseCuota - descInas + ingrExtras + ingrDobles + ingrFeriados;
  const presentismo = nov.presentismo_mantiene ? subtotal1 * 0.05 : 0;
  const subtotal2 = subtotal1 + presentismo;
  const total = subtotal2 - nov.otros_desc - adelantosATildar;
  return Math.max(0, Math.round(total));
}

// ── Componente principal ────────────────────────────────────────────────────
export default function SueldosPreview() {
  // Filtros
  const now = new Date();
  const [mes, setMes] = useState(now.getMonth() + 1);
  const [anio, setAnio] = useState(now.getFullYear());
  // Respetar el local activo del sidebar (App.tsx lo guarda en sessionStorage).
  // Sin esto, el mockup arranca con el primer local alfabéticamente (puede ser
  // "Local Prueba" con 2 empleados) en vez del que el user está mirando.
  const sidebarLocalRaw = typeof sessionStorage !== "undefined"
    ? sessionStorage.getItem("pase_local_activo")
    : null;
  const sidebarLocalId = sidebarLocalRaw ? parseInt(sidebarLocalRaw) : null;
  const [localId, setLocalId] = useState<number | null>(sidebarLocalId);
  const [filtroEstado, setFiltroEstado] = useState<"todos" | "pendientes" | "pagados">("pendientes");

  // Data real desde DB
  const [empleados, setEmpleados] = useState<Emp[]>([]);
  const [adelantos, setAdelantos] = useState<Adel[]>([]);
  const [liqs, setLiqs] = useState<Liq[]>([]);
  const [locales, setLocales] = useState<Local[]>([]);
  const [cuentas, setCuentas] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  // State local (mockup — no persiste)
  const [novEdits, setNovEdits] = useState<Record<string, NovEdit>>({});
  const [adelantosOverrides, setAdelantosOverrides] = useState<Record<string, Partial<Adel>>>({});
  const [adelantosNuevos, setAdelantosNuevos] = useState<Adel[]>([]);
  const [liqsLocal, setLiqsLocal] = useState<Record<string, "pendiente" | "pagado">>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [authError, setAuthError] = useState<string | null>(null);
  // Cargar locales + cuentas
  // Fix race condition: en /sueldos-preview cargado en frío, la query corre
  // antes de hidratar la sesión → RLS devuelve 0 sin error. Esperamos getSession
  // primero y reintentamos si vuelve vacío (mismo patrón que App.tsx).
  // Detección de JWT roto: si la query devuelve 401/403/406, mostrar
  // mensaje claro para que el user se relogee (no quedar colgado).
  useEffect(() => {
    (async () => {
      await db.auth.getSession();
      let locArr: Local[] = [];
      let lastErr: { code?: string; message?: string } | null = null;
      for (let intento = 0; intento < 4; intento++) {
        const { data: locs, error } = await db.from("locales").select("id, nombre").order("nombre");
        if (error) {
          lastErr = error as { code?: string; message?: string };
          // Detectar errores de autorización irrecuperables sin re-login
          const code = error.code || "";
          const msg = (error.message || "").toLowerCase();
          if (code === "PGRST116" || msg.includes("jwt") || msg.includes("unauthor") || msg.includes("permission")) {
            setAuthError(`${code || "AUTH"}: ${error.message || "tu sesión está vencida"}`);
            setLoading(false);
            return;
          }
        }
        locArr = (locs || []) as Local[];
        if (locArr.length > 0) break;
        await new Promise(r => setTimeout(r, 200 * Math.pow(2, intento)));
      }
      setLocales(locArr);
      if (locArr.length > 0 && !localId && locArr[0]) {
        setLocalId(locArr[0].id);
      } else if (locArr.length === 0) {
        if (lastErr) {
          setAuthError(`Sin locales y query falló: ${lastErr.message || "sesión inválida"}`);
        }
        setLoading(false);
      }
      // Cuentas: hardcoded en el sistema real (CUENTAS_PAGO en lib/cuentas).
      // En el mockup uso las mismas para que se vean iguales.
      setCuentas(["Caja Efectivo", "Banco", "MercadoPago", "Caja Chica", "Caja Mayor"]);
    })();
  }, [localId]);

  // Cargar empleados + adelantos + liqs cuando cambia mes/local
  useEffect(() => {
    if (!localId) return;
    (async () => {
      setLoading(true);
      const { data: emps } = await db.from("rrhh_empleados")
        .select("id, nombre, apellido, puesto, sueldo_mensual, modo_pago, local_id, activo, alias_mp")
        .eq("activo", true)
        .eq("local_id", localId)
        .order("apellido");
      setEmpleados((emps || []) as Emp[]);

      // Adelantos de empleados del local, en el mes y ±1 mes (para mostrar futuros/atrasados)
      const empIds = ((emps || []) as Emp[]).map(e => e.id);
      if (empIds.length > 0) {
        const desde = `${anio}-${String(mes).padStart(2, "0")}-01`;
        const hastaMes = new Date(anio, mes, 0).getDate();
        const hasta = `${anio}-${String(mes).padStart(2, "0")}-${hastaMes}`;
        // Campo `concepto` (NO `detalle` — esa columna no existe en prod).
        const { data: ads } = await db.from("rrhh_adelantos")
          .select("id, empleado_id, fecha, monto, cuenta, descontado, auto_aplicar, concepto")
          .in("empleado_id", empIds)
          .eq("descontado", false)
          .gte("fecha", desde)
          .lte("fecha", hasta);
        setAdelantos((ads || []) as Adel[]);
      } else {
        setAdelantos([]);
      }

      // Estado de pago: mes/anio/cuota viven en rrhh_novedades, estado en
      // rrhh_liquidaciones (vinculado por novedad_id). Cargamos novedades del
      // período con su liquidación nested y derivamos el estado por slot.
      const { data: ns } = await db.from("rrhh_novedades")
        .select("empleado_id, cuota_num, cuotas_total, rrhh_liquidaciones(estado)")
        .eq("mes", mes).eq("anio", anio);
      type NovRow = { empleado_id: string; cuota_num: number | null; cuotas_total: number | null;
        rrhh_liquidaciones: { estado: string }[] | null };
      const liqsArr: Liq[] = ((ns || []) as NovRow[]).map(n => {
        const liqs = n.rrhh_liquidaciones || [];
        const pagado = liqs.some(l => l.estado === "pagado");
        return {
          empleado_id: n.empleado_id,
          cuota_num: n.cuota_num ?? 1,
          cuotas_total: n.cuotas_total ?? 1,
          estado: pagado ? "pagado" : "pendiente",
        };
      });
      setLiqs(liqsArr);

      setLoading(false);
    })();
  }, [mes, anio, localId]);

  // Construir lista de "slots" (1 fila por cuota: mensual=1 slot, quincenal=2)
  const slots = useMemo(() => {
    const out: { emp: Emp; cuota: number; cuotasTotal: number; key: string }[] = [];
    for (const e of empleados) {
      const ct = e.modo_pago === "QUINCENAL" ? 2 : 1;
      for (let c = 1; c <= ct; c++) {
        out.push({ emp: e, cuota: c, cuotasTotal: ct, key: `${e.id}__${c}` });
      }
    }
    return out;
  }, [empleados]);

  // Adelantos visibles por slot (todos los pendientes del empleado, pre-tildados solo los del período)
  function adelantosDelSlot(empId: string, cuota: number, cuotasTotal: number) {
    const fin = fechaFinPeriodo(anio, mes, cuota, cuotasTotal);
    const ini = fechaInicioPeriodo(anio, mes, cuota, cuotasTotal);
    const todos = [...adelantos.filter(a => a.empleado_id === empId), ...adelantosNuevos.filter(a => a.empleado_id === empId)];
    return todos.map(a => {
      const o = adelantosOverrides[a.id] || {};
      return { ...a, ...o, _entraPeriodo: a.fecha >= ini && a.fecha <= fin };
    });
  }

  // IDs de adelantos tildados por slot (state)
  const [tildados, setTildados] = useState<Record<string, Set<string>>>({});
  // Inicializar tildados cuando aparecen adelantos (pre-tildar los del período + auto_aplicar)
  useEffect(() => {
    const next: Record<string, Set<string>> = {};
    for (const s of slots) {
      const adels = adelantosDelSlot(s.emp.id, s.cuota, s.cuotasTotal);
      const set = new Set<string>();
      for (const a of adels) {
        if (a._entraPeriodo && (a.auto_aplicar !== false)) set.add(a.id);
      }
      next[s.key] = set;
    }
    setTildados(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots.length, adelantos.length, adelantosNuevos.length]);

  // Liq estado (real DB + overrides del mockup)
  function estadoSlot(empId: string, cuota: number): "pendiente" | "pagado" {
    const key = `${empId}__${cuota}`;
    if (key in liqsLocal) return liqsLocal[key] ?? "pendiente";
    const liq = liqs.find(l => l.empleado_id === empId && l.cuota_num === cuota);
    return liq?.estado === "pagado" ? "pagado" : "pendiente";
  }

  // Slots filtrados (legacy, lo dejo por si alguien lo usa). Filtro real
  // de visualización: empleadosVisibles abajo (agrupa slots por empleado).
  const slotsFiltrados = useMemo(() => {
    return slots.filter(s => {
      const est = estadoSlot(s.emp.id, s.cuota);
      if (filtroEstado === "pendientes" && est !== "pendiente") return false;
      if (filtroEstado === "pagados" && est !== "pagado") return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, filtroEstado, liqsLocal, liqs]);

  // Agrupar por empleado para mostrar UNA card unificada (Q1+Q2 juntas).
  // Filtro: el empleado aparece si AL MENOS UNA cuota matchea el filtro.
  const empleadosVisibles = useMemo(() => {
    type Grupo = { emp: Emp; slots: typeof slots };
    const map = new Map<string, Grupo>();
    for (const s of slots) {
      const est = estadoSlot(s.emp.id, s.cuota);
      if (filtroEstado === "pendientes" && est !== "pendiente") continue;
      if (filtroEstado === "pagados" && est !== "pagado") continue;
      if (!map.has(s.emp.id)) map.set(s.emp.id, { emp: s.emp, slots: [] });
      map.get(s.emp.id)!.slots.push(s);
    }
    return Array.from(map.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, filtroEstado, liqsLocal, liqs]);

  // Tab activo (Q1/Q2) por empleado cuando se expande
  const [cuotaTabPorEmp, setCuotaTabPorEmp] = useState<Record<string, number>>({});

  // Total a separar (suma de pendientes con su total estimado)
  const totalASeparar = useMemo(() => {
    return slotsFiltrados.reduce((acc, s) => {
      if (estadoSlot(s.emp.id, s.cuota) !== "pendiente") return acc;
      const nov = novEdits[s.key] || NOV_VACIA;
      const adels = adelantosDelSlot(s.emp.id, s.cuota, s.cuotasTotal);
      const tildSet = tildados[s.key] || new Set();
      const sumaAdel = adels.filter(a => tildSet.has(a.id)).reduce((sum, a) => sum + Number(a.monto), 0);
      return acc + calcularTotal(s.emp, nov, s.cuotasTotal, sumaAdel);
    }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotsFiltrados, novEdits, tildados, adelantos, adelantosNuevos, adelantosOverrides]);

  // ── Acciones (todas client-side) ──────────────────────────────────────────
  const toggleExpand = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const updateNov = (key: string, field: keyof NovEdit, value: number | boolean | string) => {
    setNovEdits(prev => ({ ...prev, [key]: { ...(prev[key] || NOV_VACIA), [field]: value } }));
  };
  const toggleAdelanto = (slotKey: string, adelId: string) => {
    setTildados(prev => {
      const cur = new Set(prev[slotKey] || []);
      if (cur.has(adelId)) cur.delete(adelId); else cur.add(adelId);
      return { ...prev, [slotKey]: cur };
    });
  };
  const goPrevMes = () => { if (mes === 1) { setMes(12); setAnio(anio - 1); } else setMes(mes - 1); };
  const goNextMes = () => { if (mes === 12) { setMes(1); setAnio(anio + 1); } else setMes(mes + 1); };

  // Modal "+ Adelanto"
  const [adelModalSlot, setAdelModalSlot] = useState<string | null>(null);
  const [adelForm, setAdelForm] = useState({ monto: "", fecha: toISO(today), cuenta: "", motivo: "", auto_aplicar: true });
  const guardarAdelantoMock = () => {
    if (!adelModalSlot) return;
    const parts = adelModalSlot.split("__");
    const empId = parts[0];
    if (!empId) return;
    const monto = parseFloat(adelForm.monto);
    if (!monto || monto <= 0) return;
    const nuevo: Adel = {
      id: "mock_" + Date.now(),
      empleado_id: empId,
      fecha: adelForm.fecha,
      monto,
      cuenta: adelForm.cuenta || null,
      descontado: false,
      auto_aplicar: adelForm.auto_aplicar,
      concepto: adelForm.motivo,
    };
    setAdelantosNuevos(prev => [...prev, nuevo]);
    setAdelModalSlot(null);
    setAdelForm({ monto: "", fecha: toISO(today), cuenta: "", motivo: "", auto_aplicar: true });
  };

  // Modal "Pagar"
  const [pagoSlot, setPagoSlot] = useState<string | null>(null);
  const [pagoLineas, setPagoLineas] = useState<{ cuenta: string; monto: string }[]>([]);
  const abrirPago = (slotKey: string) => {
    const s = slots.find(x => x.key === slotKey);
    if (!s) return;
    const nov = novEdits[slotKey] || NOV_VACIA;
    const adels = adelantosDelSlot(s.emp.id, s.cuota, s.cuotasTotal);
    const tildSet = tildados[slotKey] || new Set();
    const sumaAdel = adels.filter(a => tildSet.has(a.id)).reduce((sum, a) => sum + Number(a.monto), 0);
    const total = calcularTotal(s.emp, nov, s.cuotasTotal, sumaAdel);
    setPagoLineas([{ cuenta: cuentas[0] || "", monto: String(total) }]);
    setPagoSlot(slotKey);
  };
  const confirmarPagoMock = () => {
    if (!pagoSlot) return;
    setLiqsLocal(prev => ({ ...prev, [pagoSlot]: "pagado" }));
    // Marcar adelantos tildados como "descontados" (en mockup, solo los oculta del próximo período)
    const tildSet = tildados[pagoSlot] || new Set();
    for (const adelId of tildSet) {
      setAdelantosOverrides(prev => ({ ...prev, [adelId]: { ...prev[adelId], descontado: true } }));
    }
    setPagoSlot(null);
    setPagoLineas([]);
  };

  const slotPago = pagoSlot ? slots.find(s => s.key === pagoSlot) : null;
  const slotAdel = adelModalSlot ? slots.find(s => s.key === adelModalSlot) : null;
  const sumaLineasPago = pagoLineas.reduce((s, l) => s + (parseFloat(l.monto) || 0), 0);

  return (
    <div>
      {/* Banner sandbox */}
      <div style={{
        background: "linear-gradient(135deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05))",
        border: "0.5px solid rgba(245,158,11,0.35)",
        borderRadius: 8, padding: "10px 14px", marginBottom: 16,
        display: "flex", alignItems: "center", gap: 10, fontSize: 12,
      }}>
        <span style={{ fontSize: 18 }}>🧪</span>
        <div>
          <div style={{ fontWeight: 500, color: "var(--warn)" }}>
            Vista previa del rediseño RRHH
          </div>
          <div style={{ color: "var(--muted2)", marginTop: 2 }}>
            Datos reales de Maneki en modo lectura. Las interacciones (editar campos,
            tildar adelantos, "pagar") <strong>no afectan la DB</strong>. Reset al recargar.
            La pantalla real de hoy sigue en <code style={{background:"var(--s2)",padding:"1px 6px",borderRadius:4}}>/equipo</code>.
          </div>
        </div>
      </div>

      {/* Header */}
      <div className="ph-row" style={{ marginBottom: 16 }}>
        <div>
          <div className="ph-title">Sueldos</div>
          <div className="ph-sub">Una pantalla. Todo el flujo. Sin Novedades+Pagos separados.</div>
        </div>
      </div>

      {/* Toolbar */}
      <div style={{
        display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center",
      }}>
        <button className="btn btn-ghost btn-sm" onClick={goPrevMes} style={{ padding: "4px 10px" }}>←</button>
        <div style={{
          padding: "5px 12px", background: "var(--s2)", borderRadius: 6,
          fontSize: 13, fontWeight: 500, minWidth: 130, textAlign: "center",
        }}>
          {nombreMes(mes)} {anio}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={goNextMes} style={{ padding: "4px 10px" }}>→</button>
        <div style={{ width: 1, height: 24, background: "var(--bd)", margin: "0 4px" }} />
        <select
          className="search"
          style={{ width: 170 }}
          value={localId ?? ""}
          onChange={e => setLocalId(parseInt(e.target.value))}
        >
          {locales.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
        </select>
        <div style={{ flex: 1 }} />
        {(["pendientes", "pagados", "todos"] as const).map(opt => (
          <button
            key={opt}
            className={`btn btn-sm ${filtroEstado === opt ? "btn-acc" : "btn-ghost"}`}
            onClick={() => setFiltroEstado(opt)}
            style={{ padding: "4px 12px", fontSize: 11 }}
          >
            {opt === "pendientes" ? "Pendientes" : opt === "pagados" ? "Pagados" : "Todos"}
          </button>
        ))}
      </div>

      {/* Strip resumen */}
      <div style={{
        padding: "10px 14px", marginBottom: 16,
        background: "var(--s2)", borderRadius: 8,
        display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap", fontSize: 12,
      }}>
        <span><strong>{empleadosVisibles.length}</strong> empleado{empleadosVisibles.length !== 1 ? "s" : ""}{filtroEstado !== "todos" ? ` con ${filtroEstado}` : ""}</span>
        {filtroEstado !== "pagados" && totalASeparar > 0 && (
          <span style={{
            padding: "3px 10px", borderRadius: 6,
            background: "rgba(34,197,94,0.10)",
            border: "0.5px solid rgba(34,197,94,0.25)",
            color: "var(--success)", fontWeight: 500,
          }}>
            A separar: {fmt_$(totalASeparar)}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--muted2)" }}>
          Cargar adelanto: usá "+ Adelanto" dentro de la card del empleado
        </span>
      </div>

      {/* Lista de slots */}
      {authError ? (
        <div className="alert alert-danger" style={{ lineHeight: 1.5 }}>
          <strong>Tu sesión está vencida o inválida.</strong>
          <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
            Detalle técnico: {authError}
          </div>
          <div style={{ marginTop: 10, fontSize: 13 }}>
            <strong>Solución:</strong> Andá al sidebar abajo a la izquierda → <strong>Cerrar sesión →</strong>,
            volvé a loguearte y entrá de nuevo a esta pantalla.
          </div>
          <button
            className="btn btn-acc btn-sm"
            style={{ marginTop: 12 }}
            onClick={async () => { await db.auth.signOut(); window.location.href = "/"; }}
          >
            Cerrar sesión ahora
          </button>
        </div>
      ) : !localId && locales.length === 0 ? (
        <div className="alert alert-warn">
          No pude cargar tus locales. Refrescá la página (sesión todavía hidratando).
        </div>
      ) : !localId ? (
        <div className="alert alert-info">Elegí un local arriba.</div>
      ) : loading ? (
        <div className="loading">Cargando datos reales…</div>
      ) : empleadosVisibles.length === 0 ? (
        <div className="empty">No hay empleados que coincidan con el filtro</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {empleadosVisibles.map(grupo => {
            const emp = grupo.emp;
            const cuotasTotal = grupo.slots[0]?.cuotasTotal ?? 1;
            const isExp = expanded.has(emp.id);
            // Estados de cada cuota
            const cuotasInfo = grupo.slots.map(s => {
              const nov = novEdits[s.key] || NOV_VACIA;
              const adels = adelantosDelSlot(s.emp.id, s.cuota, s.cuotasTotal);
              const tildSet = tildados[s.key] || new Set();
              const sumaAdel = adels.filter(a => tildSet.has(a.id)).reduce((sum, a) => sum + Number(a.monto), 0);
              const total = calcularTotal(s.emp, nov, s.cuotasTotal, sumaAdel);
              const estado = estadoSlot(s.emp.id, s.cuota);
              const venceFecha = fechaFinPeriodo(anio, mes, s.cuota, s.cuotasTotal);
              return { slot: s, nov, adels, tildSet, sumaAdel, total, estado, venceFecha };
            });
            const todasPagas = cuotasInfo.every(c => c.estado === "pagado");
            const cuotaActivaIdx = cuotaTabPorEmp[emp.id] ?? 0;
            const cuotaActiva = cuotasInfo[cuotaActivaIdx] ?? cuotasInfo[0];
            if (!cuotaActiva) return null;

            return (
              <div key={emp.id} className="panel" style={{
                padding: 0, overflow: "hidden",
                opacity: todasPagas ? 0.7 : 1,
              }}>
                {/* Header card: nombre + puesto + chip modo */}
                <div
                  onClick={() => toggleExpand(emp.id)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "22px 1fr 130px",
                    gap: 12, padding: "12px 16px", cursor: "pointer",
                    alignItems: "center",
                    background: todasPagas ? "rgba(34,197,94,0.06)" : "transparent",
                  }}
                >
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{isExp ? "▾" : "▸"}</span>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>
                      {emp.apellido}, {emp.nombre}
                      <span style={{
                        marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 4,
                        background: "var(--pase-celeste-100)", color: "var(--acc)", fontWeight: 400,
                      }}>
                        {cuotasTotal === 1 ? "Mensual" : "Quincenal"} · {nombreMes(mes).toLowerCase()}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 2 }}>{emp.puesto}</div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: 11 }}>
                    {todasPagas ? (
                      <span className="badge b-success" style={{ fontSize: 10 }}>
                        {cuotasTotal === 1 ? "Mes pagado ✓" : "Mes completo ✓"}
                      </span>
                    ) : (
                      <span style={{ color: "var(--muted2)" }}>
                        {cuotasInfo.filter(c => c.estado === "pagado").length}/{cuotasInfo.length} pagada{cuotasInfo.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                </div>

                {/* Sub-filas: una por cuota (con su estado y botón Pagar) */}
                <div onClick={e => e.stopPropagation()}>
                  {cuotasInfo.map((c) => (
                    <div key={c.slot.key} style={{
                      display: "grid",
                      gridTemplateColumns: "60px 1fr 130px 110px 110px",
                      gap: 12, padding: "10px 16px 10px 38px",
                      alignItems: "center",
                      borderTop: "0.5px solid var(--bd)",
                      background: c.estado === "pagado" ? "rgba(34,197,94,0.04)" : "transparent",
                    }}>
                      <span style={{ fontSize: 11, fontWeight: 500, color: "var(--acc)" }}>
                        {labelSlot(c.slot.cuota, c.slot.cuotasTotal)}
                      </span>
                      <span style={{ fontSize: 11, color: "var(--muted2)" }}>
                        vence {fmt_d(c.venceFecha)}
                      </span>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--acc)" }}>
                        {fmt_$(c.total)}
                      </div>
                      <div>
                        {c.estado === "pagado" ? (
                          <span className="badge b-success" style={{ fontSize: 9 }}>Pagado</span>
                        ) : (
                          <span className="badge b-warn" style={{ fontSize: 9 }}>Pendiente</span>
                        )}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        {c.estado === "pendiente" && (
                          <button
                            className="btn btn-acc btn-sm"
                            onClick={() => abrirPago(c.slot.key)}
                            style={{ padding: "4px 12px", fontSize: 11 }}
                          >
                            Pagar →
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Body expandido */}
                {isExp && (() => {
                  const s = cuotaActiva.slot;
                  const nov = cuotaActiva.nov;
                  const adels = cuotaActiva.adels;
                  const tildSet = cuotaActiva.tildSet;
                  const sumaAdel = cuotaActiva.sumaAdel;
                  const total = cuotaActiva.total;
                  return (
                    <div style={{ borderTop: "0.5px solid var(--bd)", padding: "16px 20px" }}>
                      {/* Tabs Q1/Q2 si tiene 2 cuotas */}
                      {cuotasTotal > 1 && (
                        <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
                          {cuotasInfo.map((c, idx) => (
                            <button
                              key={c.slot.key}
                              onClick={() => setCuotaTabPorEmp(prev => ({ ...prev, [emp.id]: idx }))}
                              className={`btn btn-sm ${cuotaActivaIdx === idx ? "btn-acc" : "btn-ghost"}`}
                              style={{ padding: "4px 14px", fontSize: 11 }}
                            >
                              Editar {labelSlot(c.slot.cuota, c.slot.cuotasTotal)}
                              {c.estado === "pagado" && " ✓"}
                            </button>
                          ))}
                        </div>
                      )}
                      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 28 }}>
                        {/* Col izq: novedades + adelantos */}
                        <div>
                          <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", letterSpacing: 0.5, marginBottom: 8 }}>
                            Novedades de {labelSlot(s.cuota, s.cuotasTotal)}
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
                            <NovInput label="Faltas (días)" value={nov.inasistencias} onChange={v => updateNov(s.key, "inasistencias", v)} />
                            <NovInput label="Horas extras" value={nov.horas_extras} onChange={v => updateNov(s.key, "horas_extras", v)} />
                            <NovInput label="Turnos dobles" value={nov.dobles} onChange={v => updateNov(s.key, "dobles", v)} />
                            <NovInput label="Feriados trab." value={nov.feriados} onChange={v => updateNov(s.key, "feriados", v)} />
                            <NovInput label="Otros desc. ($)" value={nov.otros_desc} onChange={v => updateNov(s.key, "otros_desc", v)} />
                            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, paddingTop: 18 }}>
                              <input
                                type="checkbox"
                                checked={nov.presentismo_mantiene}
                                onChange={e => updateNov(s.key, "presentismo_mantiene", e.target.checked)}
                              />
                              Presentismo (+5%)
                            </label>
                          </div>

                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                            <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", letterSpacing: 0.5 }}>
                              Adelantos
                            </div>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => setAdelModalSlot(s.key)}
                              style={{ padding: "3px 10px", fontSize: 11 }}
                            >
                              + Adelanto
                            </button>
                          </div>
                          {adels.length === 0 ? (
                            <div style={{ fontSize: 11, color: "var(--muted2)", padding: "8px 0" }}>
                              Sin adelantos. Toca <strong>+ Adelanto</strong> para cargar uno.
                            </div>
                          ) : (
                            <div style={{ background: "var(--s2)", borderRadius: 8, padding: 10 }}>
                              {adels.map(a => {
                                const tildado = tildSet.has(a.id);
                                return (
                                  <label key={a.id} style={{
                                    display: "flex", alignItems: "center", gap: 10,
                                    fontSize: 11, padding: "6px 6px", borderRadius: 4,
                                    cursor: "pointer", opacity: tildado ? 1 : 0.55,
                                  }}>
                                    <input
                                      type="checkbox"
                                      checked={tildado}
                                      onChange={() => toggleAdelanto(s.key, a.id)}
                                    />
                                    <span style={{ color: "var(--muted2)", flex: 1 }}>
                                      {fmt_d(a.fecha)} · {a.cuenta || "—"}
                                      {!a._entraPeriodo && (
                                        <span style={{
                                          marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                                          background: "rgba(245,158,11,0.15)", color: "var(--warn)",
                                        }}>
                                          futuro
                                        </span>
                                      )}
                                      {a.auto_aplicar === false && (
                                        <span style={{
                                          marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 3,
                                          background: "rgba(59,130,246,0.15)", color: "var(--info)",
                                        }}>
                                          saldo
                                        </span>
                                      )}
                                    </span>
                                    <span style={{ color: tildado ? "var(--danger)" : "var(--muted2)" }}>
                                      {tildado ? "−" : ""}{fmt_$(a.monto)}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* Col der: desglose en vivo */}
                        <div>
                          <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", letterSpacing: 0.5, marginBottom: 8 }}>
                            Cálculo en vivo
                          </div>
                          <div style={{ background: "var(--s2)", borderRadius: 8, padding: 14, fontSize: 12 }}>
                            <DesgloseRow label="Sueldo base" value={fmt_$(s.emp.sueldo_mensual / s.cuotasTotal)} />
                            {nov.horas_extras > 0 && <DesgloseRow label={`+ ${nov.horas_extras} hs extra`} value="auto" />}
                            {nov.dobles > 0 && <DesgloseRow label={`+ ${nov.dobles} dobles`} value="auto" />}
                            {nov.feriados > 0 && <DesgloseRow label={`+ ${nov.feriados} feriados`} value="auto" />}
                            {nov.inasistencias > 0 && <DesgloseRow label={`− ${nov.inasistencias} faltas`} value="auto" tone="danger" />}
                            {nov.presentismo_mantiene && <DesgloseRow label="+ Presentismo 5%" value="auto" tone="success" />}
                            {nov.otros_desc > 0 && <DesgloseRow label="− Otros desc." value={`−${fmt_$(nov.otros_desc)}`} tone="danger" />}
                            {sumaAdel > 0 && <DesgloseRow label={`− Adelantos (${tildSet.size})`} value={`−${fmt_$(sumaAdel)}`} tone="danger" />}
                            <div style={{
                              marginTop: 10, paddingTop: 10, borderTop: "0.5px solid var(--bd)",
                              display: "flex", justifyContent: "space-between", alignItems: "baseline",
                            }}>
                              <span style={{ fontWeight: 500 }}>Total</span>
                              <span style={{ fontSize: 18, fontWeight: 500, color: "var(--acc)" }}>{fmt_$(total)}</span>
                            </div>
                          </div>
                          <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 8, lineHeight: 1.5 }}>
                            Los cambios se guardarían en vivo. Sin pasos "confirmar" — vas directo a <strong>Pagar</strong>.
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {/* Modal Adelanto */}
      <Modal
        isOpen={!!adelModalSlot}
        onClose={() => setAdelModalSlot(null)}
        title={slotAdel ? `Adelanto a ${slotAdel.emp.apellido}` : "Adelanto"}
        maxWidth={480}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setAdelModalSlot(null)}>Cancelar</button>
            <button
              className="btn btn-acc"
              onClick={guardarAdelantoMock}
              disabled={!parseFloat(adelForm.monto)}
            >
              Registrar (mock)
            </button>
          </>
        }
      >
        <div className="form2">
          <div className="field">
            <label>Monto $</label>
            <input
              type="number"
              value={adelForm.monto}
              onChange={e => setAdelForm({ ...adelForm, monto: e.target.value })}
              placeholder="0"
            />
          </div>
          <div className="field">
            <label>Fecha</label>
            <input
              type="date"
              value={adelForm.fecha}
              onChange={e => setAdelForm({ ...adelForm, fecha: e.target.value })}
            />
          </div>
        </div>
        <div className="field">
          <label>Cuenta</label>
          <select value={adelForm.cuenta} onChange={e => setAdelForm({ ...adelForm, cuenta: e.target.value })}>
            <option value="">Elegí cuenta…</option>
            {cuentas.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Motivo (opcional)</label>
          <input
            value={adelForm.motivo}
            onChange={e => setAdelForm({ ...adelForm, motivo: e.target.value })}
            placeholder="Ej: urgencia personal…"
          />
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginTop: 8 }}>
          <input
            type="checkbox"
            checked={adelForm.auto_aplicar}
            onChange={e => setAdelForm({ ...adelForm, auto_aplicar: e.target.checked })}
          />
          <span style={{ fontSize: 12 }}>
            Descontar automáticamente en el próximo sueldo
          </span>
        </label>
        <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4, paddingLeft: 24 }}>
          {adelForm.auto_aplicar
            ? "Va a venir tildado en el próximo pago. Lo podés destildar ahí también."
            : "Queda como saldo. Solo se descuenta si lo tildás manual al pagar."}
        </div>
      </Modal>

      {/* Modal Pagar */}
      <Modal
        isOpen={!!pagoSlot}
        onClose={() => setPagoSlot(null)}
        title={slotPago ? `Pagar — ${slotPago.emp.apellido}, ${slotPago.emp.nombre}` : "Pagar"}
        subtitle={slotPago ? `${labelSlot(slotPago.cuota, slotPago.cuotasTotal)} ${nombreMes(mes)} ${anio}` : ""}
        maxWidth={520}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setPagoSlot(null)}>Cancelar</button>
            <button className="btn btn-acc" onClick={confirmarPagoMock}>
              Confirmar pago (mock)
            </button>
          </>
        }
      >
        {slotPago && (() => {
          const nov = novEdits[pagoSlot!] || NOV_VACIA;
          const adels = adelantosDelSlot(slotPago.emp.id, slotPago.cuota, slotPago.cuotasTotal);
          const tildSet = tildados[pagoSlot!] || new Set();
          const sumaAdel = adels.filter(a => tildSet.has(a.id)).reduce((sum, a) => sum + Number(a.monto), 0);
          const total = calcularTotal(slotPago.emp, nov, slotPago.cuotasTotal, sumaAdel);
          return (
            <>
              <div style={{
                padding: "10px 14px", background: "var(--s2)", borderRadius: 8,
                marginBottom: 14, display: "flex", justifyContent: "space-between",
              }}>
                <span style={{ fontSize: 12 }}>Total a pagar</span>
                <span style={{ fontSize: 18, fontWeight: 500, color: "var(--acc)" }}>{fmt_$(total)}</span>
              </div>

              {/* Adelantos en el modal (mismo widget que la card expandida) */}
              {adels.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", marginBottom: 6 }}>
                    Adelantos a descontar
                  </div>
                  <div style={{ background: "var(--s2)", borderRadius: 8, padding: 10 }}>
                    {adels.map(a => {
                      const tildado = tildSet.has(a.id);
                      return (
                        <label key={a.id} style={{
                          display: "flex", alignItems: "center", gap: 10,
                          fontSize: 11, padding: "5px 6px", borderRadius: 4,
                          cursor: "pointer", opacity: tildado ? 1 : 0.55,
                        }}>
                          <input
                            type="checkbox"
                            checked={tildado}
                            onChange={() => toggleAdelanto(pagoSlot!, a.id)}
                          />
                          <span style={{ flex: 1, color: "var(--muted2)" }}>
                            {fmt_d(a.fecha)} · {a.cuenta || "—"}
                            {!a._entraPeriodo && <span style={{ marginLeft: 6, fontSize: 9, padding: "1px 5px", borderRadius: 3, background: "rgba(245,158,11,0.15)", color: "var(--warn)" }}>futuro</span>}
                          </span>
                          <span style={{ color: tildado ? "var(--danger)" : "var(--muted2)" }}>
                            {tildado ? "−" : ""}{fmt_$(a.monto)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Líneas de pago */}
              <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "none", marginBottom: 6 }}>
                Formas de pago
              </div>
              {pagoLineas.map((l, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <select
                    className="search"
                    style={{ flex: 1 }}
                    value={l.cuenta}
                    onChange={e => setPagoLineas(prev => prev.map((x, j) => j === i ? { ...x, cuenta: e.target.value } : x))}
                  >
                    <option value="">Cuenta…</option>
                    {cuentas.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input
                    type="number"
                    className="search"
                    style={{ width: 130 }}
                    value={l.monto}
                    onChange={e => setPagoLineas(prev => prev.map((x, j) => j === i ? { ...x, monto: e.target.value } : x))}
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setPagoLineas(prev => prev.filter((_, j) => j !== i))}
                    style={{ padding: "0 10px" }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setPagoLineas(prev => [...prev, { cuenta: "", monto: "0" }])}
                style={{ marginBottom: 14 }}
              >
                + Agregar forma de pago
              </button>
              <div style={{
                display: "flex", justifyContent: "space-between",
                fontSize: 12, paddingTop: 10, borderTop: "0.5px solid var(--bd)",
              }}>
                <span style={{ color: "var(--muted2)" }}>Asignado en formas de pago</span>
                <span style={{ color: sumaLineasPago === total ? "var(--success)" : "var(--warn)", fontWeight: 500 }}>
                  {fmt_$(sumaLineasPago)} {sumaLineasPago === total ? "✓" : `(faltan ${fmt_$(Math.max(0, total - sumaLineasPago))})`}
                </span>
              </div>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}

// ── Sub-componentes ─────────────────────────────────────────────────────────
function NovInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="field">
      <label style={{ fontSize: 10 }}>{label}</label>
      <input
        type="number"
        value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        style={{ fontSize: 13 }}
      />
    </div>
  );
}
function DesgloseRow({ label, value, tone }: { label: string; value: string; tone?: "success" | "danger" }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "3px 0" }}>
      <span style={{ color: "var(--muted2)" }}>{label}</span>
      <span style={{ color: tone === "danger" ? "var(--danger)" : tone === "success" ? "var(--success)" : undefined }}>
        {value === "auto" ? "" : value}
      </span>
    </div>
  );
}
