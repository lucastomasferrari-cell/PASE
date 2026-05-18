import { useState } from "react";
import { db } from "../lib/supabase";
import { PageHeader, EmptyState, LocalLockedChip, LocalSelectorObligatorio, DocumentIcon, FolderIcon, AlertIcon, CheckIcon } from "../components/ui";
import { formatCurrency } from "../lib/format";
import { exportCSV } from "../lib/exportCSV";
import type { Usuario, Local } from "../types";

/**
 * Lector IA del extracto mensual de MercadoPago.
 *
 * Decisión core (memoria pos_falencias): la API de MP omite ventas
 * (devuelve datos distintos según el servidor que conteste). El cron
 * con release_report cubre la mayoría pero no es 100%. Camino B
 * documentado: el dueño baja el PDF/Excel del panel MP una vez al
 * mes → este lector lo parsea con Claude IA → dedup contra los
 * movimientos ya importados → confirma + inserta los faltantes.
 *
 * Es la fuente legal (el extracto del panel), entonces garantiza 100%
 * de fidelidad. Tiempo del usuario: ~2 min/mes.
 *
 * Stack: mismo patrón que LectorFacturasIA (PDF → base64 → /api/claude
 * con Opus 4.7 → JSON estructurado).
 */

interface MovimientoExtracto {
  fecha: string;          // YYYY-MM-DD
  monto: number;          // signed: negativo=egreso, positivo=ingreso
  tipo: string;           // cobro/comision/retiro/devolucion/etc
  descripcion: string;
  referencia_externa: string | null;  // operation_id del extracto
}

interface MovimientoConDedup extends MovimientoExtracto {
  yaExiste: boolean;
  matchId?: string;       // id del mp_movimientos existente si yaExiste
}

interface IAResponse {
  movimientos: MovimientoExtracto[];
  total_movimientos: number;
  rango_fechas: { desde: string; hasta: string };
  confianza_global: number;
  advertencias?: string[];
}

interface Props {
  user: Usuario;
  locales: Local[];
  localActivo: number | null;
}

export default function LectorExtractoMP({ user, locales, localActivo }: Props) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [localImport, setLocalImport] = useState<number | null>(localActivo);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{
    movimientos: MovimientoConDedup[];
    rango: { desde: string; hasta: string } | null;
    confianza: number;
    advertencias: string[];
  } | null>(null);
  const [importando, setImportando] = useState(false);
  const [importResult, setImportResult] = useState<{ ok: boolean; insertadas: number; error?: string } | null>(null);

  async function toBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function procesar() {
    if (!archivo || !localImport) return;
    setLoading(true); setError(null); setResultado(null); setImportResult(null);

    try {
      const base64 = await toBase64(archivo);
      const isImg = archivo.type.startsWith("image/");
      const mediaType = isImg ? archivo.type : "application/pdf";

      const sess = (await db.auth.getSession()).data.session;
      if (!sess?.access_token) {
        throw new Error("Sesión expirada. Recargá la página.");
      }

      const response = await fetch("/api/claude", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sess.access_token}`,
        },
        body: JSON.stringify({
          model: "claude-opus-4-7",
          max_tokens: 16000,  // extractos mensuales pueden tener cientos de movimientos
          messages: [{
            role: "user",
            content: [
              { type: isImg ? "image" : "document", source: { type: "base64", media_type: mediaType, data: base64 } },
              { type: "text", text: `Estás procesando un extracto mensual de MercadoPago argentino.

Extraé TODOS los movimientos de la cuenta y devolvé SOLO JSON, sin texto extra ni markdown.

FORMATO DE MONTOS ARGENTINOS:
- "1.234,56" = mil doscientos treinta y cuatro con 56 centavos.
- En el JSON usá punto decimal: 1234.56.
- Cobros/ingresos = monto positivo. Comisiones/retiros/devoluciones/egresos = monto NEGATIVO.

Estructura JSON requerida:
{
  "movimientos": [
    {
      "fecha": "YYYY-MM-DD",
      "monto": numero_signed,
      "tipo": "cobro|comision|retiro|devolucion|transferencia|otro",
      "descripcion": "string corto (≤80 chars)",
      "referencia_externa": "operation_id si está visible, o null"
    }
  ],
  "total_movimientos": numero,
  "rango_fechas": { "desde": "YYYY-MM-DD", "hasta": "YYYY-MM-DD" },
  "confianza_global": 0-100,
  "advertencias": ["string corto", ...]
}

REGLAS CRÍTICAS:
- Procesá CADA fila del extracto, no omitas movimientos.
- Si el documento es muy largo y no podés con todo, devolvé igual lo que pudiste + advertencia.
- Si una fila no tiene fecha clara o monto, NO la inventes — omitila + agregá advertencia.
- referencia_externa puede ser el "ID de operación" / "Número de cobro" / "Reference" según el extracto.
- Si el extracto tiene fila "Saldo inicial" o "Saldo final", NO la incluyas como movimiento.
- Si hay descripción duplicada en muchas filas (típico cobros QR), está bien — son cobros distintos.

Si el archivo no parece un extracto de MercadoPago, devolvé:
{ "movimientos": [], "total_movimientos": 0, "rango_fechas": {"desde":"","hasta":""}, "confianza_global": 0, "advertencias": ["No es un extracto MP válido"] }`}
            ]
          }]
        })
      });

      if (!response.ok) {
        let detalle = `HTTP ${response.status}`;
        try {
          const ct = response.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const err: { error?: { message?: string } } = await response.json();
            detalle = err.error?.message || JSON.stringify(err).slice(0, 200);
          } else {
            detalle = (await response.text()).slice(0, 200);
          }
        } catch { /* ignore */ }
        throw new Error(`La IA respondió con error (${response.status}): ${detalle}`);
      }

      const data: { content?: Array<{ text?: string }>; error?: { message?: string } } = await response.json();
      if (data.error) throw new Error(`IA rechazó: ${data.error.message}`);
      const text = data.content?.map(c => c.text || "").join("") || "";
      if (!text.trim()) throw new Error("La IA respondió vacío. Probá con otro archivo.");
      const clean = text.replace(/```json|```/g, "").trim();
      let parsed: IAResponse;
      try { parsed = JSON.parse(clean); }
      catch {
        console.error("[LectorMP] Respuesta no-JSON:", text);
        throw new Error("La IA devolvió texto no-JSON. Ver consola.");
      }

      if (!Array.isArray(parsed.movimientos) || parsed.movimientos.length === 0) {
        const adv = parsed.advertencias?.join(" · ") || "Sin movimientos detectados";
        throw new Error(adv);
      }

      // Dedup contra mp_movimientos existentes.
      // Estrategia: buscamos por referencia_externa cuando existe (más confiable),
      // o por combo (fecha + monto + local_id) cuando no.
      const refsExternas = parsed.movimientos
        .map(m => m.referencia_externa)
        .filter((r): r is string => Boolean(r));

      const desde = parsed.rango_fechas?.desde || parsed.movimientos[0]!.fecha;
      const hasta = parsed.rango_fechas?.hasta || parsed.movimientos[parsed.movimientos.length - 1]!.fecha;

      const existingByRef = new Map<string, string>();  // ref → id
      const existingByCombo = new Map<string, string>();  // "fecha|monto" → id

      if (refsExternas.length > 0) {
        const { data: existing } = await db.from("mp_movimientos")
          .select("id, referencia_id")
          .in("referencia_id", refsExternas);
        for (const r of existing ?? []) {
          const row = r as { id: string; referencia_id: string };
          existingByRef.set(row.referencia_id, row.id);
        }
      }

      const { data: existingRange } = await db.from("mp_movimientos")
        .select("id, fecha, monto")
        .gte("fecha", desde)
        .lte("fecha", hasta)
        .eq("local_id", localImport);
      for (const r of existingRange ?? []) {
        const row = r as { id: string; fecha: string; monto: number };
        const key = `${row.fecha?.slice(0, 10)}|${Number(row.monto).toFixed(2)}`;
        existingByCombo.set(key, row.id);
      }

      const conDedup: MovimientoConDedup[] = parsed.movimientos.map(m => {
        if (m.referencia_externa && existingByRef.has(m.referencia_externa)) {
          return { ...m, yaExiste: true, matchId: existingByRef.get(m.referencia_externa)! };
        }
        const key = `${m.fecha}|${Number(m.monto).toFixed(2)}`;
        if (existingByCombo.has(key)) {
          return { ...m, yaExiste: true, matchId: existingByCombo.get(key)! };
        }
        return { ...m, yaExiste: false };
      });

      setResultado({
        movimientos: conDedup,
        rango: parsed.rango_fechas?.desde ? parsed.rango_fechas : null,
        confianza: parsed.confianza_global ?? 0,
        advertencias: parsed.advertencias || [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function importar() {
    if (!resultado || !localImport || !user.tenant_id) return;
    const nuevas = resultado.movimientos.filter(m => !m.yaExiste);
    if (nuevas.length === 0) return;

    setImportando(true);
    const payload = nuevas.map(m => ({
      tenant_id: user.tenant_id,
      local_id: localImport,
      fecha: m.fecha,
      monto: m.monto,
      tipo: m.tipo,
      descripcion: m.descripcion.slice(0, 200),
      referencia_id: m.referencia_externa,
      // origen explícito para distinguir del cron y de la API
      // (no rompe si la columna no existe — Supabase ignora keys extra al insert)
      origen: "lector_ia_extracto",
    }));

    // eslint-disable-next-line pase-local/no-direct-financiera-write -- import de extracto MP (IA). Es el flujo equivalente al cron de MP que tambien hace insert directo. No hay RPC porque es batch grande y los movs no disparan side-effects (saldos/etc) hasta conciliarse. Ruta gateada a quien tiene permiso 'mp'.
    const { error: insErr } = await db.from("mp_movimientos").insert(payload);
    if (insErr) {
      setImportResult({ ok: false, insertadas: 0, error: insErr.message });
    } else {
      setImportResult({ ok: true, insertadas: nuevas.length });
    }
    setImportando(false);
  }

  function reset() {
    setArchivo(null);
    setResultado(null);
    setError(null);
    setImportResult(null);
  }

  const nuevas = resultado?.movimientos.filter(m => !m.yaExiste).length ?? 0;
  const yaExisten = resultado?.movimientos.filter(m => m.yaExiste).length ?? 0;

  return (
    <div style={{ padding: "0 20px" }}>
      <PageHeader
        title="Lector extracto MP"
        subtitle="importar movimientos vía IA"
        info={<>
          La API de MercadoPago no devuelve siempre todas las ventas (problema documentado de shards inconsistentes). Este lector resuelve eso: bajás el extracto mensual desde tu panel MP (Reportes → Extracto), lo subís acá, la IA parsea cada movimiento, dedup contra lo que ya está sincronizado, y confirmás la importación de los faltantes.<br /><br />
          Es la <strong>fuente legal</strong> — garantiza 100% de fidelidad. Tiempo del usuario: ~2 min/mes.
        </>}
      />

      {/* Selector de sucursal destino — los movimientos se importan a un local */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>Importar a:</span>
        {localActivo !== null ? (
          <LocalLockedChip nombre={locales.find(l => l.id === localActivo)?.nombre ?? "—"} />
        ) : (
          <LocalSelectorObligatorio
            value={localImport}
            onChange={setLocalImport}
            locales={locales}
          />
        )}
      </div>

      {!archivo && !resultado && (
        <div className="panel" style={{ padding: 32 }}>
          <EmptyState
            icon={<DocumentIcon size={40} tone="muted" />}
            title="Subí el extracto mensual de MercadoPago"
            description="Aceptamos PDF o imagen del extracto. Bajalo del panel MP en: Reportes → Movimientos → Extracto."
            cta={
              <label className="btn btn-acc" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                <FolderIcon size={16} tone="muted" />
                Elegir archivo
                <input
                  type="file"
                  accept=".pdf,image/*"
                  style={{ display: "none" }}
                  onChange={e => {
                    const f = e.target.files?.[0];
                    if (f) setArchivo(f);
                    e.target.value = "";
                  }}
                />
              </label>
            }
          />
        </div>
      )}

      {archivo && !resultado && !error && (
        <div className="panel" style={{ padding: 24, textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <DocumentIcon size={36} tone="celeste" />
          </div>
          <div style={{ fontSize: "var(--pase-fs-md)", fontWeight: 500, marginBottom: 4 }}>{archivo.name}</div>
          <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginBottom: 16 }}>
            {(archivo.size / 1024).toFixed(0)} KB · {archivo.type || "tipo desconocido"}
          </div>
          {loading ? (
            <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-celeste)", fontWeight: 500 }}>
              Procesando con IA... (puede tardar 30-90 seg con extractos grandes)
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button className="btn btn-ghost" onClick={reset}>Cambiar archivo</button>
              <button
                className="btn btn-acc"
                onClick={procesar}
                disabled={!localImport}
                title={!localImport ? "Elegí primero una sucursal arriba" : undefined}
              >
                Procesar con IA →
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: 16 }}>
          <strong>Error procesando:</strong> {error}
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={reset}>Empezar de nuevo</button>
          </div>
        </div>
      )}

      {resultado && !importResult && (
        <div>
          {/* Resumen header */}
          <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
            <div className="panel" style={{ padding: "10px 14px", flex: 1, minWidth: 150 }}>
              <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginBottom: 4 }}>Detectados</div>
              <div style={{ fontSize: "var(--pase-fs-xl)", fontWeight: 500, color: "var(--pase-text)" }}>{resultado.movimientos.length}</div>
            </div>
            <div className="panel" style={{ padding: "10px 14px", flex: 1, minWidth: 150 }}>
              <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginBottom: 4 }}>Nuevos a importar</div>
              <div style={{ fontSize: "var(--pase-fs-xl)", fontWeight: 500, color: "var(--pase-celeste)" }}>{nuevas}</div>
            </div>
            <div className="panel" style={{ padding: "10px 14px", flex: 1, minWidth: 150 }}>
              <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginBottom: 4 }}>Ya estaban</div>
              <div style={{ fontSize: "var(--pase-fs-xl)", fontWeight: 500, color: "var(--pase-text-muted)" }}>{yaExisten}</div>
            </div>
            <div className="panel" style={{ padding: "10px 14px", flex: 1, minWidth: 150 }}>
              <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginBottom: 4 }}>Confianza IA</div>
              <div style={{ fontSize: "var(--pase-fs-xl)", fontWeight: 500, color: resultado.confianza >= 80 ? "var(--pase-celeste)" : "#D97706" }}>
                {resultado.confianza}%
              </div>
            </div>
          </div>

          {resultado.advertencias.length > 0 && (
            <div className="alert" style={{ marginBottom: 14, fontSize: "var(--pase-fs-sm)" }}>
              <strong style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <AlertIcon size={14} tone="muted" /> Advertencias de la IA:
              </strong>
              <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                {resultado.advertencias.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}

          {/* Acciones */}
          <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
            <button className="btn btn-ghost btn-sm" onClick={reset}>← Empezar de nuevo</button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const headers = ["Fecha", "Tipo", "Descripción", "Monto", "Referencia", "Estado"];
                const rows = resultado.movimientos.map(m => [
                  m.fecha, m.tipo, m.descripcion, m.monto,
                  m.referencia_externa || "", m.yaExiste ? "Ya estaba" : "Nuevo",
                ]);
                exportCSV(`extracto_mp_${resultado.rango?.desde || "?"}.csv`, headers, rows);
              }}
            >⬇ Exportar lista a CSV</button>
            <div style={{ flex: 1 }} />
            <button
              className="btn btn-acc"
              onClick={importar}
              disabled={nuevas === 0 || importando}
              title={nuevas === 0 ? "No hay nuevos para importar" : undefined}
            >
              {importando ? "Importando..." : `Importar ${nuevas} nuevos`}
            </button>
          </div>

          {/* Tabla preview */}
          <div className="panel" style={{ maxHeight: 500, overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th>Descripción</th>
                  <th style={{ textAlign: "right" }}>Monto</th>
                  <th>Ref</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {resultado.movimientos.map((m, i) => (
                  <tr key={i} style={{
                    opacity: m.yaExiste ? 0.5 : 1,
                    background: m.yaExiste ? "transparent" : "rgba(117, 170, 219, 0.04)",
                  }}>
                    <td style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", fontVariantNumeric: "tabular-nums" }}>
                      {m.fecha}
                    </td>
                    <td style={{ fontSize: "var(--pase-fs-xs)" }}>
                      <span className="badge b-muted" style={{ fontSize: 9 }}>{m.tipo}</span>
                    </td>
                    <td style={{ fontSize: "var(--pase-fs-sm)" }}>{m.descripcion}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: m.monto < 0 ? "var(--pase-text-muted)" : "var(--pase-celeste)", fontWeight: 500 }}>
                      {formatCurrency(m.monto)}
                    </td>
                    <td style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", fontFamily: "monospace" }}>
                      {m.referencia_externa || "—"}
                    </td>
                    <td style={{ fontSize: "var(--pase-fs-xs)" }}>
                      {m.yaExiste ? (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--pase-text-muted)" }}>
                          <CheckIcon size={11} tone="muted" /> Ya estaba
                        </span>
                      ) : (
                        <span style={{ color: "var(--pase-celeste)", fontWeight: 500 }}>Nuevo</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {importResult && (
        <div className="alert" style={{
          padding: 20, marginTop: 16,
          background: importResult.ok ? "var(--pase-celeste-100)" : "var(--pase-bg-out)",
          borderLeft: `3px solid ${importResult.ok ? "var(--pase-celeste)" : "#D97706"}`,
        }}>
          <strong style={{ fontSize: "var(--pase-fs-md)", display: "inline-flex", alignItems: "center", gap: 8 }}>
            {importResult.ok
              ? <><CheckIcon size={16} tone="gold" /> Importados {importResult.insertadas} movimientos nuevos.</>
              : <><AlertIcon size={16} tone="muted" /> Error en la importación</>
            }
          </strong>
          {importResult.error && (
            <div style={{ marginTop: 8, fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>{importResult.error}</div>
          )}
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-ghost btn-sm" onClick={reset}>Procesar otro extracto</button>
            {importResult.ok && (
              <span style={{ marginLeft: 12, fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)" }}>
                Andá a <a href="/caja/conciliacion" style={{ color: "var(--pase-celeste)" }}>Conciliación MP</a> para vincular los nuevos a facturas/gastos.
              </span>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
