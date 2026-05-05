import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import { listVentas, abrirVenta } from '../../services/ventasService';
import { listCanales } from '../../services/canalesService';
import type { VentaPos } from '../../types/database';
import { formatARS, relativoCorto } from '../../lib/format';
import { Badge } from '../../components/Badge';

export function MostradorView() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [ventas, setVentas] = useState<VentaPos[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data, error: err } = await listVentas({
      localId,
      modos: ['mostrador'],
      estados: ['abierta', 'enviada', 'lista'],
    });
    if (err) setError(err);
    setVentas(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  async function nuevaOrden() {
    if (!empleado || localId === null) return;
    setCreando(true);
    const { data: canales } = await listCanales(null, true);
    const canal = canales.find((c) => c.slug === 'mostrador');
    if (!canal) { setError('No hay canal "mostrador" configurado'); setCreando(false); return; }
    const { ventaId, error: err } = await abrirVenta({
      localId, modo: 'mostrador', canalId: canal.id, cajeroId: empleado.id,
    });
    setCreando(false);
    if (err || !ventaId) { setError(err ?? 'Error abriendo venta'); return; }
    navigate(`/pos/venta/${ventaId}`);
  }

  if (loading) return <div style={{ padding: 32, textAlign: 'center', color: '#6B7280' }}>Cargando…</div>;

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 16px' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Mostrador</h2>
        <span style={{ fontSize: 13, color: '#6B7280' }}>{ventas.length} órdenes activas</span>
        <button type="button" onClick={nuevaOrden} disabled={creando} style={{ marginLeft: 'auto', ...btnPrimary }}>
          {creando ? 'Creando…' : '+ Nueva orden'}
        </button>
      </header>

      {error && <div style={errBox}>{error}</div>}

      {ventas.length === 0 ? (
        <div style={{ padding: 48, border: '1px dashed #D1D5DB', borderRadius: 8, textAlign: 'center', color: '#6B7280' }}>
          No hay órdenes abiertas. Tocá "+ Nueva orden" para crear una.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          {ventas.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => navigate(`/pos/venta/${v.id}`)}
              style={card}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <strong style={{ fontSize: 15 }}>#{v.numero_local}</strong>
                <Badge variant={estadoColor(v.estado)}>{v.estado}</Badge>
              </div>
              <div style={{ marginTop: 4, fontSize: 13, color: '#6B7280' }}>
                {v.cliente_nombre ?? 'Sin nombre'}
              </div>
              <div style={{ marginTop: 8, fontSize: 18, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {formatARS(v.total)}
              </div>
              <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>
                {relativoCorto(v.abierta_at)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function estadoColor(e: string): 'gray' | 'amber' | 'green' | 'blue' {
  if (e === 'abierta') return 'gray';
  if (e === 'enviada') return 'amber';
  if (e === 'lista')   return 'blue';
  if (e === 'entregada') return 'green';
  return 'gray';
}

const card: React.CSSProperties = {
  textAlign: 'left', padding: 12, border: '1px solid #E5E7EB', borderRadius: 8,
  background: '#FFFFFF', cursor: 'pointer', fontFamily: 'inherit',
};
const btnPrimary: React.CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 6, background: '#2563EB', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginBottom: 12 };
