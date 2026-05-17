import { useEffect, useMemo, useState } from "react";
import { db } from "../lib/supabase";
import { PageHeader, EmptyState, InfoTooltip } from "../components/ui";
import { formatCurrency } from "../lib/format";
import type { Local } from "../types";

interface ObjetivoFila {
  local_id: number;
  local_nombre: string;
  id: number | null;  // null si todavía no existe la fila en DB
  // Facturación y volumen (se miden en cualquier momento)
  facturacion_objetivo: number | null;
  // ticket_promedio_objetivo: oculto hasta integración COMANDA. La columna
  // existe en DB pero no se carga ni se muestra — Maxirest solo trae totales
  // diarios, no líneas, así que calcular ticket promedio acá sería engañoso.
  // Punto de equilibrio
  costos_fijos_mes: number | null;
  margen_contribucion_pct: number | null;
  // Objetivos de eficiencia (% — se comparan contra EERR a fin de mes)
  costo_mercaderia_pct: number | null;
  costo_mp_pct: number | null;
  margen_bruto_pct: number | null;
  notas: string | null;
}

interface Props {
  locales: Local[];
  tenantId: string;
  /** Sucursal seleccionada en el sidebar. Si !== null filtramos a SOLO esa sucursal.
   * Si === null, mostramos un selector interno para elegir cuál editar (mejor que
   * scrollear por todas). */
  localActivo: number | null;
}

/**
 * Pantalla Objetivos — el dueño/admin carga objetivos mes a mes por local.
 *
 * Lee/escribe tabla `objetivos_mes` (migration 202605161600). Reemplazó
 * el placeholder anterior. El widget ObjetivosMesWidget y PuntoEquilibrioWidget
 * leen estos valores.
 *
 * Decisión Lucas 2026-05-17: a mitad de mes las métricas devengadas
 * mienten (los fijos caen los primeros 15 días). Por eso esta pantalla
 * pide explícitamente **costos fijos del mes** + **margen de contribución
 * esperado** — insumos del Punto de Equilibrio, métrica honesta en cualquier
 * momento del mes.
 */
export default function Objetivos({ locales, tenantId, localActivo }: Props) {
  const [mes, setMes] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [filas, setFilas] = useState<ObjetivoFila[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sucursal "interna" cuando el sidebar dice "Todas las sucursales".
  // Si localActivo del sidebar !== null, este state queda forzado a ese valor.
  // Si el sidebar es null, el dueño DEBE elegir explícitamente cuál editar —
  // NO pre-poblamos con la primera (decisión Lucas 2026-05-17: el modo "Todas"
  // no debe sugerir ninguna sucursal por default, hay que forzar el click
  // para evitar carga accidental en la equivocada).
  const [localInterno, setLocalInterno] = useState<number | null>(localActivo);

  useEffect(() => {
    // Si el sidebar tiene una sucursal específica → sincronizamos.
    // Si el sidebar vuelve a "Todas" (null) → reseteamos a null para forzar
    // elección explícita (no mantenemos el último elegido — sería confuso).
    setLocalInterno(localActivo);
  }, [localActivo]);

  // Sucursal efectiva sobre la que se está trabajando.
  const localTrabajando = localActivo ?? localInterno;
  const bloqueadoPorSidebar = localActivo !== null;

  // Primer día del mes en formato ISO (clave única en la tabla).
  const mesIso = useMemo(() => `${mes}-01`, [mes]);

  async function load() {
    setLoading(true);
    setError(null);
    const { data, error } = await db
      .from("objetivos_mes")
      .select("id, local_id, facturacion_objetivo, costos_fijos_mes, margen_contribucion_pct, costo_mercaderia_pct, costo_mp_pct, margen_bruto_pct, notas")
      .eq("mes", mesIso);
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    const porLocal = new Map<number, {
      id: number;
      facturacion_objetivo: number | null;
      costos_fijos_mes: number | null;
      margen_contribucion_pct: number | null;
      costo_mercaderia_pct: number | null;
      costo_mp_pct: number | null;
      margen_bruto_pct: number | null;
      notas: string | null;
    }>();
    for (const r of data ?? []) {
      const row = r as {
        id: number; local_id: number;
        facturacion_objetivo: number | null;
        costos_fijos_mes: number | null; margen_contribucion_pct: number | null;
        costo_mercaderia_pct: number | null; costo_mp_pct: number | null; margen_bruto_pct: number | null;
        notas: string | null;
      };
      porLocal.set(row.local_id, row);
    }
    const rows: ObjetivoFila[] = locales.map(l => {
      const stored = porLocal.get(l.id);
      return {
        local_id: l.id,
        local_nombre: l.nombre,
        id: stored?.id ?? null,
        facturacion_objetivo: stored?.facturacion_objetivo ?? null,
        costos_fijos_mes: stored?.costos_fijos_mes ?? null,
        margen_contribucion_pct: stored?.margen_contribucion_pct ?? null,
        costo_mercaderia_pct: stored?.costo_mercaderia_pct ?? null,
        costo_mp_pct: stored?.costo_mp_pct ?? null,
        margen_bruto_pct: stored?.margen_bruto_pct ?? null,
        notas: stored?.notas ?? null,
      };
    });
    setFilas(rows);
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mesIso, locales]);

  async function guardarFila(localId: number, patch: Partial<Omit<ObjetivoFila, "local_id" | "local_nombre" | "id">>) {
    setSavingId(localId);
    setError(null);
    const fila = filas.find(f => f.local_id === localId);
    if (!fila) { setSavingId(null); return; }
    const next = { ...fila, ...patch };
    setFilas(prev => prev.map(f => f.local_id === localId ? next : f));
    const { error } = await db
      .from("objetivos_mes")
      .upsert({
        tenant_id: tenantId,
        local_id: localId,
        mes: mesIso,
        facturacion_objetivo: next.facturacion_objetivo,
        // ticket_promedio_objetivo intencionalmente NO se setea — esperando
        // integración con COMANDA para tener ticket real.
        costos_fijos_mes: next.costos_fijos_mes,
        margen_contribucion_pct: next.margen_contribucion_pct,
        costo_mercaderia_pct: next.costo_mercaderia_pct,
        costo_mp_pct: next.costo_mp_pct,
        margen_bruto_pct: next.margen_bruto_pct,
        notas: next.notas,
      }, { onConflict: "local_id,mes" });
    if (error) setError(error.message);
    setSavingId(null);
    // Recargar para refrescar el id (en caso de insert nuevo).
    void load();
  }

  if (locales.length === 0) {
    return (
      <div style={{ padding: "0 20px" }}>
        <PageHeader title="Objetivos" subtitle="metas mes a mes por sucursal" />
        <EmptyState
          icon="🏪"
          title="Sin sucursales"
          description="Creá al menos un local desde Ajustes para poder cargar objetivos."
        />
      </div>
    );
  }

  // Sucursal mostrada actualmente
  const filaTrabajando = filas.find(f => f.local_id === localTrabajando);

  return (
    <div style={{ padding: "0 20px" }}>
      <PageHeader
        title="Objetivos"
        subtitle="metas mes a mes por sucursal"
        info={
          <>
            <strong>Facturación:</strong> objetivo del mes vs facturado a la fecha (se ve en Negocio mid-month).<br />
            <strong>Punto de equilibrio:</strong> costos fijos + margen contribución. BEP = fijos ÷ margen % (se ve en Negocio mid-month).<br />
            <strong>Eficiencia:</strong> CMV %, costo MP %, margen bruto %. Se comparan contra el EERR cerrado a fin de mes en Reportes (mid-month estos números mienten porque las facturas vencidas distorsionan el costo).
            {bloqueadoPorSidebar && <><br /><strong>Sucursal bloqueada por el sidebar.</strong> Para cambiar, andá al selector del sidebar.</>}
          </>
        }
        actions={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {/* Selector de sucursal interna SOLO cuando el sidebar dice "Todas".
                Si el sidebar tiene una sucursal específica, mostramos un chip
                bloqueado para que sea obvio que viene del sidebar. */}
            {bloqueadoPorSidebar ? (
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                padding: "0 12px", height: "var(--pase-h-sm)",
                background: "var(--pase-celeste-100)", borderRadius: 8,
                fontSize: "var(--pase-fs-sm)", color: "var(--pase-text)",
                border: "0.5px solid var(--pase-celeste-300)",
              }}>
                <span style={{ fontSize: 10, opacity: 0.7 }}>🔒</span>
                {filaTrabajando?.local_nombre ?? "—"}
              </div>
            ) : (
              <select
                value={localTrabajando ?? ""}
                onChange={e => setLocalInterno(e.target.value ? Number(e.target.value) : null)}
                className="search"
                style={{ width: 220, borderColor: localTrabajando === null ? "#D97706" : undefined }}
              >
                <option value="">— Seleccionar sucursal —</option>
                {locales.map(l => (
                  <option key={l.id} value={l.id}>{l.nombre}</option>
                ))}
              </select>
            )}
            <input
              type="month"
              value={mes}
              onChange={e => setMes(e.target.value)}
              className="search"
              style={{ width: 160 }}
            />
          </div>
        }
      />

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>
      )}

      {loading ? (
        <div className="loading">Cargando objetivos…</div>
      ) : !filaTrabajando ? (
        <EmptyState
          icon="🏪"
          title="Seleccioná una sucursal"
          description="Elegí del selector de arriba a qué sucursal cargarle objetivos."
        />
      ) : (
        <FilaObjetivo
          key={filaTrabajando.local_id}
          fila={filaTrabajando}
          saving={savingId === filaTrabajando.local_id}
          onSave={(patch) => guardarFila(filaTrabajando.local_id, patch)}
        />
      )}
    </div>
  );
}

interface FilaProps {
  fila: ObjetivoFila;
  saving: boolean;
  onSave: (patch: Partial<Omit<ObjetivoFila, "local_id" | "local_nombre" | "id">>) => void;
}

function FilaObjetivo({ fila, saving, onSave }: FilaProps) {
  // Grupo 1: facturación
  // (Ticket promedio removido a la espera de integración COMANDA — Maxirest
  // solo trae totales agregados, no líneas, por lo que calcular ticket promedio
  // sería ruidoso. Se reactiva cuando COMANDA pushee data real.)
  const [facturacion, setFacturacion] = useState(String(fila.facturacion_objetivo ?? ""));
  // Grupo 2: BEP
  const [fijos, setFijos] = useState(String(fila.costos_fijos_mes ?? ""));
  const [margenC, setMargenC] = useState(String(fila.margen_contribucion_pct ?? ""));
  // Grupo 3: eficiencia (cierre)
  const [cmv, setCmv] = useState(String(fila.costo_mercaderia_pct ?? ""));
  const [costoMp, setCostoMp] = useState(String(fila.costo_mp_pct ?? ""));
  const [margenB, setMargenB] = useState(String(fila.margen_bruto_pct ?? ""));
  // Notas
  const [notas, setNotas] = useState(fila.notas ?? "");

  useEffect(() => {
    setFacturacion(String(fila.facturacion_objetivo ?? ""));
    setFijos(String(fila.costos_fijos_mes ?? ""));
    setMargenC(String(fila.margen_contribucion_pct ?? ""));
    setCmv(String(fila.costo_mercaderia_pct ?? ""));
    setCostoMp(String(fila.costo_mp_pct ?? ""));
    setMargenB(String(fila.margen_bruto_pct ?? ""));
    setNotas(fila.notas ?? "");
  }, [
    fila.local_id,
    fila.facturacion_objetivo,
    fila.costos_fijos_mes, fila.margen_contribucion_pct,
    fila.costo_mercaderia_pct, fila.costo_mp_pct, fila.margen_bruto_pct,
    fila.notas,
  ]);

  const facturacionNum = parseFloat(facturacion.replace(/[^0-9.-]/g, ""));
  const fijosNum = parseFloat(fijos.replace(/[^0-9.-]/g, ""));
  const margenCNum = parseFloat(margenC.replace(/[^0-9.-]/g, ""));
  const bep = (!isNaN(fijosNum) && !isNaN(margenCNum) && margenCNum > 0)
    ? fijosNum / (margenCNum / 100)
    : null;

  type Field =
    | "fact"
    | "fijos" | "margenC"
    | "cmv" | "mp" | "margenB"
    | "notas";

  function handleBlur(field: Field) {
    const patch: Parameters<typeof onSave>[0] = {};
    if (field === "fact") patch.facturacion_objetivo = isNaN(facturacionNum) ? null : facturacionNum;
    if (field === "fijos") patch.costos_fijos_mes = isNaN(fijosNum) ? null : fijosNum;
    if (field === "margenC") patch.margen_contribucion_pct = isNaN(margenCNum) ? null : margenCNum;
    if (field === "cmv") {
      const n = parseFloat(cmv.replace(/[^0-9.-]/g, ""));
      patch.costo_mercaderia_pct = isNaN(n) ? null : n;
    }
    if (field === "mp") {
      const n = parseFloat(costoMp.replace(/[^0-9.-]/g, ""));
      patch.costo_mp_pct = isNaN(n) ? null : n;
    }
    if (field === "margenB") {
      const n = parseFloat(margenB.replace(/[^0-9.-]/g, ""));
      patch.margen_bruto_pct = isNaN(n) ? null : n;
    }
    if (field === "notas") patch.notas = notas.trim() || null;
    onSave(patch);
  }

  return (
    <div className="panel" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16, gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: "var(--pase-fs-lg)", fontWeight: 500, color: "var(--pase-text)" }}>
          {fila.local_nombre}
        </h3>
        {saving && <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>guardando…</span>}
      </div>

      {/* ─── Grupo 1: Facturación ─── */}
      <GroupTitle>Facturación</GroupTitle>
      <div className="field" style={{ marginBottom: 0 }}>
        <FieldLabel
          text="Facturación objetivo (mes)"
          info="Cuánto querés facturar este mes en esta sucursal. Se compara contra lo facturado a la fecha en el widget 'Objetivo del mes' del dashboard."
        />
        <input
          type="number"
          inputMode="decimal"
          value={facturacion}
          onChange={e => setFacturacion(e.target.value)}
          onBlur={() => handleBlur("fact")}
        />
      </div>

      {/* ─── Grupo 2: BEP ─── */}
      <GroupTitle style={{ marginTop: 18 }}>Punto de equilibrio</GroupTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <FieldLabel
            text="Costos fijos (mes)"
            info="Suma esperada de gastos fijos del mes: alquiler + sueldos fijos + servicios + cuotas + suscripciones."
          />
          <input
            type="number"
            inputMode="decimal"
            value={fijos}
            onChange={e => setFijos(e.target.value)}
            onBlur={() => handleBlur("fijos")}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <FieldLabel
            text="Margen contribución %"
            info="% que te queda de cada peso vendido después de restar el costo variable (CMV + comisiones + delivery). Si no lo cargás, el sistema usa 50% como valor por defecto."
          />
          <input
            type="number"
            inputMode="decimal"
            value={margenC}
            onChange={e => setMargenC(e.target.value)}
            onBlur={() => handleBlur("margenC")}
            min={0}
            max={100}
            step={0.5}
          />
        </div>
      </div>
      {bep !== null && (
        <div style={{ marginTop: 10, padding: 10, background: "var(--pase-celeste-100)", borderRadius: 8, fontSize: "var(--pase-fs-sm)" }}>
          <strong>BEP del mes:</strong>{" "}
          <strong style={{ color: "var(--pase-celeste)", fontVariantNumeric: "tabular-nums" }}>
            {formatCurrency(bep)}
          </strong>
          <span style={{ color: "var(--pase-text-muted)", marginLeft: 6 }}>
            ({fijos || "0"} ÷ {margenC || "0"}%)
          </span>
        </div>
      )}

      {/* ─── Grupo 3: Eficiencia (cierre) ─── */}
      <GroupTitle
        style={{ marginTop: 18 }}
        info="Estos % se calculan al cerrar el mes (en Reportes). A mitad de mes los números mienten porque las facturas vencidas y los desfasajes de pago distorsionan el costo real."
      >
        Eficiencia · cierre de mes
      </GroupTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <FieldLabel
            text="CMV objetivo %"
            info="Costo de mercadería sobre venta. Cuánto del precio de venta se va en insumos (carne, verdura, bebidas, etc.). Típico en gastronomía AR: 28-35%."
          />
          <input
            type="number"
            inputMode="decimal"
            value={cmv}
            onChange={e => setCmv(e.target.value)}
            onBlur={() => handleBlur("cmv")}
            min={0}
            max={100}
            step={0.5}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <FieldLabel
            text="Costo MP objetivo %"
            info="Comisiones de MercadoPago sobre venta total. Depende del plan MP que tengas (Punto Pro, QR, Link, etc.). Típico: 2-5%."
          />
          <input
            type="number"
            inputMode="decimal"
            value={costoMp}
            onChange={e => setCostoMp(e.target.value)}
            onBlur={() => handleBlur("mp")}
            min={0}
            max={20}
            step={0.1}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <FieldLabel
            text="Margen bruto objetivo %"
            info="Lo que te queda después de descontar el CMV. Margen bruto = (venta − costo mercadería) ÷ venta × 100. Típico en gastronomía: 65-72%."
          />
          <input
            type="number"
            inputMode="decimal"
            value={margenB}
            onChange={e => setMargenB(e.target.value)}
            onBlur={() => handleBlur("margenB")}
            min={0}
            max={100}
            step={0.5}
          />
        </div>
      </div>

      <div className="field" style={{ marginTop: 18, marginBottom: 0 }}>
        <FieldLabel
          text="Notas del mes (opcional)"
          info="Contexto del mes que sirva para entender los números después. Ej: 'campaña navidad', 'mes con cierre 5 días por refacción', 'inflación alta'."
        />
        <input
          type="text"
          value={notas}
          onChange={e => setNotas(e.target.value)}
          onBlur={() => handleBlur("notas")}
          maxLength={200}
        />
      </div>
    </div>
  );
}

function GroupTitle({ children, style, info }: { children: React.ReactNode; style?: React.CSSProperties; info?: React.ReactNode }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 6,
      marginBottom: 8,
      paddingBottom: 4,
      borderBottom: "0.5px solid var(--pase-border)",
      ...style,
    }}>
      <span style={{
        fontSize: "var(--pase-fs-xs)",
        fontWeight: 500,
        color: "var(--pase-text-muted)",
        textTransform: "uppercase",
        letterSpacing: "var(--pase-ls-overline)",
      }}>
        {children}
      </span>
      {info && <InfoTooltip maxWidth={300}>{info}</InfoTooltip>}
    </div>
  );
}

function FieldLabel({ text, info }: { text: string; info: React.ReactNode }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {text}
      <InfoTooltip maxWidth={280} size={14}>{info}</InfoTooltip>
    </label>
  );
}
