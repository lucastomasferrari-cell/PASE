import React, { useState } from 'react';
import { Send, Trash2, PauseCircle, Play, CloudUpload } from 'lucide-react';
import { formatARS } from '../../../lib/format';
import { cn } from '@/lib/utils';
import type { VentaPosItem } from '../../../types/database';
import type { ItemConGrupo } from '../../../services/itemsService';

// Paleta sobria (Lucas 2026-06-30): el único acento del POS es el índigo
// primary. Los cursos NO se diferencian por color — todos en muted neutro,
// se distinguen por el número.
const CURSO_COLORS: Record<number, string> = {
  1: 'bg-muted text-foreground border-border',
  2: 'bg-muted text-foreground border-border',
  3: 'bg-muted text-foreground border-border',
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
  selected: boolean;
  onSelect: () => void;
}

// Patrón Toast: cada item es UNA línea compacta (cantidad · nombre · porciones
// · precio). Al tocarla se selecciona y recién ahí aparecen sus acciones
// (cantidad, quitar, enviar solo, hold…). Maximiza cuántos items entran sin
// scroll; el envío global vive en el footer (Marchar / Hold / Cobrar).
function CheckRow({
  item, catalogo, onQty, onRemove, onRepetir, onAnular,
  onCambiarPrecio, onCortesia, onMandarSolo, onToggleStay, onEditar,
  editable, usarCursos = true, flashed, selected, onSelect,
}: CheckRowProps) {
  const it = catalogo.find((c) => c.id === item.item_id);
  const anulado = item.estado === 'anulado';
  const enHold = item.estado === 'hold';
  const enStay = item.stay_until_release;
  const qty = Number(item.cantidad);
  const btnCls = 'h-7 px-2.5 rounded text-[11px] font-medium border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors';

  return (
    <div
      className={cn(
        'border-b border-border/40 transition-colors',
        anulado && 'opacity-40',
        flashed && 'bg-primary/10 ring-1 ring-primary/40',
        selected && 'bg-accent/50',
      )}
    >
      {/* Línea compacta — tap para seleccionar / desplegar acciones */}
      <button
        type="button"
        onClick={() => { if (editable && !anulado) onSelect(); }}
        onDoubleClick={editable && enHold ? onEditar : undefined}
        className="w-full flex items-baseline gap-1.5 px-2 py-1.5 text-left"
      >
        {qty > 1 && (
          <span className="text-xs font-semibold tabular-nums text-muted-foreground shrink-0">{qty}×</span>
        )}
        <span className="flex-1 min-w-0 truncate">
          <span className="text-sm font-medium">
            {item.nombre_display ?? it?.nombre ?? `Item #${item.item_id}`}
          </span>
          {item.modificadores && item.modificadores.length > 0 && (
            <span className="text-[11px] text-muted-foreground ml-1.5">
              {item.modificadores.map((m) => m.nombre).join(' · ')}
            </span>
          )}
          {it?.es_cubierto && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-primary/15 text-primary font-bold uppercase ml-1.5">Cubierto</span>
          )}
          {item.es_cortesia && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground font-bold uppercase ml-1.5">Cortesía</span>
          )}
          {item.precio_unitario_original != null && Number(item.precio_unitario_original) !== Number(item.precio_unitario) && !item.es_cortesia && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground font-bold uppercase ml-1.5">Precio mod.</span>
          )}
          {(item as unknown as { _local_dirty?: boolean })._local_dirty && (
            <span className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground font-bold uppercase inline-flex items-center gap-0.5 animate-pulse ml-1.5">
              <CloudUpload className="h-2.5 w-2.5" /> Queued
            </span>
          )}
        </span>
        <strong className="text-sm tabular-nums shrink-0">{formatARS(item.subtotal)}</strong>
      </button>

      {/* Nota / aclaración (solo si existe) */}
      {item.notas && (
        <div className="px-2 pb-1 -mt-0.5 text-[11px] text-muted-foreground italic truncate">{item.notas}</div>
      )}

      {/* Acciones — solo cuando el item está seleccionado */}
      {selected && editable && !anulado && (
        <div className="flex items-center gap-1.5 px-2 pb-2">
          {enHold ? (
            <>
              <div className="flex items-center rounded border border-border divide-x divide-border overflow-hidden">
                <button type="button" className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:bg-accent text-base leading-none"
                  onClick={() => onQty(Math.max(1, qty - 1))}>−</button>
                <span className="w-7 text-center text-xs tabular-nums select-none">{qty}</span>
                <button type="button" className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:bg-accent text-base leading-none"
                  onClick={() => onQty(Math.min(99, qty + 1))}>+</button>
              </div>
              <button type="button" onClick={onRemove} title="Quitar item"
                className="h-7 w-7 flex items-center justify-center rounded text-destructive hover:bg-destructive/10">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
              <div className="flex-1" />
              {usarCursos && (
                <button type="button" onClick={onMandarSolo} title="Enviar solo este item a cocina"
                  className={cn(btnCls, 'inline-flex items-center gap-1')}>
                  <Send className="h-3 w-3" /> Enviar solo
                </button>
              )}
              {usarCursos && (
                <button type="button" onClick={onToggleStay} title={enStay ? 'Liberar' : 'Hold'}
                  className={cn('h-7 px-2.5 rounded text-[11px] font-medium inline-flex items-center gap-1 border transition-colors',
                    enStay
                      ? 'bg-accent text-foreground border-border'
                      : 'bg-muted text-muted-foreground border-border hover:text-foreground hover:bg-accent')}>
                  {enStay ? <Play className="h-3 w-3" /> : <PauseCircle className="h-3 w-3" />}{enStay ? 'Liberar' : 'Hold'}
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" onClick={onRepetir} className={btnCls}>Repetir</button>
              {!item.es_cortesia && <button type="button" onClick={onCambiarPrecio} className={btnCls}>Precio</button>}
              {!item.es_cortesia && <button type="button" onClick={onCortesia} className={btnCls}>Cortesía</button>}
              <div className="flex-1" />
              <button type="button" onClick={onAnular}
                className="h-7 px-2.5 rounded text-[11px] font-medium border border-destructive/30 text-destructive hover:bg-destructive/10">
                Anular
              </button>
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
  // Item seleccionado (patrón Toast): solo el seleccionado muestra sus acciones.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-2">
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
                    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-background/60 text-muted-foreground border border-border font-bold uppercase text-[9px]">
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
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Enviado</span>
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
                    selected={selectedId === it.id}
                    onSelect={() => setSelectedId((cur) => (cur === it.id ? null : it.id))}
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
