import React, { useCallback, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '../../../components/SearchInput';
import { formatARS } from '../../../lib/format';
import { cn } from '@/lib/utils';
import type { ItemConGrupo } from '../../../services/itemsService';
import type { ItemGrupo } from '../../../types/database';

// ── Density del catálogo del POS (Compacto/Normal/Grande) ─────────────────
// Mismo patrón que SalonView. Independiente del salón (otra key) para que
// el cajero pueda preferir items chiquitos pero mesas grandes (o viceversa).
type CatalogoDensity = 'compact' | 'normal' | 'large';
const CATALOGO_DENSITY_KEY = 'comanda_pos_catalogo_density';

interface CatalogoDensityConfig {
  itemPaddingY: string;
  itemText: string;
  priceText: string;
  agotadoText: string;
  gridCols: string;
}

const CATALOGO_DENSITY_CONFIG: Record<CatalogoDensity, CatalogoDensityConfig> = {
  compact: {
    itemPaddingY: 'py-1',
    itemText: 'text-xs',
    priceText: 'text-xs',
    agotadoText: 'text-[9px]',
    gridCols: 'grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-x-3',
  },
  normal: {
    itemPaddingY: 'py-1.5',
    itemText: 'text-sm',
    priceText: 'text-sm',
    agotadoText: 'text-[10px]',
    gridCols: 'grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4',
  },
  large: {
    itemPaddingY: 'py-2.5',
    itemText: 'text-base',
    priceText: 'text-base',
    agotadoText: 'text-xs',
    gridCols: 'grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-x-5',
  },
};

function useCatalogoDensity(): readonly [CatalogoDensity, (d: CatalogoDensity) => void] {
  const [density, setDensityState] = useState<CatalogoDensity>(() => {
    if (typeof window === 'undefined') return 'normal';
    const saved = window.localStorage.getItem(CATALOGO_DENSITY_KEY);
    if (saved === 'compact' || saved === 'normal' || saved === 'large') return saved;
    return 'normal';
  });
  const setDensity = useCallback((d: CatalogoDensity) => {
    setDensityState(d);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(CATALOGO_DENSITY_KEY, d); } catch { /* private mode */ }
    }
  }, []);
  return [density, setDensity] as const;
}

interface GrupoTabProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function GrupoTab({ active, onClick, children }: GrupoTabProps) {
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

interface ProductTileProps {
  item: ItemConGrupo;
  disabled: boolean;
  flashed?: boolean;
  favorito?: boolean;
  density?: CatalogoDensity;
  onToggleFavorito?: () => void;
  onClick: () => void;
  onLongPress?: () => void;
}

// Fila plana tipo menú: nombre … precio. Sin caja, sin monograma, sin emoji.
function ProductTile({ item, disabled, flashed, favorito, density = 'normal', onToggleFavorito, onClick, onLongPress }: ProductTileProps) {
  const agotado = item.estado === 'agotado';
  const densityCfg = CATALOGO_DENSITY_CONFIG[density];
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
    if (longPressRef.current.fired) {
      e.preventDefault();
      longPressRef.current.fired = false;
      return;
    }
    onClick();
  }

  const agotadoLabel = (() => {
    if (!agotado) return null;
    if (!item.agotado_hasta) return 'agotado';
    const ms = new Date(item.agotado_hasta).getTime() - Date.now();
    if (ms <= 0) return 'agotado';
    const min = Math.floor(ms / 60000);
    const horas = Math.floor(min / 60);
    return horas > 0 ? `agotado · vuelve en ${horas}h${min % 60}m` : `agotado · vuelve en ${min}m`;
  })();

  return (
    <div className="group relative border-b border-border/40">
      <button
        type="button"
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={clearLongPress}
        onPointerLeave={clearLongPress}
        onPointerCancel={clearLongPress}
        onContextMenu={(e) => {
          if (onLongPress) e.preventDefault();
        }}
        disabled={disabled || (agotado && !onLongPress)}
        className={cn(
          'w-full flex items-baseline justify-between gap-3 pl-1 pr-7 text-left rounded-md',
          densityCfg.itemPaddingY,
          'transition-colors hover:bg-accent active:bg-accent',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          flashed && 'bg-success/15',
          agotado && 'opacity-50',
        )}
        title={agotado ? 'AGOTADO — mantené presionado para reponer' : 'Tocá para agregar · mantené presionado para marcar agotado'}
      >
        <span className={cn('min-w-0 flex-1 truncate', densityCfg.itemText)}>
          {item.nombre}
          {agotadoLabel && (
            <span className={cn('ml-2 uppercase tracking-wide text-destructive font-medium', densityCfg.agotadoText)}>{agotadoLabel}</span>
          )}
        </span>
        <span className={cn('shrink-0 tabular-nums text-muted-foreground', densityCfg.priceText)}>
          {formatARS(item.precio_madre)}
        </span>
      </button>
      {onToggleFavorito && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleFavorito(); }}
          aria-label={favorito ? 'Quitar de favoritos' : 'Agregar a favoritos'}
          className={cn(
            'absolute top-1/2 -translate-y-1/2 right-1 z-10 h-6 w-6 inline-flex items-center justify-center rounded-full transition-all',
            favorito
              ? 'text-amber-500'
              : 'text-muted-foreground/40 hover:text-amber-500 opacity-0 group-hover:opacity-100 focus:opacity-100',
          )}
          title={favorito ? 'Quitar de favoritos' : 'Agregar a Quick Items'}
        >
          <Star className={cn('h-3.5 w-3.5', favorito && 'fill-current')} />
        </button>
      )}
    </div>
  );
}

export interface VentaCatalogoPanelProps {
  catalogo: ItemConGrupo[];
  catalogoFiltrado: ItemConGrupo[];
  grupos: ItemGrupo[];
  favoritosSet: Set<number>;
  grupoSel: number | 'favoritos' | null;
  search: string;
  editable: boolean;
  cursoActivo: number;
  maxCurso: number;
  /** Si false, oculta la fila de tabs "Curso 1/2/3 + Curso N+" del header.
   * Configurado por local en SettingsLocal (comanda_local_settings.usar_cursos). */
  usarCursos?: boolean;
  lastAddedItemId: number | null;
  searchRef: React.RefObject<HTMLInputElement | null>;
  setGrupoSel: (v: number | 'favoritos' | null) => void;
  setSearch: (v: string) => void;
  setCursoActivo: (v: number) => void;
  onSearchKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onAddItem: (item: ItemConGrupo) => void;
  onLongPress: (item: ItemConGrupo) => void;
  onToggleFav: (item: ItemConGrupo) => void;
}

export const VentaCatalogoPanel = React.memo(function VentaCatalogoPanel({
  catalogoFiltrado,
  grupos,
  favoritosSet,
  grupoSel,
  search,
  editable,
  cursoActivo,
  maxCurso,
  usarCursos = true,
  lastAddedItemId,
  searchRef,
  setGrupoSel,
  setSearch,
  setCursoActivo,
  onSearchKeyDown,
  onAddItem,
  onLongPress,
  onToggleFav,
}: VentaCatalogoPanelProps) {
  const [density, setDensity] = useCatalogoDensity();
  const densityCfg = CATALOGO_DENSITY_CONFIG[density];
  return (
    <div className="p-4 overflow-y-auto border-r border-border bg-card min-h-0">
      {/* Selector de curso — solo si el local usa cursos. Si no, ocultamos
          toda la franja y los items van todos al curso 1 implícito. */}
      {editable && usarCursos && (
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

      <div className="mb-3 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Buscar producto… (Enter agrega el primero)"
            autoFocus
            inputRef={searchRef}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        {/* Toggle density del catálogo (S/M/L) — persiste en localStorage */}
        <div className="inline-flex rounded-md border border-border bg-background p-0.5 shrink-0" role="group" aria-label="Tamaño de items">
          {(['compact', 'normal', 'large'] as const).map((d) => {
            const label = d === 'compact' ? 'Compacto' : d === 'normal' ? 'Normal' : 'Grande';
            const letra = d === 'compact' ? 'S' : d === 'normal' ? 'M' : 'L';
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDensity(d)}
                aria-pressed={density === d}
                aria-label={`Items ${label.toLowerCase()}`}
                title={`Items ${label.toLowerCase()}`}
                className={cn(
                  'px-2.5 h-9 text-xs font-medium rounded transition-colors min-w-[28px]',
                  density === d
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                )}
              >
                {letra}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex gap-1 mb-3 flex-wrap">
        {favoritosSet.size > 0 && (
          <GrupoTab active={grupoSel === 'favoritos'} onClick={() => setGrupoSel('favoritos')}>
            Favoritos ({favoritosSet.size})
          </GrupoTab>
        )}
        <GrupoTab active={grupoSel === null} onClick={() => setGrupoSel(null)}>Todos</GrupoTab>
        {grupos.map((g) => (
          <GrupoTab key={g.id} active={grupoSel === g.id} onClick={() => setGrupoSel(g.id)}>
            {g.nombre}
          </GrupoTab>
        ))}
      </div>

      <div className={cn('grid', densityCfg.gridCols)}>
        {catalogoFiltrado.map((it) => (
          <ProductTile
            key={it.id}
            item={it}
            disabled={!editable}
            flashed={lastAddedItemId === it.id}
            favorito={favoritosSet.has(it.id)}
            density={density}
            onToggleFavorito={() => onToggleFav(it)}
            onClick={() => onAddItem(it)}
            onLongPress={() => onLongPress(it)}
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
  );
});
