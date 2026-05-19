// DispatchMap — pantalla principal de "despacho" de delivery.
//
// Patrón Uber Eats Restaurant Dashboard: el dueño ve un mapa con todos
// los pedidos por entregar + el sidebar con los riders disponibles.
//
// Acciones clave:
//   - Ver de un vistazo qué pedidos hay y hace cuánto se aprobaron
//     (urgencia por color)
//   - Click en pin → drawer con detalle + asignar rider
//   - Click en moto → ver qué está entregando + última posición

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import {
  Bike, Clock, RefreshCw, X, UserPlus, MessageCircle,
  AlertCircle, Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { DeliveryMap } from '@/components/maps/DeliveryMap';
import {
  listPedidosDeliveryMapa, listRidersStatus, asignarPedidoRider, desasignarRider,
  type PedidoDeliveryMapa, type Rider,
} from '@/services/ridersService';
import { formatARS } from '@/lib/format';
import { db } from '@/lib/supabase';

const REFRESH_MS = 15_000;

// Tucumán plaza como fallback si no hay coords del local
const FALLBACK_CENTER: [number, number] = [-34.6037, -58.3816];

export function DispatchMap() {
  const { user } = useAuth();
  const [localActivo] = useLocalActivo(user);
  const [pedidos, setPedidos] = useState<PedidoDeliveryMapa[]>([]);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [localCenter, setLocalCenter] = useState<[number, number]>(FALLBACK_CENTER);
  const [selectedPedidoId, setSelectedPedidoId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filterEstado, setFilterEstado] = useState<'todos' | 'enviada' | 'lista'>('todos');

  const loadLocalCenter = useCallback(async () => {
    if (!localActivo) return;
    // eslint-disable-next-line pase-local/require-apply-local-scope -- RLS local + por id
    const { data } = await db
      .from('comanda_local_settings')
      .select('lat, lon')
      .eq('local_id', localActivo)
      .maybeSingle();
    const row = data as { lat: number | null; lon: number | null } | null;
    if (row?.lat && row?.lon) setLocalCenter([Number(row.lat), Number(row.lon)]);
  }, [localActivo]);

  const reload = useCallback(async () => {
    setRefreshing(true);
    const [pedRes, rRes] = await Promise.all([
      listPedidosDeliveryMapa(localActivo ?? undefined),
      listRidersStatus(localActivo ?? undefined),
    ]);
    if (pedRes.error) toast.error(`Pedidos: ${pedRes.error}`);
    else setPedidos(pedRes.data);
    if (rRes.error) toast.error(`Riders: ${rRes.error}`);
    else setRiders(rRes.data);
    setRefreshing(false);
    setLoading(false);
  }, [localActivo]);

  useEffect(() => {
    void loadLocalCenter();
    void reload();
    const t = setInterval(() => { void reload(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [loadLocalCenter, reload]);

  const pedidosFiltrados = useMemo(() => {
    if (filterEstado === 'todos') return pedidos;
    return pedidos.filter((p) => p.estado === filterEstado);
  }, [pedidos, filterEstado]);

  const selectedPedido = selectedPedidoId
    ? pedidos.find((p) => p.venta_id === selectedPedidoId) ?? null
    : null;

  const ridersOnline = riders.filter((r) => r.status === 'en_linea');
  const ridersDisponibles = ridersOnline.filter((r) => r.current_venta_id == null);

  // ── Asignar rider al pedido seleccionado
  async function handleAsignar(riderId: number) {
    if (!selectedPedido) return;
    const { error } = await asignarPedidoRider(selectedPedido.venta_id, riderId);
    if (error) toast.error(error);
    else {
      toast.success(`Pedido #${selectedPedido.numero_local} asignado`);
      void reload();
    }
  }

  async function handleDesasignar(ventaId: number) {
    const { error } = await desasignarRider(ventaId);
    if (error) toast.error(error);
    else {
      toast.success('Rider desasignado');
      void reload();
    }
  }

  // ── WhatsApp click-to-chat
  function whatsappLink(telefono: string | null | undefined, mensaje: string): string | null {
    if (!telefono) return null;
    // Limpiar tel: dejar solo dígitos, prefix 54 si no tiene
    const clean = telefono.replace(/[^\d]/g, '');
    const withCountry = clean.startsWith('54') ? clean : `54${clean}`;
    return `https://wa.me/${withCountry}?text=${encodeURIComponent(mensaje)}`;
  }

  if (loading) {
    return <div className="p-12 text-center text-foreground/60">Cargando despacho…</div>;
  }

  return (
    <div className="h-[calc(100vh-60px)] flex flex-col bg-gray-50">
      {/* Header */}
      <div className="px-4 py-3 bg-white border-b flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Bike className="h-5 w-5" />
            Despacho de delivery
          </h1>
          <p className="text-xs text-foreground/60">
            {pedidosFiltrados.length} pedido(s) · {ridersOnline.length} moto(s) en línea ·
            actualiza c/15s
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1 text-xs bg-gray-100 rounded-md p-0.5">
            {(['todos', 'enviada', 'lista'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilterEstado(s)}
                className={`px-3 py-1 rounded ${filterEstado === s ? 'bg-white shadow-sm font-medium' : 'text-foreground/60'}`}
              >
                {s === 'todos' ? 'Todos' : s === 'enviada' ? 'En preparación' : 'Listos'}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => reload()} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* Main: mapa + sidebars */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar izquierda: lista pedidos */}
        <div className="w-80 bg-white border-r overflow-y-auto">
          <div className="p-3 border-b">
            <div className="text-xs uppercase tracking-wide font-medium text-foreground/60">
              Pedidos a entregar ({pedidosFiltrados.length})
            </div>
          </div>
          {pedidosFiltrados.length === 0 ? (
            <div className="p-6 text-center text-sm text-foreground/50">
              No hay pedidos en este filtro.
            </div>
          ) : (
            <div className="divide-y">
              {pedidosFiltrados.map((p) => (
                <PedidoRow
                  key={p.venta_id}
                  pedido={p}
                  selected={selectedPedidoId === p.venta_id}
                  onClick={() => setSelectedPedidoId(p.venta_id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Mapa central */}
        <div className="flex-1 relative">
          <DeliveryMap
            center={localCenter}
            zoom={14}
            pedidos={pedidosFiltrados}
            riders={ridersOnline}
            selectedPedidoId={selectedPedidoId}
            onPedidoClick={(id) => setSelectedPedidoId(id)}
            height="100%"
          />
        </div>

        {/* Sidebar derecha: detalle pedido o riders */}
        <div className="w-96 bg-white border-l overflow-y-auto">
          {selectedPedido ? (
            <DetallePedidoSidebar
              pedido={selectedPedido}
              ridersDisponibles={ridersDisponibles}
              onAsignar={handleAsignar}
              onDesasignar={() => handleDesasignar(selectedPedido.venta_id)}
              onClose={() => setSelectedPedidoId(null)}
              whatsappLink={whatsappLink}
            />
          ) : (
            <RidersSidebar riders={riders} />
          )}
        </div>
      </div>

      {/* Banner: sin riders configurados */}
      {riders.length === 0 && (
        <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 text-xs text-amber-900 flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          No tenés repartidores cargados. Andá a{' '}
          <Link to="/hardware/riders" className="underline font-medium">
            Hardware → Repartidores
          </Link>{' '}
          para sumar uno.
        </div>
      )}
    </div>
  );
}

// ─── PedidoRow ──────────────────────────────────────────────────────

function PedidoRow({ pedido: p, selected, onClick }: {
  pedido: PedidoDeliveryMapa;
  selected: boolean;
  onClick: () => void;
}) {
  const min = p.minutos_desde_enviada;
  const color = min == null ? 'gray' : min < 20 ? 'green' : min < 40 ? 'amber' : 'red';
  const colorClass = {
    gray: 'bg-gray-100 text-gray-700',
    green: 'bg-green-100 text-green-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-800',
  }[color];

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 hover:bg-gray-50 ${selected ? 'bg-sky-50 border-l-4 border-sky-500 pl-2' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">#{p.numero_local}</span>
            <span className={`text-xs px-1.5 py-0.5 rounded ${colorClass} font-medium`}>
              {min != null ? `${Math.floor(min)}min` : '—'}
            </span>
            {p.estado === 'lista' && <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 font-medium">listo</span>}
          </div>
          <p className="text-sm mt-0.5 truncate">{p.cliente_nombre ?? '(sin nombre)'}</p>
          <p className="text-xs text-foreground/60 truncate mt-0.5">{p.cliente_direccion ?? '(sin dirección)'}</p>
          {p.rider_nombre && (
            <div className="flex items-center gap-1 text-xs text-sky-700 mt-1">
              <Bike className="h-3 w-3" />
              {p.rider_nombre}
            </div>
          )}
        </div>
        <div className="text-xs font-medium text-foreground/70 whitespace-nowrap">{formatARS(p.total)}</div>
      </div>
    </button>
  );
}

// ─── DetallePedidoSidebar ─────────────────────────────────────────────

function DetallePedidoSidebar({
  pedido: p, ridersDisponibles, onAsignar, onDesasignar, onClose, whatsappLink,
}: {
  pedido: PedidoDeliveryMapa;
  ridersDisponibles: Rider[];
  onAsignar: (riderId: number) => void;
  onDesasignar: () => void;
  onClose: () => void;
  whatsappLink: (tel: string | null | undefined, mensaje: string) => string | null;
}) {
  const wpUrl = whatsappLink(
    p.cliente_telefono,
    `Hola ${p.cliente_nombre ?? ''}, te escribimos por tu pedido #${p.numero_local}. `,
  );

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-foreground/60">Detalle pedido</div>
          <h2 className="text-xl font-semibold">#{p.numero_local}</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <Card>
        <CardContent className="p-3 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-foreground/60 text-xs w-16">Cliente:</span>
            <span className="font-medium">{p.cliente_nombre ?? '—'}</span>
          </div>
          {p.cliente_telefono && (
            <div className="flex items-center gap-2">
              <span className="text-foreground/60 text-xs w-16">Tel:</span>
              <span className="font-medium">{p.cliente_telefono}</span>
              {wpUrl && (
                <a href={wpUrl} target="_blank" rel="noopener" className="ml-auto">
                  <Button variant="outline" size="sm" className="h-7 text-xs">
                    <MessageCircle className="h-3 w-3 mr-1" />
                    WhatsApp
                  </Button>
                </a>
              )}
            </div>
          )}
          <div className="flex items-start gap-2">
            <span className="text-foreground/60 text-xs w-16 pt-0.5">Dirección:</span>
            <span className="flex-1">{p.cliente_direccion ?? '—'}</span>
          </div>
          {p.notas && (
            <div className="flex items-start gap-2 pt-2 border-t">
              <span className="text-foreground/60 text-xs w-16">Notas:</span>
              <span className="text-xs flex-1">{p.notas}</span>
            </div>
          )}
          <div className="flex items-center gap-2 pt-2 border-t">
            <Clock className="h-3.5 w-3.5 text-foreground/60" />
            <span className="text-xs text-foreground/70">
              {p.minutos_desde_enviada != null ? `Hace ${Math.floor(p.minutos_desde_enviada)}min` : 'sin marcar'}
            </span>
            <span className="ml-auto font-semibold">{formatARS(p.total)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Rider asignado o asignar */}
      <div>
        <div className="text-xs uppercase tracking-wide text-foreground/60 mb-2 flex items-center gap-1.5">
          <Bike className="h-3.5 w-3.5" />
          Moto asignada
        </div>
        {p.rider_nombre ? (
          <Card>
            <CardContent className="p-3 flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">{p.rider_nombre}</p>
                {p.rider_last_seen_at && (
                  <p className="text-xs text-foreground/60">
                    Última posición: {new Date(p.rider_last_seen_at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={onDesasignar} className="text-red-700">
                Desasignar
              </Button>
            </CardContent>
          </Card>
        ) : ridersDisponibles.length === 0 ? (
          <Card>
            <CardContent className="p-3 text-xs text-foreground/60">
              No hay motos disponibles en este momento.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-1.5">
            {ridersDisponibles.map((r) => (
              <button
                key={r.id}
                onClick={() => onAsignar(r.id)}
                className="w-full text-left p-2.5 border border-gray-200 rounded-md hover:border-sky-300 hover:bg-sky-50 transition-colors flex items-center gap-3"
              >
                <div className="w-8 h-8 rounded-full bg-sky-500 text-white text-sm font-semibold flex items-center justify-center">
                  {r.nombre.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{r.nombre}</p>
                  <p className="text-xs text-foreground/60">
                    🟢 disponible {r.last_battery_pct != null ? `· 🔋 ${r.last_battery_pct}%` : ''}
                  </p>
                </div>
                <UserPlus className="h-4 w-4 text-foreground/40" />
              </button>
            ))}
          </div>
        )}
      </div>

      <Link to={`/pos/pedidos/${p.venta_id}`}>
        <Button variant="outline" size="sm" className="w-full">
          Ver detalle completo en POS →
        </Button>
      </Link>
    </div>
  );
}

// ─── RidersSidebar (cuando no hay pedido seleccionado) ───────────────

function RidersSidebar({ riders }: { riders: Rider[] }) {
  const grouped = {
    en_linea: riders.filter((r) => r.status === 'en_linea'),
    reciente: riders.filter((r) => r.status === 'reciente'),
    offline: riders.filter((r) => r.status === 'offline' || r.status === 'desconectado' || r.status === 'sin_reportar'),
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-medium flex items-center gap-2">
          <Users className="h-4 w-4" />
          Repartidores
        </h2>
        <Link to="/hardware/riders" className="text-xs text-sky-700 hover:underline">
          Gestionar →
        </Link>
      </div>

      {Object.entries(grouped).map(([key, list]) => list.length > 0 && (
        <div key={key}>
          <div className="text-xs uppercase tracking-wide text-foreground/60 mb-1.5">
            {key === 'en_linea' ? '🟢 En línea' : key === 'reciente' ? '🟡 Reciente' : '⚪ Desconectados'} ({list.length})
          </div>
          <div className="space-y-1">
            {list.map((r) => (
              <div key={r.id} className="flex items-center gap-3 p-2 rounded-md hover:bg-gray-50">
                <div className={`w-8 h-8 rounded-full text-white text-sm font-semibold flex items-center justify-center ${
                  r.status === 'en_linea' ? 'bg-sky-500' : 'bg-gray-400'
                }`}>
                  {r.nombre.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{r.nombre}</p>
                  <p className="text-xs text-foreground/60">
                    {r.current_venta_id ? `Entregando #${r.pedido_numero}` : 'libre'}
                    {r.last_battery_pct != null && ` · 🔋 ${r.last_battery_pct}%`}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {riders.length === 0 && (
        <div className="text-center py-8">
          <Bike className="h-10 w-10 mx-auto text-foreground/30 mb-2" />
          <p className="text-sm text-foreground/60">Sin repartidores</p>
          <Link to="/hardware/riders" className="inline-block mt-3">
            <Button size="sm">
              <UserPlus className="h-4 w-4 mr-1.5" />
              Agregar repartidor
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}
