import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import {
  getTurnoAbierto, listMovimientos, totalesPorMetodo, registrarMovimiento,
  type TotalesPorMetodo,
} from '../../services/turnosCajaService';
import type { TurnoCaja, MovimientoCaja } from '../../types/database';
import { formatARS, formatHoraAR, relativoCorto } from '../../lib/format';
import { Badge } from '../../components/Badge';
import { MoneyInput } from '../../components/MoneyInput';

export function CajaEstado() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [turno, setTurno] = useState<TurnoCaja | null>(null);
  const [movs, setMovs] = useState<MovimientoCaja[]>([]);
  const [totales, setTotales] = useState<TotalesPorMetodo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [movDialog, setMovDialog] = useState<'retiro' | 'deposito' | null>(null);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data: t } = await getTurnoAbierto(localId);
    setTurno(t);
    if (t) {
      const [m, tot] = await Promise.all([listMovimientos(t.id), totalesPorMetodo(t.id)]);
      setMovs(m.data);
      setTotales(tot.data);
    }
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  if (loading) return <Centered>Cargando…</Centered>;
  if (!turno) {
    return (
      <div style={page}>
        <div style={card}>
          <h2>Caja cerrada</h2>
          <p style={{ color: '#6B7280' }}>No hay turno abierto en este local.</p>
          <button type="button" onClick={() => navigate('/caja/abrir')} style={btnPrimary}>Abrir caja</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px', fontFamily: 'system-ui' }}>
      <header style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Caja</h2>
        <Badge variant="green">Turno #{turno.numero} abierto</Badge>
        <span style={{ fontSize: 13, color: '#6B7280' }}>desde {formatHoraAR(turno.abierto_at)} · {relativoCorto(turno.abierto_at)}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setMovDialog('retiro')} style={btnSecondary}>Retiro</button>
          <button type="button" onClick={() => setMovDialog('deposito')} style={btnSecondary}>Depósito</button>
          <button type="button" onClick={() => navigate('/caja/cerrar')} style={btnDanger}>Cerrar caja</button>
        </div>
      </header>

      {error && <div style={errBox}>{error}</div>}

      {/* Cards por método */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12, marginBottom: 24 }}>
        <Card title="Monto inicial" valor={formatARS(turno.monto_inicial)} subtitle="al abrir" />
        {totales.map((t) => (
          <Card key={t.metodo} title={t.metodo} valor={formatARS(t.total)} subtitle={`${t.cantidad} mov.`} />
        ))}
      </section>

      {/* Movimientos del turno */}
      <h3 style={{ fontSize: 14, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 0 }}>
        Movimientos del turno ({movs.length})
      </h3>
      <div style={{ border: '1px solid #E5E7EB', borderRadius: 8, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead style={{ background: '#F9FAFB' }}>
            <tr>
              <th style={th}>Hora</th>
              <th style={th}>Tipo</th>
              <th style={th}>Método</th>
              <th style={{ ...th, textAlign: 'right' }}>Monto</th>
              <th style={th}>Motivo</th>
            </tr>
          </thead>
          <tbody>
            {movs.length === 0 && <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: '#6B7280' }}>Sin movimientos.</td></tr>}
            {movs.map((m) => (
              <tr key={m.id} style={{ borderTop: '1px solid #F3F4F6' }}>
                <td style={td}>{formatHoraAR(m.created_at)}</td>
                <td style={td}><Badge variant={tipoBadgeVariant(m.tipo)}>{m.tipo}</Badge></td>
                <td style={td}>{m.metodo}</td>
                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{formatARS(m.monto)}</td>
                <td style={{ ...td, color: '#6B7280' }}>{m.motivo ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {movDialog && (
        <MovimientoDialog
          tipo={movDialog}
          onClose={() => setMovDialog(null)}
          onDone={() => { setMovDialog(null); reload(); }}
          localId={localId!}
          empleadoId={empleado?.id ?? ''}
          onError={setError}
        />
      )}
    </div>
  );
}

function Card({ title, valor, subtitle }: { title: string; valor: string; subtitle: string }) {
  return (
    <div style={{ border: '1px solid #E5E7EB', borderRadius: 8, padding: 12, background: '#FFFFFF' }}>
      <div style={{ fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{valor}</div>
      <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>{subtitle}</div>
    </div>
  );
}

function tipoBadgeVariant(t: string): 'green' | 'red' | 'gray' | 'blue' | 'amber' {
  if (t === 'venta' || t === 'deposito' || t === 'apertura') return 'green';
  if (t === 'retiro' || t === 'venta_anulada') return 'red';
  if (t === 'ajuste') return 'amber';
  return 'gray';
}

interface MovDialogProps {
  tipo: 'retiro' | 'deposito';
  localId: number;
  empleadoId: string;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

function MovimientoDialog({ tipo, localId, empleadoId, onClose, onDone, onError }: MovDialogProps) {
  const [monto, setMonto] = useState(0);
  const [motivo, setMotivo] = useState('');
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (monto <= 0) return;
    if (!motivo.trim()) return;
    setSaving(true);
    const { error: err } = await registrarMovimiento(localId, empleadoId, tipo, monto, 'efectivo', motivo.trim());
    setSaving(false);
    if (err) { onError(err); return; }
    onDone();
  }

  return (
    <div role="dialog" style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form onSubmit={onSubmit} style={modal}>
        <h3 style={{ margin: 0, fontSize: 18, marginBottom: 16 }}>
          {tipo === 'retiro' ? 'Retiro de caja' : 'Depósito a caja'}
        </h3>

        <label style={{ display: 'block', marginBottom: 12, fontSize: 13 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>Monto</div>
          <MoneyInput value={monto} onChange={setMonto} autoFocus />
        </label>

        <label style={{ display: 'block', marginBottom: 16, fontSize: 13 }}>
          <div style={{ marginBottom: 4, fontWeight: 500 }}>Motivo</div>
          <input
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            required
            placeholder={tipo === 'retiro' ? 'Pago proveedor, viático, etc.' : 'Refuerzo, propina depositada, etc.'}
            style={input}
          />
        </label>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={btnSecondary} disabled={saving}>Cancelar</button>
          <button type="submit" disabled={saving} style={btnPrimary}>
            {saving ? 'Guardando…' : 'Confirmar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: '40vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B7280', fontFamily: 'system-ui' }}>{children}</div>;
}

const page: React.CSSProperties = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'system-ui' };
const card: React.CSSProperties = { background: '#FFFFFF', borderRadius: 8, padding: 32, maxWidth: 420, width: '100%', border: '1px solid #E5E7EB', textAlign: 'center' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 };
const modal: React.CSSProperties = { background: '#FFFFFF', borderRadius: 8, padding: 24, maxWidth: 380, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', fontWeight: 600, color: '#374151', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 };
const td: React.CSSProperties = { padding: '10px 12px' };
const btnPrimary: React.CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 6, background: '#2563EB', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
const btnSecondary: React.CSSProperties = { padding: '6px 14px', border: '1px solid #D1D5DB', borderRadius: 6, background: '#FFFFFF', cursor: 'pointer', fontSize: 14 };
const btnDanger: React.CSSProperties = { padding: '6px 14px', border: 'none', borderRadius: 6, background: '#DC2626', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
const input: React.CSSProperties = { padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 6, fontSize: 14, width: '100%', fontFamily: 'inherit', boxSizing: 'border-box' };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginBottom: 12 };
