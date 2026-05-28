import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, Send, Wallet, MoreHorizontal, Package, Trash2, Star, PauseCircle, Play, CloudUpload,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { type ItemConGrupo } from '../../services/itemsService';
import {
  agregarItem, modificarItem, mandarCurso, mandarItemIndividual, toggleItemStay, updateVentaMeta,
} from '../../services/ventasService';
import type { VentaPosItem, ItemGrupo } from '../../types/database';
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
import { EmitirFacturaDialog } from '@/components/dialogs/EmitirFacturaDialog';
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
import { EstadoVentaBadge } from '@/components/EstadoBadge';
import { cn } from '@/lib/utils';
import { useVentaData } from './hooks/useVentaData';
import { useVentaCursos } from './hooks/useVentaCursos';
import { useVentaOverrides } from './hooks/useVentaOverrides';

const CURSO_COLORS: Record<number, string> = {
  1: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100 border-amber-200 dark:border-amber-800',
  2: 'bg-orange-100 text-orange-900 dark:bg-orange-900/30 dark:text-orange-100 border-orange-200 dark:border-orange-800',
  3: 'bg-purple-100 text-purple-900 dark:bg-purple-900/30 dark:text-purple-100 border-purple-200 dark:border-purple-800',
};

export function VentaScreen() {
  const { ventaId: idStr } = useParams<{ ventaId: string }>();
  const ventaId = Number(idStr);
  const { user } = useAuth();
  const { empleado, toggleFavorito } = useAuthPos();
  const navigate = useNavigate();

  // Hook #1: carga + reload de los 4 datasets primarios + realtime + reconcile
  const { venta, items, catalogo, grupos, loading, reloadVenta } = useVentaData(ventaId);

  // 'favoritos' = filtra solo los Quick Items del empleado; null = todos; N = grupo_id
  const [grupoSel, setGrupoSel] = useState<number | 'favoritos' | null>(null);
  const [search, setSearch] = useState('');
  const [cursoActivo, setCursoActivo] = useState<number>(1);

  // Dialogs
  const [showCobro, setShowCobro] = useState(false);
  const [showEmitirFactura, setShowEmitirFactura] = useState(false);
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

  // Alias para mantener compat con código existente que llama reload()
  const reload = reloadVenta;

  // Notas globales de la venta (editable inline)
  const [editandoNotas, setEditandoNotas] = useState(false);
  const [notasDraft, setNotasDraft] = useState('');

  // Hook #3: state + actions del flow de overrides manager
  const {
    historial,
    historialOpen, setHistorialOpen,
    anularItemTarget, setAnularItemTarget,
    cortesiaItemTarget, setCortesiaItemTarget,
    precioItemTarget, setPrecioItemTarget,
    precioNuevo, setPrecioNuevo,
    precioMotivo, setPrecioMotivo,
    showPrecioMgr, setShowPrecioMgr,
  } = useVentaOverrides(ventaId);

  // Item seleccionado para agotar (abre AgotarDialog)
  const [agotarItem, setAgotarItem] = useState<ItemConGrupo | null>(null);

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

  const favoritosSet = useMemo(
    () => new Set(empleado?.pos_favoritos ?? []),
    [empleado?.pos_favoritos],
  );

  const catalogoFiltrado = useMemo(() => {
    return catalogo.filter((it) => {
      // Mostrar disponibles + agotados (agotados aparecen tachados, long-press
      // los reactiva). Inactivos NO se muestran (es estado de admin).
      if (it.estado !== 'disponible' && it.estado !== 'agotado') return false;
      if (!it.visible_pos) return false;
      if (grupoSel === 'favoritos') {
        if (!favoritosSet.has(it.id)) return false;
      } else if (grupoSel !== null && it.grupo_id !== grupoSel) {
        return false;
      }
      if (search.trim() && !it.nombre.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [catalogo, grupoSel, search, favoritosSet]);

  // Hook #2: derivar agrupaciones por curso (puro, useMemo)
  const { itemsPorCurso, tiempoEstimadoMin, holdCount, stayCount } = useVentaCursos(items, catalogo);

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
    // Confirmación destructiva (UX fix auditoría): tap accidental sin confirm
    // perdía datos sin reversa rápida. Ahora pide confirm explícito.
    const nombre = catalogo.find((c) => c.id === itemRow.item_id)?.nombre ?? `Item #${itemRow.item_id}`;
    if (!confirm(`¿Quitar "${nombre}" × ${itemRow.cantidad} de la venta?`)) return;
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

  // Toggle Quick Item del empleado actual. Persiste en DB + actualiza state.
  // Si llega al máximo (20) la RPC retorna error y lo mostramos.
  async function onToggleFavorito(it: ItemConGrupo) {
    const era = favoritosSet.has(it.id);
    const { ok, error } = await toggleFavorito(it.id);
    if (!ok) { toast.error(error ?? 'No se pudo actualizar favorito'); return; }
    toast.success(era ? `${it.nombre} quitado de favoritos` : `★ ${it.nombre} agregado a favoritos`);
  }

  async function changeQty(itemRow: VentaPosItem, qty: number) {
    if (qty <= 0) return;
    const { error } = await modificarItem(itemRow.id, { cantidad: qty });
    if (error) { toast.error(error); return; }
    reload();
  }

  async function mandarCursoHandler(curso: number) {
    const { count, error } = await mandarCurso(ventaId, curso);
    if (error) { toast.error(error); return; }
    // Sprint 2 F #1: si count=0 puede ser todos en stay → mensaje específico.
    const itemsEnHold = (itemsPorCurso.get(curso) ?? []).filter((i) => i.estado === 'hold');
    const enStay = itemsEnHold.filter((i) => i.stay_until_release).length;
    if (count === 0 && enStay > 0) {
      toast.warning(`Curso ${curso}: ${enStay} item(s) en stay no se enviaron. Liberalos individualmente.`);
    } else {
      toast.success(`Curso ${curso} enviado a cocina${enStay > 0 ? ` (${enStay} en stay quedaron)` : ''}`);
    }
    reload();
  }

  // Sprint 2 F #1: enviar UN item específico (no el curso entero)
  async function mandarItemSolo(itemRow: VentaPosItem) {
    const { error } = await mandarItemIndividual(itemRow.id);
    if (error) { toast.error(error); return; }
    const nombre = catalogo.find((c) => c.id === itemRow.item_id)?.nombre ?? 'Item';
    toast.success(`${nombre} enviado a cocina`);
    reload();
  }

  // Sprint 2 F #1: toggle del flag stay_until_release
  async function toggleStay(itemRow: VentaPosItem) {
    const { stay, error } = await toggleItemStay(itemRow.id);
    if (error) { toast.error(error); return; }
    const nombre = catalogo.find((c) => c.id === itemRow.item_id)?.nombre ?? 'Item';
    toast.success(stay ? `⏸ ${nombre} en STAY (no sale con mandar curso)` : `${nombre} ya no en STAY`);
    reload();
  }

  // Guarda notas globales venta. Se llama desde el inline editor del header.
  async function guardarNotasVenta() {
    const trimmed = notasDraft.trim();
    const { error } = await updateVentaMeta(ventaId, { notas: trimmed || null });
    if (error) { toast.error(error); return; }
    toast.success('Notas guardadas');
    setEditandoNotas(false);
    reload();
  }

  // Toggle coursing automático (curso N+1 dispara solo cuando todos los del N están listos)
  async function toggleCoursingAuto() {
    if (!venta) return;
    const nuevo = !venta.coursing_auto;
    const { error } = await updateVentaMeta(ventaId, { coursing_auto: nuevo });
    if (error) { toast.error(error); return; }
    toast.success(`Coursing automático ${nuevo ? 'activado' : 'desactivado'}`);
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
          {favoritosSet.size > 0 && (
            <GrupoTab active={grupoSel === 'favoritos'} onClick={() => setGrupoSel('favoritos')}>
              ★ Favoritos ({favoritosSet.size})
            </GrupoTab>
          )}
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
              favorito={favoritosSet.has(it.id)}
              onToggleFavorito={() => onToggleFavorito(it)}
              onClick={() => clickItem(it)}
              onLongPress={() => longPressItem(it)}
            />
          ))}
          {catalogoFiltrado.length === 0 && grupoSel === 'favoritos' && !search.trim() && (
            <div className="col-span-full text-center text-muted-foreground text-sm py-8">
              Sin favoritos aún. Tocá la ★ en cualquier producto para agregarlo a tus Quick Items.
            </div>
          )}
          {catalogoFiltrado.length === 0 && search.trim() && (
            <div className="col-span-full text-center text-muted-foreground text-sm py-8">
              Sin resultados para "{search}"
            </div>
          )}
        </div>
      </div>

      {/* CHECK DER — column con header fijo, items scrolleables, footer pinned */}
      <aside className="bg-muted/40 border-l border-border flex flex-col min-h-0 overflow-hidden">
        <div className="p-3 border-b border-border bg-card space-y-2">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Volver
            </Button>
            <strong className="text-base">#{venta.numero_local}</strong>
            <EstadoVentaBadge estado={venta.estado} />
            {venta.tab_nombre && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-bold uppercase" title="Open Tab">
                Tab · {venta.tab_nombre}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {venta.modo === 'salon' && venta.mesa_id && 'Mesa · '}
            {venta.cliente_nombre ?? venta.tab_nombre ?? 'Sin cliente'} · abierta {relativoCorto(venta.abierta_at)}
            {tiempoEstimadoMin > 0 && (
              <span title="Suma de tiempos de prep de los items en hold/cocina">
                {' · ⏱ ~'}{tiempoEstimadoMin}min
              </span>
            )}
          </div>

          {/* Notas globales venta — inline edit */}
          {editandoNotas ? (
            <div className="flex gap-1 items-start">
              <textarea
                value={notasDraft}
                onChange={(e) => setNotasDraft(e.target.value)}
                rows={2}
                placeholder="Ej: cumpleaños — traer torta al final"
                className="flex-1 text-xs rounded-md border border-input bg-background p-1.5 resize-none"
                autoFocus
              />
              <div className="flex flex-col gap-1">
                <Button size="sm" variant="success" className="h-7 px-2 text-[10px]" onClick={guardarNotasVenta}>OK</Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={() => setEditandoNotas(false)}>×</Button>
              </div>
            </div>
          ) : venta.notas ? (
            <button
              type="button"
              onClick={() => { setNotasDraft(venta.notas ?? ''); setEditandoNotas(true); }}
              className="block w-full text-left text-xs italic px-2 py-1.5 rounded bg-warning/10 text-warning-foreground border border-warning/30 hover:bg-warning/15"
              title="Click para editar"
            >
              📝 {venta.notas}
            </button>
          ) : editable ? (
            <button
              type="button"
              onClick={() => { setNotasDraft(''); setEditandoNotas(true); }}
              className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
            >
              + Agregar nota a la mesa
            </button>
          ) : null}

          {/* Coursing automático toggle */}
          {editable && (
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={venta.coursing_auto ?? false}
                onChange={toggleCoursingAuto}
                className="h-3.5 w-3.5"
              />
              <span>Coursing automático <span className="opacity-60">(curso N+1 sale solo cuando termina N)</span></span>
            </label>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {items.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              Sin items. Tocá productos del catálogo para agregar.
            </div>
          ) : (
            Array.from(itemsPorCurso.entries()).map(([curso, itemsCurso]) => {
              const hold = holdCount(curso);
              const stay = stayCount(curso);
              return (
                <div key={curso}>
                  <div className={cn(
                    'flex items-center justify-between gap-2 px-2 py-1.5 rounded-md border text-xs font-medium',
                    CURSO_COLORS[curso] ?? 'bg-muted',
                  )}>
                    <span>Curso {curso}</span>
                    <div className="flex items-center gap-1">
                      {hold > 0 ? (
                        <Badge variant="amber">{hold} en hold</Badge>
                      ) : stay === 0 ? (
                        <Badge variant="green">Enviado</Badge>
                      ) : null}
                      {stay > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-200 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100 font-bold uppercase inline-flex items-center gap-0.5" title="Items en STAY: no salen con mandar curso, requieren liberación individual">
                          <PauseCircle className="h-2.5 w-2.5" /> {stay} stay
                        </span>
                      )}
                    </div>
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
                        onMandarSolo={() => mandarItemSolo(it)}
                        onToggleStay={() => toggleStay(it)}
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
                <DropdownMenuItem onClick={() => setHistorialOpen(true)}>
                  Ver historial de cambios
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
            // Post-cobro: ofrecer emitir factura electrónica. El modal
            // EmitirFacturaDialog chequea solo si AFIP está activo en el
            // tenant; si no lo está, el user igual lo cierra con "solo
            // ticket no fiscal" y navegamos como antes.
            setShowEmitirFactura(true);
          }}
        />
      )}

      {showEmitirFactura && (
        <EmitirFacturaDialog
          open={showEmitirFactura}
          onOpenChange={setShowEmitirFactura}
          venta={venta}
          onClose={() => {
            navigate(venta.modo === 'salon' ? '/pos/salon' : '/pos/mostrador');
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

      {/* Historial de cambios de la venta (overrides aplicados) */}
      <Dialog open={historialOpen} onOpenChange={setHistorialOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-6 pt-6 shrink-0">
            <DialogTitle>Historial de cambios — Venta #{venta.numero_local}</DialogTitle>
            <DialogDescription>
              Todos los overrides aplicados (descuentos, cortesías, cambios de precio, anulaciones, transferencias).
              Cada uno con manager que autorizó + cajero + motivo.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
            {historial.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground italic">
                Sin cambios — esta venta no tuvo overrides aplicados.
              </div>
            ) : (
              <div className="space-y-2">
                {historial.map((h) => (
                  <div key={h.id} className="rounded-md border border-border p-3 bg-card">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-sm font-semibold uppercase">
                        {accionLabel(h.accion)}
                      </span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {new Date(h.created_at).toLocaleString('es-AR')}
                      </span>
                    </div>
                    <div className="text-sm">{h.motivo}</div>
                    <div className="text-[11px] text-muted-foreground mt-1 flex flex-wrap gap-x-3">
                      {h.manager_nombre && <span>👤 Manager: <strong>{h.manager_nombre}</strong></span>}
                      {h.cajero_nombre && h.cajero_nombre !== h.manager_nombre && <span>Cajero: {h.cajero_nombre}</span>}
                      {h.venta_item_id && <span>Item #{h.venta_item_id}</span>}
                      {h.valor_anterior !== null && h.valor_nuevo !== null && (
                        <span>
                          {formatARS(Number(h.valor_anterior))} → <strong>{formatARS(Number(h.valor_nuevo))}</strong>
                        </span>
                      )}
                      {h.monto_afectado !== null && (
                        <span className={cn('font-medium', Number(h.monto_afectado) < 0 ? 'text-destructive' : 'text-success')}>
                          {Number(h.monto_afectado) >= 0 ? '+' : ''}{formatARS(Number(h.monto_afectado))}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

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

// Mapeo human-readable de accion del override
function accionLabel(accion: string): string {
  switch (accion) {
    case 'void': return '❌ Anular item / venta';
    case 'comp': return '🎁 Cortesía';
    case 'discount': return '💰 Descuento / cambio precio';
    case 'refund': return '↩ Reembolso';
    case 'reopen': return '🔓 Reabrir venta';
    case 'transfer_table': return '🔀 Transferir mesa';
    case 'cambio_mozo': return '👤 Cambio de mozo';
    case 'merge_mesas': return '🔗 Unir mesas';
    case 'split_check': return '✂ Partir cuenta';
    default: return accion;
  }
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

function CheckRow({ item, catalogo, onQty, onRemove, onRepetir, onAnular, onCambiarPrecio, onCortesia, onMandarSolo, onToggleStay, editable, flashed }:
  {
    item: VentaPosItem;
    catalogo: ItemConGrupo[];
    onQty: (n: number) => void;
    onRemove: () => void;
    onRepetir: () => void;
    onAnular: () => void;
    onCambiarPrecio: () => void;
    onCortesia: () => void;
    onMandarSolo: () => void;
    onToggleStay: () => void;
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
          {/* Sprint 2 F #1: STAY badge — visible cuando el item está en hold
              permanente. Sirve al cajero para reconocer "este NO sale con mandar curso". */}
          {item.stay_until_release && item.estado === 'hold' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-200 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100 font-bold uppercase inline-flex items-center gap-0.5" title="STAY: no se envía con 'mandar curso'. Liberalo con ▶ para enviarlo.">
              <PauseCircle className="h-2.5 w-2.5" /> Stay
            </span>
          )}
          {/* Fase 4.3 offline-first: indicador de pending sync. Muestra
              el icono de subida cuando el item tiene cambios locales sin
              sincronizar (típico al agregar offline o al volver de un corte). */}
          {(item as unknown as { _local_dirty?: boolean })._local_dirty && (
            <span
              className="text-[9px] px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100 font-bold uppercase inline-flex items-center gap-0.5 animate-pulse"
              title="Pendiente de sincronizar al servidor — se va a subir cuando vuelva internet"
            >
              <CloudUpload className="h-2.5 w-2.5" /> Queued
            </span>
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
          <div className="flex items-center gap-1 mt-0.5 flex-wrap justify-end">
            <button
              type="button"
              onClick={onRepetir}
              aria-label={`Repetir ${it?.nombre ?? 'item'}`}
              title="Agregar uno más igual (mismos modificadores) al curso activo"
              className="text-[10px] text-primary hover:underline"
            >
              + Repetir
            </button>
            {/* Sprint 2 F #1: Send individual + Toggle Stay (solo en hold) */}
            {item.estado === 'hold' && (
              <>
                <button
                  type="button"
                  onClick={onMandarSolo}
                  aria-label="Enviar solo este item"
                  title="Enviar este item a cocina ahora (sin mandar el curso entero)"
                  className="text-[10px] inline-flex items-center gap-0.5 text-success hover:underline"
                >
                  <Send className="h-2.5 w-2.5" /> Enviar solo
                </button>
                <button
                  type="button"
                  onClick={onToggleStay}
                  aria-label={item.stay_until_release ? 'Quitar STAY' : 'Marcar STAY'}
                  title={item.stay_until_release
                    ? 'Quitar STAY — el item volverá a salir cuando se mande el curso'
                    : 'STAY — el item se queda en hold aunque mandes el curso (sale solo cuando lo liberes)'}
                  className={cn(
                    'text-[10px] inline-flex items-center gap-0.5 hover:underline',
                    item.stay_until_release ? 'text-purple-600 dark:text-purple-300 font-medium' : 'text-muted-foreground',
                  )}
                >
                  {item.stay_until_release ? <Play className="h-2.5 w-2.5" /> : <PauseCircle className="h-2.5 w-2.5" />}
                  {item.stay_until_release ? 'Liberar' : 'Stay'}
                </button>
              </>
            )}
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

function ProductTile({ item, grupo, disabled, flashed, favorito, onToggleFavorito, onClick, onLongPress }: {
  item: ItemConGrupo;
  grupo: ItemGrupo | null;
  disabled: boolean;
  flashed?: boolean;
  favorito?: boolean;
  onToggleFavorito?: () => void;
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
    <div className="group relative">
      {/* Estrella favorito — sibling absoluto del tile (NO nested button — HTML
          inválido). Visible siempre si ya es favorito, hover-only si no. */}
      {onToggleFavorito && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleFavorito(); }}
          aria-label={favorito ? 'Quitar de favoritos' : 'Agregar a favoritos'}
          className={cn(
            'absolute top-1 right-1 z-10 h-6 w-6 inline-flex items-center justify-center rounded-full transition-all',
            favorito
              ? 'bg-amber-400 text-white shadow'
              : 'bg-background/70 text-muted-foreground hover:bg-amber-100 hover:text-amber-600 opacity-0 group-hover:opacity-100 focus:opacity-100',
          )}
          title={favorito ? 'Quitar de favoritos' : 'Agregar a Quick Items'}
        >
          <Star className={cn('h-3.5 w-3.5', favorito && 'fill-current')} />
        </button>
      )}
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
        'w-full aspect-[4/3] rounded-lg p-3 flex flex-col items-center justify-center gap-1 relative',
        'transition-all duration-300 active:scale-[0.98] touch-target-lg',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
        cls,
        flashed && 'ring-4 ring-success scale-[1.02]',
        agotado && 'opacity-50',
      )}
      title={agotado ? 'AGOTADO — mantené presionado para reponer' : 'Tocá para agregar · mantené presionado para marcar agotado'}
    >
      {agotado && (
        <div className="absolute inset-0 rounded-lg bg-destructive/10 flex flex-col items-center justify-center pointer-events-none gap-1">
          <div className="bg-destructive text-destructive-foreground px-2 py-0.5 rounded text-[10px] font-bold uppercase rotate-[-12deg] shadow">
            Agotado
          </div>
          {/* Snooze: si tiene fecha hasta cuando se reactiva, mostrar countdown */}
          {item.agotado_hasta && (() => {
            const ms = new Date(item.agotado_hasta).getTime() - Date.now();
            if (ms <= 0) return null;
            const min = Math.floor(ms / 60000);
            const horas = Math.floor(min / 60);
            const label = horas > 0 ? `vuelve en ${horas}h${min % 60}m` : `vuelve en ${min}m`;
            return (
              <div className="bg-background/80 px-1.5 py-0.5 rounded text-[8px] tabular-nums text-foreground/70">
                ⏱ {label}
              </div>
            );
          })()}
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
        <img src={item.foto_url} alt="" loading="lazy" className="w-12 h-12 object-cover rounded" />
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
    </div>
  );
}
