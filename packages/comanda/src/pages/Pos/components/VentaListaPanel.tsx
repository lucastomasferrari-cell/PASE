import React from 'react';
import { Send, Trash2, PauseCircle, Play, CloudUpload } from 'lucide-react';
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
  editable: boolean;
  flashed?: boolean;
}

function CheckRow({
  item, catalogo, onQty, onRemove, onRepetir, onAnular,
  onCambiarPrecio, onCortesia, onMandarSolo, onToggleStay, editable, flashed,
}: CheckRowProps) {
  const it = catalogo.find((c) => c.id === item.item_id);
  const anulado = item.estado === 'anulado';
  return (
    <div
      className={cn(
        'py-1 px-2 border-b border-border transition-colors duration-700',
        anulado && 'opacity-40',
        flashed && 'bg-amber-100/70 dark:bg-amber-900/30 ring-1 ring-amber-400',
      )}
    >
      {/* Línea 1: nombre · controles de qty · precio total */}
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0 flex items-center gap-1 flex-wrap">
          <span className="text-sm font-medium truncate">{it?.nombre ?? `Item #${item.item_id}`}</span>
          {item.es_cortesia && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-success/15 text-success font-bold uppercase">Cortesía</span>
          )}
          {item.precio_unitario_original != null && Number(item.precio_unitario_original) !== Number(item.precio_unitario) && !item.es_cortesia && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-warning/15 text-warning font-bold uppercase">Precio mod.</span>
          )}
          {item.stay_until_release && item.estado === 'hold' && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-purple-200 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100 font-bold uppercase inline-flex items-center gap-0.5">
              <PauseCircle className="h-2.5 w-2.5" /> Stay
            </span>
          )}
          {(item as unknown as { _local_dirty?: boolean })._local_dirty && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-200 text-amber-900 font-bold uppercase inline-flex items-center gap-0.5 animate-pulse">
              <CloudUpload className="h-2.5 w-2.5" /> Queued
            </span>
          )}
        </div>
        {editable && item.estado === 'hold' ? (
          <div className="flex items-center gap-0.5 shrink-0">
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
            <button
              type="button"
              onClick={onRemove}
              title="Quitar"
              className="h-6 w-6 flex items-center justify-center rounded text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground shrink-0">×{item.cantidad}</span>
        )}
        <strong className="text-sm tabular-nums shrink-0">{formatARS(item.subtotal)}</strong>
      </div>

      {/* Línea 2: modificadores / notas / precio u. (solo si hay info extra) */}
      {(item.modificadores && item.modificadores.length > 0 || item.notas) && (
        <div className="text-[11px] text-muted-foreground truncate">
          {item.modificadores?.map((m) => m.nombre).join(' · ')}
          {item.modificadores?.length && item.notas ? ' · ' : ''}
          {item.notas && <span className="text-warning italic">{item.notas}</span>}
        </div>
      )}

      {/* Acciones rápidas */}
      {editable && !anulado && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={onRepetir} className="text-[10px] text-primary hover:underline">+ Repetir</button>
          {item.estado === 'hold' && (
            <>
              <button
                type="button"
                onClick={onMandarSolo}
                className="text-[10px] inline-flex items-center gap-0.5 text-success hover:underline"
              >
                <Send className="h-2.5 w-2.5" /> Enviar solo
              </button>
              <button
                type="button"
                onClick={onToggleStay}
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
          {item.estado !== 'hold' && !item.es_cortesia && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="text-[10px] text-muted-foreground hover:text-foreground px-1 rounded hover:bg-accent">⋯</button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={onCambiarPrecio}>Cambiar precio…</DropdownMenuItem>
                <DropdownMenuItem onClick={onCortesia}>🎁 Cortesía (gratis)</DropdownMenuItem>
                <DropdownMenuItem onClick={onAnular} className="text-destructive">Anular item</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
}

export const VentaListaPanel = React.memo(function VentaListaPanel({
  itemsPorCurso,
  catalogo,
  editable,
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
              {/* Un solo bloque: muestra estado del curso y actúa como botón de envío */}
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
                  <span>Curso {curso}</span>
                  {stay > 0 && (
                    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-purple-200 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100 font-bold uppercase text-[9px]">
                      <PauseCircle className="h-2 w-2" /> {stay} stay
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
  );
});
