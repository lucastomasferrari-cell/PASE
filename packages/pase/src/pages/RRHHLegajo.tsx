// El legajo abre con empleado_id de la URL (click desde el listado RRHH ya
// scoped por applyLocalScope). Todas las queries acá usan `.eq("id", emp.id)`
// o `.eq("empleado_id", emp.id)` — RLS server-side filtra por local del
// caller, así que un empleado_id de otra sucursal devuelve null. Las pocas
// queries directas sobre tablas con `local_id` quedan con disable de C3
// porque la defense-in-depth se hace en la página padre RRHH, no acá.
/* eslint-disable pase-local/require-apply-local-scope */
import { useState, useEffect, useRef } from "react";
import { db } from "../lib/supabase";
import { cuentasOperables } from "../lib/auth";
import { translateRpcError } from "../lib/errors";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import { Modal } from "../components/ui";
import { toISO, fmt_d, fmt_$ } from "@pase/shared/utils";
import { today } from "../lib/utils";
import {
  diasVacacionesPorAnio,
  calcularVacaciones,
  calcularSACTeorico,
  calcularSACMejorSueldo,
  mesesTrabajadosEnSemestre,
  calcularLiquidacionFinal,
  type LiquidacionFinalResult,
} from "../lib/calculos/rrhh";
import type { Usuario, Local } from "../types/auth";
import { EmpleadoCesiones } from "./rrhh/EmpleadoCesiones";
import type {
  Empleado, Novedad, PagoEspecial, HistorialSueldo,
  Adelanto, DocumentoLegajo, NovedadConLiquidaciones, LineaPago,
} from "../types/rrhh";

// Forma del state liqFinalForm — únicamente usado en este archivo.
interface LiqFinalForm { fecha_egreso: string; motivo: string }

const MESES = ["","Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
const DOC_TIPOS = [
  { value:"alta_temprana", label:"Alta temprana" },
  { value:"dni", label:"DNI" },
  { value:"recibo_sueldo", label:"Recibo de sueldo" },
  { value:"baja", label:"Baja" },
  { value:"contrato", label:"Contrato" },
  { value:"otro", label:"Otro" },
];
const CUENTAS_LIQ = ["Caja Efectivo","Caja Chica","Caja Mayor","MercadoPago","Banco"];

interface RRHHLegajoProps {
  empleadoId: string;
  user: Usuario;
  locales: Local[];
  // El parent (RRHH.tsx) pasa onClose pero el componente no lo usa internamente
  // — el cierre del legajo viene del cambio de tab. Aceptado en el contrato
  // para que el caller no rompa.
  onClose?: () => void;
  onGoToPago?: (emp: Empleado, nov: Novedad) => void;
}

export default function RRHHLegajo({ empleadoId, user, locales, onGoToPago }: RRHHLegajoProps) {
  // Cuentas para los selects de pago de vacaciones, aguinaldo y liquidación
  // final. Filtra por cuentas_operables — un usuario con permiso de cargar
  // pagos puede no ver el saldo consolidado de la cuenta.
  const opCuentas = cuentasOperables(user);
  const cuentasUsables = opCuentas === null ? CUENTAS_LIQ : CUENTAS_LIQ.filter(c => opCuentas.includes(c));
  const cuentasKey = cuentasUsables.join("|");
  const [emp, setEmp] = useState<Empleado | null>(null);
  const [tab, setTab] = useState("datos");
  const [loading, setLoading] = useState(true);

  // Datos
  const [histSueldos, setHistSueldos] = useState<HistorialSueldo[]>([]);
  const [sueldoModal, setSueldoModal] = useState(false);
  const [sueldoForm, setSueldoForm] = useState({ monto:"", motivo:"" });

  // Movimientos
  const [movMeses, setMovMeses] = useState<NovedadConLiquidaciones[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Vacaciones/Aguinaldo
  const [pagosEsp, setPagosEsp] = useState<PagoEspecial[]>([]);
  const [adelantos, setAdelantos] = useState<Adelanto[]>([]);
  const [vacTomadas, setVacTomadas] = useState(0);
  // AUDIT F4A#3: flag para que el botón "Liquidación final" no permita abrir
  // el modal hasta tener vacTomadas real (sino el primer cálculo arranca con
  // vacAcum incorrecto = vacaciones acumuladas sin restar las ya tomadas).
  const [vacTomadasLoaded, setVacTomadasLoaded] = useState(false);
  const [vacModal, setVacModal] = useState(false);
  const [vacDias, setVacDias] = useState("");
  // Bug Caja-1: default vacío fuerza elección consciente del user.
  const [vacLineas, setVacLineas] = useState<LineaPago[]>([{cuenta:"", monto:""}]);
  const [aguModal, setAguModal] = useState(false);
  const [aguLineas, setAguLineas] = useState<LineaPago[]>([{cuenta:"", monto:""}]);

  // Documentos
  const [docs, setDocs] = useState<DocumentoLegajo[]>([]);
  const [docModal, setDocModal] = useState(false);
  const [docForm, setDocForm] = useState({ tipo:"otro", mes:"", anio:"" });
  const [uploading, setUploading] = useState(false);

  // Liquidación final
  const [liqFinalModal, setLiqFinalModal] = useState(false);
  const [liqFinalForm, setLiqFinalForm] = useState<LiqFinalForm>({ fecha_egreso: toISO(today), motivo: "Renuncia" });
  const [liqFinalData, setLiqFinalData] = useState<LiquidacionFinalResult | null>(null);
  const [liqFinalCuenta, setLiqFinalCuenta] = useState("");
  const [liqFinalOverrides, setLiqFinalOverrides] = useState<Record<string, string>>({});
  const [liqFinalLoading, setLiqFinalLoading] = useState(false);

  const { toast, showToast, showError } = useToast();

  // Defensive (Bug Caja-1): si cualquiera de los state values de cuenta queda
  // con un valor que no está en cuentasUsables (regression future, scope
  // change), reseteamos a "" para que el placeholder del <select> aparezca.
  // NO borrar — previene regresión del bug.
  useEffect(() => {
    if (liqFinalCuenta && !cuentasUsables.includes(liqFinalCuenta)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLiqFinalCuenta("");
    }
    if (vacLineas.some(l => l.cuenta && !cuentasUsables.includes(l.cuenta))) {
      setVacLineas(prev => prev.map(l => l.cuenta && !cuentasUsables.includes(l.cuenta) ? { ...l, cuenta: "" } : l));
    }
    if (aguLineas.some(l => l.cuenta && !cuentasUsables.includes(l.cuenta))) {
      setAguLineas(prev => prev.map(l => l.cuenta && !cuentasUsables.includes(l.cuenta) ? { ...l, cuenta: "" } : l));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liqFinalCuenta, vacLineas, aguLineas, cuentasKey]);
  const esDueno = user?.rol === "dueno" || user?.rol === "admin";

  // ─── LOAD ──────────────────────────────────────────────────────────────────
  const loadEmp = async () => {
    const { data } = await db.from("rrhh_empleados").select("*").eq("id", empleadoId).single();
    const empData = (data as Empleado | null) ?? null;
    setEmp(empData);
    return empData;
  };

  const loadHistSueldos = async () => {
    const { data } = await db.from("rrhh_historial_sueldos").select("*").eq("empleado_id", empleadoId).order("fecha_cambio", { ascending: false });
    setHistSueldos((data as HistorialSueldo[]) || []);
  };

  const loadMovimientos = async () => {
    const { data: novs } = await db.from("rrhh_novedades").select("*, rrhh_liquidaciones(*)").eq("empleado_id", empleadoId).order("anio", { ascending: false }).order("mes", { ascending: false });
    setMovMeses((novs as NovedadConLiquidaciones[]) || []);
  };

  // AUDIT F4A#3: traemos vacaciones tomadas con un flag de loaded para que
  // el botón "Liquidación final" no permita abrir el modal antes de tener
  // el valor real. Antes vacTomadas arrancaba en 0 y si el usuario clickeaba
  // rápido, el modal calculaba la liq con vacAcum incorrecto.
  const loadVacTomadas = async () => {
    const { data } = await db.from("rrhh_novedades").select("vacaciones_dias").eq("empleado_id", empleadoId).eq("estado", "confirmado").gt("vacaciones_dias", 0);
    const total = (data || []).reduce((s, n) => s + Number(n.vacaciones_dias || 0), 0);
    setVacTomadas(total);
    setVacTomadasLoaded(true);
  };

  const loadPagosEsp = async () => {
    const { data } = await db.from("rrhh_pagos_especiales").select("*").eq("empleado_id", empleadoId).order("pagado_at", { ascending: false });
    setPagosEsp((data as PagoEspecial[]) || []);
  };

  const loadAdelantos = async () => {
    const { data } = await db.from("rrhh_adelantos").select("*").eq("empleado_id", empleadoId).order("fecha", { ascending: false });
    setAdelantos((data as Adelanto[]) || []);
  };

  const loadDocs = async () => {
    const { data } = await db.from("rrhh_documentos").select("*").eq("empleado_id", empleadoId).order("subido_at", { ascending: false });
    setDocs((data as DocumentoLegajo[]) || []);
  };

  const loadAll = async () => {
    setLoading(true);
    await Promise.all([loadEmp(), loadHistSueldos(), loadMovimientos(), loadPagosEsp(), loadAdelantos(), loadDocs(), loadVacTomadas()]);
    setLoading(false);
  };

  // Patrón fetch-on-dep-change.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { loadAll(); }, [empleadoId]);

  // Recalcular liquidación final cuando cambia fecha/motivo o abre el modal.
  // Computación derivada de inputs — calcularLiquidacionFinal es pure.
  // Podría pasar a useMemo, pero el set en effect es funcionalmente
  // equivalente y la lógica está estable en producción.
  useEffect(() => {
    if (!liqFinalModal || !emp || !emp.fecha_inicio) return;
    const vacAcum = calcularVacaciones(emp.fecha_inicio, vacTomadas);
    // El select del UI sólo permite estos 4 motivos — el cast estrecha el tipo
    // string del state al union literal que espera calcularLiquidacionFinal.
    const motivo = liqFinalForm.motivo as "Renuncia" | "Despido sin causa" | "Despido con causa" | "Acuerdo mutuo";
    const lf = calcularLiquidacionFinal({
      sueldo_mensual: Number(emp.sueldo_mensual),
      fecha_inicio: emp.fecha_inicio,
      fecha_egreso: liqFinalForm.fecha_egreso,
      vacaciones_acumuladas: vacAcum,
      motivo,
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLiqFinalData(lf);
  // emp.sueldo_mensual y emp.fecha_inicio ya están en deps explícitamente;
  // el linter pide el emp completo pero esos son los únicos campos usados.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liqFinalModal, liqFinalForm.fecha_egreso, liqFinalForm.motivo, emp?.sueldo_mensual, emp?.fecha_inicio, vacTomadas]);

  // Reset overrides al cambiar motivo
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setLiqFinalOverrides({}); }, [liqFinalForm.motivo]);

  // ─── REFS ANTI-DOBLE-CLICK ────────────────────────────────────────────────
  // BUG FIX 2026-05-20: estos 3 useRef estaban DESPUÉS del early return de
  // línea de abajo (if loading || !emp). Eso violaba las reglas de hooks:
  // cuando loading=true se llamaban 0 useRef, cuando loading=false se
  // llamaban 3 → React error #310 "Rendered fewer hooks than expected".
  // Reportado por Lucas: crash al abrir legajo. Fix: declararlos siempre,
  // antes de cualquier return condicional.
  const guardandoSueldoRef = useRef(false);
  const pagandoVacRef = useRef(false);
  const pagandoAguRef = useRef(false);

  if (loading || !emp) return <div className="loading">Cargando legajo...</div>;

  const localNombre = locales.find((l) => l.id === emp.local_id)?.nombre || "—";
  const valorDia = emp.sueldo_mensual / 30;
  const valorDiaVacacional = emp.sueldo_mensual / 25; // LCT Art 155

  // Antigüedad
  const sinFechaInicio = !emp.fecha_inicio;
  const fechaInicio = emp.fecha_inicio ? new Date(emp.fecha_inicio + "T12:00:00") : null;
  const fechaInicioValida = fechaInicio && !isNaN(fechaInicio.getTime());
  // TODO(lint-cleanup): Date.now() durante render hace que antiguedadMs
  // re-calcule cada render. La diferencia es <1s entre renders, sin impacto
  // visible. Fix correcto: useMemo o congelar al mount con useState. Refactor
  // dejado para PR dedicado.
  // eslint-disable-next-line react-hooks/purity
  const antiguedadMs = fechaInicioValida ? Date.now() - fechaInicio.getTime() : 0;
  const antiguedadAnios = antiguedadMs / (365.25 * 24 * 60 * 60 * 1000);
  const diasVacAnuales = diasVacacionesPorAnio(Math.floor(antiguedadAnios));
  const diasVacPorMes = diasVacAnuales / 12;
  const vacAcumuladas = calcularVacaciones(emp.fecha_inicio, vacTomadas);

  // SAC teórico — toma mejor sueldo del semestre (Art 122 LCT) prorrateado
  // por tiempo efectivamente trabajado (considera fecha_inicio + historial).
  const now = new Date();
  const mesActual = now.getMonth() + 1;
  const anioActual = now.getFullYear();
  const sueldoNum = parseFloat(String(emp.sueldo_mensual || 0)) || 0;
  const sinSueldo = sueldoNum <= 0;
  const mesesEnSemestre = mesesTrabajadosEnSemestre(emp.fecha_inicio, mesActual, anioActual);
  const sacAcumulado = calcularSACMejorSueldo({
    sueldoActual: sueldoNum,
    historialSueldos: histSueldos,
    fechaInicio: emp.fecha_inicio,
    mesActual,
    anioActual,
  });
  const sacTeorico = calcularSACTeorico(sueldoNum);

  // ─── ACCIONES: SUELDO ──────────────────────────────────────────────────────
  // RPC atómica: INSERT historial + UPDATE sueldo_mensual en TX única
  // (deuda C4 cerrada). Antes podían quedar inconsistentes si el INSERT
  // pasaba y el UPDATE fallaba → historial mostraba cambio pero legajo
  // seguía con sueldo viejo.
  // (guardandoSueldoRef declarado arriba, antes del early return — fix 310)
  const guardarSueldo = async () => {
    if (guardandoSueldoRef.current) return;
    const nuevo = parseFloat(sueldoForm.monto);
    if (!nuevo || nuevo === emp.sueldo_mensual) return;
    guardandoSueldoRef.current = true;
    try {
      const { error } = await db.rpc("cambiar_sueldo_empleado", {
        p_emp_id: emp.id,
        p_nuevo_sueldo: nuevo,
        p_motivo: sueldoForm.motivo || null,
        p_idempotency_key: crypto.randomUUID(),
      });
      if (error) { showError(translateRpcError(error)); return; }
      setSueldoModal(false); setSueldoForm({ monto:"", motivo:"" });
      loadEmp(); loadHistSueldos();
      showToast("Sueldo actualizado");
    } finally { guardandoSueldoRef.current = false; }
  };

  const toggleActivo = async () => {
    await db.from("rrhh_empleados").update({ activo: !emp.activo }).eq("id", emp.id);
    loadEmp();
  };

  // ─── ACCIONES: VACACIONES ──────────────────────────────────────────────────
  const plusVacacional = vacAcumuladas * valorDiaVacacional;

  // (pagandoVacRef declarado arriba, antes del early return — fix 310)
  const pagarVacaciones = async () => {
    if (pagandoVacRef.current) return;
    if (!emp) return;
    const dias = parseFloat(vacDias) || vacAcumuladas;
    const montoEsperado = plusVacacional;
    const totalPagado = vacLineas.reduce((s, l) => s + (parseFloat(l.monto) || 0), 0);
    if (dias <= 0 || totalPagado <= 0) return;

    const lineas = vacLineas
      .filter(l => (parseFloat(l.monto) || 0) > 0 && !!l.cuenta)
      .map(l => ({ cuenta: l.cuenta, monto: parseFloat(l.monto) }));

    if (lineas.length === 0) { showToast("Elegí una cuenta para cada línea de pago"); return; }
    pagandoVacRef.current = true;
    try {
      const { error } = await db.rpc("pagar_vacaciones", {
        p_empleado_id: emp.id,
        p_lineas: lineas,
        p_dias: dias,
        p_monto_esperado: montoEsperado,
        p_fecha: toISO(today),
      });
      if (error) { showToast(translateRpcError(error)); return; }

      const pendiente = totalPagado < montoEsperado - 0.01;
      setVacModal(false); setVacDias("");
      setVacLineas([{cuenta:"", monto:""}]);
      showToast(pendiente ? `Pago parcial — Resta ${fmt_$(montoEsperado - totalPagado)}` : "Vacaciones pagadas");
      loadAll();
    } finally { pagandoVacRef.current = false; }
  };

  // ─── ACCIONES: AGUINALDO ───────────────────────────────────────────────────
  // (pagandoAguRef declarado arriba, antes del early return — fix 310)
  const pagarAguinaldo = async () => {
    if (pagandoAguRef.current) return;
    if (!emp) return;
    const montoEsperado = sacAcumulado;
    const totalPagado = aguLineas.reduce((s, l) => s + (parseFloat(l.monto) || 0), 0);
    if (totalPagado <= 0) return;

    const lineas = aguLineas
      .filter(l => (parseFloat(l.monto) || 0) > 0 && !!l.cuenta)
      .map(l => ({ cuenta: l.cuenta, monto: parseFloat(l.monto) }));

    if (lineas.length === 0) { showToast("Elegí una cuenta para cada línea de pago"); return; }
    pagandoAguRef.current = true;
    try {
      const { error } = await db.rpc("pagar_aguinaldo", {
        p_empleado_id: emp.id,
        p_lineas: lineas,
        p_monto_esperado: montoEsperado,
        p_fecha: toISO(today),
      });
      if (error) { showToast(translateRpcError(error)); return; }

      const pendiente = totalPagado < montoEsperado - 0.01;
      setAguModal(false);
      setAguLineas([{cuenta:"", monto:""}]);
      showToast(pendiente ? `Pago parcial — Resta ${fmt_$(montoEsperado - totalPagado)}` : "Aguinaldo pagado");
      loadAll();
    } finally { pagandoAguRef.current = false; }
  };

  // ─── ACCIONES: DOCUMENTOS ─────────────────────────────────────────────────
  // BUG 3: el bucket real en Supabase Storage se llama 'empleados' (con
  // policies bucket_id='empleados'). El código apuntaba a 'rrhh-documentos'
  // que no existe → INSERT/SELECT siempre fallaban (RLS default-deny).
  // Path con prefijo tenant_id para pasar la policy 'empleados_*_mt' que
  // valida (storage.foldername(name))[1] = auth_tenant_id()::text.
  const subirDoc = async (file: File) => {
    if (!file || uploading || !emp) return;
    setUploading(true);
    const ext = file.name.split(".").pop();
    const tenantPrefix = user?.tenant_id ? `${user.tenant_id}/` : "";
    const path = `${tenantPrefix}${emp.id}/${docForm.tipo}/${Date.now()}.${ext}`;
    const { error: upErr } = await db.storage.from("empleados").upload(path, file);
    if (upErr) { showToast("Error subiendo: " + upErr.message); setUploading(false); return; }

    const { error: insErr } = await db.from("rrhh_documentos").insert([{
      empleado_id: emp.id, tipo: docForm.tipo, nombre_archivo: file.name, url: path,
      mes: docForm.mes ? parseInt(docForm.mes) : null, anio: docForm.anio ? parseInt(docForm.anio) : null,
      subido_por: user?.id,
    }]);
    if (insErr) {
      // Rollback storage si falló la inserción en la tabla.
      await db.storage.from("empleados").remove([path]);
      showToast("Error registrando: " + insErr.message);
      setUploading(false); return;
    }
    setUploading(false); setDocModal(false); setDocForm({ tipo:"otro", mes:"", anio:"" });
    showToast("Documento subido");
    loadDocs();
  };

  const verDoc = async (doc: DocumentoLegajo) => {
    const { data } = await db.storage.from("empleados").createSignedUrl(doc.url, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  };

  const eliminarDoc = async (doc: DocumentoLegajo) => {
    if (!confirm("Eliminar documento?")) return;
    await db.storage.from("empleados").remove([doc.url]);
    await db.from("rrhh_documentos").delete().eq("id", doc.id);
    loadDocs();
  };

  // ─── RENDER ────────────────────────────────────────────────────────────────
  const tabs = [
    { id:"datos", label:"Datos personales" },
    { id:"movimientos", label:"Movimientos" },
    { id:"vacagu", label:"Vacaciones / Aguinaldo" },
    { id:"documentos", label:"Documentos" },
  ];

  return (
    <div>
      <ToastComponent toast={toast} />

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,gap:12,flexWrap:"wrap"}}>
        <div style={{flex:1, minWidth: 280}}>
          <div style={{fontFamily:"var(--pase-font)",fontSize:18,fontWeight:500,lineHeight:1.1,color:"var(--pase-text)",letterSpacing:"-0.02em"}}>{emp.apellido}, {emp.nombre}</div>
          <div style={{fontSize:11,color:"var(--muted2)",marginTop:4}}>{emp.puesto} · {localNombre} (principal) · {emp.activo ? "Activo" : "Inactivo"}</div>
          {/* Feature 2: gestión de cesiones a otros locales */}
          <EmpleadoCesiones
            empleadoId={emp.id}
            localPrincipalId={emp.local_id}
            locales={locales}
          />
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:9,letterSpacing:2,textTransform:"uppercase",color:"var(--muted)"}}>Sueldo mensual</div>
          <div style={{fontFamily:"'Inter',sans-serif",fontSize:17,fontWeight:500,color:"var(--acc)"}}>{fmt_$(emp.sueldo_mensual)}</div>
          <div style={{fontSize:10,color:"var(--muted2)"}}>Día: {fmt_$(valorDia)}</div>
        </div>
      </div>

      <div className="tabs">
        {tabs.map(t => <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</div>)}
      </div>

      {tab === "datos" && (
        <TabDatos
          emp={emp}
          histSueldos={histSueldos}
          antiguedadAnios={antiguedadAnios}
          vacAcumuladas={vacAcumuladas}
          esDueno={esDueno}
          sueldoModal={sueldoModal}
          setSueldoModal={setSueldoModal}
          sueldoForm={sueldoForm}
          setSueldoForm={setSueldoForm}
          guardarSueldo={guardarSueldo}
          toggleActivo={toggleActivo}
          liqFinalModal={liqFinalModal}
          setLiqFinalModal={setLiqFinalModal}
          liqFinalForm={liqFinalForm}
          setLiqFinalForm={setLiqFinalForm}
          liqFinalData={liqFinalData}
          liqFinalCuenta={liqFinalCuenta}
          setLiqFinalCuenta={setLiqFinalCuenta}
          liqFinalOverrides={liqFinalOverrides}
          setLiqFinalOverrides={setLiqFinalOverrides}
          liqFinalLoading={liqFinalLoading}
          setLiqFinalLoading={setLiqFinalLoading}
          cuentasUsables={cuentasUsables}
          showToast={showToast}
          loadAll={loadAll}
          vacTomadasLoaded={vacTomadasLoaded}
          loadVacTomadas={loadVacTomadas}
        />
      )}

      {tab === "movimientos" && (
        <TabMovimientos
          emp={emp}
          movMeses={movMeses}
          expanded={expanded}
          setExpanded={setExpanded}
          esDueno={esDueno}
          adelantos={adelantos}
          onGoToPago={onGoToPago}
          onAnulado={loadMovimientos}
        />
      )}

      {tab === "vacagu" && (
        <TabVacAgu
          vacAcumuladas={vacAcumuladas}
          vacTomadas={vacTomadas}
          valorDia={valorDia}
          plusVacacional={plusVacacional}
          diasVacAnuales={diasVacAnuales}
          diasVacPorMes={diasVacPorMes}
          antiguedadAnios={antiguedadAnios}
          sinFechaInicio={sinFechaInicio}
          sinSueldo={sinSueldo}
          sacAcumulado={sacAcumulado}
          sacTeorico={sacTeorico}
          mesActual={mesActual}
          mesesEnSemestre={mesesEnSemestre}
          pagosEsp={pagosEsp}
          esDueno={esDueno}
          vacModal={vacModal}
          setVacModal={setVacModal}
          vacDias={vacDias}
          setVacDias={setVacDias}
          vacLineas={vacLineas}
          setVacLineas={setVacLineas}
          aguModal={aguModal}
          setAguModal={setAguModal}
          aguLineas={aguLineas}
          setAguLineas={setAguLineas}
          pagarVacaciones={pagarVacaciones}
          pagarAguinaldo={pagarAguinaldo}
          cuentasUsables={cuentasUsables}
        />
      )}

      {tab === "documentos" && (
        <TabDocumentos
          docs={docs}
          esDueno={esDueno}
          docModal={docModal}
          setDocModal={setDocModal}
          docForm={docForm}
          setDocForm={setDocForm}
          uploading={uploading}
          subirDoc={subirDoc}
          verDoc={verDoc}
          eliminarDoc={eliminarDoc}
        />
      )}
    </div>
  );
}

// ─── SUB-COMPONENTES ─────────────────────────────────────────────────────────

interface TabDatosProps {
  emp: Empleado;
  histSueldos: HistorialSueldo[];
  antiguedadAnios: number;
  vacAcumuladas: number;
  esDueno: boolean;
  sueldoModal: boolean;
  setSueldoModal: React.Dispatch<React.SetStateAction<boolean>>;
  sueldoForm: { monto: string; motivo: string };
  setSueldoForm: React.Dispatch<React.SetStateAction<{ monto: string; motivo: string }>>;
  guardarSueldo: () => Promise<void>;
  toggleActivo: () => Promise<void>;
  liqFinalModal: boolean;
  setLiqFinalModal: React.Dispatch<React.SetStateAction<boolean>>;
  liqFinalForm: LiqFinalForm;
  setLiqFinalForm: React.Dispatch<React.SetStateAction<LiqFinalForm>>;
  liqFinalData: LiquidacionFinalResult | null;
  liqFinalCuenta: string;
  setLiqFinalCuenta: React.Dispatch<React.SetStateAction<string>>;
  liqFinalOverrides: Record<string, string>;
  setLiqFinalOverrides: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  liqFinalLoading: boolean;
  setLiqFinalLoading: React.Dispatch<React.SetStateAction<boolean>>;
  cuentasUsables: string[];
  showToast: (msg: string) => void;
  loadAll: () => Promise<void>;
  vacTomadasLoaded: boolean;
  loadVacTomadas: () => Promise<void>;
}

function TabDatos({
  emp, histSueldos, antiguedadAnios, vacAcumuladas, esDueno,
  sueldoModal, setSueldoModal, sueldoForm, setSueldoForm, guardarSueldo, toggleActivo,
  liqFinalModal, setLiqFinalModal, liqFinalForm, setLiqFinalForm, liqFinalData,
  liqFinalCuenta, setLiqFinalCuenta, liqFinalOverrides, setLiqFinalOverrides,
  liqFinalLoading, setLiqFinalLoading,
  cuentasUsables, showToast, loadAll,
  vacTomadasLoaded, loadVacTomadas,
}: TabDatosProps) {
  // Refactor 2026-05-23 (Lucas: "cuadros muy grandes con poco texto adentro").
  // Antes cada dato era un .kpi con padding 14×16 → mucha caja para 1 línea.
  // Ahora 5 datos en una sola card de 2 columnas con filas label/valor.
  const dataRow = (label: string, value: React.ReactNode) => (
    <div style={{display:"flex",alignItems:"baseline",gap:10,padding:"6px 0",borderBottom:"0.5px solid var(--pase-border)",fontSize:12}}>
      <span style={{minWidth:110,color:"var(--pase-text-muted)",fontSize:11,letterSpacing:"var(--pase-ls-snug)"}}>{label}</span>
      <span style={{color:"var(--pase-text)",flex:1}}>{value}</span>
    </div>
  );
  return (
    <>
      <div className="panel" style={{padding:"4px 14px",marginBottom:16,display:"grid",gridTemplateColumns:"1fr 1fr",columnGap:24}}>
        <div>
          {dataRow("CUIL", emp.cuil || "—")}
          {dataRow("Fecha ingreso", emp.fecha_inicio
            ? fmt_d(emp.fecha_inicio)
            : <span style={{color:"var(--warn)"}}>— (falta cargar)</span>)}
          {dataRow("Antigüedad", emp.fecha_inicio
            ? `${Math.floor(antiguedadAnios)} años, ${Math.floor((antiguedadAnios % 1) * 12)} meses`
            : "—")}
        </div>
        <div>
          {dataRow("CBU / Alias", emp.alias_mp || "—")}
          {dataRow("Estado",
            <span className={`badge ${emp.activo ? "b-success" : "b-muted"}`} style={{cursor:"pointer"}} onClick={toggleActivo}>
              {emp.activo ? "Activo" : "Inactivo"}
            </span>)}
          {dataRow("Vacaciones acum.", `${vacAcumuladas.toFixed(1)} días`)}
        </div>
      </div>

      <div className="panel">
        <div className="panel-hd">
          <span className="panel-title">Sueldo actual: {fmt_$(emp.sueldo_mensual)}</span>
          {esDueno && <button className="btn btn-acc btn-sm" onClick={() => { setSueldoForm({ monto:String(emp.sueldo_mensual), motivo:"" }); setSueldoModal(true); }}>Actualizar sueldo</button>}
        </div>
        {histSueldos.length === 0 ? <div className="empty">Sin cambios de sueldo registrados</div> : (
          <table><thead><tr><th>Fecha</th><th style={{textAlign:"right"}}>Anterior</th><th style={{textAlign:"right"}}>Nuevo</th><th>Motivo</th></tr></thead>
          <tbody>{histSueldos.map((h) => (
            <tr key={h.id}>
              <td className="mono">{fmt_d(h.fecha_cambio)}</td>
              <td style={{textAlign:"right"}}><span className="num" style={{color:"var(--muted2)"}}>{fmt_$(h.sueldo_anterior)}</span></td>
              <td style={{textAlign:"right"}}><span className="num kpi-acc">{fmt_$(h.sueldo_nuevo)}</span></td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{h.motivo || "—"}</td>
            </tr>
          ))}</tbody></table>
        )}
      </div>

      {esDueno && emp.activo && (
        <button
          className="btn btn-danger btn-sm"
          style={{marginTop:12}}
          disabled={!vacTomadasLoaded}
          title={!vacTomadasLoaded ? "Cargando vacaciones tomadas..." : "Liquidación final"}
          onClick={() => {
            // AUDIT F4A#3: refresh vacTomadas justo antes de abrir el modal por
            // si pasaron pagos de vacaciones entre el primer load y ahora.
            void loadVacTomadas().then(() => setLiqFinalModal(true));
          }}
        >Liquidación final{!vacTomadasLoaded ? " ⏳" : ""}</button>
      )}

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      <Modal
        isOpen={sueldoModal}
        onClose={() => setSueldoModal(false)}
        title="Actualizar sueldo"
        maxWidth={420}
        footer={
          <>
            <button className="btn btn-sec" onClick={() => setSueldoModal(false)}>Cancelar</button>
            <button className="btn btn-acc" onClick={guardarSueldo}>Guardar</button>
          </>
        }
      >
        <div className="alert alert-info">Sueldo actual: {fmt_$(emp.sueldo_mensual)}</div>
        <div className="field"><label>Nuevo sueldo $</label><input type="number" value={sueldoForm.monto} onChange={e => setSueldoForm({...sueldoForm, monto:e.target.value})} /></div>
        <div className="field"><label>Motivo</label><input value={sueldoForm.motivo} onChange={e => setSueldoForm({...sueldoForm, motivo:e.target.value})} placeholder="Aumento paritarias, promoción..." /></div>
      </Modal>

      {liqFinalModal && (() => {
        const esDespidoSinCausa = liqFinalForm.motivo === "Despido sin causa";
        const esAcuerdoMutuo = liqFinalForm.motivo === "Acuerdo mutuo";
        const antAnios = Math.max(1, Math.floor(antiguedadAnios));

        // Las keys del array conceptos son CAMPOS de LiquidacionFinalResult.
        // Tipar como keyof permite acceder liqFinalData?.[k] sin error de
        // index signature.
        type ConceptoKey = keyof LiquidacionFinalResult;
        const conceptos: [ConceptoKey, string][] = [
          ["proporcional_mes", "Proporcional mes"],
          ["vacaciones_dinero", "Vacaciones (" + vacAcumuladas.toFixed(1) + " días)"],
          ["sac_proporcional", "SAC proporcional"],
          ...(esDespidoSinCausa ? ([
            ["indemnizacion", "Indemnización (" + antAnios + " año" + (antAnios > 1 ? "s" : "") + ")"],
            ["preaviso", "Preaviso"],
            ["integracion_mes", "Integración mes despido"],
          ] as [ConceptoKey, string][]) : []),
        ];

        const getConceptoMonto = (key: ConceptoKey, calculado: number) => {
          if (esAcuerdoMutuo && liqFinalOverrides[key] !== undefined) {
            return parseFloat(liqFinalOverrides[key]) || 0;
          }
          return calculado;
        };

        const total = conceptos.reduce((s, [k]) => {
          const calc = liqFinalData?.[k] || 0;
          return s + getConceptoMonto(k, calc);
        }, 0);

        const confirmarLiqFinal = async () => {
          if (!liqFinalData || liqFinalLoading) return;
          if (!liqFinalCuenta) { showToast("Elegí una cuenta de egreso"); return; }
          setLiqFinalLoading(true);
          try {
            const { error } = await db.rpc("liquidacion_final_empleado", {
              p_empleado_id: emp.id,
              p_fecha_egreso: liqFinalForm.fecha_egreso,
              p_motivo: liqFinalForm.motivo,
              p_total: total,
              p_cuenta: liqFinalCuenta,
            });
            if (error) { showToast("Error: " + translateRpcError(error)); return; }
            setLiqFinalModal(false);
            showToast("Liquidación final procesada");
            loadAll();
          } finally {
            setLiqFinalLoading(false);
          }
        };

        return (
          <Modal
            isOpen={true}
            onClose={() => setLiqFinalModal(false)}
            title={`Liquidación Final — ${emp.apellido}, ${emp.nombre}`}
            maxWidth={580}
            preventCloseOnOverlay={liqFinalLoading}
            footer={
              <>
                <button className="btn btn-sec" onClick={() => setLiqFinalModal(false)}>Cancelar</button>
                <button className="btn btn-danger" disabled={liqFinalLoading} onClick={confirmarLiqFinal}>{liqFinalLoading ? "Procesando..." : "Confirmar y pagar"}</button>
              </>
            }
          >
            <div className="form2" style={{marginBottom:16}}>
              <div className="field"><label>Fecha de egreso</label><input type="date" value={liqFinalForm.fecha_egreso} onChange={e => setLiqFinalForm({...liqFinalForm, fecha_egreso:e.target.value})} /></div>
              <div className="field"><label>Motivo</label>
                <select value={liqFinalForm.motivo} onChange={e => setLiqFinalForm({...liqFinalForm, motivo:e.target.value})}>
                  <option value="Renuncia">Renuncia</option><option value="Despido sin causa">Despido sin causa</option><option value="Despido con causa">Despido con causa</option><option value="Acuerdo mutuo">Acuerdo mutuo</option>
                </select></div>
            </div>
            <div style={{background:"var(--s2)",borderRadius:"var(--r)",padding:16}}>
              <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:12}}>
                Conceptos{esAcuerdoMutuo && <span style={{color:"var(--warn)",marginLeft:8}}>(editables)</span>}
              </div>
              {conceptos.map(([key, label]) => {
                const calc = liqFinalData?.[key] || 0;
                const monto = getConceptoMonto(key, calc);
                return (
                  <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"6px 0",borderBottom:"1px solid var(--bd)",fontSize:12}}>
                    <span>{label}</span>
                    {esAcuerdoMutuo ? (
                      <input
                        type="number"
                        value={liqFinalOverrides[key] ?? String(calc)}
                        onChange={e => setLiqFinalOverrides((prev) => ({...prev, [key]: e.target.value}))}
                        style={{width:130,background:"var(--bg)",border:"1px solid var(--bd)",color:"var(--acc)",padding:"3px 6px",fontFamily:"'DM Mono',monospace",fontSize:11,textAlign:"right",borderRadius:"var(--r)"}}
                      />
                    ) : (
                      <span className="num" style={{color:"var(--acc)"}}>{fmt_$(monto)}</span>
                    )}
                  </div>
                );
              })}
              <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0",fontSize:13,fontWeight:500}}>
                <span>TOTAL</span><span className="num" style={{color:"var(--success)",fontSize:15,fontWeight:500}}>{fmt_$(total)}</span>
              </div>
            </div>
            <div className="field" style={{marginTop:12}}><label>Cuenta de egreso *</label>
              <select value={liqFinalCuenta} onChange={e => setLiqFinalCuenta(e.target.value)}>
                <option value="">Seleccioná una cuenta…</option>
                {cuentasUsables.map((c: string) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </Modal>
        );
      })()}
    </>
  );
}

interface TabMovimientosProps {
  emp: Empleado;
  movMeses: NovedadConLiquidaciones[];
  expanded: string | null;
  setExpanded: React.Dispatch<React.SetStateAction<string | null>>;
  esDueno: boolean;
  adelantos: Adelanto[];
  onGoToPago?: (emp: Empleado, nov: Novedad) => void;
  onAnulado?: () => Promise<void>;
}

// Botón para anular un pago de sueldo del mes. Llama anular_movimiento
// para CADA mov activo linkeado a las liquidaciones del mes. La RPC
// (migration 202605141800) revierte todo correctamente: saldo de caja,
// adelantos consumidos, aguinaldo acumulado, estado de la liquidación.
function AnularPagoBtn({
  nov,
  liqArr,
  onDone,
}: {
  nov: NovedadConLiquidaciones;
  liqArr: NovedadConLiquidaciones["rrhh_liquidaciones"];
  onDone?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const { showToast, showError } = useToast();
  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    const liqIds = (liqArr || []).map(l => l.id).filter(Boolean);
    if (liqIds.length === 0) { showError("No hay liquidaciones para anular"); return; }
    // Buscar movs activos linkeados
    const { data: movs, error: movErr } = await db.from("movimientos")
      .select("id, importe, cuenta, fecha")
      .in("liquidacion_id", liqIds)
      .eq("anulado", false);
    if (movErr) { showError(`Error: ${movErr.message}`); return; }
    if (!movs || movs.length === 0) {
      showError("No hay pagos activos para anular en este mes.");
      return;
    }
    const resumen = movs.map(m => `• ${fmt_d(m.fecha)} ${m.cuenta} ${fmt_$(m.importe)}`).join("\n");
    const motivo = prompt(
      `¿Anular ${movs.length} pago(s) de sueldo de ${MESES[nov.mes]} ${nov.anio}?\n\n${resumen}\n\nVa a:\n• Devolver la plata a la cuenta\n• Re-habilitar adelantos consumidos\n• Bajar el aguinaldo acumulado\n• Marcar la liquidación pendiente\n\nMotivo (obligatorio):`,
    );
    if (!motivo || !motivo.trim()) return;
    setBusy(true);
    try {
      // AUDIT F3A#8: 1 RPC batch (antes era for+await con N round-trips).
      const { data: batchRes, error } = await db.rpc("anular_movimientos_batch", {
        p_mov_ids: movs.map(m => m.id),
        p_motivo: motivo.trim(),
      });
      if (error) throw error;
      const res = batchRes as { anulados?: number; fallidos?: number; detalles?: Array<{ ok: boolean; error?: string; mov_id: string }> } | null;
      if (res && (res.fallidos ?? 0) > 0) {
        const primeraFalla = (res.detalles || []).find(d => !d.ok);
        throw new Error(`Mov ${primeraFalla?.mov_id} falló: ${primeraFalla?.error || "error desconocido"}`);
      }
      showToast(`${res?.anulados ?? movs.length} pago(s) anulados. La liquidación vuelve a pendiente.`);
      if (onDone) await onDone();
    } catch (e) {
      showError(`Error anulando: ${translateRpcError(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className="btn btn-danger btn-sm"
      onClick={handleClick}
      disabled={busy}
      title="Anula los movimientos de pago y restituye saldos, adelantos y aguinaldo. Reversible."
    >
      {busy ? "Anulando…" : "Anular pago"}
    </button>
  );
}

function TabMovimientos({ emp, movMeses, expanded, setExpanded, esDueno, adelantos, onGoToPago, onAnulado }: TabMovimientosProps) {
  return (
    <>
      {(adelantos || []).length > 0 && (
        <div className="panel" style={{marginBottom:12}}>
          <div className="panel-hd"><span className="panel-title">Adelantos</span></div>
          <table>
            <thead><tr><th>Fecha</th><th>Cuenta</th><th style={{textAlign:"right"}}>Monto</th><th>Estado</th></tr></thead>
            <tbody>{adelantos.map((a) => (
              <tr key={a.id}>
                <td className="mono">{fmt_d(a.fecha)}</td>
                <td style={{fontSize:11,color:"var(--muted2)"}}>{a.cuenta || "—"}</td>
                <td style={{textAlign:"right"}}><span className="num" style={{color:"var(--danger)"}}>{fmt_$(a.monto)}</span></td>
                <td>
                  <span className="badge b-info" style={{fontSize:8,marginRight:4}}>Adelanto</span>
                  {a.descontado
                    ? <span className="badge b-success" style={{fontSize:8}}>Descontado</span>
                    : <span className="badge b-warn" style={{fontSize:8}}>Pendiente</span>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {movMeses.length === 0 ? <div className="empty">Sin movimientos registrados</div> : movMeses.map((nov) => {
        const liqArr = Array.isArray(nov.rrhh_liquidaciones) ? nov.rrhh_liquidaciones : [];
        // Para multi-cuota una novedad tiene N liqs. Agregamos: el total del
        // mes es la suma de cuotas; el estado del mes es "Pagado" solo si
        // TODAS las cuotas están pagadas, "Parcial" si alguna está pagada y
        // otras no, "Pendiente" si ninguna.
        const totalMes = liqArr.reduce((s, l) => s + Number(l?.total_a_pagar || 0), 0);
        const cuotasTotales = liqArr.length;
        const cuotasPagadas = liqArr.filter(l => l?.estado === "pagado").length;
        const todoPagado = cuotasTotales > 0 && cuotasPagadas === cuotasTotales;
        const parcial = cuotasPagadas > 0 && cuotasPagadas < cuotasTotales;
        // Componentes agregados del mes (suma de las N cuotas). Para MENSUAL
        // es la única liq; para QUINCENAL/SEMANAL es la suma de cuotas.
        const liqAgg = liqArr.length > 0 ? {
          sueldo_base: liqArr.reduce((s, l) => s + Number(l?.sueldo_base || 0), 0),
          descuento_ausencias: liqArr.reduce((s, l) => s + Number(l?.descuento_ausencias || 0), 0),
          total_horas_extras: liqArr.reduce((s, l) => s + Number(l?.total_horas_extras || 0), 0),
          total_dobles: liqArr.reduce((s, l) => s + Number(l?.total_dobles || 0), 0),
          total_feriados: liqArr.reduce((s, l) => s + Number(l?.total_feriados || 0), 0),
          monto_presentismo: liqArr.reduce((s, l) => s + Number(l?.monto_presentismo || 0), 0),
          adelantos: liqArr.reduce((s, l) => s + Number(l?.adelantos || 0), 0),
          pagos_realizados: liqArr.reduce((s, l) => s + Number(l?.pagos_realizados || 0), 0),
          total_a_pagar: totalMes,
          efectivo: liqArr.reduce((s, l) => s + Number(l?.efectivo || 0), 0),
          transferencia: liqArr.reduce((s, l) => s + Number(l?.transferencia || 0), 0),
        } : null;
        const key = `${nov.anio}-${nov.mes}`;
        const isExp = expanded === key;

        return (
          <div key={key} className="panel" style={{marginBottom:8}}>
            <div className="panel-hd" style={{cursor:"pointer"}} onClick={() => setExpanded(isExp ? null : key)}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <span className="panel-title">{MESES[nov.mes]} {nov.anio}</span>
                <span className={`badge ${nov.estado === "confirmado" ? (todoPagado ? "b-success" : parcial ? "b-info" : "b-warn") : "b-muted"}`}>
                  {nov.estado === "confirmado"
                    ? (todoPagado ? "Pagado" : parcial ? `Parcial (${cuotasPagadas}/${cuotasTotales})` : "Pendiente")
                    : "Borrador"}
                </span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                {liqAgg && <span className="num" style={{color: todoPagado ? "var(--success)" : "var(--acc)"}}>{fmt_$(totalMes)}</span>}
                <span style={{color:"var(--muted2)"}}>{isExp ? "▲" : "▼"}</span>
              </div>
            </div>
            {isExp && (
              <div style={{padding:12}}>
                {/* Stats del mes en una sola fila flex inline (refactor 23-may
                    para densidad). Antes eran 2 grid3 con 6 cards bajas y
                    mucho aire — ahora 1 fila label:valor separados por · */}
                <div style={{display:"flex",flexWrap:"wrap",gap:14,fontSize:11,color:"var(--muted2)",marginBottom:10,paddingBottom:8,borderBottom:"0.5px solid var(--pase-border)"}}>
                  <span><span style={{color:"var(--pase-text-muted)"}}>Inasist:</span> <strong style={{color:"var(--pase-text)"}}>{nov.inasistencias || 0}</strong></span>
                  <span><span style={{color:"var(--pase-text-muted)"}}>Presentismo:</span> <strong style={{color:"var(--pase-text)"}}>{nov.presentismo}</strong></span>
                  <span><span style={{color:"var(--pase-text-muted)"}}>Hs Extras:</span> <strong style={{color:"var(--pase-text)"}}>{nov.horas_extras || 0}</strong></span>
                  <span><span style={{color:"var(--pase-text-muted)"}}>Dobles:</span> <strong style={{color:"var(--pase-text)"}}>{nov.dobles || 0}</strong></span>
                  <span><span style={{color:"var(--pase-text-muted)"}}>Feriados:</span> <strong style={{color:"var(--pase-text)"}}>{nov.feriados || 0}</strong></span>
                  <span><span style={{color:"var(--pase-text-muted)"}}>Adelantos:</span> <strong style={{color:"var(--pase-text)"}}>{fmt_$(nov.adelantos || 0)}</strong></span>
                </div>
                {nov.observaciones && <div style={{fontSize:11,color:"var(--muted2)",marginBottom:10}}>Obs: {nov.observaciones}</div>}

                {liqAgg && (
                  <div style={{background:"var(--s2)",borderRadius:"var(--r)",padding:12,marginBottom:12}}>
                    {cuotasTotales > 1 && (
                      <div style={{fontSize:10,color:"var(--muted)",marginBottom:6}}>
                        Mes completo (suma de {cuotasTotales} cuotas).
                      </div>
                    )}
                    <div style={{display:"flex",flexWrap:"wrap",gap:16,fontSize:11}}>
                      <div>Base: <strong>{fmt_$(liqAgg.sueldo_base)}</strong></div>
                      {liqAgg.descuento_ausencias > 0 && <div style={{color:"var(--danger)"}}>-Ausencias: {fmt_$(liqAgg.descuento_ausencias)}</div>}
                      {liqAgg.total_horas_extras > 0 && <div>+HE: {fmt_$(liqAgg.total_horas_extras)}</div>}
                      {liqAgg.total_dobles > 0 && <div>+Dobles: {fmt_$(liqAgg.total_dobles)}</div>}
                      {liqAgg.total_feriados > 0 && <div>+Feriados: {fmt_$(liqAgg.total_feriados)}</div>}
                      {liqAgg.monto_presentismo > 0 && <div style={{color:"var(--success)"}}>+Present.: {fmt_$(liqAgg.monto_presentismo)}</div>}
                      {liqAgg.adelantos > 0 && <div style={{color:"var(--warn)"}}>-Adelantos: {fmt_$(liqAgg.adelantos)}</div>}
                      {liqAgg.pagos_realizados > 0 && <div style={{color:"var(--warn)"}}>-Pagos: {fmt_$(liqAgg.pagos_realizados)}</div>}
                    </div>
                    <div style={{marginTop:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div>
                        <span className="num" style={{fontSize:14,color:"var(--success)"}}>{fmt_$(liqAgg.total_a_pagar)}</span>
                        {liqAgg.efectivo > 0 && <span style={{fontSize:10,color:"var(--muted2)",marginLeft:8}}>Efvo: {fmt_$(liqAgg.efectivo)}</span>}
                        {liqAgg.transferencia > 0 && <span style={{fontSize:10,color:"var(--info)",marginLeft:8}}>Transf: {fmt_$(liqAgg.transferencia)}</span>}
                      </div>
                      <div style={{ display: "flex", gap: 6 }}>
                        {esDueno && !todoPagado && onGoToPago && (
                          <button
                            className="btn btn-success btn-sm"
                            onClick={(e) => { e.stopPropagation(); onGoToPago(emp, nov); }}
                            title="Cierra el legajo y abre el pago en el tab Pagos"
                          >{parcial ? "Pagar próxima cuota" : "Pagar"}</button>
                        )}
                        {esDueno && liqAgg.pagos_realizados > 0 && (
                          <AnularPagoBtn nov={nov} liqArr={liqArr} onDone={onAnulado} />
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

interface TabVacAguProps {
  vacAcumuladas: number;
  vacTomadas: number;
  valorDia: number;
  plusVacacional: number;
  diasVacAnuales: number;
  diasVacPorMes: number;
  antiguedadAnios: number;
  sinFechaInicio: boolean;
  sinSueldo: boolean;
  sacAcumulado: number;
  sacTeorico: number;
  mesActual: number;
  mesesEnSemestre: number;
  pagosEsp: PagoEspecial[];
  esDueno: boolean;
  vacModal: boolean;
  setVacModal: React.Dispatch<React.SetStateAction<boolean>>;
  vacDias: string;
  setVacDias: React.Dispatch<React.SetStateAction<string>>;
  vacLineas: LineaPago[];
  setVacLineas: React.Dispatch<React.SetStateAction<LineaPago[]>>;
  aguModal: boolean;
  setAguModal: React.Dispatch<React.SetStateAction<boolean>>;
  aguLineas: LineaPago[];
  setAguLineas: React.Dispatch<React.SetStateAction<LineaPago[]>>;
  pagarVacaciones: () => Promise<void>;
  pagarAguinaldo: () => Promise<void>;
  cuentasUsables: string[];
}

function TabVacAgu({
  vacAcumuladas, vacTomadas, valorDia, plusVacacional,
  diasVacAnuales, diasVacPorMes, antiguedadAnios, sinFechaInicio, sinSueldo,
  sacAcumulado, sacTeorico, mesActual, mesesEnSemestre,
  pagosEsp, esDueno,
  vacModal, setVacModal, vacDias, setVacDias, vacLineas, setVacLineas,
  aguModal, setAguModal, aguLineas, setAguLineas,
  pagarVacaciones, pagarAguinaldo,
  cuentasUsables,
}: TabVacAguProps) {
  return (
    <>
      {/* Refactor 23-may: panels más densos. Antes padding:16 con bastante aire,
          fontSize:17 del valor → muchos px verticales para 1 dato. Ahora
          padding:12, value en fontSize:15, separadores como meta-text. */}
      <div className="grid2" style={{marginBottom:16}}>
        {/* Vacaciones */}
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Vacaciones</span></div>
          <div style={{padding:12}}>
            {sinFechaInicio ? (
              <div style={{fontSize:13,color:"var(--warn)"}}>— (falta fecha de ingreso)</div>
            ) : (
              <div style={{display:"flex",alignItems:"baseline",gap:10,marginBottom:8}}>
                <span className="num" style={{fontSize:15,fontWeight:500,color:"var(--acc)"}}>{vacAcumuladas.toFixed(1)} días</span>
                <span style={{fontSize:10,color:"var(--muted2)"}}>
                  ≈ {fmt_$(vacAcumuladas * valorDia)}
                  {vacTomadas > 0 && ` · ${vacTomadas.toFixed(1)} tomadas`}
                </span>
              </div>
            )}
            {!sinFechaInicio && (
              <div style={{fontSize:10,color:"var(--muted2)",marginBottom:10}}>
                {diasVacAnuales} d/año ({diasVacPorMes.toFixed(2)} d/mes) · Antigüedad {Math.floor(antiguedadAnios)} años
              </div>
            )}
            {esDueno && !sinFechaInicio && vacAcumuladas > 0 && (
              <button className="btn btn-acc btn-sm" onClick={() => {
                setVacDias(String(vacAcumuladas.toFixed(1)));
                setVacLineas([{cuenta:"", monto: String(Math.round(plusVacacional))}]);
                setVacModal(true);
              }}>Pagar vacaciones</button>
            )}
          </div>
        </div>

        {/* Aguinaldo */}
        <div className="panel">
          <div className="panel-hd"><span className="panel-title">Aguinaldo</span></div>
          <div style={{padding:12}}>
            {sinSueldo ? (
              <div style={{fontSize:13,color:"var(--warn)"}}>— (falta sueldo)</div>
            ) : (
              <>
                <div style={{display:"flex",alignItems:"baseline",gap:10,marginBottom:6}}>
                  <span className="num" style={{fontSize:15,fontWeight:500,color:"var(--acc)"}}>{fmt_$(sacAcumulado)}</span>
                  <span style={{fontSize:10,color:"var(--muted2)"}}>
                    acumulado · {mesesEnSemestre} {mesesEnSemestre === 1 ? "mes" : "meses"} del semestre
                  </span>
                </div>
                <div style={{fontSize:10,color:"var(--muted2)",marginBottom:10}}>
                  Teórico {fmt_$(sacTeorico)} · Pago en {mesActual <= 6 ? "junio" : "diciembre"}
                </div>
              </>
            )}
            {esDueno && !sinSueldo && sacAcumulado > 0 && (
              <button className="btn btn-acc btn-sm" onClick={() => {
                setAguLineas([{cuenta:"", monto: String(Math.round(sacAcumulado))}]);
                setAguModal(true);
              }}>Pagar aguinaldo</button>
            )}
          </div>
        </div>
      </div>

      {/* Historial pagos especiales */}
      <div className="panel">
        <div className="panel-hd"><span className="panel-title">Historial de pagos especiales</span></div>
        {pagosEsp.length === 0 ? <div className="empty">Sin pagos registrados</div> : (
          <table><thead><tr><th>Fecha</th><th>Tipo</th><th>Días</th><th style={{textAlign:"right"}}>Monto</th><th>Estado</th></tr></thead>
          <tbody>{pagosEsp.map((p) => {
            const montoMostrado = Number(p.monto_pagado) > 0 ? Number(p.monto_pagado) : Number(p.monto);
            return (
              <tr key={p.id}>
                <td className="mono">{fmt_d(p.pagado_at?.split("T")[0])}</td>
                <td><span className={`badge ${p.tipo === "vacaciones" ? "b-info" : "b-warn"}`}>{p.tipo}</span></td>
                <td>{p.dias || "—"}</td>
                <td style={{textAlign:"right"}}>
                  <span className="num kpi-acc">{fmt_$(montoMostrado)}</span>
                  {p.pendiente && <div style={{fontSize:9,color:"var(--muted2)"}}>de {fmt_$(p.monto)}</div>}
                </td>
                <td>{p.pendiente ? <span className="badge b-warn" style={{fontSize:8}}>Parcial</span> : <span className="badge b-success" style={{fontSize:8}}>Completo</span>}</td>
              </tr>
            );
          })}</tbody></table>
        )}
      </div>

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      {(() => {
        const totalPagado = vacLineas.reduce((s, l) => s + (parseFloat(l.monto) || 0), 0);
        const restante = plusVacacional - totalPagado;
        const esParcial = totalPagado > 0 && totalPagado < plusVacacional - 0.01;
        const puedeConfirmar = totalPagado > 0 && vacLineas.every((l) => parseFloat(l.monto) > 0 && !!l.cuenta);
        return (
          <Modal
            isOpen={vacModal}
            onClose={() => setVacModal(false)}
            title="Pagar vacaciones"
            maxWidth={480}
            footer={
              <>
                <button className="btn btn-sec" onClick={() => setVacModal(false)}>Cancelar</button>
                <button className="btn btn-acc" onClick={pagarVacaciones} disabled={!puedeConfirmar}>
                  {esParcial ? "Registrar pago parcial" : "Confirmar pago"}
                </button>
              </>
            }
          >
            <div className="field"><label>Días a pagar</label>
              <input type="number" value={vacDias} onChange={e => setVacDias(e.target.value)} placeholder={vacAcumuladas.toFixed(1)} />
            </div>
            <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",marginBottom:12,borderBottom:"1px solid var(--bd)"}}>
              <span style={{fontSize:12,color:"var(--muted2)"}}>Plus vacacional recomendado</span>
              <span style={{fontSize:14,fontWeight:500,color:"var(--acc)"}}>{fmt_$(plusVacacional)}</span>
            </div>
            <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Formas de pago</div>
            {/* Bug Caja-1 fix: cada línea tiene placeholder y la validación
                de "puedeConfirmar" exige cuenta != "". */}
            {vacLineas.map((l, i) => (
              <div key={i} style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
                <select className="search" style={{flex:1}} value={l.cuenta}
                  onChange={e => setVacLineas((prev) => prev.map((f, j) => j === i ? { ...f, cuenta: e.target.value } : f))}>
                  <option value="">Seleccioná una cuenta…</option>
                  {cuentasUsables.map((c: string) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input type="number" className="search" style={{width:120}} placeholder="Monto" value={l.monto}
                  onChange={e => setVacLineas((prev) => prev.map((f, j) => j === i ? { ...f, monto: e.target.value } : f))} />
                {vacLineas.length > 1 && <button className="btn btn-danger btn-sm" onClick={() => setVacLineas((prev) => prev.filter((_, j) => j !== i))}>✕</button>}
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" style={{marginBottom:12}}
              onClick={() => setVacLineas((prev) => [...prev, { cuenta: "", monto: restante > 0 ? String(Math.round(restante)) : "" }])}>
              + Agregar forma de pago
            </button>
            <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:"1px solid var(--bd)"}}>
              <span style={{fontSize:12,color: esParcial ? "var(--warn)" : "var(--muted2)"}}>
                {esParcial ? "Pago parcial — Restante" : "Restante"}
              </span>
              <span style={{fontSize:14,fontWeight:500,color: Math.abs(restante) < 0.5 ? "var(--success)" : "var(--warn)"}}>
                {fmt_$(Math.max(0, restante))}
              </span>
            </div>
          </Modal>
        );
      })()}

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      {(() => {
        const totalPagado = aguLineas.reduce((s, l) => s + (parseFloat(l.monto) || 0), 0);
        const restante = sacAcumulado - totalPagado;
        const esParcial = totalPagado > 0 && totalPagado < sacAcumulado - 0.01;
        const puedeConfirmar = totalPagado > 0 && aguLineas.every((l) => parseFloat(l.monto) > 0 && !!l.cuenta);
        return (
          <Modal
            isOpen={aguModal}
            onClose={() => setAguModal(false)}
            title="Pagar aguinaldo"
            maxWidth={480}
            footer={
              <>
                <button className="btn btn-sec" onClick={() => setAguModal(false)}>Cancelar</button>
                <button className="btn btn-acc" onClick={pagarAguinaldo} disabled={!puedeConfirmar}>
                  {esParcial ? "Registrar pago parcial" : "Confirmar pago"}
                </button>
              </>
            }
          >
            <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",marginBottom:8,borderBottom:"1px solid var(--bd)"}}>
              <span style={{fontSize:12,color:"var(--muted2)"}}>Acumulado proporcional</span>
              <span style={{fontSize:14,fontWeight:500,color:"var(--acc)"}}>{fmt_$(sacAcumulado)}</span>
            </div>
            <div style={{fontSize:10,color:"var(--muted2)",marginBottom:12}}>Teórico semestre completo: {fmt_$(sacTeorico)}</div>
            <div style={{fontSize:10,color:"var(--muted)",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Formas de pago</div>
            {aguLineas.map((l, i) => (
              <div key={i} style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
                <select className="search" style={{flex:1}} value={l.cuenta}
                  onChange={e => setAguLineas((prev) => prev.map((f, j) => j === i ? { ...f, cuenta: e.target.value } : f))}>
                  <option value="">Seleccioná una cuenta…</option>
                  {cuentasUsables.map((c: string) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input type="number" className="search" style={{width:120}} placeholder="Monto" value={l.monto}
                  onChange={e => setAguLineas((prev) => prev.map((f, j) => j === i ? { ...f, monto: e.target.value } : f))} />
                {aguLineas.length > 1 && <button className="btn btn-danger btn-sm" onClick={() => setAguLineas((prev) => prev.filter((_, j) => j !== i))}>✕</button>}
              </div>
            ))}
            <button className="btn btn-ghost btn-sm" style={{marginBottom:12}}
              onClick={() => setAguLineas((prev) => [...prev, { cuenta: "", monto: restante > 0 ? String(Math.round(restante)) : "" }])}>
              + Agregar forma de pago
            </button>
            <div style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderTop:"1px solid var(--bd)"}}>
              <span style={{fontSize:12,color: esParcial ? "var(--warn)" : "var(--muted2)"}}>
                {esParcial ? "Pago parcial — Restante" : "Restante"}
              </span>
              <span style={{fontSize:14,fontWeight:500,color: Math.abs(restante) < 0.5 ? "var(--success)" : "var(--warn)"}}>
                {fmt_$(Math.max(0, restante))}
              </span>
            </div>
          </Modal>
        );
      })()}
    </>
  );
}

interface TabDocumentosProps {
  docs: DocumentoLegajo[];
  esDueno: boolean;
  docModal: boolean;
  setDocModal: React.Dispatch<React.SetStateAction<boolean>>;
  docForm: { tipo: string; mes: string; anio: string };
  setDocForm: React.Dispatch<React.SetStateAction<{ tipo: string; mes: string; anio: string }>>;
  uploading: boolean;
  subirDoc: (file: File) => Promise<void>;
  verDoc: (doc: DocumentoLegajo) => Promise<void>;
  eliminarDoc: (doc: DocumentoLegajo) => Promise<void>;
}

function TabDocumentos({
  docs, esDueno,
  docModal, setDocModal, docForm, setDocForm,
  uploading, subirDoc, verDoc, eliminarDoc,
}: TabDocumentosProps) {
  return (
    <>
      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:12}}>
        {esDueno && <button className="btn btn-acc btn-sm" onClick={() => setDocModal(true)}>+ Subir documento</button>}
      </div>
      <div className="panel">
        {docs.length === 0 ? <div className="empty">Sin documentos</div> : (
          <table><thead><tr><th>Nombre</th><th>Tipo</th><th>Período</th><th>Fecha</th><th></th></tr></thead>
          <tbody>{docs.map((d) => (
            <tr key={d.id}>
              <td style={{fontWeight:500,fontSize:11}}>{d.nombre_archivo}</td>
              <td><span className="badge b-info">{DOC_TIPOS.find(t => t.value === d.tipo)?.label || d.tipo}</span></td>
              <td style={{fontSize:11,color:"var(--muted2)"}}>{d.mes && d.anio ? `${MESES[d.mes]} ${d.anio}` : "—"}</td>
              <td className="mono" style={{fontSize:11}}>{fmt_d(d.subido_at?.split("T")[0])}</td>
              <td>
                <div style={{display:"flex",gap:4}}>
                  <button className="btn btn-ghost btn-sm" onClick={() => verDoc(d)}>Ver</button>
                  {esDueno && <button className="btn btn-danger btn-sm" onClick={() => eliminarDoc(d)}>X</button>}
                </div>
              </td>
            </tr>
          ))}</tbody></table>
        )}
      </div>

      {/* AUDIT F4B#1 / sprint #5: migrado a <Modal> compartido. */}
      <Modal
        isOpen={docModal}
        onClose={() => setDocModal(false)}
        title="Subir documento"
        maxWidth={480}
        footer={<button className="btn btn-sec" onClick={() => setDocModal(false)}>Cerrar</button>}
      >
        <div className="field"><label>Tipo de documento</label>
          <select value={docForm.tipo} onChange={e => setDocForm({...docForm, tipo:e.target.value})}>
            {DOC_TIPOS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select></div>
        <div className="form2">
          <div className="field"><label>Mes (opcional)</label>
            <select value={docForm.mes} onChange={e => setDocForm({...docForm, mes:e.target.value})}>
              <option value="">—</option>{MESES.slice(1).map((m,i) => <option key={i+1} value={i+1}>{m}</option>)}
            </select></div>
          <div className="field"><label>Año (opcional)</label>
            <input type="number" value={docForm.anio} onChange={e => setDocForm({...docForm, anio:e.target.value})} placeholder={String(today.getFullYear())} /></div>
        </div>
        <div className="field"><label>Archivo</label>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
            onChange={e => e.target.files?.[0] && subirDoc(e.target.files[0])}
            style={{background:"var(--bg)",border:"1px solid var(--bd)",padding:8,borderRadius:"var(--r)",width:"100%",color:"var(--txt)",fontFamily:"'DM Mono',monospace",fontSize:12}} />
        </div>
        {uploading && <div className="loading">Subiendo...</div>}
      </Modal>
    </>
  );
}