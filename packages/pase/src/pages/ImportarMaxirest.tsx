import { useMemo, useState } from "react";
import { db } from "../lib/supabase";
import { fmt_d, fmt_$, genId } from "../lib/utils";
import { useMediosCobro } from "../lib/useMediosCobro";
import { parseCierreMaxirest } from "../lib/maxirest/parser";
import { PARSER_VERSION } from "../lib/maxirest/types";
import type { CierreMaxirest } from "../lib/maxirest/types";

interface ImportarMaxirestProps {
  // Compatible con la prop existente en App.tsx (no se usa pero se acepta).
  locales?: unknown;
  localActivo?: number | null;
  onImported?: () => void;
}

interface MedioMapeado {
  /** Nombre crudo como vino del cierre. */
  raw: string;
  /** Nombre del medio en el catálogo del local (null si no matchea). */
  matched: string | null;
  monto: number;
  cantidad: number;
}

// Razones por las que el cierre no se puede importar. Si hay alguna,
// el botón Importar queda deshabilitado y se muestra un mensaje claro.
type Bloqueo =
  | { tipo: 'sin_local' }
  | { tipo: 'campo_faltante'; campo: 'fecha' | 'turno' | 'total' | 'medios' }
  | { tipo: 'medio_no_configurado'; nombre: string };

export default function ImportarMaxirest({ localActivo, onImported }: ImportarMaxirestProps) {
  const [texto, setTexto] = useState('');
  const [cierre, setCierre] = useState<CierreMaxirest | null>(null);
  const [loading, setLoading] = useState(false);
  const { mediosDisponibles } = useMediosCobro();

  function procesar() {
    if (!texto.trim()) return;
    setCierre(parseCierreMaxirest(texto));
  }

  function reset() { setCierre(null); setTexto(''); }

  // Mapeo de medios del cierre al catálogo del local activo. Match exacto
  // case-insensitive sobre el nombre.
  const medios: MedioMapeado[] = useMemo(() => {
    if (!cierre || !cierre.ventasPorMedio.valor || localActivo == null) return [];
    const cat = mediosDisponibles(Number(localActivo));
    return cierre.ventasPorMedio.valor.map(m => {
      const target = m.raw.trim().toUpperCase();
      const found = cat.find(c => c.nombre.trim().toUpperCase() === target);
      return { raw: m.raw, matched: found?.nombre ?? null, monto: m.monto, cantidad: m.cantidad };
    });
  }, [cierre, localActivo, mediosDisponibles]);

  const totalCierre = medios.reduce((s, m) => s + m.monto, 0);

  const bloqueo: Bloqueo | null = useMemo(() => {
    if (localActivo == null) return { tipo: 'sin_local' };
    if (!cierre) return null;
    if (cierre.fecha.valor == null) return { tipo: 'campo_faltante', campo: 'fecha' };
    if (cierre.turno.valor == null) return { tipo: 'campo_faltante', campo: 'turno' };
    if (medios.length === 0)        return { tipo: 'campo_faltante', campo: 'medios' };
    if (totalCierre <= 0)            return { tipo: 'campo_faltante', campo: 'total' };
    const sinConfig = medios.find(m => !m.matched);
    if (sinConfig) return { tipo: 'medio_no_configurado', nombre: sinConfig.raw };
    return null;
  }, [cierre, medios, totalCierre, localActivo]);

  async function importar() {
    if (!cierre || !cierre.fecha.valor || !cierre.turno.valor || localActivo == null || bloqueo) return;
    setLoading(true);
    try {
      const lid = Number(localActivo);
      const fecha = cierre.fecha.valor;
      const turno = cierre.turno.valor;

      // Idempotency: si ya hay un cierre del mismo (fecha, turno, local), confirmar.
      const { data: dup } = await db.from('ventas').select('id')
        .eq('fecha', fecha).eq('turno', turno).eq('local_id', lid).limit(1);
      if (dup && dup.length > 0) {
        if (!confirm(`Ya existe un cierre del ${fmt_d(fecha)} turno ${turno} para este local. ¿Importar igual?`)) {
          setLoading(false); return;
        }
      }

      const ventas = medios.map(m => ({
        id: genId('V'),
        medio: m.matched!,         // bloqueo previene null acá
        monto: m.monto,
        cant: m.cantidad,
        fecha, turno, local_id: lid,
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
            {cierre && <button className="btn btn-sec" onClick={reset}>Limpiar</button>}
          </div>
        </div>
      </div>

      {cierre && (
        <Preview
          cierre={cierre}
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

interface PreviewProps {
  cierre: CierreMaxirest;
  medios: MedioMapeado[];
  totalCierre: number;
  bloqueo: Bloqueo | null;
  loading: boolean;
  onImportar: () => void;
}

function Preview({ cierre, medios, totalCierre, bloqueo, loading, onImportar }: PreviewProps) {
  if (bloqueo) return <BloqueoMsg bloqueo={bloqueo} cierre={cierre} />;

  return (
    <div className="panel">
      <div className="panel-hd"><span className="panel-title">Cierre detectado</span></div>
      <div style={{ padding: 16, display: 'grid', gap: 12 }}>
        <Linea label="Fecha" valor={cierre.fecha.valor ? fmt_d(cierre.fecha.valor) : '—'} />
        <Linea label="Turno" valor={cierre.turno.valor ?? '—'} />
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

function BloqueoMsg({ bloqueo, cierre }: { bloqueo: Bloqueo; cierre: CierreMaxirest }) {
  return (
    <div className="panel">
      <div className="panel-hd"><span className="panel-title">No se pudo procesar el cierre</span></div>
      <div style={{ padding: 16 }}>
        <div className="alert alert-warn" style={{ fontSize: 13, lineHeight: 1.6 }}>
          {textoBloqueo(bloqueo, cierre)}
        </div>
      </div>
    </div>
  );
}

function textoBloqueo(b: Bloqueo, cierre: CierreMaxirest): string {
  if (b.tipo === 'sin_local') {
    return 'Tenés que tener un local activo seleccionado en el sidebar para importar.';
  }
  if (b.tipo === 'campo_faltante') {
    if (b.campo === 'fecha') {
      return 'No se detectó la FECHA del cierre. Verificá que el texto incluya la fecha (ej: "Lunes 4 de Mayo de 2026") y volvé a procesar.';
    }
    if (b.campo === 'turno') {
      return 'No se detectó el TURNO. Verificá que el texto incluya la línea "Turno: Mediodía" o "Turno: Noche" y volvé a procesar.';
    }
    if (b.campo === 'medios') {
      return 'No se detectaron MEDIOS DE COBRO. Verificá que el texto incluya la sección "VENTAS POR FORMA DE COBRO" con sus filas y volvé a procesar.';
    }
    if (b.campo === 'total') {
      const f = cierre.fecha.valor ? fmt_d(cierre.fecha.valor) : '';
      return `Los medios detectados suman 0 ${f ? `(cierre ${f})` : ''}. Probablemente el texto está incompleto. Volvé a copiar el cierre completo y procesalo de nuevo.`;
    }
  }
  if (b.tipo === 'medio_no_configurado') {
    return `El medio "${b.nombre}" no está configurado en el catálogo del local. Andá a Configuración → Medios de cobro, agregalo, y volvé a procesar el cierre.`;
  }
  return 'No se pudo procesar el cierre. Volvé a copiarlo completo y procesalo de nuevo.';
}
