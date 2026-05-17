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

// Indicador individual — card con 2 estados: vacío (CTA "+ Definir") y
// cargado (valor formateado + Editar/Borrar). Click → modo edición inline
// con input + Guardar/Cancelar (sin autosave, decisión Lucas 2026-05-17).
type IndicadorKey =
  | "facturacion_objetivo"
  | "costos_fijos_mes"
  | "margen_contribucion_pct"
  | "costo_mercaderia_pct"
  | "costo_mp_pct"
  | "margen_bruto_pct";

interface IndicadorMeta {
  key: IndicadorKey;
  title: string;
  info: string;
  format: "currency" | "percent";
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

const INDICADORES: Record<"facturacion" | "bep" | "eficiencia", IndicadorMeta[]> = {
  facturacion: [
    {
      key: "facturacion_objetivo",
      title: "Facturación objetivo del mes",
      info: "Cuánto querés facturar este mes en esta sucursal. Se compara contra lo facturado a la fecha en el widget 'Objetivo del mes' del dashboard.",
      format: "currency",
      placeholder: "12000000",
    },
  ],
  bep: [
    {
      key: "costos_fijos_mes",
      title: "Costos fijos del mes",
      info: "Suma esperada de gastos fijos: alquiler + servicios + cuotas + suscripciones. (El labor cost se calcula automático sumando los sueldos pagados el mes anterior.)",
      format: "currency",
      placeholder: "alquiler+servicios+...",
    },
    {
      key: "margen_contribucion_pct",
      title: "Margen contribución %",
      info: "% que te queda de cada peso vendido después de restar el costo variable (CMV + comisiones + delivery). Si no lo cargás, el sistema usa 50% como default.",
      format: "percent",
      placeholder: "55",
      min: 0, max: 100, step: 0.5,
    },
  ],
  eficiencia: [
    {
      key: "costo_mercaderia_pct",
      title: "CMV objetivo %",
      info: "Costo de mercadería sobre venta. Cuánto del precio se va en insumos. Típico en gastronomía AR: 28-35%.",
      format: "percent",
      placeholder: "32",
      min: 0, max: 100, step: 0.5,
    },
    {
      key: "costo_mp_pct",
      title: "Costo MP objetivo %",
      info: "Comisiones de MercadoPago sobre venta total. Depende del plan MP. Típico: 2-5%.",
      format: "percent",
      placeholder: "3.5",
      min: 0, max: 20, step: 0.1,
    },
    {
      key: "margen_bruto_pct",
      title: "Margen bruto objetivo %",
      info: "Lo que te queda después de descontar el CMV. (venta − costo mercadería) ÷ venta × 100. Típico: 65-72%.",
      format: "percent",
      placeholder: "60",
      min: 0, max: 100, step: 0.5,
    },
  ],
};

function FilaObjetivo({ fila, saving, onSave }: FilaProps) {
  const [notas, setNotas] = useState(fila.notas ?? "");
  const [notasEditando, setNotasEditando] = useState(false);

  useEffect(() => { setNotas(fila.notas ?? ""); }, [fila.local_id, fila.notas]);

  // BEP derivado para mostrar al lado de los inputs de fijos/margen
  const bep = (fila.costos_fijos_mes != null && fila.margen_contribucion_pct != null && fila.margen_contribucion_pct > 0)
    ? fila.costos_fijos_mes / (fila.margen_contribucion_pct / 100)
    : null;

  // Contador: cuántos indicadores tiene cargados de 6
  const totalIndicadores = 6;
  const cargados = [
    fila.facturacion_objetivo, fila.costos_fijos_mes, fila.margen_contribucion_pct,
    fila.costo_mercaderia_pct, fila.costo_mp_pct, fila.margen_bruto_pct,
  ].filter(v => v != null).length;

  function getValor(key: IndicadorKey): number | null {
    return fila[key] ?? null;
  }

  function saveIndicador(key: IndicadorKey, value: number | null) {
    onSave({ [key]: value });
  }

  function saveNotas() {
    onSave({ notas: notas.trim() || null });
    setNotasEditando(false);
  }

  return (
    <div className="panel" style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4, gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: "var(--pase-fs-lg)", fontWeight: 500, color: "var(--pase-text)" }}>
          {fila.local_nombre}
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
            {cargados} de {totalIndicadores} indicadores cargados
          </span>
          {saving && <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-celeste)" }}>guardando…</span>}
        </div>
      </div>

      <p style={{ margin: "0 0 16px", fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
        Cargá los indicadores que te interesen — ninguno es obligatorio. Los que no cargás simplemente no aparecen en los widgets del dashboard.
      </p>

      {/* ─── Grupo 1: Facturación ─── */}
      <GroupTitle>Facturación</GroupTitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8, marginBottom: 18 }}>
        {INDICADORES.facturacion.map(meta => (
          <IndicadorCard
            key={meta.key}
            meta={meta}
            valor={getValor(meta.key)}
            onSave={(v) => saveIndicador(meta.key, v)}
          />
        ))}
      </div>

      {/* ─── Grupo 2: BEP ─── */}
      <GroupTitle>Punto de equilibrio</GroupTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginBottom: bep !== null ? 10 : 18 }}>
        {INDICADORES.bep.map(meta => (
          <IndicadorCard
            key={meta.key}
            meta={meta}
            valor={getValor(meta.key)}
            onSave={(v) => saveIndicador(meta.key, v)}
          />
        ))}
      </div>
      {bep !== null && (
        <div style={{ marginBottom: 18, padding: "10px 12px", background: "var(--pase-celeste-100)", borderRadius: 8, fontSize: "var(--pase-fs-sm)", borderLeft: "3px solid var(--pase-celeste)" }}>
          <strong>BEP del mes calculado:</strong>{" "}
          <strong style={{ color: "var(--pase-celeste)", fontVariantNumeric: "tabular-nums" }}>{formatCurrency(bep)}</strong>
          <span style={{ color: "var(--pase-text-muted)", marginLeft: 6 }}>
            ({formatCurrency(fila.costos_fijos_mes ?? 0)} ÷ {fila.margen_contribucion_pct ?? 0}%)
          </span>
        </div>
      )}

      {/* ─── Grupo 3: Eficiencia ─── */}
      <GroupTitle info="Estos % se calculan al cerrar el mes (en Reportes). A mitad de mes los números mienten porque las facturas vencidas y los desfasajes de pago distorsionan el costo real.">
        Eficiencia · cierre de mes
      </GroupTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginBottom: 18 }}>
        {INDICADORES.eficiencia.map(meta => (
          <IndicadorCard
            key={meta.key}
            meta={meta}
            valor={getValor(meta.key)}
            onSave={(v) => saveIndicador(meta.key, v)}
          />
        ))}
      </div>

      {/* ─── Notas ─── */}
      <GroupTitle>Notas del mes</GroupTitle>
      {notasEditando ? (
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <input
            type="text"
            value={notas}
            onChange={e => setNotas(e.target.value)}
            placeholder="ej. campaña navidad, mes con refacción 5 días..."
            maxLength={200}
            autoFocus
            style={{ flex: 1, height: "var(--pase-h-md)", padding: "0 11px", border: "0.5px solid var(--pase-border-strong)", borderRadius: 8, background: "var(--pase-bg)", color: "var(--pase-text)", fontFamily: "var(--pase-font)", fontSize: "var(--pase-fs-base)" }}
          />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setNotas(fila.notas ?? ""); setNotasEditando(false); }}>Cancelar</button>
          <button type="button" className="btn btn-acc btn-sm" onClick={saveNotas}>Guardar</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setNotasEditando(true)}
          style={{
            width: "100%", textAlign: "left", padding: "10px 12px",
            border: "0.5px dashed var(--pase-border-strong)", borderRadius: 8,
            background: "transparent", cursor: "pointer", color: notas ? "var(--pase-text)" : "var(--pase-text-muted)",
            fontSize: "var(--pase-fs-sm)", fontFamily: "var(--pase-font)",
            fontStyle: notas ? "normal" : "italic",
          }}
        >
          {notas || "+ Agregar nota del mes (opcional)"}
        </button>
      )}
    </div>
  );
}

// ─── IndicadorCard ─────────────────────────────────────────────────────
interface IndicadorCardProps {
  meta: IndicadorMeta;
  valor: number | null;
  onSave: (v: number | null) => void;
}

function IndicadorCard({ meta, valor, onSave }: IndicadorCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(valor != null ? String(valor) : "");

  useEffect(() => { setDraft(valor != null ? String(valor) : ""); }, [valor]);

  function commit() {
    const n = parseFloat(draft.replace(/[^0-9.-]/g, ""));
    onSave(isNaN(n) ? null : n);
    setEditing(false);
  }

  function cancel() {
    setDraft(valor != null ? String(valor) : "");
    setEditing(false);
  }

  function clear() {
    onSave(null);
    setDraft("");
    setEditing(false);
  }

  const cargado = valor != null;
  const formatted = !cargado ? null
    : meta.format === "currency" ? formatCurrency(valor)
    : `${valor}%`;

  return (
    <div style={{
      border: `0.5px solid ${cargado ? "var(--pase-celeste-300)" : "var(--pase-border)"}`,
      background: cargado ? "var(--pase-celeste-100)" : "var(--pase-bg)",
      borderRadius: 10,
      padding: "10px 12px",
      transition: "all 0.15s",
    }}>
      {/* Header — título + tooltip */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", fontWeight: 500 }}>
          {meta.title}
        </span>
        <InfoTooltip maxWidth={260} size={14}>{meta.info}</InfoTooltip>
      </div>

      {editing ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="number"
            inputMode="decimal"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder={meta.placeholder}
            min={meta.min}
            max={meta.max}
            step={meta.step}
            autoFocus
            onKeyDown={e => { if (e.key === "Enter") commit(); else if (e.key === "Escape") cancel(); }}
            style={{ flex: 1, height: "var(--pase-h-sm)", padding: "0 10px", border: "0.5px solid var(--pase-border-strong)", borderRadius: 6, background: "var(--pase-bg)", color: "var(--pase-text)", fontFamily: "var(--pase-font)", fontSize: "var(--pase-fs-base)" }}
          />
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancel} title="Cancelar (Esc)">✕</button>
          <button type="button" className="btn btn-acc btn-sm" onClick={commit} title="Guardar (Enter)">✓</button>
        </div>
      ) : cargado ? (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <strong style={{ fontSize: "var(--pase-fs-lg)", color: "var(--pase-text)", fontVariantNumeric: "tabular-nums", letterSpacing: "var(--pase-ls-tight)" }}>
            {formatted}
          </strong>
          <div style={{ display: "flex", gap: 4 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)} style={{ fontSize: 10 }}>Editar</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={clear} style={{ fontSize: 10 }} title="Borrar objetivo">✕</button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          style={{
            width: "100%", padding: "6px 0", background: "transparent",
            border: "none", cursor: "pointer", textAlign: "left",
            color: "var(--pase-celeste)", fontSize: "var(--pase-fs-sm)",
            fontFamily: "var(--pase-font)", fontWeight: 500,
          }}
        >
          + Definir objetivo
        </button>
      )}
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

