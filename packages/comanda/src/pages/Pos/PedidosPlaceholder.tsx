import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Inbox, Phone, MapPin, Home, CheckCircle2, ChefHat } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import {
  listPedidosPorTab, getCountersPedidos, aprobarPedidoService,
  marcarListoService, marcarEntregadoService,
  type PedidoTab,
} from '@/services/pedidosService';
import { listCanales } from '@/services/canalesService';
import type { VentaPos, Canal } from '@/types/database';
import { formatARS } from '@/lib/format';
import { UrgencyTimer } from '@/components/UrgencyTimer';
import { CanalBadge } from '@/components/CanalBadge';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const TABS: Array<{ key: PedidoTab; label: string }> = [
  { key: 'necesita_aprobacion', label: 'Por aprobar' },
  { key: 'programados',         label: 'Programados' },
  { key: 'activos',             label: 'En cocina' },
  { key: 'listos',              label: 'Listos' },
  { key: 'completados',         label: 'Completados' },
];

const POLL_MS = 30_000;

export function PedidosPlaceholder() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();
  const [tab, setTab] = useState<PedidoTab>('activos');
  const [pedidos, setPedidos] = useState<VentaPos[]>([]);
  const [canales, setCanales] = useState<Canal[]>([]);
  const [counters, setCounters] = useState<Record<PedidoTab, number>>({
    necesita_aprobacion: 0, programados: 0, activos: 0, listos: 0, completados: 0,
  });
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const [pRes, cRes, ctsRes] = await Promise.all([
      listPedidosPorTab(localId, tab),
      listCanales(user?.tenant_id ?? null, true),
      getCountersPedidos(localId),
    ]);
    setPedidos(pRes.data);
    setCanales(cRes.data);
    setCounters(ctsRes);
    setLoading(false);
  }, [localId, tab, user?.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  // Polling cada 30s mientras esté abierto. (Realtime postergado — DEUDA TÉCNICA)
  useEffect(() => {
    const id = setInterval(reload, POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  return (
    <div className="container py-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Pedidos</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pedidos online y delivery externo. Refresca cada 30 segundos.
        </p>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as PedidoTab)}>
        <TabsList className="bg-transparent border-b border-border w-full justify-start rounded-none h-auto p-0 mb-6 overflow-x-auto">
          {TABS.map((t) => {
            const c = counters[t.key];
            return (
              <TabsTrigger
                key={t.key}
                value={t.key}
                className="data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none rounded-none border-b-2 border-transparent px-4 py-3 gap-2"
              >
                {t.label}
                {c > 0 && (
                  <span className={cn(
                    'inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-semibold relative',
                    t.key === 'necesita_aprobacion' ? 'bg-warning text-warning-foreground' : 'bg-muted text-foreground',
                  )}>
                    {c}
                    {t.key === 'necesita_aprobacion' && (
                      <span className="absolute inset-0 rounded-full bg-warning/40 animate-ping pointer-events-none" />
                    )}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {TABS.map((t) => (
          <TabsContent key={t.key} value={t.key} className="mt-0">
            {loading ? (
              <div className="py-8 text-center text-muted-foreground">Cargando…</div>
            ) : pedidos.length === 0 ? (
              <EmptyState tab={t.key} />
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {pedidos.map((p) => (
                  <PedidoCard
                    key={p.id}
                    pedido={p}
                    canales={canales}
                    onClick={() => navigate(`/pos/venta/${p.id}`)}
                    onAccion={async () => {
                      let r;
                      if (p.estado === 'necesita_aprobacion') r = await aprobarPedidoService(p.id);
                      else if (p.estado === 'enviada') r = await marcarListoService(p.id);
                      else if (p.estado === 'lista') r = await marcarEntregadoService(p.id);
                      if (r?.error) toast.error(r.error);
                      else { toast.success('Pedido actualizado'); reload(); }
                    }}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function PedidoCard({ pedido, canales, onClick, onAccion }: {
  pedido: VentaPos;
  canales: Canal[];
  onClick: () => void;
  onAccion: () => Promise<void>;
}) {
  const canal = canales.find((c) => c.id === pedido.canal_id);
  const accionLabel =
    pedido.estado === 'necesita_aprobacion' ? 'Aprobar' :
    pedido.estado === 'enviada' ? 'Marcar listo' :
    pedido.estado === 'lista' ? 'Entregado' : null;
  const accionVariant: 'success' | 'default' =
    pedido.estado === 'necesita_aprobacion' ? 'success' : 'default';
  const AccionIcon =
    pedido.estado === 'necesita_aprobacion' ? CheckCircle2 :
    pedido.estado === 'enviada' ? ChefHat :
    CheckCircle2;

  return (
    <Card className="overflow-hidden cursor-pointer hover:border-primary/50 transition-colors" onClick={onClick}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <strong className="text-base">#{pedido.numero_local}</strong>
          {canal && <CanalBadge slug={canal.slug} label={canal.nombre} emoji={canal.emoji} />}
        </div>

        <div className="text-sm font-medium truncate">{pedido.cliente_nombre ?? 'Sin nombre'}</div>

        {pedido.cliente_telefono && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Phone className="h-3 w-3" /> {pedido.cliente_telefono}
          </div>
        )}
        {pedido.tipo_entrega === 'delivery' && pedido.cliente_direccion && (
          <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3 mt-0.5 flex-shrink-0" />
            <span className="line-clamp-2">{pedido.cliente_direccion}</span>
          </div>
        )}
        {pedido.tipo_entrega === 'retiro' && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Home className="h-3 w-3" /> Retiro en local
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <UrgencyTimer desdeIso={pedido.created_at} />
          <strong className="text-lg tabular-nums">{formatARS(pedido.total)}</strong>
        </div>

        {accionLabel && (
          <Button
            type="button"
            variant={accionVariant}
            className="w-full mt-2"
            onClick={(e) => { e.stopPropagation(); void onAccion(); }}
          >
            <AccionIcon className="h-4 w-4 mr-2" />
            {accionLabel}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyState({ tab }: { tab: PedidoTab }) {
  const messages: Record<PedidoTab, { titulo: string; subtitulo: string }> = {
    necesita_aprobacion: { titulo: 'Todo al día', subtitulo: 'No hay pedidos esperando aprobación.' },
    programados:         { titulo: 'Sin programados', subtitulo: 'No hay pedidos programados para más tarde.' },
    activos:             { titulo: 'Cocina libre', subtitulo: 'No hay pedidos en preparación.' },
    listos:              { titulo: 'Sin pedidos listos', subtitulo: 'Cuando un pedido esté listo aparecerá acá.' },
    completados:         { titulo: 'Sin completados', subtitulo: 'Los pedidos entregados van apareciendo acá.' },
  };
  const m = messages[tab];
  return (
    <Card>
      <CardContent className="py-20 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
          <Inbox className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium mb-1">{m.titulo}</h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">{m.subtitulo}</p>
      </CardContent>
    </Card>
  );
}
