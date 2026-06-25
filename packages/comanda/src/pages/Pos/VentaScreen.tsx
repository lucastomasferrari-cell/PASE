import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '../../lib/auth';
import { useAuthPos } from '../../lib/authPos';
import { type ItemConGrupo } from '../../services/itemsService';
import {
  agregarItem, modificarItem, mandarCurso, mandarItemIndividual, toggleItemStay, updateVentaMeta,
} from '../../services/ventasService';
import type { VentaPosItem } from '../../types/database';
import { formatARS } from '../../lib/format';
import { Button } from '@/components/ui/button';
import { ModifiersDialog } from '@/components/dialogs/ModifiersDialog';
import { PaymentDialog } from '@/components/dialogs/PaymentDialog';
import { EmitirFacturaDialog } from '@/components/dialogs/EmitirFacturaDialog';
import { getCredencialesAFIP } from '@/lib/afip/service';
import { DiscountDialog } from '@/components/dialogs/DiscountDialog';
import { TransferMesaDialog } from '@/components/dialogs/TransferMesaDialog';
import { MergeMesasDialog } from '@/components/dialogs/MergeMesasDialog';
import { SplitCheckDialog } from '@/components/dialogs/SplitCheckDialog';
import { ComensalSplitDialog } from '@/components/dialogs/ComensalSplitDialog';
import { ManagerOverrideDialog } from '@/components/dialogs/ManagerOverrideDialog';
import { anularVenta, anularItem, modificarPrecioItem, cortesiaItem } from '@/services/overridesService';
import { marcarDisponible } from '@/services/itemsService';
import { AgotarDialog } from '@/pages/Catalogo/AgotarDialog';
import { MoneyInput } from '@/components/MoneyInput';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { db } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useVentaData } from './hooks/useVentaData';
import { useVentaCursos } from './hooks/useVentaCursos';
import { useVentaOverrides } from './hooks/useVentaOverrides';
import { VentaHeader } from './components/VentaHeader';
import { VentaCatalogoPanel } from './components/VentaCatalogoPanel';
import { VentaListaPanel } from './components/VentaListaPanel';
import { VentaFooter } from './components/VentaFooter';

// Helper: accion → label human-readable del override
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

export function VentaScreen() {
  const { ventaId: idStr } = useParams<{ ventaId: string }>();
  const ventaId = Number(idStr);
  const { user } = useAuth();
  const { empleado, toggleFavorito } = useAuthPos();
  const navigate = useNavigate();

  // Hook #1: carga + reload de los 4 datasets primarios + realtime + reconcile
  const { venta, items, setItems, catalogo, grupos, loading, reloadVenta, addOptimistic, reconcileAdd } = useVentaData(ventaId);

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
  const [showComensalSplit, setShowComensalSplit] = useState(false);
  const [showAnular, setShowAnular] = useState(false);
  const [pendingModifiers, setPendingModifiers] = useState<ItemConGrupo | null>(null);

  // Cache de qué items tienen modifier_groups asignados (para decidir si abre dialog)
  const [itemsConModifiers, setItemsConModifiers] = useState<Set<number>>(new Set());

  // UX deep: feedback visual al agregar
  const [lastAddedItemId, setLastAddedItemId] = useState<number | null>(null);
  const [lastAddedRowId, setLastAddedRowId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Anti-double-tap: evita agregar el mismo producto 2 veces en < 350ms
  const clickCooldownRef = useRef<Map<number, number>>(new Map());

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

  // Editor inline de nombre/precio (doble click en la lista)
  const [editandoItem, setEditandoItem] = useState<VentaPosItem | null>(null);
  const [editNombreDraft, setEditNombreDraft] = useState('');
  const [editPrecioDraft, setEditPrecioDraft] = useState(0);

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

  // Cross-local guard: si la venta es de otro local, NO permitir operar
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

  const cursosExistentes = Array.from(itemsPorCurso.keys());
  const maxCurso = Math.max(3, ...cursosExistentes);

  async function addItem(it: ItemConGrupo, modificadores: { nombre: string; precio_extra: number; modifier_id?: number }[] = [], notas: string | null = null, cantidad: number = 1) {
    if (!editable || !empleado || !venta) return;

    // Merge: si el mismo producto ya está en hold en el mismo curso, sin
    // modificadores ni notas, incrementamos la cantidad en vez de crear nueva fila.
    if (modificadores.length === 0 && notas == null) {
      const existente = items.find(
        (i) => i.item_id === it.id && i.curso === cursoActivo && i.estado === 'hold'
          && (!i.modificadores || i.modificadores.length === 0) && !i.notas && i.id > 0,
      );
      if (existente) {
        const nuevaCantidad = Number(existente.cantidad) + cantidad;
        setItems((prev) => prev.map((i) => i.id === existente.id ? { ...i, cantidad: nuevaCantidad } : i));
        setLastAddedItemId(it.id);
        setLastAddedRowId(existente.id);
        setSearch('');
        searchRef.current?.focus();
        const { error } = await modificarItem(existente.id, { cantidad: nuevaCantidad });
        if (error) {
          toast.error(error);
          setItems((prev) => prev.map((i) => i.id === existente.id ? { ...i, cantidad: existente.cantidad } : i));
          return;
        }
        reload();
        return;
      }
    }

    // UI optimista: la fila aparece YA (id temporal negativo), sin esperar el
    // round-trip. El precio definitivo lo pone el server; acá usamos precio_madre
    // + modificadores como estimación (se reconcilia al refrescar).
    const precio = Number(it.precio_madre ?? 0);
    const sumMods = modificadores.reduce((s, m) => s + Number(m.precio_extra ?? 0), 0);
    const ahora = new Date().toISOString();
    const tempId = addOptimistic({
      tenant_id: venta.tenant_id, local_id: venta.local_id, venta_id: ventaId,
      item_id: it.id, cantidad, precio_unitario: precio, subtotal: (precio + sumMods) * cantidad,
      descuento: 0, modificadores: modificadores.length > 0 ? modificadores : null,
      curso: cursoActivo, comensal: null, combo_padre_id: null, es_combo_padre: false,
      estado: 'hold', enviado_at: null, listo_at: null, anulado_at: null, anulado_motivo: null,
      notas, nombre_display: null, cargado_por: empleado.id, es_cortesia: false, precio_unitario_original: null,
      stay_until_release: false, created_at: ahora, updated_at: ahora, deleted_at: null,
    });
    setLastAddedItemId(it.id);
    setLastAddedRowId(tempId);
    setSearch('');
    searchRef.current?.focus();

    const { id, error } = await agregarItem({
      ventaId, itemId: it.id, cantidad, curso: cursoActivo,
      modificadores: modificadores.length > 0 ? modificadores : null,
      notas,
      cargadoPor: empleado.id,
    });
    if (error) {
      toast.error(error);
      reconcileAdd(tempId, null); // sacá la fila optimista — el INSERT falló
      return;
    }
    reconcileAdd(tempId, id);
    if (id != null) setLastAddedRowId(id);
    // Sin reload() bloqueante: el realtime de ventas_pos_items trae la fila
    // canónica y reconcilia. Igual disparamos uno liviano por las dudas.
    reload();
  }

  async function repetirItem(itemRow: VentaPosItem) {
    if (!editable || !empleado) return;
    const cat = catalogo.find((c) => c.id === itemRow.item_id);
    if (!cat) { toast.error('Item no encontrado en catálogo'); return; }
    const mods = itemRow.modificadores?.map((m) => ({
      nombre: m.nombre,
      precio_extra: Number(m.precio_extra),
      modifier_id: m.modifier_id,
    })) ?? [];
    // Delega en addItem → misma UI optimista (la fila aparece al instante).
    await addItem(cat, mods, itemRow.notas ?? null, 1);
  }

  async function removeItem(itemRow: VentaPosItem) {
    if (!editable) return;
    if (itemRow.estado !== 'hold') {
      toast.error('Solo se pueden quitar items en hold (no enviados a cocina)');
      return;
    }
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
    const now = Date.now();
    const last = clickCooldownRef.current.get(it.id) ?? 0;
    if (now - last < 350) return;
    clickCooldownRef.current.set(it.id, now);
    if (itemsConModifiers.has(it.id)) {
      setPendingModifiers(it);
    } else {
      await addItem(it);
    }
  }

  async function longPressItem(it: ItemConGrupo) {
    if (it.estado === 'agotado') {
      const ok = confirm(`¿Reponer "${it.nombre}" al catálogo?`);
      if (!ok) return;
      const { error } = await marcarDisponible(it.id);
      if (error) { toast.error(error); return; }
      toast.success(`${it.nombre} disponible de nuevo`);
      reload();
    } else {
      setAgotarItem(it);
    }
  }

  async function onToggleFavorito(it: ItemConGrupo) {
    const era = favoritosSet.has(it.id);
    const { ok, error } = await toggleFavorito(it.id);
    if (!ok) { toast.error(error ?? 'No se pudo actualizar favorito'); return; }
    toast.success(era ? `${it.nombre} quitado de favoritos` : `★ ${it.nombre} agregado a favoritos`);
  }

  async function changeQty(itemRow: VentaPosItem, qty: number) {
    if (qty <= 0) return;
    // Optimista: refleja el cambio antes de esperar la red
    setItems((prev) => prev.map((i) =>
      i.id === itemRow.id
        ? { ...i, cantidad: qty, subtotal: qty * Number(i.precio_unitario) }
        : i,
    ));
    const { error } = await modificarItem(itemRow.id, { cantidad: qty });
    if (error) { toast.error(error); reload(); return; }
    reload(); // actualiza total de la venta
  }

  async function guardarEdicionItem() {
    if (!editandoItem) return;
    const nombre = editNombreDraft.trim() || null;
    const precio = editPrecioDraft > 0 ? editPrecioDraft : undefined;
    // Optimista
    setItems((prev) => prev.map((i) =>
      i.id === editandoItem.id
        ? {
            ...i,
            nombre_display: nombre,
            precio_unitario: precio ?? Number(i.precio_unitario),
            subtotal: Number(i.cantidad) * (precio ?? Number(i.precio_unitario)),
          }
        : i,
    ));
    setEditandoItem(null);
    const { error } = await modificarItem(editandoItem.id, {
      nombre_display: nombre,
      precio_unitario: precio,
    });
    if (error) { toast.error(error); reload(); return; }
    reload();
  }

  async function mandarCursoHandler(curso: number) {
    const { count, error } = await mandarCurso(ventaId, curso);
    if (error) { toast.error(error); return; }
    const itemsEnHold = (itemsPorCurso.get(curso) ?? []).filter((i) => i.estado === 'hold');
    const enStay = itemsEnHold.filter((i) => i.stay_until_release).length;
    if (count === 0 && enStay > 0) {
      toast.warning(`Curso ${curso}: ${enStay} item(s) en stay no se enviaron. Liberalos individualmente.`);
    } else {
      toast.success(`Curso ${curso} enviado a cocina${enStay > 0 ? ` (${enStay} en stay quedaron)` : ''}`);
    }
    reload();
  }

  async function mandarItemSolo(itemRow: VentaPosItem) {
    const { error } = await mandarItemIndividual(itemRow.id);
    if (error) { toast.error(error); return; }
    const nombre = catalogo.find((c) => c.id === itemRow.item_id)?.nombre ?? 'Item';
    toast.success(`${nombre} enviado a cocina`);
    reload();
  }

  async function toggleStay(itemRow: VentaPosItem) {
    const { stay, error } = await toggleItemStay(itemRow.id);
    if (error) { toast.error(error); return; }
    const nombre = catalogo.find((c) => c.id === itemRow.item_id)?.nombre ?? 'Item';
    toast.success(stay ? `⏸ ${nombre} en STAY (no sale con mandar curso)` : `${nombre} ya no en STAY`);
    reload();
  }

  async function guardarNotasVenta() {
    const trimmed = notasDraft.trim();
    const { error } = await updateVentaMeta(ventaId, { notas: trimmed || null });
    if (error) { toast.error(error); return; }
    toast.success('Notas guardadas');
    setEditandoNotas(false);
    reload();
  }

  async function toggleCoursingAuto() {
    if (!venta) return;
    const nuevo = !venta.coursing_auto;
    const { error } = await updateVentaMeta(ventaId, { coursing_auto: nuevo });
    if (error) { toast.error(error); return; }
    toast.success(`Coursing automático ${nuevo ? 'activado' : 'desactivado'}`);
    reload();
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_380px] h-[calc(100dvh-3.5rem)] overflow-hidden">
      {/* CATÁLOGO IZQ */}
      <VentaCatalogoPanel
        catalogo={catalogo}
        catalogoFiltrado={catalogoFiltrado}
        grupos={grupos}
        favoritosSet={favoritosSet}
        grupoSel={grupoSel}
        search={search}
        editable={editable}
        cursoActivo={cursoActivo}
        maxCurso={maxCurso}
        lastAddedItemId={lastAddedItemId}
        searchRef={searchRef}
        setGrupoSel={setGrupoSel}
        setSearch={setSearch}
        setCursoActivo={setCursoActivo}
        onSearchKeyDown={onSearchKeyDown}
        onAddItem={clickItem}
        onLongPress={longPressItem}
        onToggleFav={onToggleFavorito}
      />

      {/* CHECK DER — column con header fijo, items scrolleables, footer pinned */}
      <aside className="bg-muted/40 border-l border-border flex flex-col min-h-0 overflow-hidden">
        <VentaHeader
          venta={venta}
          editable={editable}
          editandoNotas={editandoNotas}
          notasDraft={notasDraft}
          onBack={() => navigate(-1)}
          onNotasDraftChange={setNotasDraft}
          onEditNotas={() => { setNotasDraft(venta.notas ?? ''); setEditandoNotas(true); }}
          onCancelNotas={() => setEditandoNotas(false)}
          onGuardarNotas={guardarNotasVenta}
          onDescuento={() => setShowDescuento(true)}
          onTransfer={() => setShowTransfer(true)}
          onMerge={() => setShowMerge(true)}
          onSplit={() => setShowSplit(true)}
          onDividirComensal={() => setShowComensalSplit(true)}
          onAnular={() => setShowAnular(true)}
          onOpenHistorial={() => setHistorialOpen(true)}
          tiempoEstimadoMin={tiempoEstimadoMin}
          coursingAuto={venta.coursing_auto ?? false}
          onToggleCoursingAuto={toggleCoursingAuto}
        />

        <VentaListaPanel
          itemsPorCurso={itemsPorCurso}
          catalogo={catalogo}
          editable={editable}
          lastAddedRowId={lastAddedRowId}
          holdCount={holdCount}
          stayCount={stayCount}
          onModificarCantidad={changeQty}
          onRemoveItem={removeItem}
          onRepetirItem={repetirItem}
          onAnularItem={(it) => setAnularItemTarget(it)}
          onCortesiaItem={(it) => setCortesiaItemTarget(it)}
          onCambiarPrecio={(it) => {
            setPrecioItemTarget(it);
            setPrecioNuevo(Number(it.precio_unitario));
            setPrecioMotivo('');
          }}
          onToggleStay={toggleStay}
          onMandarItemSolo={mandarItemSolo}
          onMandarCurso={mandarCursoHandler}
          onEditarItem={(it) => {
            setEditandoItem(it);
            setEditNombreDraft(it.nombre_display ?? '');
            setEditPrecioDraft(Number(it.precio_unitario));
          }}
        />

        <VentaFooter
          venta={venta}
          editable={editable}
          onCobrar={() => setShowCobro(true)}
        />
      </aside>

      {/* Dialogs — se mantienen inline (Fase 5 evaluará agruparlos si aplica) */}
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
            void getCredencialesAFIP().then((r) => {
              if (r.data?.activa) setShowEmitirFactura(true);
              else navigate(venta.modo === 'salon' ? '/pos/salon' : '/pos/mostrador');
            });
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
          localId={venta?.local_id}
          onPartida={(nueva) => {
            toast.success(`Cuenta partida — venta nueva #${nueva}`);
            reload();
          }}
        />
      )}

      {showComensalSplit && (
        <ComensalSplitDialog
          open={showComensalSplit}
          onOpenChange={setShowComensalSplit}
          venta={venta}
          empleadoId={empleado.id}
          onCobrado={() => {
            reload();
            void getCredencialesAFIP().then((r) => {
              if (r.data?.activa) setShowEmitirFactura(true);
              else navigate(venta.modo === 'salon' ? '/pos/salon' : '/pos/mostrador');
            });
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

      {/* Anular item con manager override */}
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

      {/* Cortesía con manager override */}
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
          const idempotencyKey = `anular-${ventaId}-${Math.floor(Date.now() / 5000)}`;
          const { error } = await anularVenta(ventaId, managerId, motivo, idempotencyKey);
          if (error) throw new Error(error);
          toast.success('Venta anulada');
          navigate(venta.modo === 'salon' ? '/pos/salon' : '/pos/mostrador');
        }}
      />

      {/* Editor inline de ítem — doble click en el nombre */}
      <Dialog open={editandoItem !== null} onOpenChange={(o) => { if (!o) setEditandoItem(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Editar ítem</DialogTitle>
            <DialogDescription>
              {editandoItem && (() => {
                const cat = catalogo.find((c) => c.id === editandoItem.item_id);
                return `${cat?.nombre ?? 'Item'} — precio original ${formatARS(editandoItem.precio_unitario)}`;
              })()}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Nombre en cuenta (dejar vacío = usa el del catálogo)</label>
              <input
                type="text"
                value={editNombreDraft}
                onChange={(e) => setEditNombreDraft(e.target.value)}
                placeholder={editandoItem ? (catalogo.find((c) => c.id === editandoItem.item_id)?.nombre ?? '') : ''}
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
                maxLength={80}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Precio unitario</label>
              <MoneyInput value={editPrecioDraft} onChange={setEditPrecioDraft} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditandoItem(null)}>Cancelar</Button>
            <Button onClick={guardarEdicionItem} disabled={editPrecioDraft <= 0}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
