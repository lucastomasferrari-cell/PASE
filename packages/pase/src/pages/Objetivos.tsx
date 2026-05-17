import { useEffect, useMemo, useState } from "react";
import { db } from "../lib/supabase";
import { PageHeader, EmptyState } from "../components/ui";
import { formatCurrency } from "../lib/format";
import type { Local } from "../types";

interface ObjetivoFila {
  local_id: number;
  local_nombre: string;
  id: number | null;  // null si todavía no existe la fila en DB
  // Facturación y volumen (se miden en cualquier momento)
  facturacion_objetivo: number | null;
  ticket_promedio_objetivo: number | null;
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
      .select("id, local_id, facturacion_objetivo, ticket_promedio_objetivo, costos_fijos_mes, margen_contribucion_pct, costo_mercaderia_pct, costo_mp_pct, margen_bruto_pct, notas")
      .eq("mes", mesIso);
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    const porLocal = new Map<number, {
      id: number;
      facturacion_objetivo: number | null;
      ticket_promedio_objetivo: number | null;
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
        facturacion_objetivo: number | null; ticket_promedio_objetivo: number | null;
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
        ticket_promedio_objetivo: stored?.ticket_promedio_objetivo ?? null,
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
        ticket_promedio_objetivo: next.ticket_promedio_objetivo,
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
          <strong>Grupo 1 — Facturación y volumen (mid-month, en /negocio):</strong> facturación objetivo + ticket promedio.<br />
          <strong>Grupo 2 — Punto de equilibrio (mid-month, en /negocio):</strong> costos fijos + margen contribución. BEP = fijos ÷ margen %.<br />
          <strong>Grupo 3 — Eficiencia (fin de mes, en /reportes):</strong> CMV %, costo MP %, margen bruto %. Sirven para comparar contra el EERR cerrado al final del mes (mid-month mienten porque las facturas vencidas distorsionan el costo).
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
  // Grupo 1: facturación + ticket promedio
  const [facturacion, setFacturacion] = useState(String(fila.facturacion_objetivo ?? ""));
  const [ticketProm, setTicketProm] = useState(String(fila.ticket_promedio_objetivo ?? ""));
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
    setTicketProm(String(fila.ticket_promedio_objetivo ?? ""));
    setFijos(String(fila.costos_fijos_mes ?? ""));
    setMargenC(String(fila.margen_contribucion_pct ?? ""));
    setCmv(String(fila.costo_mercaderia_pct ?? ""));
    setCostoMp(String(fila.costo_mp_pct ?? ""));
    setMargenB(String(fila.margen_bruto_pct ?? ""));
    setNotas(fila.notas ?? "");
  }, [
    fila.local_id,
    fila.facturacion_objetivo, fila.ticket_promedio_objetivo,
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

  // Ventas estimadas si tenemos facturación y ticket promedio.
  const ticketPromNum = parseFloat(ticketProm.replace(/[^0-9.-]/g, ""));
  const ventasEstimadas = (!isNaN(facturacionNum) && !isNaN(ticketPromNum) && ticketPromNum > 0)
    ? Math.round(facturacionNum / ticketPromNum)
    : null;

  type Field =
    | "fact" | "tprom"
    | "fijos" | "margenC"
    | "cmv" | "mp" | "margenB"
    | "notas";

  function handleBlur(field: Field) {
    const patch: Parameters<typeof onSave>[0] = {};
    if (field === "fact") patch.facturacion_objetivo = isNaN(facturacionNum) ? null : facturacionNum;
    if (field === "tprom") patch.ticket_promedio_objetivo = isNaN(ticketPromNum) ? null : ticketPromNum;
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

      {/* ─── Grupo 1: Facturación + volumen ─── */}
      <GroupTitle>Facturación y volumen</GroupTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
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
          <label>Ticket promedio objetivo</label>
          <input
            type="number"
            inputMode="decimal"
            value={ticketProm}
            onChange={e => setTicketProm(e.target.value)}
            onBlur={() => handleBlur("tprom")}
            placeholder="ej. 8500"
          />
        </div>
      </div>
      {ventasEstimadas !== null && (
        <div style={{ marginTop: 8, fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>
          ≈ <strong style={{ color: "var(--pase-text)" }}>{ventasEstimadas.toLocaleString("es-AR")}</strong> ventas necesarias para llegar al objetivo.
        </div>
      )}

      {/* ─── Grupo 2: BEP ─── */}
      <GroupTitle style={{ marginTop: 18 }}>Punto de equilibrio</GroupTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
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
            value={margenC}
            onChange={e => setMargenC(e.target.value)}
            onBlur={() => handleBlur("margenC")}
            placeholder="ej. 55"
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
      <GroupTitle style={{ marginTop: 18 }}>
        Eficiencia · se comparan en /reportes a fin de mes
      </GroupTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>CMV objetivo % (mercadería)</label>
          <input
            type="number"
            inputMode="decimal"
            value={cmv}
            onChange={e => setCmv(e.target.value)}
            onBlur={() => handleBlur("cmv")}
            placeholder="ej. 32"
            min={0}
            max={100}
            step={0.5}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Costo MP objetivo %</label>
          <input
            type="number"
            inputMode="decimal"
            value={costoMp}
            onChange={e => setCostoMp(e.target.value)}
            onBlur={() => handleBlur("mp")}
            placeholder="ej. 3.5"
            min={0}
            max={20}
            step={0.1}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Margen bruto objetivo %</label>
          <input
            type="number"
            inputMode="decimal"
            value={margenB}
            onChange={e => setMargenB(e.target.value)}
            onBlur={() => handleBlur("margenB")}
            placeholder="ej. 60"
            min={0}
            max={100}
            step={0.5}
          />
        </div>
      </div>

      <div className="field" style={{ marginTop: 18, marginBottom: 0 }}>
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

function GroupTitle({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      fontSize: "var(--pase-fs-xs)",
      fontWeight: 500,
      color: "var(--pase-text-muted)",
      textTransform: "uppercase",
      letterSpacing: "var(--pase-ls-overline)",
      marginBottom: 8,
      paddingBottom: 4,
      borderBottom: "0.5px solid var(--pase-border)",
      ...style,
    }}>
      {children}
    </div>
  );
}
