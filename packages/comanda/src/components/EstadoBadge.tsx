import type { EstadoVenta, EstadoVentaItem, EstadoMesa, EstadoTurno } from '@/types/database';
import { Badge } from '@/components/Badge';

type Variant = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'violet';

const VENTA: Record<EstadoVenta, { label: string; variant: Variant }> = {
  abierta:             { label: 'Abierta',   variant: 'gray' },
  enviada:             { label: 'Enviada',   variant: 'amber' },
  lista:               { label: 'Lista',     variant: 'blue' },
  entregada:           { label: 'Entregada', variant: 'green' },
  cobrada:             { label: 'Cobrada',   variant: 'green' },
  anulada:             { label: 'Anulada',   variant: 'red' },
  necesita_aprobacion: { label: 'Por aprobar', variant: 'amber' },
  programada:          { label: 'Programada', variant: 'violet' },
};
const ITEM: Record<EstadoVentaItem, { label: string; variant: Variant }> = {
  hold:      { label: 'Hold',      variant: 'gray' },
  enviado:   { label: 'Enviado',   variant: 'amber' },
  listo:     { label: 'Listo',     variant: 'blue' },
  entregado: { label: 'Entregado', variant: 'green' },
  anulado:   { label: 'Anulado',   variant: 'red' },
};
const MESA: Record<EstadoMesa, { label: string; variant: Variant }> = {
  libre:     { label: 'Libre',     variant: 'green' },
  ocupada:   { label: 'Ocupada',   variant: 'amber' },
  hold:      { label: 'Hold',      variant: 'red' },
  inactiva:  { label: 'Inactiva',  variant: 'gray' },
};
const TURNO: Record<EstadoTurno, { label: string; variant: Variant }> = {
  abierto: { label: 'Abierto', variant: 'green' },
  cerrado: { label: 'Cerrado', variant: 'gray' },
};

export function EstadoVentaBadge({ estado }: { estado: EstadoVenta }) {
  const c = VENTA[estado];
  return <Badge variant={c.variant}>{c.label}</Badge>;
}

export function EstadoItemBadge({ estado }: { estado: EstadoVentaItem }) {
  const c = ITEM[estado];
  return <Badge variant={c.variant}>{c.label}</Badge>;
}

export function EstadoMesaBadge({ estado }: { estado: EstadoMesa }) {
  const c = MESA[estado];
  return <Badge variant={c.variant}>{c.label}</Badge>;
}

export function EstadoTurnoBadge({ estado }: { estado: EstadoTurno }) {
  const c = TURNO[estado];
  return <Badge variant={c.variant}>{c.label}</Badge>;
}
