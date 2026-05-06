import { useMemo, useState } from "react";
import { db } from "../lib/supabase";
import { fmt_d, fmt_$, genId, toISO } from "../lib/utils";
import { useMediosCobro } from "../lib/useMediosCobro";
import { parseCierre, PARSER_VERSION, type ParseError, type ParsedCierre } from "../lib/maxirest/parser";

interface ImportarMaxirestProps {
  // Compat con App.tsx (no se usa pero se acepta para no romper).
  locales?: unknown;
  localActivo?: number | null;
  onImported?: () => void;
}

interface MedioMapeado {
  raw: string;
  /** Nombre del medio en el catálogo del local (null si no matchea). */
  matched: string | null;
  monto: number;
  cantidad: number;
}

type Bloqueo =
  | { tipo: 'sin_local' }
  | { tipo: 'medio_no_configurado'; nombre: string };

export default function ImportarMaxirest({ localActivo, onImported }: ImportarMaxirestProps) {
  const [texto, setTexto] = useState('');
  const [parsed, setParsed] = useState<ParsedCierre | null>(null);
  const [errores, setErrores] = useState<ParseError[]>([]);
  const [loading, setLoading] = useState(false);
  const { mediosDisponibles } = useMediosCobro();

  function procesar() {
    if (!texto.trim()) return;
    const r = parseCierre(texto);
    if (r.ok) { setParsed(r.data); setErrores([]); }
    else { setParsed(null); setErrores(r.errores); }
  }

  function reset() { setParsed(null); setErrores([]); setTexto(''); }

  // Mapeo medios → catálogo del local activo (case-insensitive exacto).
  const medios: MedioMapeado[] = useMemo(() => {
    if (!parsed || localActivo == null) return [];
    const cat = mediosDisponibles(Number(localActivo));
    return parsed.medios.map(m => {
      const target = m.nombre.trim().toUpperCase();
      const found = cat.find(c => c.nombre.trim().toUpperCase() === target);
      return { raw: m.nombre, matched: found?.nombre ?? null, monto: m.monto, cantidad: m.cantidad };
    });
  }, [parsed, localActivo, mediosDisponibles]);

  const totalCierre = medios.reduce((s, m) => s + m.monto, 0);

  const bloqueo: Bloqueo | null = useMemo(() => {
    if (!parsed) return null;
    if (localActivo == null) return { tipo: 'sin_local' };
    const sinConfig = medios.find(m => !m.matched);
    if (sinConfig) return { tipo: 'medio_no_configurado', nombre: sinConfig.raw };
    return null;
  }, [parsed, medios, localActivo]);

  async function importar() {
    if (!parsed || localActivo == null || bloqueo) return;
    setLoading(true);
    try {
      const lid = Number(localActivo);
      const fechaIso = toISO(parsed.fecha);
      // El schema histórico usa "Mediodía" / "Noche" (con tilde y mayúscula).
      const turnoDB = parsed.turno === 'noche' ? 'Noche' : 'Mediodía';

      // Idempotency: si ya hay un cierre del mismo (fecha, turno, local), confirmar.
      const { data: dup } = await db.from('ventas').select('id')
        .eq('fecha', fechaIso).eq('turno', turnoDB).eq('local_id', lid).limit(1);
      if (dup && dup.length > 0) {
        if (!confirm(`Ya existe un cierre del ${fmt_d(fechaIso)} turno ${turnoDB} para este local. ¿Importar igual?`)) {
          setLoading(false); return;
        }
      }

      const ventas = medios.map(m => ({
        id: genId('V'),
        medio: m.matched!,        // bloqueo previene null
        monto: m.monto,
        cant: m.cantidad,
        fecha: fechaIso,
        turno: turnoDB,
        local_id: lid,
        origen: 'maxirest',
        parser_version: PARSER_VERSION,
      }));
      const { data: ins, error } = await db.from('ventas').insert(ventas).select();
      if (error) throw new Error(error.message);
      if (!ins || ins.length === 0) {
        throw new Error('Insert no devolvió filas — RLS bloqueando o permisos del local.');
      }
      alert('✓ Importado: ' + ins.length + ' filas · Total: ' + fmt_$(totalCierre));
      reset();
      onImported?.();
    } catch (e: unknown) {
      alert('No se pudo importar: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="ph-row"><div><div className="ph-title">Importar Maxirest</div></div></div>

      {errores.length > 0 && <PanelErrores errores={errores} />}

      <div className="panel">
        <div className="panel-hd"><span className="panel-title">Texto del cierre</span></div>
        <div style={{ padding: 16 }}>
          <textarea
            style={{
              width: '100%', height: 280, background: 'var(--bg)', border: '1px solid var(--bd)',
              color: 'var(--txt)', padding: '10px 12px', fontFamily: "'DM Mono',monospace",
              fontSize: 11, borderRadius: 'var(--r)', outline: 'none', resize: 'vertical',
            }}
            placeholder="Pegá acá el texto completo del mail de cierre de Maxirest..."
            value={texto}
            onChange={e => setTexto(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-acc" onClick={procesar} disabled={!texto.trim()}>
              Procesar cierre
            </button>
            {(parsed || errores.length > 0) && (
              <button className="btn btn-sec" onClick={reset}>Limpiar</button>
            )}
          </div>
        </div>
      </div>

      {parsed && (
        <Preview
          parsed={parsed}
          medios={medios}
          totalCierre={totalCierre}
          bloqueo={bloqueo}
          loading={loading}
          onImportar={importar}
        />
      )}
    </div>
  );
}

function PanelErrores({ errores }: { errores: ParseError[] }) {
  return (
    <div className="panel" style={{ borderColor: 'var(--danger)' }}>
      <div className="panel-hd" style={{ background: 'rgba(239,68,68,0.1)' }}>
        <span className="panel-title" style={{ color: 'var(--danger)' }}>
          ⚠️ No se pudo procesar el cierre
        </span>
      </div>
      <div style={{ padding: 16 }}>
        <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
          {errores.map((e, i) => (
            <li key={i} style={{ fontSize: 13 }}>{e.mensaje}</li>
          ))}
        </ul>
        <p style={{ fontSize: 12, color: 'var(--muted2)', marginTop: 12, marginBottom: 0 }}>
          Verificá el texto del cierre y volvé a procesar.
        </p>
      </div>
    </div>
  );
}

interface PreviewProps {
  parsed: ParsedCierre;
  medios: MedioMapeado[];
  totalCierre: number;
  bloqueo: Bloqueo | null;
  loading: boolean;
  onImportar: () => void;
}

function Preview({ parsed, medios, totalCierre, bloqueo, loading, onImportar }: PreviewProps) {
  if (bloqueo) return <BloqueoMsg bloqueo={bloqueo} />;
  const turnoLabel = parsed.turno === 'noche' ? 'Noche' : 'Mediodía';
  return (
    <div className="panel">
      <div className="panel-hd"><span className="panel-title">Cierre detectado</span></div>
      <div style={{ padding: 16, display: 'grid', gap: 12 }}>
        <Linea label="Fecha" valor={fmt_d(toISO(parsed.fecha))} />
        <Linea label="Turno" valor={turnoLabel} />
        <Linea label="Total" valor={fmt_$(totalCierre)} />

        <div style={{ marginTop: 4 }}>
          <div style={{ fontSize: 12, color: 'var(--muted2)', marginBottom: 6 }}>Medios de cobro:</div>
          <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
            {medios.map((m, i) => (
              <li key={i} style={{ fontSize: 13 }}>
                <span style={{ fontWeight: 500 }}>{m.matched ?? m.raw}</span>
                {' — '}
                <span className="num kpi-success">{fmt_$(m.monto)}</span>
                <span style={{ color: 'var(--muted2)', fontSize: 11 }}> ({m.cantidad})</span>
              </li>
            ))}
          </ul>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn btn-acc" onClick={onImportar} disabled={loading}>
            {loading ? 'Importando…' : 'Importar al local'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Linea({ label, valor }: { label: string; valor: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, alignItems: 'baseline' }}>
      <div style={{ fontSize: 12, color: 'var(--muted2)' }}>{label}:</div>
      <div style={{ fontSize: 14, fontWeight: 500 }}>{valor}</div>
    </div>
  );
}

function BloqueoMsg({ bloqueo }: { bloqueo: Bloqueo }) {
  const msg = bloqueo.tipo === 'sin_local'
    ? 'Tenés que tener un local activo seleccionado en el sidebar para importar.'
    : `El medio "${bloqueo.nombre}" no está configurado en el catálogo del local. Andá a Configuración → Medios de cobro, agregalo, y volvé a procesar el cierre.`;
  return (
    <div className="panel">
      <div className="panel-hd"><span className="panel-title">No se puede importar</span></div>
      <div style={{ padding: 16 }}>
        <div className="alert alert-warn" style={{ fontSize: 13, lineHeight: 1.6 }}>{msg}</div>
      </div>
    </div>
  );
}
