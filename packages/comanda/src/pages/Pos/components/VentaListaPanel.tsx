import React from 'react';
import { Send, Trash2, PauseCircle, Play, CloudUpload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '../../../components/Badge';
import { Stepper } from '../../../components/Stepper';
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
          {item.stay_until_release && item.estado === 'hold' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-purple-200 text-purple-900 dark:bg-purple-900/40 dark:text-purple-100 font-bold uppercase inline-flex items-center gap-0.5" title="STAY: no se envía con 'mandar curso'. Liberalo con ▶ para enviarlo.">
              <PauseCircle className="h-2.5 w-2.5" /> Stay
            </span>
          )}
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
                  onClick={() => onMandarCurso(curso)}
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
