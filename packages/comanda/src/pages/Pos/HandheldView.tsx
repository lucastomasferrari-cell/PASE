import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Send, Search } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useAuthPos } from '@/lib/authPos';
import { useLocalActivo } from '@/lib/localActivo';
import { listMesasConVentas, type MesaConVenta } from '@/services/mesasService';
import { abrirVenta, listVentasItems, agregarItem, mandarCurso, updateVentaMeta } from '@/services/ventasService';
import { resolveCanalPorModo } from '@/services/canalesService';
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
import { db } from '@/lib/supabase';
import { ModifiersDialog } from '@/components/dialogs/ModifiersDialog';
import { PaymentDialog } from '@/components/dialogs/PaymentDialog';
import { getVenta } from '@/services/ventasService';
import type { VentaPos } from '@/types/database';
import { Wallet } from 'lucide-react';
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

// Breakpoint: por encima de esto consideramos desktop/tablet grande y NO
// dejamos usar Modo Mozo (se ve raro y desperdicia espacio).
const MOBILE_BREAKPOINT = 900;

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' ? window.innerWidth < MOBILE_BREAKPOINT : true,
  );
  useEffect(() => {
    function check() { setIsMobile(window.innerWidth < MOBILE_BREAKPOINT); }
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  return isMobile;
}

export function HandheldView() {
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const [localId] = useLocalActivo(user);
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const [pantalla, setPantalla] = useState<Pantalla>({ tipo: 'mesas' });

  if (!empleado) {
    return <div className="p-8 text-center text-muted-foreground">Sesión POS requerida.</div>;
  }
  if (localId === null) {
    return <div className="p-8 text-center text-muted-foreground">Seleccioná un local.</div>;
  }

  // Bloqueo en desktop/tablet grande: el modo mozo está diseñado mobile-first
  // (~360-768px). En pantallas grandes se ve desperdiciado y la UX no escala.
  if (!isMobile) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md text-center space-y-4">
          <div className="text-6xl">📱</div>
          <h1 className="text-xl font-semibold">Modo Mozo es solo para celular</h1>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Esta vista está optimizada para que el mozo tome pedidos en la mesa con el celular.
            En tablet o computadora, usá el <strong>POS normal</strong> que aprovecha el espacio
            para mostrar el catálogo + check + acciones en paralelo.
          </p>
          <div className="flex flex-col gap-2 mt-6">
            <Button onClick={() => navigate('/pos/salon')} size="lg" className="w-full">
              Ir al POS · Salón
            </Button>
            <Button onClick={() => navigate('/pos/mostrador')} variant="outline" size="lg" className="w-full">
              Ir al POS · Mostrador
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            Si te conectaste desde un celu pero ves esta pantalla, achicá la ventana del navegador
            a menos de {MOBILE_BREAKPOINT}px de ancho.
          </p>
        </div>
      </div>
    );
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
  const [tab, setTab] = useState<'todas' | 'mis-mesas'>('todas');

  const reload = useCallback(async () => {
    setLoading(true);
    const { data } = await listMesasConVentas(localId);
    setMesas(data);
    setLoading(false);
  }, [localId]);

  useEffect(() => { reload(); }, [reload]);
  useRealtimeTable({ table: 'mesas', onChange: () => reload(), scopeByLocal: true });
  useRealtimeTable({ table: 'ventas_pos', onChange: () => reload(), scopeByLocal: true, extraFilter: 'modo=eq.salon' });

  // "Mis mesas" = mesas con venta abierta donde este empleado es el mozo
  // asignado. Si no hay ventas abiertas suyas, mostramos todas igual.
  // mozoId no viene en MesaConVenta directo — lo derivamos asumiendo que
  // venta.cajero_id o venta.mozo_id matchea. Si no tenemos ese campo,
  // hacemos fallback: "mesas con cualquier venta abierta" (sin filtrar).
  const misMesas = useMemo(() => {
    // Como MesaConVenta no incluye mozo_id, mostramos todas las ocupadas
    // por ahora. Cuando el query lo exponga, filtramos por empleadoId.
    return mesas.filter((m) => m.venta_abierta_id !== null);
  }, [mesas]);

  const mesasVisibles = tab === 'mis-mesas' ? misMesas : mesas;

  async function abrirOSeleccionar(mesa: MesaConVenta) {
    if (mesa.venta_abierta_id) {
      onMesaElegida(mesa.venta_abierta_id, mesa);
      return;
    }
    // Mesa libre — abrimos venta nueva con covers default
    const canal = await resolveCanalPorModo(tenantId || null, 'salon', localId, 'salon');
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
        <h1 className="text-base font-semibold">Modo mozo</h1>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">{mesasVisibles.length}</span>
          <FullscreenToggle className="h-8 w-8" />
        </div>
      </header>

      {/* Tabs: Todas las mesas vs. solo las que tienen venta abierta
          ("Mis mesas" — Toast Go style). */}
      <div className="flex border-b border-border bg-card">
        <button
          type="button"
          onClick={() => setTab('todas')}
          className={cn(
            'flex-1 h-10 text-sm font-medium transition-colors',
            tab === 'todas' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground',
          )}
        >
          Todas ({mesas.length})
        </button>
        <button
          type="button"
          onClick={() => setTab('mis-mesas')}
          className={cn(
            'flex-1 h-10 text-sm font-medium transition-colors',
            tab === 'mis-mesas' ? 'text-primary border-b-2 border-primary' : 'text-muted-foreground',
          )}
        >
          Activas ({misMesas.length})
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="py-12 text-center text-muted-foreground">Cargando…</div>
        ) : mesasVisibles.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground text-sm">
            {tab === 'mis-mesas' ? 'Sin mesas activas todavía.' : 'Sin mesas en el local.'}
          </div>
        ) : (
          // Grid responsive: mesas con tamaño fijo (auto-fill) en lugar
          // de 3 columnas absolutas. En celu (360-420px) caben 3-4 por fila,
          // en tablet 6-8, en desktop 10+. Cada mesa ~96-108px.
          <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
            {mesasVisibles.map((m) => (
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
  const [pendingModifiers, setPendingModifiers] = useState<ItemConGrupo | null>(null);
  const [itemsConModifiers, setItemsConModifiers] = useState<Set<number>>(new Set());
  const [venta, setVenta] = useState<VentaPos | null>(null);
  const [showCobro, setShowCobro] = useState(false);
  const [cursoActivo, setCursoActivo] = useState<number>(1);
  const online = useOnlineStatus();

  const reload = useCallback(async () => {
    setLoading(true);
    // Venta primero → su local define la MARCA del menú (igual que useVentaData).
    const vRes = await getVenta(ventaId);
    let marcaId: number | null = null;
    const lid = vRes.data?.local_id ?? null;
    if (lid) {
      try {
        const { data } = await db.from('locales').select('marca_id').eq('id', lid).maybeSingle();
        marcaId = (data?.marca_id as number | null) ?? null;
      } catch { /* sin red → sin filtro */ }
    }
    // Modelo maestro+import: el POS lee el menú de ESTA sucursal (local_id=lid);
    // si no hay local (offline) cae al filtro por marca.
    const [cRes, gRes, iRes] = await Promise.all([
      listItems({ tenantId, localId: lid, marcaId }),
      listGrupos(tenantId, marcaId, { localId: lid }),
      listVentasItems(ventaId),
    ]);
    setCatalogo(cRes.data);
    setGrupos(gRes.data);
    setItems(iRes.data);
    setVenta(vRes.data);
    setLoading(false);
  }, [tenantId, ventaId]);

  useEffect(() => { reload(); }, [reload]);
  useRealtimeTable({
    table: 'ventas_pos_items',
    onChange: () => reload(),
    extraFilter: `venta_id=eq.${ventaId}`,
  });

  // Cache de qué items tienen modifier_groups asignados — para saber si
  // tap producto abre el dialog de modificadores o agrega directo.
  useEffect(() => {
    if (catalogo.length === 0) return;
    let cancelled = false;
    const ids = catalogo.map((c) => c.id);
    db.from('item_modifier_groups').select('item_id').in('item_id', ids).then(({ data }) => {
      if (cancelled) return;
      const set = new Set<number>();
      for (const r of data ?? []) set.add((r as { item_id: number }).item_id);
      setItemsConModifiers(set);
    });
    return () => { cancelled = true; };
  }, [catalogo]);

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

  async function addItem(
    it: ItemConGrupo,
    modificadores: { nombre: string; precio_extra: number; modifier_id?: number }[] = [],
    notas: string | null = null,
    cantidad: number = 1,
  ) {
    if (!online) {
      toast.error('Sin conexión — no se puede agregar items hasta que vuelva internet');
      return;
    }
    const { error } = await agregarItem({
      ventaId,
      itemId: it.id,
      cantidad,
      curso: cursoActivo,
      modificadores: modificadores.length > 0 ? modificadores : null,
      notas,
      cargadoPor: empleadoId,
    });
    if (error) { toast.error(error); return; }
    setLastAddedItemId(it.id);
    reload();
  }

  function clickItem(it: ItemConGrupo) {
    if (itemsConModifiers.has(it.id)) {
      // Abre el dialog de modificadores; al confirmar, addItem con la selección.
      setPendingModifiers(it);
    } else {
      void addItem(it);
    }
  }

  async function handleMandarCurso(curso: number) {
    if (!online) {
      toast.error('Sin conexión — no se puede mandar a cocina hasta que vuelva internet');
      return;
    }
    const itemsCurso = items.filter((i) => i.estado === 'hold' && (i.curso ?? 1) === curso);
    if (itemsCurso.length === 0) {
      toast.error(`Nada en curso ${curso} para mandar`);
      return;
    }
    setSending(true);
    const cantidad = itemsCurso.length;
    const { error } = await mandarCurso(ventaId, curso);
    setSending(false);
    if (error) { toast.error(error); return; }
    toast.success(`${cantidad} ${cantidad === 1 ? 'item enviado' : 'items enviados'} a cocina (curso ${curso})`);
    reload();
  }

  // Cursos en hold (números únicos de curso con items pendientes de enviar)
  const cursosEnHold = useMemo(() => {
    const set = new Set<number>();
    for (const it of items) {
      if (it.estado === 'hold') set.add(it.curso ?? 1);
    }
    return Array.from(set).sort((a, b) => a - b);
  }, [items]);

  function holdCountCurso(curso: number): number {
    return items.filter((i) => i.estado === 'hold' && (i.curso ?? 1) === curso).length;
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

      {/* Notas globales de la mesa — info que el equipo + cocina deben saber
          (cumpleaños, alergias, "traer torta al final"). Pedido de Lucas:
          mismo patrón que VentaScreen del POS normal. */}
      {venta && (
        <NotasMesaBox
          ventaId={ventaId}
          notasActuales={venta.notas ?? null}
          onSaved={reload}
        />
      )}

      {/* Búsqueda + selector curso + tabs grupo */}
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
        {/* Selector de curso: a qué curso van los items que toque ahora.
            Default curso 1. Si quiero pedir postres como curso 2, cambio acá. */}
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="uppercase tracking-wide font-medium shrink-0">Cargando en:</span>
          {[1, 2, 3].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCursoActivo(c)}
              className={cn(
                'px-2 h-7 rounded-md text-xs font-medium transition-colors',
                cursoActivo === c ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent',
              )}
            >
              Curso {c}
            </button>
          ))}
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
                  onClick={() => clickItem(it)}
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
            {/* 1 botón por curso con items en hold. Si hay solo curso 1
                muestra 1 botón grande; si hay curso 2, 3 etc se apilan
                con su contador respectivo. */}
            {cursosEnHold.map((curso) => (
              <Button
                key={curso}
                variant="success"
                size="lg"
                className="w-full h-12 text-base font-semibold"
                onClick={() => handleMandarCurso(curso)}
                disabled={sending || !online}
                title={!online ? 'Sin conexión — esperá a que vuelva internet' : undefined}
              >
                <Send className="h-4 w-4 mr-2" />
                {!online ? 'Sin conexión' : sending ? 'Enviando…' :
                  cursosEnHold.length === 1
                    ? `Mandar a cocina (${holdCountCurso(curso)})`
                    : `Mandar curso ${curso} (${holdCountCurso(curso)})`}
              </Button>
            ))}
          </>
        ) : (
          <div className="py-3 text-center text-xs text-muted-foreground">
            Tocá productos del catálogo para agregar.
          </div>
        )}

        {/* Cobrar — siempre visible si la venta tiene total > 0 y no está
            cobrada. El mozo puede cobrar la mesa desde el celu sin volver
            al mostrador (estilo Toast Go). */}
        {venta && venta.estado !== 'cobrada' && venta.estado !== 'anulada' && Number(venta.total) > 0 && (
          <Button
            variant="default"
            size="lg"
            className="w-full h-12 text-base font-semibold"
            onClick={() => setShowCobro(true)}
            disabled={!online}
          >
            <Wallet className="h-4 w-4 mr-2" />
            Cobrar {formatARS(Number(venta.total))}
          </Button>
        )}
      </div>

      {/* Dialog de modificadores: se abre cuando el item tiene modifier_groups
          asignados (ej. tamaño, ingredientes extra). El cajero elige opciones
          + cantidad + notas y confirma. */}
      {pendingModifiers && (
        <ModifiersDialog
          open={true}
          onOpenChange={(o) => { if (!o) setPendingModifiers(null); }}
          item={pendingModifiers}
          onConfirm={async (mods, notas, cantidad) => {
            await addItem(pendingModifiers, mods, notas, cantidad);
            setPendingModifiers(null);
          }}
        />
      )}

      {/* PaymentDialog — Toast Go style: mozo cobra desde la mesa.
          Multi-pago (efectivo + tarjeta), vuelto, propina. Igual que el
          PaymentDialog del POS normal — reusamos el componente. */}
      {showCobro && venta && (
        <PaymentDialog
          open={showCobro}
          onOpenChange={setShowCobro}
          venta={venta}
          items={items}
          catalogo={catalogo}
          empleadoId={empleadoId}
          onCobrado={() => {
            setShowCobro(false);
            toast.success('Mesa cobrada');
            // Volver a la lista de mesas — la venta se cerró
            setTimeout(() => onVolver(), 600);
          }}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Componente: NotasMesaBox
// ────────────────────────────────────────────────────────────────────────
// Notas globales de la mesa — visible para todo el equipo + cocina. Si hay
// notas se ve la nota en una pill amarilla; tap → modo edición inline. Si
// no hay, muestra link "+ agregar nota".

function NotasMesaBox({ ventaId, notasActuales, onSaved }: {
  ventaId: number;
  notasActuales: string | null;
  onSaved: () => void;
}) {
  const [editando, setEditando] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  async function guardar() {
    setSaving(true);
    const trimmed = draft.trim();
    const { error } = await updateVentaMeta(ventaId, { notas: trimmed || null });
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success('Notas guardadas');
    setEditando(false);
    onSaved();
  }

  if (editando) {
    return (
      <div className="bg-warning/10 border-b border-warning/30 p-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          rows={2}
          placeholder="Ej: cumpleaños, alergia al maní, traer torta al final"
          className="w-full text-xs rounded-md border border-input bg-background p-2 resize-none"
        />
        <div className="flex gap-1.5 mt-1.5 justify-end">
          <Button size="sm" variant="ghost" className="h-7 text-[10px]" onClick={() => setEditando(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button size="sm" variant="success" className="h-7 text-[10px]" onClick={guardar} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </Button>
        </div>
      </div>
    );
  }
  if (notasActuales) {
    return (
      <button
        type="button"
        onClick={() => { setDraft(notasActuales); setEditando(true); }}
        className="w-full bg-warning/10 border-b border-warning/30 p-2 text-left text-xs italic text-warning-foreground hover:bg-warning/15"
      >
        📝 {notasActuales}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => { setDraft(''); setEditando(true); }}
      className="w-full text-left px-3 py-1.5 text-[10px] text-muted-foreground hover:text-foreground border-b border-border bg-muted/30"
    >
      + Agregar nota a la mesa
    </button>
  );
}
