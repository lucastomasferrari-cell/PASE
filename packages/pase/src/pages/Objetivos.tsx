import { useEffect, useMemo, useState } from "react";
import { db } from "../lib/supabase";
import { PageHeader, EmptyState } from "../components/ui";
import { formatCurrency } from "../lib/format";
import type { Local } from "../types";

interface ObjetivoFila {
  local_id: number;
  local_nombre: string;
  id: number | null;  // null si todavía no existe la fila en DB
  facturacion_objetivo: number | null;
  costos_fijos_mes: number | null;
  margen_contribucion_pct: number | null;
  notas: string | null;
}

interface Props {
  locales: Local[];
  tenantId: string;
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
export default function Objetivos({ locales, tenantId }: Props) {
  const [mes, setMes] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [filas, setFilas] = useState<ObjetivoFila[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Primer día del mes en formato ISO (clave única en la tabla).
  const mesIso = useMemo(() => `${mes}-01`, [mes]);

  async function load() {
    setLoading(true);
    setError(null);
    const { data, error } = await db
      .from("objetivos_mes")
      .select("id, local_id, facturacion_objetivo, costos_fijos_mes, margen_contribucion_pct, notas")
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
      notas: string | null;
    }>();
    for (const r of data ?? []) {
      const row = r as { id: number; local_id: number; facturacion_objetivo: number | null; costos_fijos_mes: number | null; margen_contribucion_pct: number | null; notas: string | null };
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
        costos_fijos_mes: next.costos_fijos_mes,
        margen_contribucion_pct: next.margen_contribucion_pct,
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

  return (
    <div style={{ padding: "0 20px" }}>
      <PageHeader
        title="Objetivos"
        subtitle="metas mes a mes por sucursal"
        actions={
          <input
            type="month"
            value={mes}
            onChange={e => setMes(e.target.value)}
            className="search"
            style={{ width: 160 }}
          />
        }
      />

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>
      )}

      <div className="alert" style={{ marginBottom: 16 }}>
        <strong style={{ display: "block", marginBottom: 4 }}>¿Cómo se usan estos objetivos?</strong>
        <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", lineHeight: 1.5 }}>
          <strong>Facturación objetivo:</strong> mostrada en el widget "Objetivo del mes" del dashboard. Marca si vas en ritmo.<br />
          <strong>Costos fijos:</strong> alquiler + sueldos fijos + servicios + cuotas + suscripciones. Suma esperada del mes.<br />
          <strong>Margen contribución:</strong> % que queda de cada peso vendido después de restar costo variable (CMV + comisiones + delivery). Default 50% si no lo cargás.<br />
          <strong>Punto de equilibrio</strong> = costos fijos ÷ margen %. El widget BEP avisa si ya lo cubriste.
        </div>
      </div>

      {loading ? (
        <div className="loading">Cargando objetivos…</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {filas.map(f => (
            <FilaObjetivo
              key={f.local_id}
              fila={f}
              saving={savingId === f.local_id}
              onSave={(patch) => guardarFila(f.local_id, patch)}
            />
          ))}
        </div>
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
  const [facturacion, setFacturacion] = useState(String(fila.facturacion_objetivo ?? ""));
  const [fijos, setFijos] = useState(String(fila.costos_fijos_mes ?? ""));
  const [margen, setMargen] = useState(String(fila.margen_contribucion_pct ?? ""));
  const [notas, setNotas] = useState(fila.notas ?? "");

  useEffect(() => {
    setFacturacion(String(fila.facturacion_objetivo ?? ""));
    setFijos(String(fila.costos_fijos_mes ?? ""));
    setMargen(String(fila.margen_contribucion_pct ?? ""));
    setNotas(fila.notas ?? "");
  }, [fila.local_id, fila.facturacion_objetivo, fila.costos_fijos_mes, fila.margen_contribucion_pct, fila.notas]);

  const facturacionNum = parseFloat(facturacion.replace(/[^0-9.-]/g, ""));
  const fijosNum = parseFloat(fijos.replace(/[^0-9.-]/g, ""));
  const margenNum = parseFloat(margen.replace(/[^0-9.-]/g, ""));
  const bep = (!isNaN(fijosNum) && !isNaN(margenNum) && margenNum > 0)
    ? fijosNum / (margenNum / 100)
    : null;

  function handleBlur(field: "fact" | "fijos" | "margen" | "notas") {
    const patch: Parameters<typeof onSave>[0] = {};
    if (field === "fact") patch.facturacion_objetivo = isNaN(facturacionNum) ? null : facturacionNum;
    if (field === "fijos") patch.costos_fijos_mes = isNaN(fijosNum) ? null : fijosNum;
    if (field === "margen") patch.margen_contribucion_pct = isNaN(margenNum) ? null : margenNum;
    if (field === "notas") patch.notas = notas.trim() || null;
    onSave(patch);
  }

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: "var(--pase-fs-lg)", fontWeight: 500, color: "var(--pase-text)" }}>
          {fila.local_nombre}
        </h3>
        {saving && <span style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>guardando…</span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Facturación objetivo (mes)</label>
          <input
            type="number"
            inputMode="decimal"
            value={facturacion}
            onChange={e => setFacturacion(e.target.value)}
            onBlur={() => handleBlur("fact")}
            placeholder="ej. 12000000"
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Costos fijos (mes)</label>
          <input
            type="number"
            inputMode="decimal"
            value={fijos}
            onChange={e => setFijos(e.target.value)}
            onBlur={() => handleBlur("fijos")}
            placeholder="alquiler+sueldos+..."
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Margen contribución % (default 50)</label>
          <input
            type="number"
            inputMode="decimal"
            value={margen}
            onChange={e => setMargen(e.target.value)}
            onBlur={() => handleBlur("margen")}
            placeholder="ej. 55"
            min={0}
            max={100}
            step={0.5}
          />
        </div>
      </div>

      {bep !== null && (
        <div style={{ marginTop: 12, padding: 10, background: "var(--pase-celeste-100)", borderRadius: 8, fontSize: "var(--pase-fs-sm)" }}>
          <strong>Punto de equilibrio del mes:</strong>{" "}
          <strong style={{ color: "var(--pase-celeste)", fontVariantNumeric: "tabular-nums" }}>
            {formatCurrency(bep)}
          </strong>
          <div style={{ color: "var(--pase-text-muted)", marginTop: 2 }}>
            (= ${fijos || "0"} de fijos ÷ {margen || "0"}% de margen)
          </div>
        </div>
      )}

      <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
        <label>Notas del mes (opcional)</label>
        <input
          type="text"
          value={notas}
          onChange={e => setNotas(e.target.value)}
          onBlur={() => handleBlur("notas")}
          placeholder="ej. campaña navidad, mes de inflación alta..."
          maxLength={200}
        />
      </div>
    </div>
  );
}
