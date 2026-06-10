import { useState, useMemo } from "react";
import { db } from "../lib/supabase";
import { translateRpcError } from "../lib/errors";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import { PageHeader, PageContainer, EmptyState, Modal } from "../components/ui";
import { fmt_$, fmt_d } from "@pase/shared/utils";
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

interface FilaExtracto {
  idx: number;
  fecha: string;
  monto: number;
  descripcion: string;
  referencia_externa: string | null;
  estado: "verde" | "amarillo" | "rojo_falta";
  num_candidatos: number;
  candidatos: CandidatoPase[];
}

interface Sobrante {
  id: string;
  fecha: string;
  importe: number;
  detalle: string;
}

interface Totales {
  extracto_total: number;
  verdes: number;
  amarillos: number;
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
  const [resueltos, setResueltos] = useState<Record<string, string>>({});
  // Estados temporales para el modal de "elegir candidato" en amarillos
  const [pickCandidato, setPickCandidato] = useState<FilaExtracto | null>(null);
  // Estado temporal para confirmar anulación de sobrante
  const [anularSobrante, setAnularSobrante] = useState<Sobrante | null>(null);
  const [motivoAnular, setMotivoAnular] = useState<string>("");
  // Estado temporal para confirmar creación de mov faltante
  const [crearFaltante, setCrearFaltante] = useState<FilaExtracto | null>(null);
  // Saving flags
  const [savingAccion, setSavingAccion] = useState(false);
  // Última corrida persistida (cerrada)
  const [corridaCerrada, setCorridaCerrada] = useState<{ id: string; created_at: string } | null>(null);

  // Si no hay local activo, pedir que elija desde el sidebar.
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

  const localNombre = locales.find(l => l.id === localActivo)?.nombre ?? `Local ${localActivo}`;

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
      });
      if (error) { showError(translateRpcError(error)); return; }
      setCruce(data as CruceResultado);
      setResueltos({});
      showToast("Conciliación lista. Revisá el semáforo.");
    } finally {
      setCruzando(false);
    }
  }

  // ─── Resolver cada caso ──────────────────────────────────────────────────
  function ignorarExtracto(idx: number) {
    setResueltos(p => ({ ...p, [`ext:${idx}`]: "ignorar" }));
  }
  function ignorarSobrante(id: string) {
    setResueltos(p => ({ ...p, [`sob:${id}`]: "ignorar" }));
  }
  function elegirCandidato(idx: number, movId: string) {
    setResueltos(p => ({ ...p, [`ext:${idx}`]: `matcheado:${movId}` }));
  }

  async function ejecutarCrearFaltante() {
    if (!crearFaltante) return;
    setSavingAccion(true);
    try {
      // Categorización: positivo → Ingreso Manual, negativo → Egreso Manual.
      // En el campo detalle dejamos toda la traza para auditoría.
      const esEgreso = crearFaltante.monto < 0;
      const tipoMov = esEgreso ? "Egreso Manual" : "Ingreso Manual";
      const detalle = `[Concil. ${periodoDesde.slice(0, 7)}] ${crearFaltante.descripcion}${crearFaltante.referencia_externa ? ` · ref ${crearFaltante.referencia_externa}` : ""}`;
      const { error } = await db.rpc("crear_movimiento_caja", {
        p_fecha: crearFaltante.fecha,
        p_cuenta: "MercadoPago",
        p_tipo: tipoMov,
        p_cat: null,
        p_importe: crearFaltante.monto,
        p_detalle: detalle,
        p_local_id: localActivo,
      });
      if (error) { showError(translateRpcError(error)); return; }
      setResueltos(p => ({ ...p, [`ext:${crearFaltante.idx}`]: "creado" }));
      setCrearFaltante(null);
      showToast("Movimiento creado");
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

  // ─── KPIs en vivo ────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!cruce) return null;
    let verdes = 0, amarillos = 0, rojos_falta = 0, rojos_sobra = 0;
    let resueltos_count = 0;
    for (const fila of cruce.extracto) {
      const r = resueltos[`ext:${fila.idx}`];
      if (r === "ignorar" || r === "creado" || (r && r.startsWith("matcheado:"))) {
        resueltos_count++;
        continue;
      }
      if (fila.estado === "verde") verdes++;
      else if (fila.estado === "amarillo") amarillos++;
      else if (fila.estado === "rojo_falta") rojos_falta++;
    }
    for (const sob of cruce.sobrantes) {
      const r = resueltos[`sob:${sob.id}`];
      if (r === "ignorar" || r === "anulado") { resueltos_count++; continue; }
      rojos_sobra++;
    }
    return {
      verdes, amarillos, rojos_falta, rojos_sobra,
      total_pendientes: amarillos + rojos_falta + rojos_sobra,
      resueltos_count,
      // verdes NO se cuentan como "pendiente" porque son OK automático
    };
  }, [cruce, resueltos]);

  // ─── Cerrar conciliación ─────────────────────────────────────────────────
  async function cerrarConciliacion() {
    if (!cruce || !stats) return;
    if (stats.total_pendientes > 0) {
      const ok = confirm(`Quedan ${stats.total_pendientes} casos sin resolver. ¿Cerrar igual?`);
      if (!ok) return;
    }
    setSavingAccion(true);
    try {
      // eslint-disable-next-line pase-local/no-direct-financiera-write -- C4: conciliacion_corridas NO es tabla financiera, es metadata histórica del cierre. No mueve plata.
      const { data, error } = await db.from("conciliacion_corridas").insert({
        local_id: localActivo,
        cuenta: "MercadoPago",
        periodo_desde: periodoDesde,
        periodo_hasta: periodoHasta,
        archivo_nombre: archivoNombre,
        total_movs: cruce.totales.extracto_total,
        verdes: cruce.totales.verdes,
        amarillos: cruce.totales.amarillos,
        rojos_falta: cruce.totales.rojos_falta,
        rojos_sobra: cruce.totales.rojos_sobra,
        saldo_inicial_extracto: resumenExtracto?.initial_balance ?? null,
        saldo_final_extracto: resumenExtracto?.final_balance ?? null,
        cerrada_at: new Date().toISOString(),
        cerrada_por: user?.id,
        created_by: user?.id,
        tenant_id: (user as { tenant_id?: string }).tenant_id,
      }).select("id, created_at").single();
      if (error) { showError(translateRpcError(error)); return; }
      setCorridaCerrada(data as { id: string; created_at: string });
      showToast("Conciliación cerrada y registrada");
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
  }

  // ─── RENDER ──────────────────────────────────────────────────────────────
  return (
    <PageContainer>
      <PageHeader title={`Conciliación · MercadoPago · ${localNombre}`} />

      {toast && <ToastComponent toast={toast} />}

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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
              <Kpi label="Total extracto" value={cruce.totales.extracto_total.toString()} color="var(--muted2)" />
              <Kpi label="🟢 Coinciden" value={stats.verdes.toString()} color="var(--success)" />
              <Kpi label="🟡 Por elegir" value={stats.amarillos.toString()} color="var(--warn)" />
              <Kpi label="🔴 Faltan en PASE" value={stats.rojos_falta.toString()} color="var(--danger)" />
              <Kpi label="🔴 Sobran en PASE" value={stats.rojos_sobra.toString()} color="var(--danger)" />
            </div>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: 13, color: "var(--muted2)" }}>
                {stats.resueltos_count > 0 && <>✓ {stats.resueltos_count} resueltos · </>}
                <strong>{stats.total_pendientes}</strong> casos pendientes
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-ghost" onClick={resetearTodo}>Cancelar todo</button>
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

          {/* AMARILLOS — múltiples candidatos */}
          <SeccionFilas
            titulo="🟡 Por elegir (varios candidatos)"
            descripcion="El extracto tiene un mov con monto X y en PASE hay varios con ese mismo monto en la ventana ±15d. Elegí cuál es el que corresponde."
            filas={cruce.extracto.filter(f =>
              f.estado === "amarillo"
              && !resueltos[`ext:${f.idx}`]
            )}
            renderFila={fila => (
              <FilaCard
                key={fila.idx}
                fecha={fila.fecha}
                monto={fila.monto}
                descripcion={fila.descripcion}
              >
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn btn-acc btn-sm" onClick={() => setPickCandidato(fila)}>
                    Elegir cuál es ({fila.num_candidatos} candidatos)
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => ignorarExtracto(fila.idx)}>
                    Ignorar
                  </button>
                </div>
              </FilaCard>
            )}
          />

          {/* ROJOS — falta en PASE */}
          <SeccionFilas
            titulo="🔴 Faltan en PASE (están en el extracto pero no se cargaron)"
            descripcion="Si era un cobro real, tocá Crear y queda registrado en Caja con cuenta MercadoPago."
            filas={cruce.extracto.filter(f =>
              f.estado === "rojo_falta"
              && !resueltos[`ext:${f.idx}`]
            )}
            renderFila={fila => (
              <FilaCard
                key={fila.idx}
                fecha={fila.fecha}
                monto={fila.monto}
                descripcion={fila.descripcion}
              >
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn btn-acc btn-sm" onClick={() => setCrearFaltante(fila)}>
                    Crear en Caja
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => ignorarExtracto(fila.idx)}>
                    Ignorar (es de otro mes / no me interesa)
                  </button>
                </div>
              </FilaCard>
            )}
          />

          {/* ROJOS — sobra en PASE */}
          <SeccionFilas
            titulo="🔴 Sobran en PASE (cargaste pero no están en el extracto)"
            descripcion="Probablemente un error humano: alguien cargó un mov MP que en realidad no entró. Tocá Anular y queda invalidado (con motivo)."
            filas={cruce.sobrantes.filter(s =>
              !resueltos[`sob:${s.id}`]
            )}
            renderFila={(sob) => (
              <FilaCard
                key={sob.id}
                fecha={sob.fecha}
                monto={sob.importe}
                descripcion={sob.detalle || "(sin detalle)"}
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

      {/* Modal: confirmar crear faltante */}
      {crearFaltante && (
        <Modal isOpen={true} onClose={() => setCrearFaltante(null)} title="Crear este movimiento en Caja">
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div>Fecha: <strong>{fmt_d(crearFaltante.fecha)}</strong></div>
            <div>Monto: <strong>{fmt_$(crearFaltante.monto)}</strong></div>
            <div>Cuenta: <strong>MercadoPago</strong></div>
            <div>Local: <strong>{localNombre}</strong></div>
            <div style={{ marginTop: 6 }}>Detalle: <em>[Concil. {periodoDesde.slice(0, 7)}] {crearFaltante.descripcion}{crearFaltante.referencia_externa ? ` · ref ${crearFaltante.referencia_externa}` : ""}</em></div>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setCrearFaltante(null)} disabled={savingAccion}>Cancelar</button>
            <button className="btn btn-acc" onClick={ejecutarCrearFaltante} disabled={savingAccion}>
              {savingAccion ? "Creando…" : "Confirmar crear"}
            </button>
          </div>
        </Modal>
      )}

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

function FilaCard({
  fecha,
  monto,
  descripcion,
  children,
}: {
  fecha: string;
  monto: number;
  descripcion: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      padding: 12, background: "var(--s2)", borderRadius: 6,
      display: "flex", flexDirection: "column", gap: 8,
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
