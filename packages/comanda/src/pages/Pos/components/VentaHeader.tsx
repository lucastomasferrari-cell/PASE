import React from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EstadoVentaBadge } from '@/components/EstadoBadge';
import { relativoCorto } from '../../../lib/format';
import type { VentaPos } from '../../../types/database';

export interface VentaHeaderProps {
  venta: VentaPos;
  editable: boolean;
  editandoNotas: boolean;
  notasDraft: string;
  onBack: () => void;
  onNotasDraftChange: (v: string) => void;
  onEditNotas: () => void;
  onCancelNotas: () => void;
  onGuardarNotas: () => void;
  onTransfer: () => void;
  onMerge: () => void;
  onSplit: () => void;
  onDividirComensal: () => void;
  onAnular: () => void;
  onOpenHistorial: () => void;
  tiempoEstimadoMin: number;
  coursingAuto: boolean;
  onToggleCoursingAuto: () => void;
}

export const VentaHeader = React.memo(function VentaHeader({
  venta,
  editable,
  editandoNotas,
  notasDraft,
  onBack,
  onNotasDraftChange,
  onEditNotas,
  onCancelNotas,
  onGuardarNotas,
  onTransfer,
  onMerge,
  onSplit,
  onDividirComensal,
  onAnular,
  onOpenHistorial,
  tiempoEstimadoMin,
  coursingAuto,
  onToggleCoursingAuto,
}: VentaHeaderProps) {
  return (
    <div className="p-3 border-b border-border bg-card space-y-2">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Volver
        </Button>
        <strong className="text-base">#{venta.numero_local}</strong>
        <EstadoVentaBadge estado={venta.estado} />
        {venta.tab_nombre && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-bold uppercase" title="Open Tab">
            Tab · {venta.tab_nombre}
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {venta.modo === 'salon' && venta.mesa_id && 'Mesa · '}
        {venta.cliente_nombre ?? venta.tab_nombre ?? 'Sin cliente'} · abierta {relativoCorto(venta.abierta_at)}
        {tiempoEstimadoMin > 0 && (
          <span title="Suma de tiempos de prep de los items en hold/cocina">
            {' · ⏱ ~'}{tiempoEstimadoMin}min
          </span>
        )}
      </div>

      {/* Notas globales venta — inline edit */}
      {editandoNotas ? (
        <div className="flex gap-1 items-start">
          <textarea
            value={notasDraft}
            onChange={(e) => onNotasDraftChange(e.target.value)}
            rows={2}
            placeholder="Ej: cumpleaños — traer torta al final"
            className="flex-1 text-xs rounded-md border border-input bg-background p-1.5 resize-none"
            autoFocus
          />
          <div className="flex flex-col gap-1">
            <Button size="sm" variant="success" className="h-7 px-2 text-[10px]" onClick={onGuardarNotas}>OK</Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={onCancelNotas}>×</Button>
          </div>
        </div>
      ) : venta.notas ? (
        <button
          type="button"
          onClick={() => onEditNotas()}
          className="block w-full text-left text-xs italic px-2 py-1.5 rounded bg-warning/10 text-warning-foreground border border-warning/30 hover:bg-warning/15"
          title="Click para editar"
        >
          📝 {venta.notas}
        </button>
      ) : editable ? (
        <button
          type="button"
          onClick={() => onEditNotas()}
          className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
        >
          + Agregar nota a la mesa
        </button>
      ) : null}

      {/* Coursing automático toggle */}
      {editable && (
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={coursingAuto}
            onChange={onToggleCoursingAuto}
            className="h-3.5 w-3.5"
          />
          <span>Coursing automático <span className="opacity-60">(curso N+1 sale solo cuando termina N)</span></span>
        </label>
      )}

      {/* DropdownMenu con acciones de la venta */}
      {editable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="w-full">
              Opciones de la venta
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuItem onClick={onEditNotas}>
              Editar notas
            </DropdownMenuItem>
            {venta.modo === 'salon' && (
              <>
                <DropdownMenuItem onClick={onTransfer}>
                  Cambiar mesa
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onMerge}>
                  Unir con otra mesa
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onClick={onSplit}>
              Partir cuenta
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDividirComensal}>
              Dividir por comensal
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenHistorial}>
              Ver historial de cambios
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onAnular}
            >
              Anular venta
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
});
