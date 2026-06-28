import React, { useRef } from 'react';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput } from '../../../components/SearchInput';
import { formatARS } from '../../../lib/format';
import { cn } from '@/lib/utils';
import type { ItemConGrupo } from '../../../services/itemsService';
import type { ItemGrupo } from '../../../types/database';

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
  onToggleFavorito?: () => void;
  onClick: () => void;
  onLongPress?: () => void;
}

// Fila plana tipo menú: nombre … precio. Sin caja, sin monograma, sin emoji.
function ProductTile({ item, disabled, flashed, favorito, onToggleFavorito, onClick, onLongPress }: ProductTileProps) {
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
          'w-full flex items-baseline justify-between gap-3 pl-1 pr-7 py-1.5 text-left rounded-md',
          'transition-colors hover:bg-accent active:bg-accent',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          flashed && 'bg-success/15',
          agotado && 'opacity-50',
        )}
        title={agotado ? 'AGOTADO — mantené presionado para reponer' : 'Tocá para agregar · mantené presionado para marcar agotado'}
      >
        <span className="min-w-0 flex-1 truncate text-sm">
          {item.nombre}
          {agotadoLabel && (
            <span className="ml-2 text-[10px] uppercase tracking-wide text-destructive font-medium">{agotadoLabel}</span>
          )}
        </span>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
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

      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-4">
        {catalogoFiltrado.map((it) => (
          <ProductTile
            key={it.id}
            item={it}
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
