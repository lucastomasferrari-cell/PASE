// Placeholder Pedidos (tienda online) — UI completa va en Sprint 2 sesión 2.
// Por ahora muestra mensaje + lista mínima de pedidos pendientes.

import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { useLocalActivo } from '../../lib/localActivo';
import { listPedidosPorAprobar } from '../../services/tiendaService';
import { aprobarPedido } from '../../services/ventasService';
import type { VentaPos } from '../../types/database';
import { formatARS, relativoCorto } from '../../lib/format';
import { Badge } from '../../components/Badge';

export function PedidosPlaceholder() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [pedidos, setPedidos] = useState<VentaPos[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    if (localId === null) return;
    setLoading(true);
    const { data, error: err } = await listPedidosPorAprobar(localId);
    if (err) setError(err);
    setPedidos(data);
    setLoading(false);
  }

  useEffect(() => { reload(); }, [localId]);

  async function aprobar(ventaId: number) {
    const { error: err } = await aprobarPedido(ventaId);
    if (err) { setError(err); return; }
    reload();
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 16px' }}>
      <header style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>Pedidos</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6B7280' }}>
          UI completa con timer urgencia y bandejas por estado en próxima sesión.
          Por ahora vista mínima: pedidos por aprobar y botón "Aprobar".
        </p>
      </header>

      {error && <div style={errBox}>{error}</div>}

      <h3 style={{ fontSize: 13, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 16 }}>
        Por aprobar ({pedidos.length})
      </h3>
      {loading && <div style={{ padding: 24, textAlign: 'center' }}>Cargando…</div>}
      {!loading && pedidos.length === 0 && (
        <div style={{ padding: 24, border: '1px dashed #D1D5DB', borderRadius: 8, textAlign: 'center', color: '#6B7280' }}>
          No hay pedidos pendientes.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {pedidos.map((p) => (
          <div key={p.id} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>#{p.numero_local}</strong>
              <Badge variant="amber">Necesita aprobación</Badge>
            </div>
            <div style={{ marginTop: 6, fontSize: 13 }}>
              {p.cliente_nombre} · {p.cliente_telefono}
            </div>
            {p.cliente_direccion && (
              <div style={{ fontSize: 12, color: '#6B7280' }}>{p.cliente_direccion}</div>
            )}
            <div style={{ marginTop: 4, fontSize: 12, color: '#6B7280' }}>
              {p.tipo_entrega ?? '—'} · {relativoCorto(p.created_at)}
            </div>
            <div style={{ marginTop: 8, fontSize: 18, fontWeight: 600 }}>{formatARS(p.total)}</div>
            <button type="button" onClick={() => aprobar(p.id)} style={{ ...btnPrimary, marginTop: 8, width: '100%' }}>
              Aprobar y mandar a cocina
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const card: React.CSSProperties = { padding: 12, border: '1px solid #E5E7EB', borderRadius: 8, background: '#FFFFFF' };
const btnPrimary: React.CSSProperties = { padding: '8px 16px', border: 'none', borderRadius: 6, background: '#10B981', color: '#FFFFFF', cursor: 'pointer', fontSize: 14, fontWeight: 500 };
const errBox: React.CSSProperties = { padding: 10, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 13, marginBottom: 12 };
