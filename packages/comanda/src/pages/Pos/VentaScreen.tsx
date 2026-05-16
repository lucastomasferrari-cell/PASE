import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, Send, Wallet, MoreHorizontal, Package, Trash2,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { listItems, type ItemConGrupo } from '../../services/itemsService';
import { listGrupos } from '../../services/gruposService';
import {
  getVenta, listVentasItems, agregarItem, modificarItem, mandarCurso,
} from '../../services/ventasService';
import type { VentaPos, VentaPosItem, ItemGrupo } from '../../types/database';
import { Badge } from '../../components/Badge';
import { SearchInput } from '../../components/SearchInput';
import { Stepper } from '../../components/Stepper';
import { formatARS, relativoCorto } from '../../lib/format';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ModifiersDialog } from '@/components/dialogs/ModifiersDialog';
import { PaymentDialog } from '@/components/dialogs/PaymentDialog';
import { DiscountDialog } from '@/components/dialogs/DiscountDialog';
import { TransferMesaDialog } from '@/components/dialogs/TransferMesaDialog';
import { MergeMesasDialog } from '@/components/dialogs/MergeMesasDialog';
import { SplitCheckDialog } from '@/components/dialogs/SplitCheckDialog';
import { ManagerOverrideDialog } from '@/components/dialogs/ManagerOverrideDialog';
import { anularVenta, anularItem, modificarPrecioItem, cortesiaItem } from '@/services/overridesService';
import { marcarDisponible } from '@/services/itemsService';
import { AgotarDialog } from '@/pages/Catalogo/AgotarDialog';
import { MoneyInput } from '@/components/MoneyInput';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { db } from '@/lib/supabase';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { EstadoVentaBadge } from '@/components/EstadoBadge';
import { cn } from '@/lib/utils';

const CURSO_COLORS: Record<number, string> = {
  1: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100 border-amber-200 dark:border-amber-800',
  2: 'bg-orange-100 text-orange-900 dark:bg-orange-900/30 dark:text-orange-100 border-orange-200 dark:border-orange-800',
  3: 'bg-purple-100 text-purple-900 dark:bg-purple-900/30 dark:text-purple-100 border-purple-200 dark:border-purple-800',
};

export function VentaScreen() {
  const { ventaId: idStr } = useParams<{ ventaId: string }>();
  const ventaId = Number(idStr);
  const { user } = useAuth();
  const { empleado } = useAuthPos();
  const navigate = useNavigate();

  const [venta, setVenta] = useState<VentaPos | null>(null);
  const [items, setItems] = useState<VentaPosItem[]>([]);
  const [catalogo, setCatalogo] = useState<ItemConGrupo[]>([]);
  const [grupos, setGrupos] = useState<ItemGrupo[]>([]);
  const [grupoSel, setGrupoSel] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [cursoActivo, setCursoActivo] = useState<number>(1);

  // Dialogs
  const [showCobro, setShowCobro] = useState(false);
  const [showDescuento, setShowDescuento] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showMerge, setShowMerge] = useState(false);
  const [showSplit, setShowSplit] = useState(false);
  const [showAnular, setShowAnular] = useState(false);
  const [pendingModifiers, setPendingModifiers] = useState<ItemConGrupo | null>(null);

  // Cache de qué items tienen modifier_groups asignados (para decidir si abre dialog)
  const [itemsConModifiers, setItemsConModifiers] = useState<Set<number>>(new Set());

  // UX deep: feedback visual al agregar — guardamos el último item id agregado
  // y lo limpiamos a los 1.2s. Sirve para flashear el ProductTile y resaltar la
  // fila recién agregada en el check.
  const [lastAddedItemId, setLastAddedItemId] = useState<number | null>(null);
  const [lastAddedRowId, setLastAddedRowId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (lastAddedItemId == null) return;
    const t = setTimeout(() => setLastAddedItemId(null), 1200);
    return () => clearTimeout(t);
  }, [lastAddedItemId]);

  useEffect(() => {
    if (lastAddedRowId == null) return;
    const t = setTimeout(() => setLastAddedRowId(null), 2000);
    return () => clearTimeout(t);
  }, [lastAddedRowId]);

  const reload = useCallback(async () => {
    setLoading(true);
    const [vRes, iRes, cRes, gRes] = await Promise.all([
      getVenta(ventaId),
      listVentasItems(ventaId),
      listItems({ tenantId: user?.tenant_id ?? null }),
      listGrupos(user?.tenant_id ?? null),
    ]);
    if (vRes.error) toast.error(vRes.error);
    setVenta(vRes.data);
    setItems(iRes.data);
    setCatalogo(cRes.data);
    setGrupos(gRes.data);
    setLoading(false);
  }, [ventaId, user?.tenant_id]);

  useEffect(() => { reload(); }, [reload]);

  // Realtime: si la cocina marca listo o el manager anula desde otro device,
  // se refleja sin F5. Filtro por venta_id puntual + items de esta venta.
  useRealtimeTable({
    table: 'ventas_pos',
    onChange: () => reload(),
    extraFilter: Number.isFinite(ventaId) && ventaId > 0 ? `id=eq.${ventaId}` : undefined,
    enabled: Number.isFinite(ventaId) && ventaId > 0,
  });
  useRealtimeTable({
    table: 'ventas_pos_items',
    onChange: () => reload(),
    extraFilter: Number.isFinite(ventaId) && ventaId > 0 ? `venta_id=eq.${ventaId}` : undefined,
    enabled: Number.isFinite(ventaId) && ventaId > 0,
  });

  // Item seleccionado para agotar (abre AgotarDialog)
  const [agotarItem, setAgotarItem] = useState<ItemConGrupo | null>(null);

  // Acciones manager-override sobre item del check
  const [anularItemTarget, setAnularItemTarget] = useState<VentaPosItem | null>(null);
  const [cortesiaItemTarget, setCortesiaItemTarget] = useState<VentaPosItem | null>(null);
  const [precioItemTarget, setPrecioItemTarget] = useState<VentaPosItem | null>(null);
  const [precioNuevo, setPrecioNuevo] = useState<number>(0);
  const [precioMotivo, setPrecioMotivo] = useState('');
  const [showPrecioMgr, setShowPrecioMgr] = useState(false);

  // Cache: qué items tienen modifiers asignados.
  // Sprint 7 HIGH #3: cleanup con `cancelled` flag para evitar setState
  // post-unmount cuando la query resuelve después de navegar fuera.
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

  const catalogoFiltrado = useMemo(() => {
    return catalogo.filter((it) => {
      // Mostrar disponibles + agotados (agotados aparecen tachados, long-press
      // los reactiva). Inactivos NO se muestran (es estado de admin).
      if (it.estado !== 'disponible' && it.estado !== 'agotado') return false;
      if (!it.visible_pos) return false;
      if (grupoSel !== null && it.grupo_id !== grupoSel) return false;
      if (search.trim() && !it.nombre.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [catalogo, grupoSel, search]);

  // Items agrupados por curso
  const itemsPorCurso = useMemo(() => {
    const map = new Map<number, VentaPosItem[]>();
    for (const it of items) {
      const c = it.curso ?? 1;
      if (!map.has(c)) map.set(c, []);
      map.get(c)!.push(it);
    }
    return new Map([...map.entries()].sort((a, b) => a[0] - b[0]));
  }, [items]);

  // Hold count por curso (para badge "EN HOLD")
  function holdCount(curso: number): number {
    return (itemsPorCurso.get(curso) ?? []).filter((i) => i.estado === 'hold').length;
  }

  if (loading) return <div className="py-12 text-center text-muted-foreground">Cargando…</div>;
  if (!venta) return <div className="py-12 text-center text-destructive">Venta no encontrada</div>;
  if (!empleado) return <div className="py-12 text-center text-muted-foreground">Sesión POS requerida</div>;

  // Cross-local guard: si la venta es de otro local, NO permitir operar (anular,
  // cobrar, descuento, transferir mesa). El dueño/superadmin ven todas las
  // ventas del tenant por RLS pero las RPCs validan local con
  // fn_assert_empleado_en_local. Bloqueamos antes para evitar errores opacos.
  if (venta.local_id !== empleado.local_id) {
    return (
      <div className="container max-w-md py-12">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-center">
          <div className="text-3xl mb-2">⚠️</div>
          <h2 className="text-lg font-semibold mb-2">Venta de otro local</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Esta venta pertenece a un local distinto al que tenés activo. Cambiá el local
            en el sidebar de PASE para poder operarla.
          </p>
          <button
            type="button"
            onClick={() => navigate('/pos/salon')}
            className="text-sm text-primary underline"
          >
            Volver al POS
          </button>
        </div>
      </div>
    );
  }

  const editable = venta.estado !== 'cobrada' && venta.estado !== 'anulada';

  async function addItem(it: ItemConGrupo, modificadores: { nombre: string; precio_extra: number; modifier_id?: number }[] = [], notas: string | null = null, cantidad: number = 1) {
    if (!editable || !empleado) return;
    const { id, error } = await agregarItem({
      ventaId, itemId: it.id, cantidad, curso: cursoActivo,
      modificadores: modificadores.length > 0 ? modificadores : null,
      notas,
      cargadoPor: empleado.id,
    });
    if (error) { toast.error(error); return; }
    toast.success(`${cantidad > 1 ? `${cantidad}× ` : ''}${it.nombre} agregado al curso ${cursoActivo}`);
    setLastAddedItemId(it.id);
    if (id != null) setLastAddedRowId(id);
    reload();
    // UX: limpiamos search para que el cajero siga tipeando el próximo item.
    // Re-focus para mantener flow teclado-only.
    setSearch('');
    searchRef.current?.focus();
  }

  // Repetir item: agrega una nueva línea con el mismo item_id + mismos
  // modificadores + notas. NO suma cantidad a la línea existente porque
  // los modificadores podrían querer cambiar y la cantidad puede afectar
  // splits/refunds. Si el cliente pide "otro igual" es más limpio: nueva
  // línea. Usa el curso activo (no necesariamente el del item original).
  async function repetirItem(itemRow: VentaPosItem) {
    if (!editable || !empleado) return;
    const cat = catalogo.find((c) => c.id === itemRow.item_id);
    if (!cat) { toast.error('Item no encontrado en catálogo'); return; }
    const mods = itemRow.modificadores?.map((m) => ({
      nombre: m.nombre,
      precio_extra: Number(m.precio_extra),
      modifier_id: m.modifier_id,
    })) ?? [];
    const { id, error } = await agregarItem({
      ventaId, itemId: itemRow.item_id, cantidad: 1, curso: cursoActivo,
      modificadores: mods.length > 0 ? mods : null,
      notas: itemRow.notas ?? null,
      cargadoPor: empleado.id,
    });
    if (error) { toast.error(error); return; }
    toast.success(`+1 ${cat.nombre} (curso ${cursoActivo})`);
    setLastAddedItemId(itemRow.item_id);
    if (id != null) setLastAddedRowId(id);
    reload();
  }

  async function removeItem(itemRow: VentaPosItem) {
    if (!editable) return;
    if (itemRow.estado !== 'hold') {
      toast.error('Solo se pueden quitar items en hold (no enviados a cocina)');
      return;
    }
    // Quitar = cantidad 0 vía RPC modificar (gestiona la baja en BD).
    const { error } = await modificarItem(itemRow.id, { cantidad: 0 });
    if (error) { toast.error(error); return; }
    toast.success('Item quitado');
    reload();
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setSearch('');
      return;
    }
    if (e.key === 'Enter') {
      const primero = catalogoFiltrado[0];
      if (primero) {
        e.preventDefault();
        void clickItem(primero);
      }
    }
  }

  async function clickItem(it: ItemConGrupo) {
    if (!editable) return;
    if (itemsConModifiers.has(it.id)) {
      setPendingModifiers(it);
    } else {
      await addItem(it);
    }
  }

  // Long-press en ProductTile: si item está disponible → abre AgotarDialog
  // (mark "86"). Si ya está agotado → reactivar al toque (sin dialog porque
  // marcarDisponible no requiere motivo).
  async function longPressItem(it: ItemConGrupo) {
    if (it.estado === 'agotado') {
      const ok = confirm(`¿Reponer "${it.nombre}" al catálogo?`);
      if (!ok) return;
      const { error } = await marcarDisponible(it.id);
      if (error) { toast.error(error); return; }
      toast.success(`${it.nombre} disponible de nuevo`);
      // El catálogo se refresca por Realtime de tabla items, pero pedimos
      // reload inmediato para que el cajero vea el cambio sin lag.
      reload();
    } else {
      setAgotarItem(it);
    }
  }

  async function changeQty(itemRow: VentaPosItem, qty: number) {
    if (qty <= 0) return;
    const { error } = await modificarItem(itemRow.id, { cantidad: qty });
    if (error) { toast.error(error); return; }
    reload();
  }

  async function mandarCursoHandler(curso: number) {
    const { error } = await mandarCurso(ventaId, curso);
    if (error) { toast.error(error); return; }
    toast.success(`Curso ${curso} enviado a cocina`);
    reload();
  }

  const cursosExistentes = Array.from(itemsPorCurso.keys());
  const maxCurso = Math.max(3, ...cursosExistentes);

  return (
    // En tablet la vista debe entrar SIN scroll de página: el catálogo (izq)
    // y el check (der) cada uno scrollean dentro de su columna, y el botón
    // "Cobrar y enviar" queda siempre fijo abajo a la derecha — visible aún
    // con el check vacío. dvh evita problemas con la URL bar de mobile/tablet.
    // 3.5rem = header 56px del PosLayout.
    <div className="grid grid-cols-1 md:grid-cols-[1fr_380px] h-[calc(100dvh-3.5rem)] overflow-hidden">
      {/* CATÁLOGO IZQ */}
      <div className="p-4 overflow-y-auto border-r border-border bg-card min-h-0">
        {/* Selector de curso */}
        {editable && (
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Cargando en:</span>
            {Array.from({ length: maxCurso }, (_, i) => i + 1).map((c) => (
              <Button
                key={c}
                type="button"
                variant={cursoActivo === c ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCursoActivo(c)}
              >
                Curso {c}
              </Button>
            ))}
            <Button type="button" variant="ghost" size="sm" onClick={() => setCursoActivo(maxCurso + 1)}>
              + Curso {maxCurso + 1}
            </Button>
          </div>
        )}

        <div className="mb-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Buscar producto… (Enter agrega el primero)"
            autoFocus
            inputRef={searchRef}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        <div className="flex gap-1 mb-3 flex-wrap">
          <GrupoTab active={grupoSel === null} onClick={() => setGrupoSel(null)}>Todos</GrupoTab>
          {grupos.map((g) => (
            <GrupoTab key={g.id} active={grupoSel === g.id} onClick={() => setGrupoSel(g.id)}>
              {g.emoji ?? ''} {g.nombre}
            </GrupoTab>
          ))}
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
          {catalogoFiltrado.map((it) => (
            <ProductTile
              key={it.id}
              item={it}
              grupo={grupos.find((g) => g.id === it.grupo_id) ?? null}
              disabled={!editable}
              flashed={lastAddedItemId === it.id}
              onClick={() => clickItem(it)}
              onLongPress={() => longPressItem(it)}
            />
          ))}
          {catalogoFiltrado.length === 0 && search.trim() && (
            <div className="col-span-full text-center text-muted-foreground text-sm py-8">
              Sin resultados para "{search}"
            </div>
          )}
        </div>
      </div>

      {/* CHECK DER — column con header fijo, items scrolleables, footer pinned */}
      <aside className="bg-muted/40 border-l border-border flex flex-col min-h-0 overflow-hidden">
        <div className="p-3 border-b border-border bg-card">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Volver
            </Button>
            <strong className="text-base">#{venta.numero_local}</strong>
            <EstadoVentaBadge estado={venta.estado} />
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            {venta.modo === 'salon' && venta.mesa_id && 'Mesa · '}
            {venta.cliente_nombre ?? 'Sin cliente'} · abierta {relativoCorto(venta.abierta_at)}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {items.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              Sin items. Tocá productos del catálogo para agregar.
            </div>
          ) : (
            Array.from(itemsPorCurso.entries()).map(([curso, itemsCurso]) => {
              const hold = holdCount(curso);
              return (
                <div key={curso}>
                  <div className={cn(
                    'flex items-center justify-between gap-2 px-2 py-1.5 rounded-md border text-xs font-medium',
                    CURSO_COLORS[curso] ?? 'bg-muted',
                  )}>
                    <span>Curso {curso}</span>
                    {hold > 0 ? (
                      <Badge variant="amber">{hold} en hold</Badge>
                    ) : (
                      <Badge variant="green">Enviado</Badge>
                    )}
                  </div>
                  {hold > 0 && editable && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full mt-1.5"
                      onClick={() => mandarCursoHandler(curso)}
                    >
                      <Send className="h-3.5 w-3.5 mr-1.5" />
                      Mandar curso {curso} ({hold})
                    </Button>
                  )}
                  <div className="mt-1">
                    {itemsCurso.map((it) => (
                      <CheckRow
                        key={it.id}
                        item={it}
                        catalogo={catalogo}
                        onQty={(n) => changeQty(it, n)}
                        onRemove={() => removeItem(it)}
                        onRepetir={() => repetirItem(it)}
                        onAnular={() => setAnularItemTarget(it)}
                        onCambiarPrecio={() => {
                          setPrecioItemTarget(it);
                          setPrecioNuevo(Number(it.precio_unitario));
                          setPrecioMotivo('');
                        }}
                        onCortesia={() => setCortesiaItemTarget(it)}
                        editable={editable}
                        flashed={lastAddedRowId === it.id}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="p-3 border-t border-border bg-card space-y-2">
          <Row label="Subtotal" value={formatARS(venta.subtotal)} />
          {venta.descuento_total > 0 && (
            <Row label="Descuento" value={'−' + formatARS(venta.descuento_total)} />
          )}
          {venta.propina > 0 && <Row label="Propina" value={formatARS(venta.propina)} />}
          <Row label="Total" value={formatARS(venta.total)} bold />

          <div className="grid grid-cols-[1fr_auto] gap-2 mt-2">
            <Button
              type="button"
              variant="success"
              size="lg"
              onClick={() => setShowCobro(true)}
              disabled={!editable || venta.total <= 0}
            >
              <Wallet className="h-4 w-4 mr-2" />
              Cobrar y enviar
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  aria-label="Más opciones"
                  disabled={!editable}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => setShowDescuento(true)}>
                  Aplicar descuento
                </DropdownMenuItem>
                {venta.modo === 'salon' && (
                  <>
                    <DropdownMenuItem onClick={() => setShowTransfer(true)}>
                      Cambiar mesa
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setShowMerge(true)}>
                      Unir con otra mesa
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem onClick={() => setShowSplit(true)}>
                  Partir cuenta
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setShowAnular(true)}
                >
                  Anular venta
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </aside>

      {/* Dialogs */}
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

      {showCobro && (
        <PaymentDialog
          open={showCobro}
          onOpenChange={setShowCobro}
          venta={venta}
          empleadoId={empleado.id}
          onCobrado={() => {
            reload();
            setTimeout(() => navigate(venta.modo === 'salon' ? '/pos/salon' : '/pos/mostrador'), 800);
          }}
        />
      )}

      {showDescuento && (
        <DiscountDialog
          open={showDescuento}
          onOpenChange={setShowDescuento}
          ventaId={ventaId}
          subtotal={Number(venta.subtotal)}
          total={Number(venta.total)}
          onAplicado={reload}
        />
      )}

      {showTransfer && (
        <TransferMesaDialog
          open={showTransfer}
          onOpenChange={setShowTransfer}
          ventaId={ventaId}
          localId={venta.local_id}
          mesaActualId={venta.mesa_id}
          onTransferida={reload}
        />
      )}

      {showMerge && (
        <MergeMesasDialog
          open={showMerge}
          onOpenChange={setShowMerge}
          ventaDestinoId={ventaId}
          localId={venta.local_id}
          onUnida={reload}
        />
      )}

      {showSplit && (
        <SplitCheckDialog
          open={showSplit}
          onOpenChange={setShowSplit}
          ventaId={ventaId}
          tenantId={user?.tenant_id ?? ''}
          onPartida={(nueva) => {
            toast.success(`Cuenta partida — venta nueva #${nueva}`);
            reload();
          }}
        />
      )}

      {agotarItem && (
        <AgotarDialog
          item={agotarItem}
          onClose={() => setAgotarItem(null)}
          onDone={() => { setAgotarItem(null); reload(); toast.success(`${agotarItem.nombre} marcado agotado`); }}
        />
      )}

      {/* Anular item (incluso enviado a cocina) con manager override */}
      <ManagerOverrideDialog
        open={anularItemTarget !== null}
        onOpenChange={(o) => { if (!o) setAnularItemTarget(null); }}
        accion="Anular item"
        descripcion={anularItemTarget ? `Anular "${catalogo.find((c) => c.id === anularItemTarget.item_id)?.nombre ?? 'item'}" × ${anularItemTarget.cantidad} (${formatARS(anularItemTarget.subtotal)}). Si ya se mandó a cocina, avisá al cocinero.` : ''}
        onAuthorized={async ({ managerId, motivo }) => {
          if (!anularItemTarget) return;
          const idKey = `anular-item-${anularItemTarget.id}-${Math.floor(Date.now() / 5000)}`;
          const { error } = await anularItem(anularItemTarget.id, managerId, motivo, idKey);
          if (error) throw new Error(error);
          toast.success('Item anulado');
          setAnularItemTarget(null);
          reload();
        }}
      />

      {/* Cortesía (regalar item) con manager override */}
      <ManagerOverrideDialog
        open={cortesiaItemTarget !== null}
        onOpenChange={(o) => { if (!o) setCortesiaItemTarget(null); }}
        accion="🎁 Marcar como cortesía"
        descripcion={cortesiaItemTarget ? `Regalar "${catalogo.find((c) => c.id === cortesiaItemTarget.item_id)?.nombre ?? 'item'}" × ${cortesiaItemTarget.cantidad} (${formatARS(cortesiaItemTarget.subtotal)}). Queda en la venta con precio $0 y flag "cortesía" para auditoría.` : ''}
        onAuthorized={async ({ managerId, motivo }) => {
          if (!cortesiaItemTarget) return;
          const idKey = `cortesia-item-${cortesiaItemTarget.id}-${Math.floor(Date.now() / 5000)}`;
          const { error } = await cortesiaItem(cortesiaItemTarget.id, managerId, motivo, idKey);
          if (error) throw new Error(error);
          toast.success('Item marcado cortesía');
          setCortesiaItemTarget(null);
          reload();
        }}
      />

      {/* Cambiar precio puntual — dialog para input + abre ManagerOverride después */}
      <Dialog open={precioItemTarget !== null} onOpenChange={(o) => { if (!o) setPrecioItemTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cambiar precio del item</DialogTitle>
            <DialogDescription>
              {precioItemTarget && (
                <>
                  {catalogo.find((c) => c.id === precioItemTarget.item_id)?.nombre ?? 'Item'} —
                  precio actual <strong>{formatARS(precioItemTarget.precio_unitario)}</strong>
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">Nuevo precio unitario</label>
              <MoneyInput value={precioNuevo} onChange={setPrecioNuevo} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Motivo (mín 5 caracteres)</label>
              <input
                type="text"
                value={precioMotivo}
                onChange={(e) => setPrecioMotivo(e.target.value)}
                placeholder="Promo / error de carga / cliente reclamó…"
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrecioItemTarget(null)}>Cancelar</Button>
            <Button
              onClick={() => {
                if (precioMotivo.trim().length < 5) { toast.error('Motivo: mínimo 5 caracteres'); return; }
                if (precioNuevo < 0) { toast.error('Precio inválido'); return; }
                setShowPrecioMgr(true);
              }}
              disabled={precioNuevo < 0 || precioMotivo.trim().length < 5}
            >
              Continuar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ManagerOverrideDialog
        open={showPrecioMgr}
        onOpenChange={(o) => { if (!o) setShowPrecioMgr(false); }}
        accion="Cambiar precio item"
        descripcion={precioItemTarget ? `Cambiar precio de "${catalogo.find((c) => c.id === precioItemTarget.item_id)?.nombre ?? 'item'}" de ${formatARS(precioItemTarget.precio_unitario)} a ${formatARS(precioNuevo)}.` : ''}
        onAuthorized={async ({ managerId }) => {
          if (!precioItemTarget) return;
          const idKey = `precio-item-${precioItemTarget.id}-${Math.floor(Date.now() / 5000)}`;
          const { error } = await modificarPrecioItem(precioItemTarget.id, precioNuevo, managerId, precioMotivo.trim(), idKey);
          if (error) throw new Error(error);
          toast.success('Precio actualizado');
          setShowPrecioMgr(false);
          setPrecioItemTarget(null);
          setPrecioMotivo('');
          reload();
        }}
      />

      <ManagerOverrideDialog
        open={showAnular}
        onOpenChange={setShowAnular}
        accion="Anular venta"
        descripcion={`Anular venta #${venta.numero_local} por ${formatARS(venta.total)}.`}
        onAuthorized={async ({ managerId, motivo }) => {
          // Sprint 7 BLOCKER #3: idempotency_key derivado de venta_id +
          // ventana de tiempo. Doble-click sobre el mismo botón "Confirmar"
          // reusa el key y la RPC retorna el mismo override sin duplicar.
          const idempotencyKey = `anular-${ventaId}-${Math.floor(Date.now() / 5000)}`;
          const { error } = await anularVenta(ventaId, managerId, motivo, idempotencyKey);
          if (error) throw new Error(error);
          toast.success('Venta anulada');
          navigate(venta.modo === 'salon' ? '/pos/salon' : '/pos/mostrador');
        }}
      />
    </div>
  );
}

function GrupoTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 h-9 rounded-md text-xs font-medium transition-colors',
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  );
}

function CheckRow({ item, catalogo, onQty, onRemove, onRepetir, onAnular, onCambiarPrecio, onCortesia, editable, flashed }:
  {
    item: VentaPosItem;
    catalogo: ItemConGrupo[];
    onQty: (n: number) => void;
    onRemove: () => void;
    onRepetir: () => void;
    onAnular: () => void;
    onCambiarPrecio: () => void;
    onCortesia: () => void;
    editable: boolean;
    flashed?: boolean;
  }) {
  const it = catalogo.find((c) => c.id === item.item_id);
  return (
    <div
      className={cn(
        'p-2 border-b border-border flex gap-2 items-start transition-colors duration-700',
        item.estado === 'anulado' && 'opacity-40',
        flashed && 'bg-amber-100/70 dark:bg-amber-900/30 ring-2 ring-amber-400',
      )}
    >
      <div className="text-base">{it?.emoji ?? '📦'}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate flex items-center gap-1.5">
          {it?.nombre ?? `Item #${item.item_id}`}
          {item.es_cortesia && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-success/15 text-success font-bold uppercase">Cortesía</span>
          )}
          {item.precio_unitario_original != null && Number(item.precio_unitario_original) !== Number(item.precio_unitario) && !item.es_cortesia && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-warning/15 text-warning font-bold uppercase" title={`Precio original ${formatARS(item.precio_unitario_original)}`}>Precio mod.</span>
          )}
        </div>
        {item.modificadores && item.modificadores.length > 0 && (
          <div className="text-xs text-muted-foreground">
            {item.modificadores.map((m) => m.nombre).join(' · ')}
          </div>
        )}
        {item.notas && <div className="text-xs text-warning italic">{item.notas}</div>}
        <div className="text-xs text-muted-foreground mt-0.5">
          {item.precio_unitario_original != null && Number(item.precio_unitario_original) !== Number(item.precio_unitario) && (
            <span className="line-through mr-1.5 opacity-60">{formatARS(item.precio_unitario_original)}</span>
          )}
          {formatARS(item.precio_unitario)} c/u · {item.estado}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        {editable && item.estado === 'hold' ? (
          <div className="flex items-center gap-1">
            <Stepper value={Number(item.cantidad)} onChange={onQty} min={1} max={99} />
            <button
              type="button"
              onClick={onRemove}
              aria-label="Quitar item"
              title="Quitar (solo items en hold)"
              className="h-9 w-9 inline-flex items-center justify-center rounded-md text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <span className="text-xs">x{item.cantidad}</span>
        )}
        <strong className="text-sm tabular-nums">{formatARS(item.subtotal)}</strong>
        {/* Repetir item: agrega +1 con los mismos modificadores al curso activo */}
        {editable && item.estado !== 'anulado' && (
          <div className="flex items-center gap-1 mt-0.5">
            <button
              type="button"
              onClick={onRepetir}
              aria-label={`Repetir ${it?.nombre ?? 'item'}`}
              title="Agregar uno más igual (mismos modificadores) al curso activo"
              className="text-[10px] text-primary hover:underline"
            >
              + Repetir
            </button>
            {/* Acciones manager (anular/precio/cortesía) — solo si el item ya
                no está en hold (en hold se puede simplemente eliminar) */}
            {item.estado !== 'hold' && !item.es_cortesia && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="text-[10px] text-muted-foreground hover:text-foreground px-1 rounded hover:bg-accent"
                    aria-label="Más acciones del item"
                    title="Más acciones (manager override)"
                  >
                    ⋯
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={onCambiarPrecio}>
                    Cambiar precio…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onCortesia}>
                    🎁 Cortesía (gratis)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onAnular} className="text-destructive">
                    Anular item
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div
      className={cn(
        'flex justify-between py-1',
        bold ? 'text-base font-semibold text-foreground' : 'text-sm font-normal text-muted-foreground',
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

// ProductTile (Sprint 3) — color_ramp con clases Tailwind nativas
const RAMP_CLASSES: Record<string, string> = {
  amber:  'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:bg-amber-900/50',
  pink:   'bg-pink-100 text-pink-900 hover:bg-pink-200 dark:bg-pink-900/30 dark:text-pink-100 dark:hover:bg-pink-900/50',
  purple: 'bg-purple-100 text-purple-900 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-100 dark:hover:bg-purple-900/50',
  blue:   'bg-blue-100 text-blue-900 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-100 dark:hover:bg-blue-900/50',
  coral:  'bg-orange-100 text-orange-900 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-100 dark:hover:bg-orange-900/50',
  teal:   'bg-teal-100 text-teal-900 hover:bg-teal-200 dark:bg-teal-900/30 dark:text-teal-100 dark:hover:bg-teal-900/50',
  green:  'bg-green-100 text-green-900 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-100 dark:hover:bg-green-900/50',
  gray:   'bg-muted text-foreground hover:bg-accent',
};

function ProductTile({ item, grupo, disabled, flashed, onClick, onLongPress }: {
  item: ItemConGrupo;
  grupo: ItemGrupo | null;
  disabled: boolean;
  flashed?: boolean;
  onClick: () => void;
  onLongPress?: () => void;
}) {
  const ramp = grupo?.color_ramp ?? 'gray';
  const cls = RAMP_CLASSES[ramp] ?? RAMP_CLASSES.gray;
  const agotado = item.estado === 'agotado';
  // Long-press detector: pointerDown arranca timer 500ms, si llega al timeout
  // dispara onLongPress y cancela el click normal. pointerUp/leave/move
  // antes del timeout = click normal.
  const longPressRef = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });

  function handlePointerDown() {
    if (!onLongPress) return;
    longPressRef.current.fired = false;
    longPressRef.current.timer = window.setTimeout(() => {
      longPressRef.current.fired = true;
      onLongPress();
    }, 500);
  }
  function clearLongPress() {
    if (longPressRef.current.timer) {
      clearTimeout(longPressRef.current.timer);
      longPressRef.current.timer = null;
    }
  }
  function handleClick(e: React.MouseEvent) {
    // Si el long-press disparó, cancelar el click normal
    if (longPressRef.current.fired) {
      e.preventDefault();
      longPressRef.current.fired = false;
      return;
    }
    onClick();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={clearLongPress}
      onPointerLeave={clearLongPress}
      onPointerCancel={clearLongPress}
      onContextMenu={(e) => {
        // Bloquear menú contextual nativo (mobile long-press abre uno)
        if (onLongPress) e.preventDefault();
      }}
      disabled={disabled || (agotado && !onLongPress)}
      className={cn(
        'aspect-[4/3] rounded-lg p-3 flex flex-col items-center justify-center gap-1 relative',
        'transition-all duration-300 active:scale-[0.98] touch-target-lg',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
        cls,
        flashed && 'ring-4 ring-success scale-[1.02]',
        agotado && 'opacity-50',
      )}
      title={agotado ? 'AGOTADO — mantené presionado para reponer' : 'Tocá para agregar · mantené presionado para marcar agotado'}
    >
      {agotado && (
        <div className="absolute inset-0 rounded-lg bg-destructive/10 flex items-center justify-center pointer-events-none">
          <div className="bg-destructive text-destructive-foreground px-2 py-0.5 rounded text-[10px] font-bold uppercase rotate-[-12deg] shadow">
            Agotado
          </div>
        </div>
      )}
      {flashed && (
        <div className="absolute inset-0 rounded-lg bg-success/20 flex items-center justify-center pointer-events-none">
          <div className="bg-success text-success-foreground rounded-full h-10 w-10 flex items-center justify-center text-2xl shadow-lg">
            ✓
          </div>
        </div>
      )}
      {item.foto_url ? (
        <img src={item.foto_url} alt="" className="w-12 h-12 object-cover rounded" />
      ) : item.emoji ? (
        <div className="text-3xl">{item.emoji}</div>
      ) : (
        <div className="text-2xl font-medium leading-none">
          {item.nombre.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('')}
          <Package className="hidden" />
        </div>
      )}
      <div className="text-[10px] text-center line-clamp-2 leading-tight opacity-80">
        {item.nombre}
      </div>
      <div className="text-xs font-medium tabular-nums">
        {formatARS(item.precio_madre)}
      </div>
    </button>
  );
}
