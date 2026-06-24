// FloorPlanCanvas — plano visual del salón.
//
// Dos modos:
//   readonly=true  → vista en vivo con colores de estado (ReservasAdmin)
//   readonly=false → editor drag-drop para posicionar mesas (SettingsMesas)
//
// Las mesas sin pos_x/pos_y aparecen en la barra "Sin ubicar" debajo del canvas.

import { useRef, useState, useCallback, type PointerEvent } from 'react';
import { Users, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Mesa, MesaEstadoLive, EstadoMesaLive } from '@/types/database';
import { relativoCorto } from '@/lib/format';

const CANVAS_W = 900;
const CANVAS_H = 540;

function mesaSize(m: Mesa): { w: number; h: number } {
  const w = m.ancho > 0 ? m.ancho : (m.forma === 'rectangular' ? 110 : 80);
  const h = m.alto  > 0 ? m.alto  : (m.forma === 'rectangular' ?  65 : 80);
  return { w, h };
}

const ESTADO_STYLE: Record<EstadoMesaLive, { border: string; bg: string; text: string; dot: string }> = {
  libre:            { border: 'border-emerald-400', bg: 'bg-emerald-50',  text: 'text-emerald-800', dot: 'bg-emerald-400' },
  ocupada_ticket:   { border: 'border-red-400',     bg: 'bg-red-50',      text: 'text-red-800',     dot: 'bg-red-400'     },
  ocupada_reserva:  { border: 'border-indigo-400',  bg: 'bg-indigo-50',   text: 'text-indigo-800',  dot: 'bg-indigo-400'  },
  reservada_pronto: { border: 'border-amber-400',   bg: 'bg-amber-50',    text: 'text-amber-800',   dot: 'bg-amber-400'   },
};

const ESTADO_LABEL: Record<EstadoMesaLive, string> = {
  libre:            'Libre',
  ocupada_ticket:   'Ocupada (ticket)',
  ocupada_reserva:  'En mesa (reserva)',
  reservada_pronto: 'Reservada pronto',
};

export interface FloorPlanCanvasProps {
  mesas: Mesa[];
  estadoLive?: Map<number, MesaEstadoLive>;
  readonly?: boolean;
  onMesaMoved?: (id: number, x: number, y: number) => void;
  onMesaClick?: (mesa: Mesa, estado: MesaEstadoLive | null) => void;
}

export function FloorPlanCanvas({
  mesas,
  estadoLive,
  readonly = true,
  onMesaMoved,
  onMesaClick,
}: FloorPlanCanvasProps) {
  const [localPos, setLocalPos] = useState<Map<number, { x: number; y: number }>>(new Map());
  const drag = useRef<{
    id: number;
    startPX: number;
    startPY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const getPos = useCallback((m: Mesa) => {
    const lp = localPos.get(m.id);
    return { x: lp?.x ?? m.pos_x ?? 0, y: lp?.y ?? m.pos_y ?? 0 };
  }, [localPos]);

  function startDrag(e: PointerEvent<HTMLDivElement>, m: Mesa) {
    if (readonly) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = getPos(m);
    drag.current = { id: m.id, startPX: e.clientX, startPY: e.clientY, origX: x, origY: y };
  }

  function moveDrag(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const d = drag.current;
    const m = mesas.find((mx) => mx.id === d.id);
    if (!m) return;
    const { w, h } = mesaSize(m);
    const nx = Math.max(0, Math.min(CANVAS_W - w, d.origX + e.clientX - d.startPX));
    const ny = Math.max(0, Math.min(CANVAS_H - h, d.origY + e.clientY - d.startPY));
    setLocalPos((prev) => new Map(prev).set(d.id, { x: nx, y: ny }));
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const lp = localPos.get(drag.current.id);
    if (lp) onMesaMoved?.(drag.current.id, Math.round(lp.x), Math.round(lp.y));
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }

  const ubicadas  = mesas.filter((m) => m.pos_x !== null);
  const sinUbicar = mesas.filter((m) => m.pos_x === null);

  return (
    <div className="space-y-3">
      {/* Leyenda */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
        {(Object.entries(ESTADO_STYLE) as [EstadoMesaLive, (typeof ESTADO_STYLE)[EstadoMesaLive]][]).map(([k, s]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={cn('w-2 h-2 rounded-full', s.dot)} />
            {ESTADO_LABEL[k]}
          </span>
        ))}
        {!readonly && (
          <span className="ml-auto text-xs text-muted-foreground/60">Arrastrá las mesas para posicionarlas</span>
        )}
      </div>

      {/* Canvas */}
      <div className="border border-border rounded-xl overflow-auto">
        <div
          className="relative bg-[radial-gradient(circle,_hsl(var(--border))_1px,_transparent_1px)] bg-[size:24px_24px]"
          style={{ width: CANVAS_W, height: CANVAS_H, minWidth: CANVAS_W }}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          {ubicadas.map((m) => {
            const pos = getPos(m);
            const est = estadoLive?.get(m.id) ?? null;
            return (
              <div key={m.id} className="absolute touch-none" style={{ left: pos.x, top: pos.y }}>
                <MesaToken
                  mesa={m}
                  estado={est}
                  draggable={!readonly}
                  onPointerDown={(e) => startDrag(e, m)}
                  onClick={() => onMesaClick?.(m, est)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Sin ubicar */}
      {sinUbicar.length > 0 && (
        <div className="rounded-lg border border-dashed border-border p-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">Sin ubicar en el plano</p>
          <div className="flex flex-wrap gap-2">
            {sinUbicar.map((m) => {
              const est = estadoLive?.get(m.id) ?? null;
              return (
                <MesaToken
                  key={m.id}
                  mesa={m}
                  estado={est}
                  draggable={false}
                  onPointerDown={() => {}}
                  onClick={() => onMesaClick?.(m, est)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Token de mesa (visual individual) ────────────────────────────────────────
interface TokenProps {
  mesa: Mesa;
  estado: MesaEstadoLive | null;
  draggable: boolean;
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onClick: () => void;
}

function MesaToken({ mesa, estado, draggable, onPointerDown, onClick }: TokenProps) {
  const { w, h } = mesaSize(mesa);
  const esLive = estado?.estado_live ?? 'libre';
  const s = ESTADO_STYLE[esLive];

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center border-2 select-none transition-shadow',
        s.border, s.bg, s.text,
        mesa.forma === 'redondo' ? 'rounded-full' : 'rounded-lg',
        draggable && 'cursor-grab active:cursor-grabbing hover:shadow-lg',
        !draggable && 'cursor-pointer hover:shadow-md',
      )}
      style={{ width: w, height: h }}
      onPointerDown={onPointerDown}
      onClick={onClick}
    >
      <span className="text-xs font-bold leading-tight">{mesa.numero}</span>

      {mesa.capacidad != null && (
        <span className="flex items-center gap-0.5 text-[10px] opacity-70 mt-0.5">
          <Users className="h-2.5 w-2.5" />{mesa.capacidad}
        </span>
      )}

      {estado && esLive !== 'libre' && (
        <span className="text-[10px] mt-0.5 opacity-80 leading-none text-center px-0.5 w-full truncate">
          {esLive === 'ocupada_ticket' && estado.venta_abierta_at ? (
            <span className="flex items-center justify-center gap-0.5">
              <Clock className="h-2.5 w-2.5 flex-shrink-0" />
              {relativoCorto(estado.venta_abierta_at)}
            </span>
          ) : estado.reserva_nombre ? (
            estado.reserva_nombre.split(' ')[0]
          ) : null}
        </span>
      )}
    </div>
  );
}
