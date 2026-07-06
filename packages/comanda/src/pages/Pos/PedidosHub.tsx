import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Inbox, Clock, Pencil, Check, X, Plus, Bell, BellOff, BellRing, Search, ArrowDownUp } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { useNotifier } from '@/lib/useNotifier';
import { useDebouncedValue } from '@pase/shared/utils';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  listPedidosPorTab, getCountersPedidos,
  getQuoteTimes, updateQuoteTimes,
  type PedidoTab, type PedidoConItems,
} from '@/services/pedidosService';
import { listCanales } from '@/services/canalesService';
import type { Canal } from '@/types/database';
import { PedidoCard } from '@/components/PedidoCard';
import { NuevoPedidoDialog } from '@/components/dialogs/NuevoPedidoDialog';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// PedidosHub — feed Toast-style con 5 tabs + cards enriquecidas + toolbar con quote times.
// Reemplaza al antiguo PedidosPlaceholder (que era una versión inicial sin la profundidad del spec).
// Las cards navegan a `/pos/pedidos/:ventaId` (vista detallada con sidebar + cálculo + footer).

const TABS: Array<{ key: PedidoTab; label: string }> = [
  { key: 'activos',     label: 'Activos' },
  { key: 'por_aceptar', label: 'Por aceptar' },
  { key: 'programadas', label: 'Programadas' },
  { key: 'aceptadas',   label: 'Aceptadas' },
  { key: 'cerradas',    label: 'Cerradas' },
];

// Sprint optim egress 2026-05-16 (sesión 2): subido de 30s a 120s.
// Realtime cubre nuevos pedidos al instante (es la fuente). Este polling
// es solo BACKUP por si Realtime se desconecta. 120s reduce 4x el egress
// de la pantalla más usada del POS (PedidosHub queda abierta 24/7).
const POLL_MS = 120_000;

export function PedidosHub() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();
  const [tab, setTab] = useState<PedidoTab>('activos');
  const [pedidos, setPedidos] = useState<PedidoConItems[]>([]);
  const [canales, setCanales] = useState<Canal[]>([]);
  const [counters, setCounters] = useState<Record<PedidoTab, number>>({
    activos: 0, por_aceptar: 0, programadas: 0, aceptadas: 0, cerradas: 0,
  });
  const [loading, setLoading] = useState(true);
  const [nuevoPedidoOpen, setNuevoPedidoOpen] = useState(false);

  // Quote times (configurables manager+)
  const [quoteRetiro, setQuoteRetiro] = useState<number | null>(null);
  const [quoteDelivery, setQuoteDelivery] = useState<number | null>(null);
  const [editingQuote, setEditingQuote] = useState<'retiro' | 'delivery' | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // Notificador de pedidos nuevos — beep + browser notification.
  // Comparamos counter anterior vs nuevo: si subió necesita_aprobacion,
  // alguien externo nos mandó un pedido nuevo.
  const { notify, muted, setMuted, permState, askPermission } = useNotifier();
  const prevAprobacionCountRef = useRef<number | null>(null);

  // Filtros / sort dentro del tab activo
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [canalFiltro, setCanalFiltro] = useState<string>('todos');
  const [sortBy, setSortBy] = useState<'recientes' | 'antiguos' | 'monto_desc' | 'monto_asc'>('recientes');

  // Reset filtros al cambiar de tab (cada tab tiene su propio estado mental)
  useEffect(() => { setSearch(''); setCanalFiltro('todos'); }, [tab]);

  // Quote times son config del local — manager+ desde sesión Supabase (NO desde rol_pos POS).
  // Roles válidos: dueño/admin/superadmin.
  const puedeEditarQuotes = !!user && ['dueno', 'admin', 'superadmin'].includes(user.rol);

  // Sprint optim egress 2026-05-16 (sesión 2): separar reload pesado del liviano.
  // - reloadFull: 4 queries (pedidos + canales + counters + quote times) —
  //   solo al MOUNT y al CAMBIAR DE TAB. canales y quoteTimes rara vez
  //   cambian, no vale traerlas cada poll.
  // - reloadLight: 2 queries (pedidos + counters) — disparado por polling
  //   y Realtime. Reduce ~50% queries × cada poll.

  const reloadFull = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const [pRes, cRes, ctsRes, qtRes] = await Promise.all([
      listPedidosPorTab(localId, tab),
      listCanales(user?.tenant_id ?? null, true),
      getCountersPedidos(localId),
      getQuoteTimes(localId),
    ]);
    setPedidos(pRes.data);
    setCanales(cRes.data);

    const aprobacionPrev = prevAprobacionCountRef.current;
    const aprobacionNuevo = ctsRes.por_aceptar;
    if (aprobacionPrev !== null && aprobacionNuevo > aprobacionPrev) {
      const delta = aprobacionNuevo - aprobacionPrev;
      notify(
        `🛵 ${delta} pedido${delta > 1 ? 's' : ''} nuevo${delta > 1 ? 's' : ''} por aceptar`,
        'Tocá para revisar y aceptar.',
      );
    }
    prevAprobacionCountRef.current = aprobacionNuevo;

    setCounters(ctsRes);
    if (qtRes) {
      setQuoteRetiro(qtRes.retiro);
      setQuoteDelivery(qtRes.delivery);
    }
    setLoading(false);
  }, [localId, tab, user?.tenant_id, notify]);

  // Liviano: solo lo que cambia. NO trae canales ni quote times.
  const reloadLight = useCallback(async () => {
    if (localId === null) return;
    const [pRes, ctsRes] = await Promise.all([
      listPedidosPorTab(localId, tab),
      getCountersPedidos(localId),
    ]);
    setPedidos(pRes.data);

    const aprobacionPrev = prevAprobacionCountRef.current;
    const aprobacionNuevo = ctsRes.por_aceptar;
    if (aprobacionPrev !== null && aprobacionNuevo > aprobacionPrev) {
      const delta = aprobacionNuevo - aprobacionPrev;
      notify(
        `🛵 ${delta} pedido${delta > 1 ? 's' : ''} nuevo${delta > 1 ? 's' : ''} por aceptar`,
        'Tocá para revisar y aceptar.',
      );
    }
    prevAprobacionCountRef.current = aprobacionNuevo;
    setCounters(ctsRes);
  }, [localId, tab, notify]);

  useEffect(() => { reloadFull(); }, [reloadFull]);

  // Realtime: pedidos nuevos disparan reloadLight (no full)
  useRealtimeTable({ table: 'ventas_pos', onChange: () => reloadLight(), scopeByLocal: true, extraFilter: 'modo=eq.pedidos' });

  // Polling backup cada 120s
  useEffect(() => {
    const id = setInterval(reloadLight, POLL_MS);
    return () => clearInterval(id);
  }, [reloadLight]);

  useEffect(() => {
    if (editingQuote && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingQuote]);

  // Derived: pedidos filtrados + ordenados según search/canal/sort
  const pedidosFiltrados = useMemo(() => {
    let list = pedidos;
    const q = debouncedSearch.trim().toLowerCase();
    if (q) {
      list = list.filter((p) => {
        const haystack = [
          String(p.numero_local ?? ''),
          p.cliente_nombre ?? '',
          p.cliente_telefono ?? '',
          p.cliente_direccion ?? '',
        ].join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }
    if (canalFiltro !== 'todos') {
      list = list.filter((p) => String(p.canal_id ?? '') === canalFiltro);
    }
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case 'recientes':
          return new Date(b.abierta_at).getTime() - new Date(a.abierta_at).getTime();
        case 'antiguos':
          return new Date(a.abierta_at).getTime() - new Date(b.abierta_at).getTime();
        case 'monto_desc':
          return Number(b.total) - Number(a.total);
        case 'monto_asc':
          return Number(a.total) - Number(b.total);
        default: return 0;
      }
    });
    return sorted;
  }, [pedidos, debouncedSearch, canalFiltro, sortBy]);

  async function guardarQuote(tipo: 'retiro' | 'delivery', nuevo: number) {
    if (localId === null) return;
    if (!Number.isFinite(nuevo) || nuevo < 1 || nuevo > 300) {
      toast.error('Tiempo inválido (1-300 min)');
      return;
    }
    const retiro = tipo === 'retiro' ? nuevo : (quoteRetiro ?? 15);
    const delivery = tipo === 'delivery' ? nuevo : (quoteDelivery ?? 35);
    const r = await updateQuoteTimes(localId, retiro, delivery);
    if (r.error) {
      toast.error(r.error);
      return;
    }
    setQuoteRetiro(retiro);
    setQuoteDelivery(delivery);
    setEditingQuote(null);
    toast.success('Tiempo actualizado');
  }

  return (
    <div className="container py-4">
      <NuevoPedidoDialog
        open={nuevoPedidoOpen}
        onOpenChange={setNuevoPedidoOpen}
        onCreated={(ventaId) => navigate(`/pos/venta/${ventaId}`)}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as PedidoTab)}>
        {/* Barra única: título + tabs + acciones en una sola línea */}
        <div className="flex items-center gap-1 border-b border-border pb-0 mb-4 overflow-x-auto">
          <span className="text-sm font-semibold shrink-0 mr-3 text-foreground">Pedidos</span>

          <TabsList className="bg-transparent h-auto p-0 flex gap-0 shrink-0">
            {TABS.map((t) => {
              const c = counters[t.key];
              return (
                <TabsTrigger
                  key={t.key}
                  value={t.key}
                  className="data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none rounded-none border-b-2 border-transparent px-3 py-2.5 text-sm gap-1.5"
                >
                  {t.label}
                  {c > 0 && (
                    <span className={cn(
                      'inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-semibold relative',
                      t.key === 'por_aceptar' ? 'bg-warning text-warning-foreground' : 'bg-muted text-muted-foreground',
                    )}>
                      {c}
                      {t.key === 'por_aceptar' && (
                        <span className="absolute inset-0 rounded-full bg-warning/40 animate-ping pointer-events-none" />
                      )}
                    </span>
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {/* Acciones — al extremo derecho */}
          <div className="ml-auto flex items-center gap-1.5 shrink-0 pb-1">
            <NotifierToggle
              muted={muted}
              setMuted={setMuted}
              permState={permState}
              askPermission={askPermission}
            />
            <QuoteTimeWidget
              label="Retiro"
              valor={quoteRetiro}
              editing={editingQuote === 'retiro'}
              puedeEditar={puedeEditarQuotes}
              onEdit={() => setEditingQuote('retiro')}
              onCancel={() => setEditingQuote(null)}
              onSave={(v) => guardarQuote('retiro', v)}
              inputRef={editingQuote === 'retiro' ? editInputRef : undefined}
            />
            <QuoteTimeWidget
              label="Envío"
              valor={quoteDelivery}
              editing={editingQuote === 'delivery'}
              puedeEditar={puedeEditarQuotes}
              onEdit={() => setEditingQuote('delivery')}
              onCancel={() => setEditingQuote(null)}
              onSave={(v) => guardarQuote('delivery', v)}
              inputRef={editingQuote === 'delivery' ? editInputRef : undefined}
            />
            <Button onClick={() => setNuevoPedidoOpen(true)} size="sm" className="gap-1.5 h-8">
              <Plus className="h-3.5 w-3.5" />
              Nuevo
            </Button>
          </div>
        </div>

        {TABS.map((t) => (
          <TabsContent key={t.key} value={t.key} className="mt-0">
            {/* Barra filtros/sort — solo aparece si hay >3 pedidos para no saturar */}
            {!loading && pedidos.length > 3 && (
              <div className="mb-3 flex items-center gap-2 flex-wrap">
                <div className="relative flex-1 min-w-[200px] max-w-xs">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar #, nombre, teléfono, dirección…"
                    className="pl-9 h-9"
                  />
                </div>
                <Select value={canalFiltro} onValueChange={setCanalFiltro}>
                  <SelectTrigger className="h-9 w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="todos">Todos los canales</SelectItem>
                    {canales.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.emoji ?? ''} {c.nombre}
                      </SelectItem>
                    ))}
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
                  {pedidosFiltrados.length === pedidos.length
                    ? `${pedidos.length} pedidos`
                    : `${pedidosFiltrados.length} de ${pedidos.length}`}
                </div>
              </div>
            )}

            {loading ? (
              <div className="py-8 text-center text-muted-foreground">Cargando…</div>
            ) : pedidos.length === 0 ? (
              <EmptyState tab={t.key} />
            ) : pedidosFiltrados.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No hay pedidos que matcheen los filtros.
                <button
                  type="button"
                  onClick={() => { setSearch(''); setCanalFiltro('todos'); }}
                  className="ml-2 text-primary hover:underline"
                >
                  Limpiar filtros
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2.5">
                {pedidosFiltrados.map((p) => (
                  <PedidoCard
                    key={p.id}
                    pedido={p}
                    canales={canales}
                    variant={p.estado === 'lista' ? 'listo' : 'default'}
                    onClick={() => navigate(`/pos/pedidos/${p.id}`)}
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

// ─── Widget Quote Time ───────────────────────────────────────────────────────
interface QuoteTimeWidgetProps {
  label: string;
  valor: number | null;
  editing: boolean;
  puedeEditar: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (nuevo: number) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

function QuoteTimeWidget({
  label, valor, editing, puedeEditar, onEdit, onCancel, onSave, inputRef,
}: QuoteTimeWidgetProps) {
  const [draft, setDraft] = useState<string>(String(valor ?? ''));

  useEffect(() => {
    if (editing) setDraft(String(valor ?? ''));
  }, [editing, valor]);

  if (editing) {
    return (
      <div className="flex items-center gap-1 bg-muted/60 rounded-md pl-2 pr-1 py-1">
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{label}:</span>
        <Input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="number"
          min={1}
          max={300}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const n = parseInt(draft, 10);
              if (Number.isFinite(n)) onSave(n);
            } else if (e.key === 'Escape') {
              onCancel();
            }
          }}
          className="h-7 w-16 text-sm"
        />
        <span className="text-xs text-muted-foreground mr-1">min</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => {
            const n = parseInt(draft, 10);
            if (Number.isFinite(n)) onSave(n);
          }}
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onCancel}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={puedeEditar ? onEdit : undefined}
      disabled={!puedeEditar}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs',
        'bg-muted/40 border border-border/60',
        puedeEditar ? 'cursor-pointer hover:bg-muted hover:border-border' : 'cursor-default',
      )}
      title={puedeEditar ? `Editar tiempo de ${label.toLowerCase()}` : `Tiempo de ${label.toLowerCase()}`}
    >
      <Clock className="h-3 w-3 text-muted-foreground" />
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium tabular-nums">~{valor ?? '—'} min</span>
      {puedeEditar && <Pencil className="h-3 w-3 text-muted-foreground opacity-60" />}
    </button>
  );
}

// ─── Notifier Toggle ─────────────────────────────────────────────────────────
function NotifierToggle({ muted, setMuted, permState, askPermission }: {
  muted: boolean;
  setMuted: (m: boolean) => void;
  permState: 'default' | 'granted' | 'denied' | 'unsupported';
  askPermission: () => Promise<'default' | 'granted' | 'denied' | 'unsupported'>;
}) {
  const Icon = muted ? BellOff : permState === 'granted' ? BellRing : Bell;
  const label = muted
    ? 'Alertas en silencio'
    : permState === 'granted'
      ? 'Alertas activas (ping + notificación)'
      : permState === 'denied'
        ? 'Alertas (solo ping, notif bloqueada)'
        : 'Alertas (solo ping)';
  return (
    <button
      type="button"
      onClick={async () => {
        if (muted) {
          setMuted(false);
          // Si nunca pidió permiso, aprovechamos para pedirlo en el click.
          if (permState === 'default') await askPermission();
        } else {
          setMuted(true);
        }
      }}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs',
        'border transition-colors',
        muted
          ? 'bg-muted/40 border-border/60 text-muted-foreground hover:bg-muted'
          : 'bg-success/10 border-success/30 text-success hover:bg-success/20',
      )}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{muted ? 'Mute' : 'Alertas'}</span>
      {!muted && permState === 'default' && (
        <span className="text-xs opacity-70">(activar)</span>
      )}
    </button>
  );
}

// ─── Empty States ────────────────────────────────────────────────────────────
function EmptyState({ tab }: { tab: PedidoTab }) {
  const messages: Record<PedidoTab, { titulo: string; subtitulo: string }> = {
    activos:     { titulo: 'Sin pedidos activos', subtitulo: 'Cuando entre un pedido nuevo aparece acá.' },
    por_aceptar: { titulo: 'Todo al día', subtitulo: 'No hay pedidos esperando aceptación.' },
    programadas: { titulo: 'Sin programados', subtitulo: 'No hay pedidos programados para más tarde.' },
    aceptadas:   { titulo: 'Cocina libre', subtitulo: 'No hay pedidos activos.' },
    cerradas:    { titulo: 'Sin cerrados', subtitulo: 'Los pedidos entregados, cobrados y anulados van apareciendo acá.' },
  };
  const m = messages[tab];
  return (
    <Card>
      <CardContent className="py-20 text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted mb-4">
          <Inbox className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-medium mb-1">{m.titulo}</h3>
        <p className="text-xs text-muted-foreground max-w-sm mx-auto">{m.subtitulo}</p>
      </CardContent>
    </Card>
  );
}
