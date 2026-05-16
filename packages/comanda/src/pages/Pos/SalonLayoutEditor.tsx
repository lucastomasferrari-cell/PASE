import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Save, X, Layout, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MesaConVenta } from '@/services/mesasService';
import { updateMesaPosicion } from '@/services/mesasService';
import { cn } from '@/lib/utils';

// Editor de plano de mesas drag-drop estilo Toast. Permite al manager
// arrastrar las mesas a su posición real en el salón. Las posiciones se
// persisten en mesas.pos_x / pos_y (ya existen en el schema). Cuando NO
// está activo el editor, SalonView usa estas posiciones si existen, o
// fallback al grid tradicional.
//
// Implementación pointer-events native (sin lib externa). Soporta touch
// + mouse. Drop guarda al soltar (sin debounce, una request por mesa).

interface Props {
  mesas: MesaConVenta[];
  onClose: () => void;
  onSaved: () => void;
}

const MESA_W = 96;
const MESA_H = 80;
const GRID = 8; // snap a múltiplos de 8px

export function SalonLayoutEditor({ mesas, onClose, onSaved }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);
  // Estado local de posiciones — arranca desde DB. Si no hay pos guardada,
  // calculamos default en grid 4 cols.
  const [posiciones, setPosiciones] = useState<Map<number, { x: number; y: number }>>(() => {
    const map = new Map<number, { x: number; y: number }>();
    mesas.forEach((m, idx) => {
      if (m.pos_x !== null && m.pos_y !== null) {
        map.set(m.id, { x: m.pos_x, y: m.pos_y });
      } else {
        const col = idx % 4;
        const row = Math.floor(idx / 4);
        map.set(m.id, { x: 16 + col * (MESA_W + 16), y: 16 + row * (MESA_H + 16) });
      }
    });
    return map;
  });
  const [dragId, setDragId] = useState<number | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [dirty, setDirty] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  const onPointerDown = useCallback((e: React.PointerEvent, mesaId: number) => {
    if (!canvasRef.current) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const rect = target.getBoundingClientRect();
    dragOffsetRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setDragId(mesaId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragId === null || !canvasRef.current) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    let x = e.clientX - canvasRect.left - dragOffsetRef.current.x;
    let y = e.clientY - canvasRect.top - dragOffsetRef.current.y;
    // Snap a grid 8px
    x = Math.round(x / GRID) * GRID;
    y = Math.round(y / GRID) * GRID;
    // Bound dentro del canvas
    x = Math.max(0, Math.min(canvasRect.width - MESA_W, x));
    y = Math.max(0, Math.min(canvasRect.height - MESA_H, y));
    setPosiciones((p) => {
      const next = new Map(p);
      next.set(dragId, { x, y });
      return next;
    });
  }, [dragId]);

  const onPointerUp = useCallback(() => {
    if (dragId !== null) {
      setDirty((d) => new Set(d).add(dragId));
      setDragId(null);
    }
  }, [dragId]);

  // Si Esc, cierra el editor
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function guardar() {
    if (dirty.size === 0) {
      toast.info('Sin cambios para guardar');
      onClose();
      return;
    }
    setSaving(true);
    const updates = Array.from(dirty).map((id) => {
      const p = posiciones.get(id);
      if (!p) return Promise.resolve({ error: 'sin posicion' });
      return updateMesaPosicion(id, p.x, p.y);
    });
    const results = await Promise.all(updates);
    const errores = results.filter((r) => r.error);
    setSaving(false);
    if (errores.length > 0) {
      toast.error(`${errores.length} mesas no se pudieron guardar`);
      return;
    }
    toast.success(`${dirty.size} mesa${dirty.size === 1 ? '' : 's'} guardada${dirty.size === 1 ? '' : 's'}`);
    setDirty(new Set());
    onSaved();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-40 bg-background flex flex-col">
      {/* Header del editor */}
      <header className="border-b border-border bg-card h-14 px-4 flex items-center gap-3">
        <Layout className="h-5 w-5 text-primary" />
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold">Editar plano del salón</h2>
          <p className="text-xs text-muted-foreground">Arrastrá las mesas a su posición real · snap 8px · Esc para salir</p>
        </div>
        {dirty.size > 0 && (
          <span className="text-xs text-warning tabular-nums">
            {dirty.size} sin guardar
          </span>
        )}
        <Button variant="outline" onClick={onClose} disabled={saving}>
          <X className="h-4 w-4 mr-1" />
          Cancelar
        </Button>
        <Button onClick={guardar} disabled={saving || dirty.size === 0}>
          <Save className="h-4 w-4 mr-1" />
          {saving ? 'Guardando…' : `Guardar ${dirty.size > 0 ? `(${dirty.size})` : ''}`}
        </Button>
      </header>

      {/* Hint inicial */}
      <div className="bg-primary/5 border-b border-primary/20 px-4 py-2 text-xs text-primary flex items-center gap-2">
        <Info className="h-3.5 w-3.5" />
        Las mesas guardadas se ven en el orden del plano al volver al salón. Las que no muevas quedan en grid auto.
      </div>

      {/* Canvas con grid background */}
      <div
        ref={canvasRef}
        className="flex-1 overflow-auto relative"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--border) 1px, transparent 1px)',
          backgroundSize: `${GRID}px ${GRID}px`,
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* Inner: tamaño grande para scroll si hace falta */}
        <div className="relative" style={{ width: 1600, height: 1200 }}>
          {mesas.map((m) => {
            const pos = posiciones.get(m.id) ?? { x: 0, y: 0 };
            const isDirty = dirty.has(m.id);
            const isDragging = dragId === m.id;
            return (
              <div
                key={m.id}
                onPointerDown={(e) => onPointerDown(e, m.id)}
                className={cn(
                  'absolute select-none cursor-move rounded-lg border-2 flex flex-col items-center justify-center text-center transition-shadow touch-none',
                  m.estado === 'libre'
                    ? 'bg-success/10 border-success/30 text-success'
                    : m.estado === 'ocupada'
                      ? 'bg-warning/10 border-warning/30 text-warning'
                      : 'bg-muted border-border',
                  isDirty && 'ring-2 ring-warning',
                  isDragging && 'shadow-2xl scale-105 z-10',
                )}
                style={{
                  left: pos.x,
                  top: pos.y,
                  width: MESA_W,
                  height: MESA_H,
                }}
              >
                <div className="text-2xl font-bold">{m.numero}</div>
                {m.zona && <div className="text-[10px] opacity-70 truncate max-w-full px-1">{m.zona}</div>}
                {m.capacidad && (
                  <div className="text-[9px] opacity-60">{m.capacidad}p</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
