import React, { useRef } from 'react';
import { Star, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '../../../components/SearchInput';
import { formatARS } from '../../../lib/format';
import { cn } from '@/lib/utils';
import type { ItemConGrupo } from '../../../services/itemsService';
import type { ItemGrupo } from '../../../types/database';

// Color ramps for ProductTile — must match VentaScreen RAMP_CLASSES
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
  grupo: ItemGrupo | null;
  disabled: boolean;
  flashed?: boolean;
  favorito?: boolean;
  onToggleFavorito?: () => void;
  onClick: () => void;
  onLongPress?: () => void;
}

function ProductTile({ item, grupo, disabled, flashed, favorito, onToggleFavorito, onClick, onLongPress }: ProductTileProps) {
  const ramp = grupo?.color_ramp ?? 'gray';
  const cls = RAMP_CLASSES[ramp] ?? RAMP_CLASSES.gray;
  const agotado = item.estado === 'agotado';
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

  return (
    <div className="group relative">
      {onToggleFavorito && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleFavorito(); }}
          aria-label={favorito ? 'Quitar de favoritos' : 'Agregar a favoritos'}
          className={cn(
            'absolute top-1 right-1 z-10 h-6 w-6 inline-flex items-center justify-center rounded-full transition-all',
            favorito
              ? 'bg-amber-400 text-white shadow'
              : 'bg-background/70 text-muted-foreground hover:bg-amber-100 hover:text-amber-600 opacity-0 group-hover:opacity-100 focus:opacity-100',
          )}
          title={favorito ? 'Quitar de favoritos' : 'Agregar a Quick Items'}
        >
          <Star className={cn('h-3.5 w-3.5', favorito && 'fill-current')} />
        </button>
      )}
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
          'w-full aspect-[4/3] rounded-lg p-3 flex flex-col items-center justify-center gap-1 relative',
          'transition-all duration-300 active:scale-[0.98] touch-target-lg',
          'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100',
          cls,
          flashed && 'ring-4 ring-success scale-[1.02]',
          agotado && 'opacity-50',
        )}
        title={agotado ? 'AGOTADO — mantené presionado para reponer' : 'Tocá para agregar · mantené presionado para marcar agotado'}
      >
        {agotado && (
          <div className="absolute inset-0 rounded-lg bg-destructive/10 flex flex-col items-center justify-center pointer-events-none gap-1">
            <div className="bg-destructive text-destructive-foreground px-2 py-0.5 rounded text-[10px] font-bold uppercase rotate-[-12deg] shadow">
              Agotado
            </div>
            {item.agotado_hasta && (() => {
              const ms = new Date(item.agotado_hasta).getTime() - Date.now();
              if (ms <= 0) return null;
              const min = Math.floor(ms / 60000);
              const horas = Math.floor(min / 60);
              const label = horas > 0 ? `vuelve en ${horas}h${min % 60}m` : `vuelve en ${min}m`;
              return (
                <div className="bg-background/80 px-1.5 py-0.5 rounded text-[8px] tabular-nums text-foreground/70">
                  ⏱ {label}
                </div>
              );
            })()}
          </div>
        )}
        {flashed && (
          <div className="absolute inset-0 rounded-lg bg-success/20 flex items-center justify-center pointer-events-none">
            <div className="bg-success text-success-foreground rounded-full h-10 w-10 flex items-center justify-center text-2xl shadow-lg">
              ✓
            </div>
          </div>
        )}
        {item.foto_url ? (
          <img src={item.foto_url} alt="" loading="lazy" className="w-12 h-12 object-cover rounded" />
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
  return (
    <div className="p-4 overflow-y-auto border-r border-border bg-card min-h-0">
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
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Buscar producto… (Enter agrega el primero)"
          autoFocus
          inputRef={searchRef}
          onKeyDown={onSearchKeyDown}
        />
      </div>
      <div className="flex gap-1 mb-3 flex-wrap">
        {favoritosSet.size > 0 && (
          <GrupoTab active={grupoSel === 'favoritos'} onClick={() => setGrupoSel('favoritos')}>
            ★ Favoritos ({favoritosSet.size})
          </GrupoTab>
        )}
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
            flashed={lastAddedItemId === it.id}
            favorito={favoritosSet.has(it.id)}
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
