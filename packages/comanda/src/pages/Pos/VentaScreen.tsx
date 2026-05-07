import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, Send, Wallet, MoreHorizontal, Package,
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
import { anularVenta } from '@/services/overridesService';
import { db } from '@/lib/supabase';
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
      if (it.estado !== 'disponible') return false;
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

  const editable = venta.estado !== 'cobrada' && venta.estado !== 'anulada';

  async function addItem(it: ItemConGrupo, modificadores: { nombre: string; precio_extra: number; modifier_id?: number }[] = [], notas: string | null = null) {
    if (!editable || !empleado) return;
    const { error } = await agregarItem({
      ventaId, itemId: it.id, cantidad: 1, curso: cursoActivo,
      modificadores: modificadores.length > 0 ? modificadores : null,
      notas,
      cargadoPor: empleado.id,
    });
    if (error) { toast.error(error); return; }
    toast.success(`${it.nombre} agregado al curso ${cursoActivo}`);
    reload();
  }

  async function clickItem(it: ItemConGrupo) {
    if (!editable) return;
    if (itemsConModifiers.has(it.id)) {
      setPendingModifiers(it);
    } else {
      await addItem(it);
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
    <div className="grid grid-cols-[1fr_380px] min-h-[calc(100vh-60px)]">
      {/* CATÁLOGO IZQ */}
      <div className="p-4 overflow-y-auto border-r border-border bg-card">
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
          <SearchInput value={search} onChange={setSearch} placeholder="Buscar producto…" />
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
              onClick={() => clickItem(it)}
            />
          ))}
        </div>
      </div>

      {/* CHECK DER */}
      <aside className="bg-muted/40 border-l border-border flex flex-col">
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
                        editable={editable}
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
          onConfirm={async (mods, notas) => {
            await addItem(pendingModifiers, mods, notas);
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

function CheckRow({ item, catalogo, onQty, editable }:
  { item: VentaPosItem; catalogo: ItemConGrupo[]; onQty: (n: number) => void; editable: boolean }) {
  const it = catalogo.find((c) => c.id === item.item_id);
  return (
    <div
      className={cn(
        'p-2 border-b border-border flex gap-2 items-start',
        item.estado === 'anulado' && 'opacity-40',
      )}
    >
      <div className="text-base">{it?.emoji ?? '📦'}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{it?.nombre ?? `Item #${item.item_id}`}</div>
        {item.modificadores && item.modificadores.length > 0 && (
          <div className="text-xs text-muted-foreground">
            {item.modificadores.map((m) => m.nombre).join(' · ')}
          </div>
        )}
        {item.notas && <div className="text-xs text-warning italic">{item.notas}</div>}
        <div className="text-xs text-muted-foreground mt-0.5">
          {formatARS(item.precio_unitario)} c/u · {item.estado}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        {editable && item.estado === 'hold' ? (
          <Stepper value={Number(item.cantidad)} onChange={onQty} min={0} max={99} />
        ) : (
          <span className="text-xs">x{item.cantidad}</span>
        )}
        <strong className="text-sm tabular-nums">{formatARS(item.subtotal)}</strong>
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

function ProductTile({ item, grupo, disabled, onClick }: {
  item: ItemConGrupo;
  grupo: ItemGrupo | null;
  disabled: boolean;
  onClick: () => void;
}) {
  const ramp = grupo?.color_ramp ?? 'gray';
  const cls = RAMP_CLASSES[ramp] ?? RAMP_CLASSES.gray;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'aspect-[4/3] rounded-lg p-3 flex flex-col items-center justify-center gap-1',
        'transition-transform active:scale-[0.98] touch-target-lg',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
        cls,
      )}
    >
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
