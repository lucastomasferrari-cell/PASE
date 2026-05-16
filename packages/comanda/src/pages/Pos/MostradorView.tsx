import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Coffee, Search, ArrowDownUp } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ComandasActivasPanel } from '@/components/ComandasActivasPanel';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

export function MostradorView() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [ventas, setVentas] = useState<VentaPos[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creando, setCreando] = useState(false);

  // Filtros / sort
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [estadoFiltro, setEstadoFiltro] = useState<string>('todos');
  const [sortBy, setSortBy] = useState<'recientes' | 'antiguos' | 'monto_desc' | 'monto_asc'>('recientes');

  const ventasFiltradas = useMemo(() => {
    let list = ventas;
    const q = debouncedSearch.trim().toLowerCase();
    if (q) {
      list = list.filter((v) => {
        const haystack = [
          String(v.numero_local ?? ''),
          v.cliente_nombre ?? '',
          v.cliente_telefono ?? '',
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }
    if (estadoFiltro !== 'todos') {
      list = list.filter((v) => v.estado === estadoFiltro);
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case 'recientes': return new Date(b.abierta_at).getTime() - new Date(a.abierta_at).getTime();
        case 'antiguos': return new Date(a.abierta_at).getTime() - new Date(b.abierta_at).getTime();
        case 'monto_desc': return Number(b.total) - Number(a.total);
        case 'monto_asc': return Number(a.total) - Number(b.total);
        default: return 0;
      }
    });
    return sorted;
  }, [ventas, debouncedSearch, estadoFiltro, sortBy]);

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

  // F0.3 Realtime — refresca cuando otro cajero abre/cierra tabs en el mismo
  // local. Filtra modo=mostrador para no recargar ventas de Salón/Pedidos.
  useRealtimeTable({ table: 'ventas_pos', onChange: () => reload(), scopeByLocal: true, extraFilter: 'modo=eq.mostrador' });

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

  return (
    <div className="flex h-full">
      {/* Panel izq: comandas activas modo mostrador */}
      <ComandasActivasPanel
        className="w-[240px] border-r border-border flex-shrink-0 hidden lg:flex"
        modos={['mostrador']}
      />

      {/* Centro: lista de órdenes activas + CTA */}
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="p-6">
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

          {/* Filtros — aparecen si hay >3 órdenes */}
          {!loading && ventas.length > 3 && (
            <div className="mb-4 flex items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-[200px] max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar #, cliente, teléfono…"
                  className="pl-9 h-9"
                />
              </div>
              <Select value={estadoFiltro} onValueChange={setEstadoFiltro}>
                <SelectTrigger className="h-9 w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todos">Todos los estados</SelectItem>
                  <SelectItem value="abierta">Abiertas</SelectItem>
                  <SelectItem value="enviada">Enviadas</SelectItem>
                  <SelectItem value="lista">Listas</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="h-9 w-[170px]">
                  <ArrowDownUp className="h-3.5 w-3.5 mr-1" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="recientes">Más recientes</SelectItem>
                  <SelectItem value="antiguos">Más antiguos</SelectItem>
                  <SelectItem value="monto_desc">Mayor monto</SelectItem>
                  <SelectItem value="monto_asc">Menor monto</SelectItem>
                </SelectContent>
              </Select>
              <div className="ml-auto text-xs text-muted-foreground">
                {ventasFiltradas.length === ventas.length
                  ? `${ventas.length} órdenes`
                  : `${ventasFiltradas.length} de ${ventas.length}`}
              </div>
            </div>
          )}

          {loading ? (
            <div className="py-8 text-center text-muted-foreground">Cargando…</div>
          ) : ventas.length === 0 ? (
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
          ) : ventasFiltradas.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No hay órdenes que matcheen los filtros.
              <button
                type="button"
                onClick={() => { setSearch(''); setEstadoFiltro('todos'); }}
                className="ml-2 text-primary hover:underline"
              >
                Limpiar filtros
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
              {ventasFiltradas.map((v) => (
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
      </div>
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
