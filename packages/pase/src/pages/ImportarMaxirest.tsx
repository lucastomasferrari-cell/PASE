import { useMemo, useState } from "react";
import { db } from "../lib/supabase";
import { toISO, today, fmt_d, fmt_$, genId } from "../lib/utils";
import { useMediosCobro } from "../lib/useMediosCobro";
import type { Local } from "../types";
import { parseCierreMaxirest } from "../lib/maxirest/parser";
import type { CierreMaxirest, Confianza, Warning, MedioVenta } from "../lib/maxirest/types";

interface ImportarMaxirestProps {
  locales: Local[];
  localActivo?: number | null;
  onImported?: () => void;
}

interface MedioConSnapshot extends MedioVenta {
  /** medio del catálogo matcheado (null si no existe). */
  matchedNombre: string | null;
}

/** Estado editable del preview: qué cambió el usuario respecto al auto-detect. */
interface EstadoEditado {
  fecha?: string;
  turno?: 'Mediodía' | 'Noche';
  localId?: number;
  cubiertos?: number | null;
  // Medios: clave = índice, valor = nombre del medio en el catálogo
  // (string vacío = ignorar la fila).
  medios?: Record<number, string>;
}

const PARSER_VERSION = 'maxirest-v2-2026.05.08';

export default function ImportarMaxirest({ locales, localActivo, onImported }: ImportarMaxirestProps) {
  const [texto, setTexto] = useState('');
  const [cierre, setCierre] = useState<CierreMaxirest | null>(null);
  const [editado, setEditado] = useState<EstadoEditado>({});
  const [loading, setLoading] = useState(false);
  const { mediosDisponibles } = useMediosCobro();

  function analizar() {
    if (!texto.trim()) return;
    const c = parseCierreMaxirest(texto);
    setCierre(c);
    // Inicializar editado con el local del usuario activo si el parser no
    // pudo determinar uno con certeza (heurística simple).
    const auto: EstadoEditado = {};
    if (localActivo) auto.localId = Number(localActivo);
    setEditado(auto);
  }

  function reset() { setCierre(null); setEditado({}); setTexto(''); }

  // Valores efectivos (auto + ediciones del usuario).
  const valores = useMemo(() => {
    if (!cierre) return null;
    const fecha = editado.fecha ?? cierre.fecha.valor ?? toISO(today);
    const turno: 'Mediodía' | 'Noche' = editado.turno ?? cierre.turno.valor ?? 'Mediodía';
    const localId = editado.localId ?? localActivo ?? null;
    return { fecha, turno, localId };
  }, [cierre, editado, localActivo]);

  // Mapeo dinámico medios → catálogo del local activo.
  const mediosNorm: MedioConSnapshot[] = useMemo(() => {
    if (!cierre || !cierre.ventasPorMedio.valor) return [];
    const localId = valores?.localId ?? null;
    if (localId == null) return cierre.ventasPorMedio.valor.map(m => ({ ...m, matchedNombre: null }));
    const cat = mediosDisponibles(localId);
    return cierre.ventasPorMedio.valor.map(m => {
      const target = m.raw.trim().toUpperCase();
      const found = cat.find(c => c.nombre.trim().toUpperCase() === target);
      return { ...m, matchedNombre: found?.nombre ?? null };
    });
  }, [cierre, valores?.localId, mediosDisponibles]);

  const warningsCriticos = (cierre?.warnings ?? []).filter(w => w.severidad === 'critical');
  const mediosFaltantes = mediosNorm.filter(m => {
    const override = editado.medios?.[mediosNorm.indexOf(m)];
    if (override === '__ignorar__') return false;
    if (override) return false;
    return !m.matchedNombre;
  });
  // Medios faltantes y locales sin elegir bloquean importar.
  const bloqueado = warningsCriticos.length > 0 || mediosFaltantes.length > 0
                 || valores?.localId == null;

  function setMedioOverride(idx: number, nombre: string) {
    setEditado(e => ({ ...e, medios: { ...(e.medios ?? {}), [idx]: nombre } }));
  }

  async function confirmar() {
    if (!cierre || !valores || valores.localId == null) return;
    setLoading(true);
    try {
      // Resolver medios efectivos (override del usuario o match automático).
      const ventas: Array<{ id: string; medio: string; monto: number; cant: number; fecha: string; turno: string; local_id: number; origen: string; parser_version: string; campos_editados: Record<string, unknown> | null }> = [];
      const camposEditados = construirCamposEditados(cierre, editado);
      for (let i = 0; i < mediosNorm.length; i++) {
        const m = mediosNorm[i]!;
        const override = editado.medios?.[i];
        if (override === '__ignorar__') continue;
        const nombreMedio = override && override !== '' ? override : m.matchedNombre;
        if (!nombreMedio) continue; // bloqueado, no debería pasar
        ventas.push({
          id: genId('V'),
          medio: nombreMedio,
          monto: m.monto,
          cant: m.cantidad,
          fecha: valores.fecha,
          turno: valores.turno,
          local_id: valores.localId!,
          origen: 'maxirest',
          parser_version: PARSER_VERSION,
          campos_editados: Object.keys(camposEditados).length > 0 ? camposEditados : null,
        });
      }
      if (ventas.length === 0) { alert('No hay medios para importar.'); setLoading(false); return; }

      // Idempotency: confirmar si ya hay un cierre del mismo (fecha, turno, local).
      const { data: dup } = await db.from('ventas').select('id').eq('fecha', valores.fecha)
        .eq('turno', valores.turno).eq('local_id', valores.localId).limit(1);
      if (dup && dup.length > 0) {
        if (!confirm(`Ya existe un cierre del ${fmt_d(valores.fecha)} turno ${valores.turno} para este local. ¿Importar igual?`)) {
          setLoading(false); return;
        }
      }

      const { data: ins, error } = await db.from('ventas').insert(ventas).select();
      if (error) throw new Error(error.message);
      if (!ins || ins.length === 0) {
        throw new Error('Insert no devolvió filas — RLS bloqueando o permisos del local.');
      }
      alert('✓ Importado: ' + ins.length + ' filas · Total: ' + fmt_$(ventas.reduce((s, v) => s + v.monto, 0)));
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
        <div className="panel-hd"><span className="panel-title">Texto del mail de cierre</span></div>
        <div style={{ padding: 16 }}>
          <textarea
            style={{ width: '100%', height: 280, background: 'var(--bg)', border: '1px solid var(--bd)', color: 'var(--txt)', padding: '10px 12px', fontFamily: "'DM Mono',monospace", fontSize: 11, borderRadius: 'var(--r)', outline: 'none', resize: 'vertical' }}
            placeholder="Pegá acá el texto completo del mail de cierre de Maxirest..."
            value={texto}
            onChange={e => setTexto(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn btn-acc" onClick={analizar} disabled={!texto.trim()}>Analizar texto</button>
            {cierre && <button className="btn btn-sec" onClick={reset}>Limpiar</button>}
          </div>
        </div>
      </div>

      {cierre && valores && (
        <PreviewEditable
          cierre={cierre}
          valores={valores}
          editado={editado}
          setEditado={setEditado}
          locales={locales}
          mediosNorm={mediosNorm}
          setMedioOverride={setMedioOverride}
          bloqueado={bloqueado}
          loading={loading}
          onConfirmar={confirmar}
        />
      )}
    </div>
  );
}

interface PreviewProps {
  cierre: CierreMaxirest;
  valores: { fecha: string; turno: 'Mediodía' | 'Noche'; localId: number | null };
  editado: EstadoEditado;
  setEditado: React.Dispatch<React.SetStateAction<EstadoEditado>>;
  locales: Local[];
  mediosNorm: MedioConSnapshot[];
  setMedioOverride: (idx: number, nombre: string) => void;
  bloqueado: boolean;
  loading: boolean;
  onConfirmar: () => void;
}

function PreviewEditable({
  cierre, valores, editado, setEditado, locales, mediosNorm, setMedioOverride,
  bloqueado, loading, onConfirmar,
}: PreviewProps) {
  const total = mediosNorm.reduce((s, m) => {
    return s + m.monto;
  }, 0);
  return (
    <div className="panel">
      <div className="panel-hd"><span className="panel-title">Preview detectado · editable</span></div>
      <div style={{ padding: 16, display: 'grid', gap: 12 }}>
        <WarningsList warnings={cierre.warnings} />

        <FieldRow
          label="Fecha"
          campo={cierre.fecha}
          editado={editado.fecha != null}
        >
          <input
            type="date"
            className="search"
            style={{ width: 180 }}
            value={editado.fecha ?? cierre.fecha.valor ?? ''}
            onChange={e => setEditado(s => ({ ...s, fecha: e.target.value }))}
          />
        </FieldRow>

        <FieldRow
          label="Turno"
          campo={cierre.turno}
          editado={editado.turno != null}
        >
          <select
            value={editado.turno ?? cierre.turno.valor ?? 'Mediodía'}
            onChange={e => setEditado(s => ({ ...s, turno: e.target.value as 'Mediodía' | 'Noche' }))}
          >
            <option value="Mediodía">Mediodía</option>
            <option value="Noche">Noche</option>
          </select>
        </FieldRow>

        <FieldRow
          label="Local"
          campo={cierre.localNombre}
          editado={editado.localId != null && editado.localId !== valores.localId}
          extraNota={
            cierre.localNombre.valor && !locales.find(l => l.nombre.toLowerCase() === cierre.localNombre.valor!.toLowerCase())
              ? `Detectado "${cierre.localNombre.valor}" pero ese nombre no existe en tu tenant. Elegí manualmente.`
              : null
          }
        >
          <select
            value={valores.localId ?? ''}
            onChange={e => setEditado(s => ({ ...s, localId: parseInt(e.target.value, 10) || undefined }))}
          >
            <option value="">— Seleccioná —</option>
            {locales.map(l => <option key={l.id} value={l.id}>{l.nombre}</option>)}
          </select>
          {cierre.cuit.valor && (
            <span style={{ fontSize: 10, color: 'var(--muted2)', marginLeft: 8 }}>
              CUIT detectado: {cierre.cuit.valor}
            </span>
          )}
        </FieldRow>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
          <ReadonlyMini label="Cierre n°" valor={cierre.cierreNumero.valor} confianza={cierre.cierreNumero.confianza} />
          <ReadonlyMini label="Apertura" valor={cierre.horaApertura.valor} confianza={cierre.horaApertura.confianza} />
          <ReadonlyMini label="Cierre" valor={cierre.horaCierre.valor} confianza={cierre.horaCierre.confianza} />
          <ReadonlyMini label="Cubiertos" valor={cierre.cubiertos.valor} confianza={cierre.cubiertos.confianza} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <ReadonlyMini label="Ingresos" valor={cierre.totalIngresos.valor != null ? fmt_$(cierre.totalIngresos.valor) : null} confianza={cierre.totalIngresos.confianza} />
          <ReadonlyMini label="Egresos" valor={cierre.totalEgresos.valor != null ? fmt_$(cierre.totalEgresos.valor) : null} confianza={cierre.totalEgresos.confianza} />
          <ReadonlyMini label="Saldo" valor={cierre.saldoCaja.valor != null ? fmt_$(cierre.saldoCaja.valor) : null} confianza={cierre.saldoCaja.confianza} />
        </div>

        <MediosTable
          mediosNorm={mediosNorm}
          editado={editado}
          setMedioOverride={setMedioOverride}
          localId={valores.localId}
          totalCalc={total}
        />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
          {bloqueado && <span style={{ fontSize: 11, color: 'var(--danger)' }}>
            Resolvé los warnings críticos antes de importar.
          </span>}
          <button
            className="btn btn-acc"
            onClick={onConfirmar}
            disabled={bloqueado || loading}
          >
            {loading ? 'Importando…' : '✓ Confirmar e Importar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Subcomponentes ────────────────────────────────────────────────────────

function WarningsList({ warnings }: { warnings: Warning[] }) {
  if (warnings.length === 0) {
    return (
      <div className="alert" style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.4)', color: 'var(--success)', padding: '8px 12px', fontSize: 12, borderRadius: 'var(--r)' }}>
        ✓ Sin warnings. El parser detectó todos los campos con confianza alta.
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      {warnings.map((w, i) => {
        const color = w.severidad === 'critical' ? 'var(--danger)' : w.severidad === 'warning' ? '#f59e0b' : '#3b82f6';
        const bg = w.severidad === 'critical' ? 'rgba(239,68,68,0.1)' : w.severidad === 'warning' ? 'rgba(245,158,11,0.1)' : 'rgba(59,130,246,0.1)';
        return (
          <div key={i} style={{ background: bg, border: `1px solid ${color}40`, color, padding: '6px 10px', fontSize: 12, borderRadius: 'var(--r)' }}>
            <strong style={{ marginRight: 6 }}>
              {w.severidad === 'critical' ? '🔴' : w.severidad === 'warning' ? '⚠️' : 'ℹ️'} [{w.campo}]
            </strong>
            {w.mensaje}
          </div>
        );
      })}
    </div>
  );
}

function ConfianzaIcon({ confianza, editado }: { confianza: Confianza; editado: boolean }) {
  if (editado) return <span title="Editado por usuario" style={{ color: '#3b82f6' }}>✏️</span>;
  if (confianza === 'alta') return <span title="Detectado por múltiples fuentes" style={{ color: 'var(--success)' }}>✅</span>;
  if (confianza === 'media') return <span title="Detectado por una fuente" style={{ color: '#f59e0b' }}>⚠️</span>;
  if (confianza === 'baja') return <span title="Detectado con baja confianza" style={{ color: '#f59e0b' }}>⚠️</span>;
  return <span title="No detectado" style={{ color: 'var(--danger)' }}>🔴</span>;
}

interface FieldRowProps {
  label: string;
  campo: { confianza: Confianza; nota: string | null; fuente: string | null };
  editado: boolean;
  extraNota?: string | null;
  children: React.ReactNode;
}

function FieldRow({ label, campo, editado, extraNota, children }: FieldRowProps) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px auto 1fr', gap: 8, alignItems: 'center' }}>
      <label style={{ fontSize: 12, color: 'var(--muted2)' }}>{label}</label>
      <ConfianzaIcon confianza={campo.confianza} editado={editado} />
      <div>
        {children}
        {(campo.nota || extraNota) && (
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>
            {extraNota ?? campo.nota}
            {campo.fuente && ` · fuente: ${campo.fuente}`}
          </div>
        )}
      </div>
    </div>
  );
}

function ReadonlyMini({ label, valor, confianza }: { label: string; valor: number | string | null; confianza: Confianza }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--bd)', padding: '6px 8px', borderRadius: 'var(--r)' }}>
      <div style={{ fontSize: 10, color: 'var(--muted2)', display: 'flex', alignItems: 'center', gap: 4 }}>
        {label} <ConfianzaIcon confianza={confianza} editado={false} />
      </div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{valor ?? '—'}</div>
    </div>
  );
}

interface MediosProps {
  mediosNorm: MedioConSnapshot[];
  editado: EstadoEditado;
  setMedioOverride: (idx: number, nombre: string) => void;
  localId: number | null;
  totalCalc: number;
}

function MediosTable({ mediosNorm, editado, setMedioOverride, localId, totalCalc }: MediosProps) {
  const { mediosDisponibles } = useMediosCobro();
  const cat = localId != null ? mediosDisponibles(localId) : [];
  if (mediosNorm.length === 0) {
    return <div className="alert alert-warn">No se detectaron medios de cobro en el cierre.</div>;
  }
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--muted2)', marginBottom: 6 }}>
        Medios de cobro detectados ({mediosNorm.length}). Si alguno no matchea con tu catálogo, mapealo o ignoralo.
      </div>
      <table>
        <thead><tr>
          <th>Detectado</th><th>Mapear a catálogo</th>
          <th style={{ textAlign: 'right' }}>Monto</th>
          <th style={{ textAlign: 'right' }}>Cant.</th>
        </tr></thead>
        <tbody>
          {mediosNorm.map((m, idx) => {
            const override = editado.medios?.[idx];
            const efectivo = override === '__ignorar__' ? '(ignorar)' : (override && override !== '') ? override : m.matchedNombre;
            const necesitaMap = !efectivo;
            return (
              <tr key={idx} style={necesitaMap ? { background: 'rgba(239,68,68,0.05)' } : {}}>
                <td style={{ fontFamily: "'DM Mono', monospace", fontSize: 11 }}>{m.raw}</td>
                <td>
                  <select
                    value={override ?? (m.matchedNombre ?? '')}
                    onChange={e => setMedioOverride(idx, e.target.value)}
                  >
                    <option value="">— Sin mapear —</option>
                    <option value="__ignorar__">Ignorar esta línea</option>
                    {cat.map(c => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
                  </select>
                </td>
                <td style={{ textAlign: 'right' }}><span className="num kpi-success">{fmt_$(m.monto)}</span></td>
                <td style={{ textAlign: 'right', color: 'var(--muted2)' }}>{m.cantidad}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ textAlign: 'right', fontSize: 13, fontWeight: 500, color: 'var(--success)', marginTop: 8 }}>
        Total: {fmt_$(totalCalc)}
      </div>
    </div>
  );
}

// ── Audit log helpers ─────────────────────────────────────────────────────

function construirCamposEditados(cierre: CierreMaxirest, editado: EstadoEditado): Record<string, { auto: unknown; manual: unknown }> {
  const out: Record<string, { auto: unknown; manual: unknown }> = {};
  if (editado.fecha != null && editado.fecha !== cierre.fecha.valor) {
    out.fecha = { auto: cierre.fecha.valor, manual: editado.fecha };
  }
  if (editado.turno != null && editado.turno !== cierre.turno.valor) {
    out.turno = { auto: cierre.turno.valor, manual: editado.turno };
  }
  if (editado.medios && Object.keys(editado.medios).length > 0) {
    out.medios = { auto: cierre.ventasPorMedio.valor, manual: editado.medios };
  }
  return out;
}

