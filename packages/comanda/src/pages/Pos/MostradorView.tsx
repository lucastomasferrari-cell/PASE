import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Coffee } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { useLocalActivo } from '../../lib/localActivo';
import { listVentas, abrirVenta } from '../../services/ventasService';
import { listCanales } from '../../services/canalesService';
import type { VentaPos } from '../../types/database';
import { formatARS, relativoCorto } from '../../lib/format';
import { Badge } from '../../components/Badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

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

  if (loading) {
    return <div className="container py-8 text-center text-muted-foreground">Cargando…</div>;
  }

  return (
    <div className="container py-6">
      <header className="flex items-center gap-3 mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Mostrador</h1>
        <span className="text-sm text-muted-foreground">{ventas.length} órdenes activas</span>
        <Button
          onClick={nuevaOrden}
          disabled={creando}
          variant="success"
          size="lg"
          className="ml-auto"
        >
          <Plus className="h-5 w-5 mr-2" />
          {creando ? 'Creando…' : 'Nueva orden'}
        </Button>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {ventas.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
              <Coffee className="h-8 w-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium mb-1">Sin órdenes abiertas</h3>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-4">
              Tocá "Nueva orden" para empezar a tomar pedidos del mostrador o la barra.
            </p>
            <Button onClick={nuevaOrden} disabled={creando} variant="success">
              <Plus className="h-5 w-5 mr-2" />
              Nueva orden
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {ventas.map((v) => (
            <Card
              key={v.id}
              className="cursor-pointer transition-colors hover:bg-accent"
              onClick={() => navigate(`/pos/venta/${v.id}`)}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <strong className="text-base">#{v.numero_local}</strong>
                  <Badge variant={estadoColor(v.estado)}>{v.estado}</Badge>
                </div>
                <div className="mt-2 text-sm text-muted-foreground truncate">
                  {v.cliente_nombre ?? 'Sin nombre'}
                </div>
                <div className="mt-3 text-xl font-bold tabular-nums">
                  {formatARS(v.total)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {relativoCorto(v.abierta_at)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function estadoColor(e: string): 'gray' | 'amber' | 'green' | 'blue' {
  if (e === 'abierta') return 'gray';
  if (e === 'enviada') return 'amber';
  if (e === 'lista') return 'blue';
  if (e === 'entregada') return 'green';
  return 'gray';
}
