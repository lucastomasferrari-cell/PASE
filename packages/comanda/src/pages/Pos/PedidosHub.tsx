import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Inbox, Clock, Pencil, Check, X, Plus, Bell, BellOff, BellRing } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { useNotifier } from '@/lib/useNotifier';
import {
  listPedidosPorTab, getCountersPedidos,
  aprobarPedidoService, marcarListoService, marcarEntregadoService,
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
  { key: 'necesita_aprobacion', label: 'Por aprobar' },
  { key: 'programados',         label: 'Programados' },
  { key: 'activos',             label: 'En cocina' },
  { key: 'listos',              label: 'Listos' },
  { key: 'completados',         label: 'Completados' },
];

const POLL_MS = 30_000;

export function PedidosHub() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();
  const [tab, setTab] = useState<PedidoTab>('activos');
  const [pedidos, setPedidos] = useState<PedidoConItems[]>([]);
  const [canales, setCanales] = useState<Canal[]>([]);
  const [counters, setCounters] = useState<Record<PedidoTab, number>>({
    necesita_aprobacion: 0, programados: 0, activos: 0, listos: 0, completados: 0,
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

  // Quote times son config del local — manager+ desde sesión Supabase (NO desde rol_pos POS).
  // Roles válidos: dueño/admin/superadmin.
  const puedeEditarQuotes = !!user && ['dueno', 'admin', 'superadmin'].includes(user.rol);

  const reload = useCallback(async () => {
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

    // Detecta pedidos nuevos por aprobar: ping audio + browser notification.
    // El primer reload setea baseline (no notifica), reloads siguientes comparan.
    const aprobacionPrev = prevAprobacionCountRef.current;
    const aprobacionNuevo = ctsRes.necesita_aprobacion;
    if (aprobacionPrev !== null && aprobacionNuevo > aprobacionPrev) {
      const delta = aprobacionNuevo - aprobacionPrev;
      notify(
        `🛵 ${delta} pedido${delta > 1 ? 's' : ''} nuevo${delta > 1 ? 's' : ''} por aprobar`,
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

  useEffect(() => { reload(); }, [reload]);

  // Realtime: cuando MP/tienda envía pedido nuevo, aparece sin F5. Filtro por
  // modo=pedidos para no recargar con ventas de Salón/Mostrador.
  useRealtimeTable({ table: 'ventas_pos', onChange: () => reload(), scopeByLocal: true, extraFilter: 'modo=eq.pedidos' });

  // Polling 30s como respaldo (si Realtime se cae, este sigue refrescando).
  useEffect(() => {
    const id = setInterval(reload, POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  useEffect(() => {
    if (editingQuote && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingQuote]);

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
    <div className="container py-6">
      <header className="mb-5 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Pedidos</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pedidos online y delivery externo. Refresca cada 30 segundos.
          </p>
        </div>

        {/* TOOLBAR: nuevo pedido + quote times editables inline (manager+) */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button onClick={() => setNuevoPedidoOpen(true)} size="lg" className="gap-1.5">
            <Plus className="h-4 w-4" />
            Nuevo pedido
          </Button>
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
        </div>
      </header>

      <NuevoPedidoDialog
        open={nuevoPedidoOpen}
        onOpenChange={setNuevoPedidoOpen}
        onCreated={(ventaId) => navigate(`/pos/venta/${ventaId}`)}
      />

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
                    variant={t.key === 'listos' ? 'listo' : 'default'}
                    onClick={() => navigate(`/pos/pedidos/${p.id}`)}
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
        <span className="text-[10px] opacity-70">(activar)</span>
      )}
    </button>
  );
}

// ─── Empty States ────────────────────────────────────────────────────────────
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
