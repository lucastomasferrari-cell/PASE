import React from 'react';
import { Send, Trash2, PauseCircle, Play, CloudUpload, MoreHorizontal } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '../../../components/Badge';
import { formatARS } from '../../../lib/format';
import { cn } from '@/lib/utils';
import type { VentaPosItem } from '../../../types/database';
import type { ItemConGrupo } from '../../../services/itemsService';

const CURSO_COLORS: Record<number, string> = {
  1: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100 border-amber-200 dark:border-amber-800',
  2: 'bg-orange-100 text-orange-900 dark:bg-orange-900/30 dark:text-orange-100 border-orange-200 dark:border-orange-800',
  3: 'bg-purple-100 text-purple-900 dark:bg-purple-900/30 dark:text-purple-100 border-purple-200 dark:border-purple-800',
};

interface CheckRowProps {
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
  onEditar: () => void;
  editable: boolean;
  usarCursos?: boolean;
  flashed?: boolean;
}

function CheckRow({
  item, catalogo, onQty, onRemove, onRepetir, onAnular,
  onCambiarPrecio, onCortesia, onMandarSolo, onToggleStay, onEditar, editable, usarCursos = true, flashed,
}: CheckRowProps) {
  const it = catalogo.find((c) => c.id === item.item_id);
  const anulado = item.estado === 'anulado';
  const enHold = item.estado === 'hold';
  const enStay = item.stay_until_release;

  return (
    <div
      className={cn(
        'py-1.5 px-2 border-b border-border/40 transition-colors duration-700',
        anulado && 'opacity-40',
        flashed && 'bg-amber-100/70 dark:bg-amber-900/30 ring-1 ring-amber-400',
      )}
    >
      {/* Línea 1: nombre + precio */}
      <div className="flex items-start gap-1.5">
        <div className="flex-1 min-w-0">
          <span
            className={cn(
              'text-sm font-medium',
              editable && enHold && 'cursor-pointer hover:text-primary',
            )}
            onDoubleClick={editable && enHold ? onEditar : undefined}
            title={editable && enHold ? 'Doble click para editar nombre o precio' : undefined}
          >
            {item.nombre_display ?? it?.nombre ?? `Item #${item.item_id}`}
          </span>
          {/* Badges inline */}
          <span className="inline-flex gap-1 ml-1.5 align-middle">
            {item.es_cortesia && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-success/15 text-success font-bold uppercase">Cortesía</span>
            )}
            {item.precio_unitario_original != null && Number(item.precio_unitario_original) !== Number(item.precio_unitario) && !item.es_cortesia && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-warning/15 text-warning font-bold uppercase">Precio mod.</span>
            )}
            {(item as unknown as { _local_dirty?: boolean })._local_dirty && (
              <span className="text-[9px] px-1 py-0.5 rounded bg-amber-200 text-amber-900 font-bold uppercase inline-flex items-center gap-0.5 animate-pulse">
                <CloudUpload className="h-2.5 w-2.5" /> Queued
              </span>
            )}
          </span>
        </div>
        <strong className="text-sm tabular-nums shrink-0">{formatARS(item.subtotal)}</strong>
      </div>

      {/* Modificadores / notas */}
      {(item.modificadores && item.modificadores.length > 0 || item.notas) && (
        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
          {item.modificadores?.map((m) => m.nombre).join(' · ')}
          {item.modificadores?.length && item.notas ? ' · ' : ''}
          {item.notas && <span className="text-warning italic">{item.notas}</span>}
        </div>
      )}

      {/* Fila de controles */}
      {editable && !anulado && (
        <div className="flex items-center gap-1.5 mt-1">

          {enHold ? (
            <>
              {/* Cantidad */}
              <div className="flex items-center rounded border border-border divide-x divide-border overflow-hidden">
                <button
                  type="button"
                  className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:bg-accent text-base leading-none"
                  onClick={() => onQty(Math.max(1, Number(item.cantidad) - 1))}
                >−</button>
                <span className="w-6 text-center text-xs tabular-nums select-none">{item.cantidad}</span>
                <button
                  type="button"
                  className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:bg-accent text-base leading-none"
                  onClick={() => onQty(Math.min(99, Number(item.cantidad) + 1))}
                >+</button>
              </div>

              {/* Quitar */}
              <button
                type="button"
                onClick={onRemove}
                title="Quitar item"
                className="h-6 w-6 flex items-center justify-center rounded text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3 w-3" />
              </button>

              <div className="flex-1" />

              {/* Enviar solo — solo con cursos */}
              {usarCursos && (
                <button
                  type="button"
                  onClick={onMandarSolo}
                  title="Enviar solo este item a cocina"
                  className="h-6 px-2 rounded text-[11px] font-medium inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-900/50 border border-emerald-200 dark:border-emerald-800"
                >
                  <Send className="h-2.5 w-2.5" />
                  Enviar solo
                </button>
              )}

              {/* Stay toggle — solo con cursos */}
              {usarCursos && (
                <button
                  type="button"
                  onClick={onToggleStay}
                  title={enStay ? 'Liberar (sale cuando marchás el curso)' : 'Hold: retener aunque marches el curso'}
                  className={cn(
                    'h-6 px-2 rounded text-[11px] font-medium inline-flex items-center gap-1 border transition-colors',
                    enStay
                      ? 'bg-purple-100 text-purple-800 border-purple-300 hover:bg-purple-200 dark:bg-purple-950/50 dark:text-purple-200 dark:border-purple-700'
                      : 'bg-muted text-muted-foreground border-border hover:text-foreground hover:bg-accent',
                  )}
                >
                  {enStay ? <Play className="h-2.5 w-2.5" /> : <PauseCircle className="h-2.5 w-2.5" />}
                  {enStay ? 'Liberar' : 'Hold'}
                </button>
              )}
            </>
          ) : (
            <>
              {/* Item ya enviado: cantidad + menú override (incluye Repetir) */}
              <span className="text-xs text-muted-foreground">×{item.cantidad}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent ml-auto"
                  >
                    <MoreHorizontal className="h-3 w-3" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={onRepetir}>Repetir item</DropdownMenuItem>
                  {!item.es_cortesia && <DropdownMenuItem onClick={onCambiarPrecio}>Cambiar precio…</DropdownMenuItem>}
                  {!item.es_cortesia && <DropdownMenuItem onClick={onCortesia}>Cortesía (gratis)</DropdownMenuItem>}
                  <DropdownMenuItem onClick={onAnular} className="text-destructive">Anular item</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export interface VentaListaPanelProps {
  itemsPorCurso: Map<number, VentaPosItem[]>;
  catalogo: ItemConGrupo[];
  editable: boolean;
  usarCursos?: boolean;
  lastAddedRowId: number | null;
  holdCount: (curso: number) => number;
  stayCount: (curso: number) => number;
  onModificarCantidad: (item: VentaPosItem, nueva: number) => void;
  onRemoveItem: (item: VentaPosItem) => void;
  onRepetirItem: (item: VentaPosItem) => void;
  onAnularItem: (item: VentaPosItem) => void;
  onCortesiaItem: (item: VentaPosItem) => void;
  onCambiarPrecio: (item: VentaPosItem) => void;
  onToggleStay: (item: VentaPosItem) => void;
  onMandarItemSolo: (item: VentaPosItem) => void;
  onMandarCurso: (curso: number) => void;
  onEditarItem: (item: VentaPosItem) => void;
}

export const VentaListaPanel = React.memo(function VentaListaPanel({
  itemsPorCurso,
  catalogo,
  editable,
  usarCursos = true,
  lastAddedRowId,
  holdCount,
  stayCount,
  onModificarCantidad,
  onRemoveItem,
  onRepetirItem,
  onAnularItem,
  onCortesiaItem,
  onCambiarPrecio,
  onToggleStay,
  onMandarItemSolo,
  onMandarCurso,
  onEditarItem,
}: VentaListaPanelProps) {
  const totalItems = Array.from(itemsPorCurso.values()).reduce((s, a) => s + a.length, 0);
  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-3">
      {totalItems === 0 ? (
        <div className="py-8 text-center text-muted-foreground text-sm">
          Sin items. Tocá productos del catálogo para agregar.
        </div>
      ) : (
        Array.from(itemsPorCurso.entries()).map(([curso, itemsCurso]) => {
          const hold = holdCount(curso);
          const stay = stayCount(curso);
          return (
            <div key={curso}>
              {/* Header del curso — clickeable para marchar */}
              <button
                type="button"
                onClick={() => { if (hold > 0 && editable) onMandarCurso(curso); }}
                disabled={hold === 0 || !editable}
                className={cn(
                  'w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md border text-xs font-medium transition-colors',
                  hold > 0 && editable ? 'hover:brightness-95 active:brightness-90 cursor-pointer' : 'cursor-default',
                  CURSO_COLORS[curso] ?? 'bg-muted',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span>{usarCursos ? `Curso ${curso}` : 'Pedido'}</span>
                  {usarCursos && stay > 0 && (
                    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-purple-200 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100 font-bold uppercase text-[9px]">
                      <PauseCircle className="h-2 w-2" /> {stay} hold
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {hold > 0 ? (
                    <>
                      <span className="opacity-70">{hold} sin enviar</span>
                      {editable && <Send className="h-3 w-3" />}
                    </>
                  ) : stay === 0 ? (
                    <Badge variant="green">Enviado</Badge>
                  ) : null}
                </div>
              </button>

              <div className="mt-1">
                {itemsCurso.map((it) => (
                  <CheckRow
                    key={it.id}
                    item={it}
                    catalogo={catalogo}
                    onQty={(n) => onModificarCantidad(it, n)}
                    onRemove={() => onRemoveItem(it)}
                    onRepetir={() => onRepetirItem(it)}
                    onAnular={() => onAnularItem(it)}
                    onCambiarPrecio={() => onCambiarPrecio(it)}
                    onCortesia={() => onCortesiaItem(it)}
                    onMandarSolo={() => onMandarItemSolo(it)}
                    onToggleStay={() => onToggleStay(it)}
                    onEditar={() => onEditarItem(it)}
                    editable={editable}
                    usarCursos={usarCursos}
                    flashed={lastAddedRowId === it.id}
                  />
                ))}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
});
