import { useEffect, useState, useCallback } from 'react';
import { Inbox, Phone, MapPin, Clock } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { listPedidosPorAprobar } from '@/services/tiendaService';
import { aprobarPedido } from '@/services/ventasService';
import type { VentaPos } from '@/types/database';
import { formatARS, relativoCorto } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';

export function PedidosPlaceholder() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [pedidos, setPedidos] = useState<VentaPos[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data, error: err } = await listPedidosPorAprobar(localId);
    if (err) setError(err);
    setPedidos(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);

  async function aprobar(ventaId: number) {
    const { error: err } = await aprobarPedido(ventaId);
    if (err) { setError(err); return; }
    reload();
  }

  return (
    <div className="container py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Pedidos</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pedidos entrantes desde tienda online y delivery externo
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      <Tabs defaultValue="por_aprobar">
        <TabsList>
          <TabsTrigger value="por_aprobar">
            Por aprobar
            {pedidos.length > 0 && (
              <span className="ml-2 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-warning text-warning-foreground text-xs font-semibold">
                {pedidos.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="en_curso" disabled>En curso</TabsTrigger>
          <TabsTrigger value="completados" disabled>Completados</TabsTrigger>
        </TabsList>

        <TabsContent value="por_aprobar" className="mt-6">
          {loading ? (
            <Card><CardContent className="py-16 text-center text-muted-foreground">Cargando…</CardContent></Card>
          ) : pedidos.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {pedidos.map((p) => (
                <PedidoCard key={p.id} pedido={p} onAprobar={() => aprobar(p.id)} />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PedidoCard({ pedido, onAprobar }: { pedido: VentaPos; onAprobar: () => void }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-base font-semibold">#{pedido.numero_local}</span>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-warning/10 text-warning text-xs font-medium border border-warning/20">
            Necesita aprobación
          </span>
        </div>

        <div className="text-sm font-medium mb-2">{pedido.cliente_nombre ?? 'Sin nombre'}</div>

        {pedido.cliente_telefono && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground mb-1">
            <Phone className="h-3.5 w-3.5" />
            <span>{pedido.cliente_telefono}</span>
          </div>
        )}
        {pedido.cliente_direccion && (
          <div className="flex items-start gap-1.5 text-sm text-muted-foreground mb-1">
            <MapPin className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>{pedido.cliente_direccion}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2">
          <Clock className="h-3 w-3" />
          <span>{pedido.tipo_entrega ?? '—'} · {relativoCorto(pedido.created_at)}</span>
        </div>

        <div className="text-2xl font-bold tabular-nums mt-4 mb-4">
          {formatARS(pedido.total)}
        </div>

        <Button variant="success" className="w-full" onClick={onAprobar}>
          Aprobar y mandar a cocina
        </Button>
      </CardContent>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="py-20 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
          <Inbox className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium mb-1">Todo al día</h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          No tenés pedidos pendientes de aprobación. Los pedidos nuevos van a aparecer acá.
        </p>
      </CardContent>
    </Card>
  );
}
