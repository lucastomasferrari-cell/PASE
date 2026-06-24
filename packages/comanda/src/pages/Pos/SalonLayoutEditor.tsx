import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Save, X, Layout, Info, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { MesaConVenta } from '@/services/mesasService';
import { updateMesaEditor } from '@/services/mesasService';
import type { FormaMesa } from '@/types/database';
import { cn } from '@/lib/utils';

interface Props {
  mesas: MesaConVenta[];
  onClose: () => void;
  onSaved: () => void;
}

const FORMA_SIZES: Record<FormaMesa, { w: number; h: number }> = {
  cuadrado:    { w: 88,  h: 88  },
  redondo:     { w: 88,  h: 88  },
  rectangular: { w: 140, h: 80  },
};

const FORMA_LABELS: Record<FormaMesa, string> = {
  cuadrado:    '□ Cuadrado',
  redondo:     '○ Redondo',
  rectangular: '▭ Rectangular',
};

const GRID = 8;
const CANVAS_W = 1600;
const CANVAS_H = 1200;

export function SalonLayoutEditor({ mesas, onClose, onSaved }: Props) {
  const canvasRef = useRef<HTMLDivElement>(null);   // inner scaled div
  const wrapperRef = useRef<HTMLDivElement>(null);  // outer scrollable wrapper

  // ── Posiciones ───────────────────────────────────────────────────────────
  const [posiciones, setPosiciones] = useState<Map<number, { x: number; y: number }>>(() => {
    const map = new Map<number, { x: number; y: number }>();
    mesas.forEach((m, idx) => {
      if (m.pos_x !== null && m.pos_y !== null) {
        map.set(m.id, { x: m.pos_x, y: m.pos_y });
      } else {
        const col = idx % 4;
        const row = Math.floor(idx / 4);
        map.set(m.id, { x: 16 + col * 120, y: 16 + row * 104 });
      }
    });
    return map;
  });

  // ── Formas ───────────────────────────────────────────────────────────────
  const [formas, setFormas] = useState<Map<number, FormaMesa>>(() => {
    const map = new Map<number, FormaMesa>();
    mesas.forEach(m => map.set(m.id, m.forma));
    return map;
  });

  const [dirty, setDirty] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  // ── Selección ─────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // ── Zoom ──────────────────────────────────────────────────────────────────
  const [zoom, setZoom] = useState(1.0);

  // ── Drag — usando refs para evitar closures stale ─────────────────────────
  const [dragIdState, setDragIdState] = useState<number | null>(null);
  const dragIdRef = useRef<number | null>(null);
  const dragStartClientRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dragStartPosRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const hasDraggedRef = useRef(false);
  const shiftOnDownRef = useRef(false);

  // Refs espejo para acceder al último valor en handlers sin recrearlos
  const selectedIdsRef = useRef(selectedIds);
  const formasRef = useRef(formas);
  const zoomRef = useRef(zoom);
  const posicionesRef = useRef(posiciones);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { formasRef.current = formas; }, [formas]);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { posicionesRef.current = posiciones; }, [posiciones]);

  function mesaSize(id: number) {
    return FORMA_SIZES[formasRef.current.get(id) ?? 'cuadrado'];
  }

  // ── Drag handlers ─────────────────────────────────────────────────────────
  const onPointerDown = useCallback((e: React.PointerEvent, mesaId: number) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

    dragIdRef.current = mesaId;
    setDragIdState(mesaId);
    dragStartClientRef.current = { x: e.clientX, y: e.clientY };
    hasDraggedRef.current = false;
    shiftOnDownRef.current = e.shiftKey;

    // Snapshot de posiciones iniciales para drag de grupo
    const sel = selectedIdsRef.current;
    const groupIds = sel.has(mesaId) ? Array.from(sel) : [mesaId];
    const snap = new Map<number, { x: number; y: number }>();
    groupIds.forEach(id => {
      const p = posicionesRef.current.get(id);
      if (p) snap.set(id, { ...p });
    });
    dragStartPosRef.current = snap;
  }, []);

  // onPointerMove va en el wrapper — los eventos del mesa capturado burbujean aquí
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const id = dragIdRef.current;
    if (id === null) return;

    const dxScreen = e.clientX - dragStartClientRef.current.x;
    const dyScreen = e.clientY - dragStartClientRef.current.y;
    if (!hasDraggedRef.current && Math.abs(dxScreen) < 5 && Math.abs(dyScreen) < 5) return;
    hasDraggedRef.current = true;

    // Convertir delta de pantalla a espacio interno del canvas (dividir por zoom)
    const dxCanvas = dxScreen / zoomRef.current;
    const dyCanvas = dyScreen / zoomRef.current;

    const sel = selectedIdsRef.current;
    const groupIds = sel.has(id) ? Array.from(sel) : [id];

    setPosiciones(prev => {
      const next = new Map(prev);
      groupIds.forEach(gid => {
        const start = dragStartPosRef.current.get(gid);
        if (!start) return;
        const { w, h } = mesaSize(gid);
        let x = Math.round((start.x + dxCanvas) / GRID) * GRID;
        let y = Math.round((start.y + dyCanvas) / GRID) * GRID;
        x = Math.max(0, Math.min(CANVAS_W - w, x));
        y = Math.max(0, Math.min(CANVAS_H - h, y));
        next.set(gid, { x, y });
      });
      return next;
    });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const id = dragIdRef.current;
    if (id === null) return;
    dragIdRef.current = null;
    setDragIdState(null);

    const sel = selectedIdsRef.current;

    if (!hasDraggedRef.current) {
      // Fue un click → manejar selección
      const shift = shiftOnDownRef.current || e.shiftKey;
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (shift) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        } else {
          if (next.size === 1 && next.has(id)) next.clear(); // toggle off
          else { next.clear(); next.add(id); }
        }
        return next;
      });
    } else {
      // Fue drag → marcar como dirty
      const groupIds = sel.has(id) ? Array.from(sel) : [id];
      setDirty(prev => {
        const next = new Set(prev);
        groupIds.forEach(gid => next.add(gid));
        return next;
      });
    }
  }, []);

  function onCanvasPointerDown(e: React.PointerEvent) {
    // Solo cuando se hace click en el fondo (no en una mesa, que llama stopPropagation)
    if (e.target === e.currentTarget || (e.target as HTMLElement).dataset['canvas'] === 'true') {
      setSelectedIds(new Set());
    }
  }

  // ── Cambiar forma de las mesas seleccionadas ──────────────────────────────
  function changeForma(forma: FormaMesa) {
    const ids = Array.from(selectedIdsRef.current);
    if (ids.length === 0) return;
    setFormas(prev => {
      const next = new Map(prev);
      ids.forEach(id => next.set(id, forma));
      return next;
    });
    setDirty(prev => {
      const next = new Set(prev);
      ids.forEach(id => next.add(id));
      return next;
    });
  }

  // ── Zoom fit ──────────────────────────────────────────────────────────────
  function fitToScreen() {
    if (!wrapperRef.current || mesas.length === 0) return;
    let maxX = 0, maxY = 0;
    posicionesRef.current.forEach((p, id) => {
      const { w, h } = mesaSize(id);
      maxX = Math.max(maxX, p.x + w + 32);
      maxY = Math.max(maxY, p.y + h + 32);
    });
    const rect = wrapperRef.current.getBoundingClientRect();
    const z = Math.min(rect.width / maxX, rect.height / maxY, 2.0);
    setZoom(Math.max(0.3, Math.round(z * 10) / 10));
  }

  // ── Teclado ───────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (selectedIdsRef.current.size > 0) { setSelectedIds(new Set()); return; }
        onClose();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) {
        e.preventDefault();
        setZoom(z => Math.min(2.0, Math.round((z + 0.1) * 10) / 10));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') {
        e.preventDefault();
        setZoom(z => Math.max(0.3, Math.round((z - 0.1) * 10) / 10));
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // ── Guardar ───────────────────────────────────────────────────────────────
  async function guardar() {
    if (dirty.size === 0) { toast.info('Sin cambios para guardar'); onClose(); return; }
    setSaving(true);
    const updates = Array.from(dirty).map(id => {
      const p = posiciones.get(id);
      const f = formas.get(id);
      return updateMesaEditor(id, {
        ...(p ? { pos_x: Math.round(p.x), pos_y: Math.round(p.y) } : {}),
        ...(f ? { forma: f } : {}),
      });
    });
    const results = await Promise.all(updates);
    const errores = results.filter(r => r.error);
    setSaving(false);
    if (errores.length > 0) { toast.error(`${errores.length} mesas no se pudieron guardar`); return; }
    toast.success(`${dirty.size} mesa${dirty.size !== 1 ? 's' : ''} guardada${dirty.size !== 1 ? 's' : ''}`);
    setDirty(new Set());
    onSaved();
    onClose();
  }

  // Forma activa en toolbar (solo si todas las seleccionadas coinciden)
  const selectedArr = Array.from(selectedIds);
  const firstId = selectedArr[0];
  const firstForma = firstId !== undefined ? (formas.get(firstId) ?? 'cuadrado') : null;
  const activeForma = (selectedIds.size > 0 && selectedArr.every(id => formas.get(id) === firstForma))
    ? firstForma : null;

  return (
    <div className="fixed inset-0 z-40 bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card h-14 px-4 flex items-center gap-3 shrink-0">
        <Layout className="h-5 w-5 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold">Editar plano del salón</h2>
          <p className="text-xs text-muted-foreground">
            Click = seleccionar · Shift+click = multi · Arrastrá para mover · Esc para salir
          </p>
        </div>
        {dirty.size > 0 && (
          <span className="text-xs text-warning tabular-nums shrink-0">{dirty.size} sin guardar</span>
        )}
        <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
          <X className="h-4 w-4 mr-1" /> Cancelar
        </Button>
        <Button size="sm" onClick={guardar} disabled={saving || dirty.size === 0}>
          <Save className="h-4 w-4 mr-1" />
          {saving ? 'Guardando…' : `Guardar${dirty.size > 0 ? ` (${dirty.size})` : ''}`}
        </Button>
      </header>

      {/* Toolbar */}
      <div className="border-b border-border bg-muted/30 px-4 py-2 flex items-center gap-2 shrink-0 flex-wrap">
        <span className="text-xs text-muted-foreground font-medium mr-1">Forma:</span>
        {(Object.keys(FORMA_LABELS) as FormaMesa[]).map(f => (
          <button
            key={f}
            type="button"
            disabled={selectedIds.size === 0}
            onClick={() => changeForma(f)}
            title={selectedIds.size === 0 ? 'Seleccioná una mesa primero' : `Cambiar a ${f}`}
            className={cn(
              'h-7 px-2.5 rounded text-xs font-medium border transition-colors',
              activeForma === f
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border bg-background hover:bg-accent text-foreground',
              selectedIds.size === 0 && 'opacity-40 cursor-not-allowed pointer-events-none',
            )}
          >
            {FORMA_LABELS[f]}
          </button>
        ))}

        {selectedIds.size > 0 && (
          <span className="text-xs text-muted-foreground ml-1">
            {selectedIds.size === 1 ? '— 1 mesa' : `— ${selectedIds.size} mesas`}
          </span>
        )}

        {/* Zoom */}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom(z => Math.max(0.3, Math.round((z - 0.1) * 10) / 10))}
            className="h-7 w-7 rounded border border-border flex items-center justify-center hover:bg-accent text-muted-foreground"
            title="Alejar (Ctrl −)"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="text-xs w-10 text-center tabular-nums font-medium select-none">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom(z => Math.min(2.0, Math.round((z + 0.1) * 10) / 10))}
            className="h-7 w-7 rounded border border-border flex items-center justify-center hover:bg-accent text-muted-foreground"
            title="Acercar (Ctrl +)"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={fitToScreen}
            className="h-7 w-7 rounded border border-border flex items-center justify-center hover:bg-accent text-muted-foreground ml-0.5"
            title="Ajustar todo en pantalla"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Hint */}
      <div className="bg-primary/5 border-b border-primary/20 px-4 py-1.5 text-xs text-primary flex items-center gap-2 shrink-0">
        <Info className="h-3.5 w-3.5 shrink-0" />
        Las mesas guardadas se ven en el orden del plano al volver al salón. Las que no muevas quedan en grid auto.
      </div>

      {/* Canvas wrapper — scrollable, fondo de puntos */}
      <div
        ref={wrapperRef}
        className="flex-1 overflow-auto relative"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--border) 1px, transparent 1px)',
          backgroundSize: `${GRID * zoom}px ${GRID * zoom}px`,
        }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* Inner canvas — escalado */}
        <div
          ref={canvasRef}
          data-canvas="true"
          className="relative"
          style={{
            width: CANVAS_W,
            height: CANVAS_H,
            transformOrigin: '0 0',
            transform: `scale(${zoom})`,
          }}
        >
          {mesas.map(m => {
            const pos = posiciones.get(m.id) ?? { x: 0, y: 0 };
            const isDirty = dirty.has(m.id);
            const isDragging = dragIdState === m.id;
            const isSelected = selectedIds.has(m.id);
            const forma = formas.get(m.id) ?? 'cuadrado';
            const { w, h } = FORMA_SIZES[forma];

            return (
              <div
                key={m.id}
                onPointerDown={e => onPointerDown(e, m.id)}
                className={cn(
                  'absolute select-none cursor-move flex flex-col items-center justify-center text-center touch-none border-2 transition-shadow',
                  forma === 'redondo' ? 'rounded-full' : 'rounded-lg',
                  m.estado === 'libre'
                    ? 'bg-success/10 border-success/30 text-success'
                    : m.estado === 'ocupada'
                      ? 'bg-warning/10 border-warning/30 text-warning'
                      : 'bg-muted border-border',
                  isSelected && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
                  isDirty && !isSelected && 'ring-2 ring-warning/60 ring-offset-1',
                  isDragging && 'shadow-2xl scale-105 z-10',
                )}
                style={{ left: pos.x, top: pos.y, width: w, height: h }}
              >
                <div className="text-xl font-bold leading-none">{m.numero}</div>
                {m.zona && (
                  <div className="text-[10px] opacity-70 truncate max-w-full px-1 leading-tight mt-0.5">
                    {m.zona}
                  </div>
                )}
                {m.capacidad && (
                  <div className="text-[9px] opacity-60 leading-none">{m.capacidad}p</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
