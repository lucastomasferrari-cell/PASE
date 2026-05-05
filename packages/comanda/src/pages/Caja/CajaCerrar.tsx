import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import {
  getTurnoAbierto, totalesPorMetodo, cerrarTurno, type TotalesPorMetodo,
} from '../../services/turnosCajaService';
import type { TurnoCaja } from '../../types/database';
import { formatARS, formatHoraAR } from '../../lib/format';
import { MoneyInput } from '../../components/MoneyInput';

export function CajaCerrar() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [turno, setTurno] = useState<TurnoCaja | null>(null);
  const [totales, setTotales] = useState<TotalesPorMetodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [montoEfectivoDeclarado, setMontoEfectivoDeclarado] = useState(0);
  const [notas, setNotas] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (localId === null) return;
    (async () => {
      const { data: t } = await getTurnoAbierto(localId);
      setTurno(t);
      if (t) {
        const tot = await totalesPorMetodo(t.id);
        setTotales(tot.data);
        const efectivo = tot.data.find((x) => x.metodo === 'efectivo');
        const calculado = (efectivo?.total ?? 0) + Number(t.monto_inicial);
        setMontoEfectivoDeclarado(calculado);
      }
      setLoading(false);
    })();
  }, [localId]);

  if (loading) return <Centered>Cargando…</Centered>;
  if (!turno) return <Centered>No hay turno abierto.</Centered>;
  if (!empleado) return <Centered>Sesión POS requerida.</Centered>;

  const efectivoEntrante = totales.find((t) => t.metodo === 'efectivo')?.total ?? 0;
  const calculadoEfectivo = Number(turno.monto_inicial) + efectivoEntrante;
  const diferencia = montoEfectivoDeclarado - calculadoEfectivo;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!empleado || !turno) return;
    setSaving(true); setError(null);
    const { error: err } = await cerrarTurno(turno.id, empleado.id, montoEfectivoDeclarado, notas.trim() || null);
    setSaving(false);
    if (err) { setError(err); return; }
    navigate('/caja/abrir', { replace: true });
  }

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px', fontFamily: 'system-ui' }}>
      <h2 style={{ margin: 0, fontSize: 22 }}>Cerrar caja</h2>
      <p style={{ margin: '4px 0 24px', color: '#6B7280', fontSize: 13 }}>
        Turno #{turno.numero} · abierto {formatHoraAR(turno.abierto_at)}
      </p>

      <section style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 13, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Totales del turno (sistema)
        </h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 14 }}>
          <tbody>
            <tr style={{ borderBottom: '1px solid #E5E7EB' }}>
              <td style={tdL}>Monto inicial (efectivo)</td>
              <td style={tdR}>{formatARS(turno.monto_inicial)}</td>
            </tr>
            {totales.map((t) => (
              <tr key={t.metodo} style={{ borderBottom: '1px solid #F3F4F6' }}>
                <td style={tdL}>{t.metodo} ({t.cantidad} mov.)</td>
                <td style={tdR}>{formatARS(t.total)}</td>
              </tr>
            ))}
            <tr style={{ background: '#FEF2F2', fontWeight: 600 }}>
              <td style={tdL}>Esperado en efectivo al cierre</td>
              <td style={tdR}>{formatARS(calculadoEfectivo)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <form onSubmit={onSubmit}>
        <label style={{ display: 'block', marginBottom: 16, fontSize: 13 }}>
          <div style={{ marginBottom: 4, fontWeight: 500, color: '#374151' }}>
            Efectivo en caja al cierre (lo que contás físicamente)
          </div>
          <MoneyInput value={montoEfectivoDeclarado} onChange={setMontoEfectivoDeclarado} autoFocus />
        </label>

        <div style={{ padding: 12, background: difBg(diferencia), borderRadius: 6, marginBottom: 16, fontSize: 14, fontWeight: 500 }}>
          Diferencia: <span style={{ fontVariantNumeric: 'tabular-nums', marginLeft: 8 }}>
            {diferencia > 0 ? '+' : ''}{formatARS(diferencia)}
          </span>
          <div style={{ fontSize: 12, marginTop: 4, fontWeight: 400 }}>
            {Math.abs(diferencia) < 0.01 ? '✓ Coincide con el sistema'
              : diferencia > 0 ? '↑ Sobra plata respecto al sistema'
              : '↓ Falta plata respecto al sistema'}
          </div>
        </div>

        <label style={{ display: 'block', marginBottom: 16, fontSize: 13 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>Notas del cierre (opcional)</div>
          <textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={3} style={{ ...input, minHeight: 60 }} />
        </label>

        {error && <div style={errBox}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => navigate('/caja')} style={btnSecondary} disabled={saving}>Volver</button>
          <button type="submit" disabled={saving} style={btnPrimary}>
            {saving ? 'Cerrando…' : 'Confirmar cierre'}
          </button>
        </div>
      </form>
    </div>
  );
}

function difBg(d: number): string {
  if (Math.abs(d) < 0.01) return '#D1FAE5';
  if (Math.abs(d) < 500) return '#FEF3C7';
  return '#FEE2E2';
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: '40vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B7280', fontFamily: 'system-ui' }}>{children}</div>;
}

const tdL: React.CSSProperties = { padding: '6px 4px' };
const tdR: React.CSSProperties = { padding: '6px 4px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const input: React.CSSProperties = { padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14, width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' };
const btnPrimary: React.CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 6, background: '#DC2626', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
const btnSecondary: React.CSSProperties = { padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14 };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginBottom: 12 };
