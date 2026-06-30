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
  onDescuento: () => void;
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
  onDescuento,
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
    <div className="px-2 py-1.5 border-b border-border/40 bg-card space-y-1">
      {/* Barra compacta: volver · # · estado · tiempo · Opciones */}
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={onBack} title="Volver">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <strong className="text-base leading-none">#{venta.numero_local}</strong>
        <EstadoVentaBadge estado={venta.estado} />
        {venta.tab_nombre && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary font-bold uppercase truncate" title="Open Tab">
            Tab · {venta.tab_nombre}
          </span>
        )}
        <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground text-right">
          {venta.cliente_nombre ? `${venta.cliente_nombre} · ` : (venta.modo === 'salon' && venta.mesa_id ? 'Mesa · ' : '')}
          {relativoCorto(venta.abierta_at)}
          {tiempoEstimadoMin > 0 && (
            <span title="Suma de tiempos de prep de los items en hold/cocina">
              {' · ⏱~'}{tiempoEstimadoMin}m
            </span>
          )}
        </span>
        {editable && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-7 px-2 shrink-0">
                Opciones
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={onToggleCoursingAuto} title="Curso N+1 sale solo cuando termina el curso N">
                <span className="mr-2">{coursingAuto ? '☑' : '☐'}</span>
                Coursing automático
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onEditNotas}>
                {venta.notas ? 'Editar nota' : 'Agregar nota'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDescuento}>
                Aplicar descuento
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

      {/* Nota: solo cuando se está editando o la venta ya tiene una */}
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
          className="block w-full text-left text-xs italic px-2 py-1 rounded bg-warning/10 text-warning-foreground border border-warning/30 hover:bg-warning/15"
          title="Click para editar"
        >
          📝 {venta.notas}
        </button>
      ) : null}
    </div>
  );
});
