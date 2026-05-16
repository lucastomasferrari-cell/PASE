import { useEffect, useState, useCallback, useRef } from 'react';
import { db } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { fmt_$ } from '../lib/utils';

// Iconos: PASE no usa lucide. Defino inline SVGs simples para los pocos
// que necesito acá (Upload, Check, Alert, Search, Trash, File).
const Upload = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
);
const CheckCircle2 = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="9 12 12 15 18 9"/></svg>
);
const AlertCircle = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
);
const Search = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
);
const Trash2 = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
);
const FileText = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
);

const supabase = db;
const fmtMoney = fmt_$;

// Conciliación bancaria file-based — estructura inicial.
//
// Flujo:
//   1. Dueño exporta extracto del homebanking en CSV (formato del banco).
//   2. Sube acá, el parser intenta detectar columnas (fecha, descripción,
//      monto) y arma las líneas en bank_statement_lines.
//   3. Auto-match contra movimientos del tenant: monto exacto + fecha ±3 días.
//      Score 1.0 = monto+fecha exacta, 0.8 = monto+fecha±1d, 0.6 = monto+fecha±3d.
//   4. UI muestra matched/unmatched/sugeridos. Botones para aceptar/rechazar
//      matches manualmente.
//
// Formato CSV soportado (autodetect, separador `,` o `;`):
//   - Header: fecha, descripcion, monto (o "debito"/"credito" separados)
//   - Fechas DD/MM/YYYY o YYYY-MM-DD
//   - Monto: positivo ingreso, negativo egreso. Si hay débito+crédito separados,
//     calcula monto = credito - debito.

interface StatementUpload {
  id: number;
  tenant_id: string;
  filename: string;
  banco: string | null;
  uploaded_at: string;
  periodo_desde: string | null;
  periodo_hasta: string | null;
  total_lineas: number;
  total_matched: number;
  estado: string;
}

interface StatementLine {
  id: number;
  statement_id: number;
  fecha: string;
  descripcion: string;
  monto: number;
  matched_movimiento_id: number | null;
  match_score: number | null;
}

interface MovimientoCandidato {
  id: number;
  fecha: string;
  concepto: string;
  monto: number;
  tipo: string;
}

export function ConciliacionBancaria() {
  const { user } = useAuth();
  const [uploads, setUploads] = useState<StatementUpload[]>([]);
  const [selectedUpload, setSelectedUpload] = useState<StatementUpload | null>(null);
  const [lines, setLines] = useState<StatementLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    if (!user?.tenant_id) return;
    setLoading(true);
    const { data, error: err } = await supabase
      .from('bank_statements')
      .select('*')
      .eq('tenant_id', user.tenant_id)
      .is('deleted_at', null)
      .order('uploaded_at', { ascending: false })
      .limit(50);
    if (err) setError(err.message);
    else setUploads(data ?? []);
    setLoading(false);
  }, [user?.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  async function loadLines(statementId: number) {
    const { data } = await supabase
      .from('bank_statement_lines')
      .select('*')
      .eq('statement_id', statementId)
      .order('fecha', { ascending: true });
    setLines((data ?? []) as StatementLine[]);
  }

  useEffect(() => {
    if (selectedUpload) loadLines(selectedUpload.id);
    else setLines([]);
  }, [selectedUpload]);

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !user?.tenant_id) return;
    setUploading(true);
    setError(null);
    try {
      const text = await file.text();
      const parsed = parseCSV(text);
      if (parsed.length === 0) {
        setError('No se pudieron parsear líneas del CSV. Verificá el formato.');
        setUploading(false);
        return;
      }

      // 1. Crear statement
      const { data: stmt, error: stmtErr } = await supabase
        .from('bank_statements')
        .insert({
          tenant_id: user.tenant_id,
          filename: file.name,
          uploaded_by: user.id,
          periodo_desde: parsed[0]?.fecha,
          periodo_hasta: parsed[parsed.length - 1]?.fecha,
          estado: 'procesando',
        })
        .select('id')
        .single();
      if (stmtErr || !stmt) {
        setError(stmtErr?.message ?? 'No se pudo crear statement');
        setUploading(false);
        return;
      }

      // 2. Insertar líneas
      const rows = parsed.map((p) => ({
        tenant_id: user.tenant_id,
        statement_id: stmt.id,
        fecha: p.fecha,
        descripcion: p.descripcion,
        monto: p.monto,
        referencia: p.referencia,
      }));
      const { error: insErr } = await supabase.from('bank_statement_lines').insert(rows);
      if (insErr) {
        setError('Líneas no se pudieron insertar: ' + insErr.message);
        setUploading(false);
        return;
      }

      // 3. Auto-match contra movimientos
      await autoMatch(stmt.id);

      reload();
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error procesando archivo');
    } finally {
      setUploading(false);
    }
  }

  async function autoMatch(statementId: number) {
    if (!user?.tenant_id) return;
    // Traer líneas sin match
    const { data: ls } = await supabase
      .from('bank_statement_lines')
      .select('*')
      .eq('statement_id', statementId)
      .is('matched_movimiento_id', null);
    const lineas = (ls ?? []) as StatementLine[];
    if (lineas.length === 0) return;

    // Traer movimientos candidatos del tenant en el rango
    const fechas = lineas.map((l) => l.fecha).sort();
    const desde = fechas[0];
    const hasta = fechas[fechas.length - 1];
    if (!desde || !hasta) return;
    const { data: movs } = await supabase
      .from('movimientos')
      .select('id, fecha, concepto, monto, tipo, anulado')
      .eq('tenant_id', user.tenant_id)
      .gte('fecha', desde)
      .lte('fecha', hasta)
      .eq('anulado', false);
    const candidatos = (movs ?? []) as MovimientoCandidato[];

    // Match: monto exacto + fecha ±3 días. Score baja con cada día.
    const updates: Array<{ id: number; matched_movimiento_id: number; match_score: number }> = [];
    const usados = new Set<number>();
    for (const linea of lineas) {
      const candidato = candidatos.find((c) => {
        if (usados.has(c.id)) return false;
        if (Math.abs(Number(c.monto) - Math.abs(Number(linea.monto))) > 0.5) return false;
        const days = Math.abs(daysBetween(linea.fecha, c.fecha));
        return days <= 3;
      });
      if (candidato) {
        usados.add(candidato.id);
        const days = Math.abs(daysBetween(linea.fecha, candidato.fecha));
        const score = days === 0 ? 1.0 : days === 1 ? 0.8 : 0.6;
        updates.push({ id: linea.id, matched_movimiento_id: candidato.id, match_score: score });
      }
    }

    // Aplicar updates uno por uno (bulk update con distintos values no es trivial en supabase-js)
    for (const u of updates) {
      await supabase
        .from('bank_statement_lines')
        .update({
          matched_movimiento_id: u.matched_movimiento_id,
          match_score: u.match_score,
          matched_at: new Date().toISOString(),
        })
        .eq('id', u.id);
    }

    // Refresh counters
    await supabase.rpc('fn_bank_statement_refresh_counters', { p_statement_id: statementId });
  }

  async function unmatch(lineId: number) {
    await supabase
      .from('bank_statement_lines')
      .update({ matched_movimiento_id: null, matched_at: null, match_score: null })
      .eq('id', lineId);
    if (selectedUpload) {
      await supabase.rpc('fn_bank_statement_refresh_counters', { p_statement_id: selectedUpload.id });
      loadLines(selectedUpload.id);
      reload();
    }
  }

  async function eliminarStatement(id: number) {
    if (!confirm('¿Eliminar este extracto? Las líneas y matches se borran.')) return;
    await supabase.from('bank_statements').update({ deleted_at: new Date().toISOString() }).eq('id', id);
    setSelectedUpload(null);
    reload();
  }

  return (
    <div className="container max-w-6xl py-6 px-4 space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <FileText className="h-6 w-6" />
          Conciliación bancaria
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Subí el extracto bancario en CSV. El sistema lo matchea automático contra los movimientos
          existentes (monto exacto + fecha ±3 días).
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Upload */}
      <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-4">
        <label className="flex flex-col sm:flex-row items-start sm:items-center gap-3 cursor-pointer">
          <div className="flex-1">
            <div className="font-medium">Subir extracto bancario (CSV)</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Formato: fecha, descripción, monto (separador "," o ";"). Fechas DD/MM/YYYY o YYYY-MM-DD.
              Monto positivo = ingreso, negativo = egreso.
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileUpload}
            disabled={uploading}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            <Upload className="h-4 w-4" />
            {uploading ? 'Procesando…' : 'Elegir archivo'}
          </button>
        </label>
      </div>

      {/* Listado de uploads */}
      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
        <aside className="space-y-2">
          <h3 className="text-sm font-semibold">Extractos subidos</h3>
          {loading ? (
            <div className="text-sm text-muted-foreground py-4">Cargando…</div>
          ) : uploads.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 italic">Sin extractos. Subí uno arriba.</div>
          ) : (
            <div className="space-y-1">
              {uploads.map((u) => {
                const pct = u.total_lineas > 0 ? Math.round((u.total_matched / u.total_lineas) * 100) : 0;
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setSelectedUpload(u)}
                    className={`w-full text-left p-3 rounded-md border transition-colors ${
                      selectedUpload?.id === u.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-muted'
                    }`}
                  >
                    <div className="text-sm font-medium truncate">{u.filename}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {new Date(u.uploaded_at).toLocaleDateString('es-AR')} · {u.total_matched}/{u.total_lineas} ({pct}%)
                    </div>
                    <div className={`h-1.5 rounded-full mt-1 bg-muted overflow-hidden`}>
                      <div
                        className={`h-full ${pct === 100 ? 'bg-success' : pct >= 80 ? 'bg-warning' : 'bg-primary/60'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        {/* Detalle */}
        <section>
          {!selectedUpload ? (
            <div className="rounded-md border border-dashed border-border bg-muted/20 p-12 text-center text-sm text-muted-foreground">
              Elegí un extracto a la izquierda para ver sus líneas.
            </div>
          ) : (
            <div className="rounded-md border border-border">
              <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
                <strong className="text-sm">{selectedUpload.filename}</strong>
                <span className="text-xs text-muted-foreground ml-auto">
                  {selectedUpload.total_matched} de {selectedUpload.total_lineas} matched
                </span>
                <button
                  type="button"
                  onClick={() => eliminarStatement(selectedUpload.id)}
                  className="text-destructive hover:bg-destructive/10 rounded p-1"
                  aria-label="Eliminar"
                  title="Eliminar extracto"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-muted/30 text-xs text-muted-foreground uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2">Fecha</th>
                    <th className="text-left px-3 py-2">Descripción</th>
                    <th className="text-right px-3 py-2">Monto</th>
                    <th className="text-center px-3 py-2">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className="border-t border-border">
                      <td className="px-3 py-2 tabular-nums text-xs">
                        {new Date(l.fecha).toLocaleDateString('es-AR')}
                      </td>
                      <td className="px-3 py-2 text-xs truncate max-w-xs">{l.descripcion}</td>
                      <td className={`px-3 py-2 text-right tabular-nums text-xs font-medium ${l.monto < 0 ? 'text-destructive' : 'text-success'}`}>
                        {fmtMoney(Math.abs(l.monto))}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {l.matched_movimiento_id !== null ? (
                          <span className="inline-flex items-center gap-1 text-xs text-success" title={`Score ${l.match_score}`}>
                            <CheckCircle2 className="h-3 w-3" />
                            Matched ({Math.round((l.match_score ?? 0) * 100)}%)
                            <button
                              type="button"
                              onClick={() => unmatch(l.id)}
                              className="ml-1 text-destructive hover:underline text-[10px]"
                              title="Deshacer match"
                            >
                              ✕
                            </button>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <AlertCircle className="h-3 w-3" />
                            Sin match
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {lines.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                        Sin líneas
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <div className="text-xs text-muted-foreground text-center pt-4">
        <Search className="h-3 w-3 inline mr-1" />
        Próximo: matching manual de las "Sin match" + soporte Excel + parser específico por banco.
      </div>
    </div>
  );
}

// ─── CSV parser (simple) ──────────────────────────────────────────────────────

interface LineaParseada {
  fecha: string;       // ISO YYYY-MM-DD
  descripcion: string;
  monto: number;
  referencia: string | null;
}

function parseCSV(text: string): LineaParseada[] {
  // Detectar separador
  const firstLine = text.split('\n')[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Header: detectar índices
  const headerRow = lines[0];
  if (!headerRow) return [];
  const header = headerRow.toLowerCase().split(sep).map((h) => h.trim().replace(/^"|"$/g, ''));
  const idxFecha = header.findIndex((h) => /fecha|date/.test(h));
  const idxDesc = header.findIndex((h) => /descripci|concepto|detalle|description/.test(h));
  const idxMonto = header.findIndex((h) => /monto|importe|amount/.test(h));
  const idxDebito = header.findIndex((h) => /d[eé]bito|debit/.test(h));
  const idxCredito = header.findIndex((h) => /cr[eé]dito|credit/.test(h));
  const idxRef = header.findIndex((h) => /ref|operaci/.test(h));

  if (idxFecha === -1 || idxDesc === -1) return [];

  const out: LineaParseada[] = [];
  for (let i = 1; i < lines.length; i++) {
    const lineRaw = lines[i];
    if (!lineRaw) continue;
    const cells = lineRaw.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
    const fechaRaw = cells[idxFecha];
    if (!fechaRaw) continue;
    const fecha = parseFecha(fechaRaw);
    if (!fecha) continue;

    const descripcion = cells[idxDesc] ?? '';
    let monto = 0;
    if (idxMonto !== -1) {
      monto = parseNum(cells[idxMonto] ?? '0');
    } else if (idxDebito !== -1 || idxCredito !== -1) {
      const debito = idxDebito !== -1 ? parseNum(cells[idxDebito] ?? '0') : 0;
      const credito = idxCredito !== -1 ? parseNum(cells[idxCredito] ?? '0') : 0;
      monto = credito - debito;
    }
    const referencia = idxRef !== -1 ? (cells[idxRef] ?? null) : null;

    out.push({ fecha, descripcion, monto, referencia });
  }
  return out;
}

function parseFecha(s: string): string | null {
  s = s.trim();
  // DD/MM/YYYY
  const m1 = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m1) {
    let yyyy = m1[3];
    if (yyyy && yyyy.length === 2) yyyy = '20' + yyyy;
    return `${yyyy}-${(m1[2] ?? '').padStart(2, '0')}-${(m1[1] ?? '').padStart(2, '0')}`;
  }
  // YYYY-MM-DD
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
  return null;
}

function parseNum(s: string): number {
  // "$1.234,56" → 1234.56
  // "1234.56" → 1234.56
  // "-500" → -500
  if (!s) return 0;
  const clean = s.replace(/\$/g, '').trim();
  // Si tiene . y , — asumimos formato AR (1.234,56)
  if (clean.includes('.') && clean.includes(',')) {
    return Number(clean.replace(/\./g, '').replace(',', '.'));
  }
  // Solo coma: asumimos decimal AR
  if (clean.includes(',') && !clean.includes('.')) {
    return Number(clean.replace(',', '.'));
  }
  return Number(clean);
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(a).getTime() - new Date(b).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
