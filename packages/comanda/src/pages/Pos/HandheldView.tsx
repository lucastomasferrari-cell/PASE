import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Send, Search } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useAuthPos } from '@/lib/authPos';
import { useLocalActivo } from '@/lib/localActivo';
import { listMesasConVentas, type MesaConVenta } from '@/services/mesasService';
import { abrirVenta, listVentasItems, agregarItem, mandarCurso } from '@/services/ventasService';
import { listCanales } from '@/services/canalesService';
import { listItems, type ItemConGrupo } from '@/services/itemsService';
import { listGrupos } from '@/services/gruposService';
import type { VentaPosItem, ItemGrupo } from '@/types/database';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/Badge';
import { FullscreenToggle } from '@/components/FullscreenToggle';
import { OfflineBanner } from '@/components/OfflineBanner';
import { formatARS, relativoCorto } from '@/lib/format';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { useOnlineStatus } from '@/lib/useOnlineStatus';
import { cn } from '@/lib/utils';

// Handheld view — vista mobile-first para mozo tomando pedido en la mesa
// con un celular o tablet chica. Sin sidebars, full-screen, controles
// grandes (touch-target 44px+), flujo de 2 pantallas:
//   1) Grid de mesas → tap para elegir
//   2) Carga rápida: catálogo arriba, carrito abajo, botón "Mandar a cocina" fijo
//
// Reutiliza las mismas RPCs que VentaScreen (no rebuild de lógica).
// El flujo es "tomar pedido y mandar" — el cobro se hace después desde el
// POS principal o desde caja. Por eso no incluye PaymentDialog.

type Pantalla = { tipo: 'mesas' } | { tipo: 'venta'; ventaId: number; mesa: MesaConVenta };

export function HandheldView() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();

  const [pantalla, setPantalla] = useState<Pantalla>({ tipo: 'mesas' });

  if (!empleado) {
    return <div className="p-8 text-center text-muted-foreground">Sesión POS requerida.</div>;
  }
  if (localId === null) {
    return <div className="p-8 text-center text-muted-foreground">Seleccioná un local.</div>;
  }

  return (
    <div className="min-h-screen bg-background">
      <OfflineBanner />
      {pantalla.tipo === 'mesas' ? (
        <PantallaMesas
          localId={localId}
          onMesaElegida={(ventaId, mesa) => setPantalla({ tipo: 'venta', ventaId, mesa })}
          onSalir={() => navigate('/pos')}
          empleadoId={empleado.id}
          tenantId={user?.tenant_id ?? ''}
        />
      ) : (
        <PantallaVenta
          ventaId={pantalla.ventaId}
          mesa={pantalla.mesa}
          empleadoId={empleado.id}
          tenantId={user?.tenant_id ?? ''}
          onVolver={() => setPantalla({ tipo: 'mesas' })}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Pantalla 1: grid de mesas
// ────────────────────────────────────────────────────────────────────────

function PantallaMesas({ localId, onMesaElegida, onSalir, empleadoId, tenantId }: {
  localId: number;
  empleadoId: string;
  tenantId: string;
  onSalir: () => void;
  onMesaElegida: (ventaId: number, mesa: MesaConVenta) => void;
}) {
  const [mesas, setMesas] = useState<MesaConVenta[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await listMesasConVentas(localId);
    setMesas(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);
  useRealtimeTable({ table: 'mesas', onChange: () => reload(), scopeByLocal: true });
  useRealtimeTable({ table: 'ventas_pos', onChange: () => reload(), scopeByLocal: true, extraFilter: 'modo=eq.salon' });

  async function abrirOSeleccionar(mesa: MesaConVenta) {
    if (mesa.venta_abierta_id) {
      onMesaElegida(mesa.venta_abierta_id, mesa);
      return;
    }
    // Mesa libre — abrimos venta nueva con covers default
    const { data: canales } = await listCanales(tenantId || null, true);
    const canal = canales.find((c) => c.slug === 'salon');
    if (!canal) {
      toast.error('No hay canal "salon" configurado');
      return;
    }
    const { ventaId, error } = await abrirVenta({
      localId,
      modo: 'salon',
      canalId: canal.id,
      mesaId: mesa.id,
      mozoId: empleadoId,
      cajeroId: empleadoId,
      covers: mesa.capacidad ?? 2,
    });
    if (error || !ventaId) {
      toast.error(error ?? 'No se pudo abrir mesa');
      return;
    }
    onMesaElegida(ventaId, mesa);
  }

  return (
    <div className="flex flex-col h-[100dvh]">
      <header className="sticky top-0 z-10 bg-card border-b border-border h-12 flex items-center px-3 gap-2">
        <Button variant="ghost" size="icon" onClick={onSalir} aria-label="Salir">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <h1 className="text-base font-semibold">Modo mozo · elegí mesa</h1>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{mesas.length} mesas</span>
          <FullscreenToggle className="h-8 w-8" />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="py-12 text-center text-muted-foreground">Cargando…</div>
        ) : (
          // Grid responsive: mesas con tamaño fijo (auto-fill) en lugar
          // de 3 columnas absolutas. En celu (360-420px) caben 3-4 por fila,
          // en tablet 6-8, en desktop 10+. Cada mesa ~96-108px.
          <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
            {mesas.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => abrirOSeleccionar(m)}
                className={cn(
                  'aspect-square rounded-xl border flex flex-col items-center justify-center p-2 transition-all active:scale-95',
                  m.estado === 'libre'
                    ? 'border-success/30 bg-success/5 text-success'
                    : m.venta_abierta_id
                      ? 'border-warning/40 bg-warning/10 text-warning-foreground'
                      : 'border-border bg-muted',
                )}
              >
                <div className="text-xl font-bold leading-none">{m.numero}</div>
                {m.zona && <div className="text-[9px] opacity-70 truncate mt-0.5">{m.zona}</div>}
                {m.venta_abierta_id && (
                  <>
                    <div className="text-[11px] font-semibold tabular-nums mt-1 leading-none">
                      {formatARS(m.venta_total)}
                    </div>
                    <div className="text-[9px] opacity-70 mt-0.5">
                      {relativoCorto(m.venta_abierta_at ?? '')}
                    </div>
                  </>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Pantalla 2: catálogo + carga rápida + mandar a cocina
// ────────────────────────────────────────────────────────────────────────

function PantallaVenta({ ventaId, mesa, empleadoId, tenantId, onVolver }: {
  ventaId: number;
  mesa: MesaConVenta;
  empleadoId: string;
  tenantId: string;
  onVolver: () => void;
}) {
  const [catalogo, setCatalogo] = useState<ItemConGrupo[]>([]);
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [items, setItems] = useState<VentaPosItem[]>([]);
  const [grupoSel, setGrupoSel] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [lastAddedItemId, setLastAddedItemId] = useState<number | null>(null);
  const online = useOnlineStatus();

  const reload = useCallback(async () => {
    setLoading(true);
    const [cRes, gRes, iRes] = await Promise.all([
      listItems({ tenantId }),
      listGrupos(tenantId),
      listVentasItems(ventaId),
    ]);
    setCatalogo(cRes.data);
    setGrupos(gRes.data);
    setItems(iRes.data);
    setLoading(false);
  }, [tenantId, ventaId]);

  useEffect(() => { reload(); }, [reload]);
  useRealtimeTable({
    table: 'ventas_pos_items',
    onChange: () => reload(),
    extraFilter: `venta_id=eq.${ventaId}`,
  });

  useEffect(() => {
    if (lastAddedItemId == null) return;
    const t = setTimeout(() => setLastAddedItemId(null), 800);
    return () => clearTimeout(t);
  }, [lastAddedItemId]);

  const catalogoFiltrado = useMemo(() => {
    return catalogo.filter((it) => {
      if (it.estado !== 'disponible') return false;
      if (!it.visible_pos) return false;
      if (grupoSel !== null && it.grupo_id !== grupoSel) return false;
      if (search.trim() && !it.nombre.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [catalogo, grupoSel, search]);

  const itemsHold = items.filter((i) => i.estado === 'hold');
  const totalHold = itemsHold.reduce((s, i) => s + Number(i.subtotal), 0);
  const totalGeneral = items
    .filter((i) => i.estado !== 'anulado')
    .reduce((s, i) => s + Number(i.subtotal), 0);

  async function addItem(it: ItemConGrupo) {
    if (!online) {
      toast.error('Sin conexión — no se puede agregar items hasta que vuelva internet');
      return;
    }
    const { error } = await agregarItem({
      ventaId,
      itemId: it.id,
      cantidad: 1,
      curso: 1,
      cargadoPor: empleadoId,
    });
    if (error) { toast.error(error); return; }
    setLastAddedItemId(it.id);
    reload();
  }

  async function handleMandar() {
    if (!online) {
      toast.error('Sin conexión — no se puede mandar a cocina hasta que vuelva internet');
      return;
    }
    if (itemsHold.length === 0) {
      toast.error('Nada para mandar');
      return;
    }
    setSending(true);
    const { error } = await mandarCurso(ventaId, 1);
    setSending(false);
    if (error) { toast.error(error); return; }
    toast.success(`${itemsHold.length} ${itemsHold.length === 1 ? 'item enviado' : 'items enviados'} a cocina`);
    reload();
  }

  return (
    <div className="flex flex-col h-[100dvh]">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-card border-b border-border h-12 flex items-center px-2 gap-2">
        <Button variant="ghost" size="icon" onClick={onVolver} aria-label="Volver">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold truncate">Mesa {mesa.numero}{mesa.zona ? ` · ${mesa.zona}` : ''}</div>
          <div className="text-[10px] text-muted-foreground tabular-nums">
            Total {formatARS(totalGeneral)} · {itemsHold.length} en hold
          </div>
        </div>
      </header>

      {/* Búsqueda + tabs grupo */}
      <div className="px-2 py-2 bg-card border-b border-border space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar…"
            className="pl-9 h-10"
          />
        </div>
        <div className="flex gap-1 overflow-x-auto -mx-1 px-1">
          <button
            type="button"
            onClick={() => setGrupoSel(null)}
            className={cn(
              'px-3 h-8 rounded-md text-xs font-medium shrink-0',
              grupoSel === null ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
            )}
          >
            Todos
          </button>
          {grupos.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => setGrupoSel(g.id)}
              className={cn(
                'px-3 h-8 rounded-md text-xs font-medium shrink-0',
                grupoSel === g.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
              )}
            >
              {g.emoji ?? ''} {g.nombre}
            </button>
          ))}
        </div>
      </div>

      {/* Catálogo — auto-fill responsivo, tiles ~104-120px en lugar de
          fijos de 500px en tablet/desktop. */}
      <div className="flex-1 overflow-y-auto p-2 pb-32">
        {loading ? (
          <div className="py-12 text-center text-muted-foreground">Cargando…</div>
        ) : catalogoFiltrado.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Sin productos.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
            {catalogoFiltrado.map((it) => {
              const cantEnHold = itemsHold.filter((i) => i.item_id === it.id).reduce((s, i) => s + Number(i.cantidad), 0);
              const flashed = lastAddedItemId === it.id;
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => addItem(it)}
                  className={cn(
                    'relative aspect-square rounded-xl border flex flex-col items-center justify-center p-2 transition-all active:scale-95',
                    flashed ? 'border-success bg-success/10 scale-[1.02]' : 'border-border bg-card',
                  )}
                >
                  {cantEnHold > 0 && (
                    <div className="absolute -top-1 -right-1">
                      <Badge variant="amber">{cantEnHold}</Badge>
                    </div>
                  )}
                  <div className="text-2xl">{it.emoji ?? '🍽️'}</div>
                  <div className="text-[10px] line-clamp-2 leading-tight text-center mt-0.5">{it.nombre}</div>
                  <div className="text-[10px] font-semibold tabular-nums mt-0.5">{formatARS(it.precio_madre)}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer fijo: hold count + mandar */}
      <div className="sticky bottom-0 bg-card border-t border-border p-2 space-y-2 shadow-[0_-4px_12px_rgba(0,0,0,0.05)]">
        {itemsHold.length > 0 ? (
          <>
            <div className="flex items-center justify-between text-sm">
              <div>
                <strong>{itemsHold.length}</strong> en hold
              </div>
              <strong className="tabular-nums text-base">{formatARS(totalHold)}</strong>
            </div>
            {/* Lista compacta items hold con +/- */}
            <div className="max-h-32 overflow-y-auto space-y-1 -mx-1 px-1">
              {itemsHold.map((it) => {
                const nombre = catalogo.find((c) => c.id === it.item_id)?.nombre ?? `Item #${it.item_id}`;
                return (
                  <div key={it.id} className="flex items-center gap-2 text-xs px-2 py-1.5 bg-muted/40 rounded">
                    <div className="flex-1 truncate">
                      <span className="font-medium">{it.cantidad}×</span> {nombre}
                    </div>
                    <strong className="tabular-nums">{formatARS(it.subtotal)}</strong>
                  </div>
                );
              })}
            </div>
            <Button
              variant="success"
              size="lg"
              className="w-full h-12 text-base font-semibold"
              onClick={handleMandar}
              disabled={sending || !online}
              title={!online ? 'Sin conexión — esperá a que vuelva internet' : undefined}
            >
              <Send className="h-4 w-4 mr-2" />
              {!online ? 'Sin conexión' : sending ? 'Enviando…' : `Mandar a cocina (${itemsHold.length})`}
            </Button>
          </>
        ) : (
          <div className="py-3 text-center text-xs text-muted-foreground">
            Tocá productos del catálogo para agregar.
          </div>
        )}
      </div>
    </div>
  );
}

// Stepper helper eliminado — agregar de nuevo si se necesita (touch grande
// por defecto, no requiere +/-).
