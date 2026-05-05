import { useEffect, useState, useCallback } from 'react';
import { ShieldCheck, Eye } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { listOverrides, getOverride } from '@/services/auditoriaService';
import type { VentaPosOverride, AccionOverride } from '@/types/database';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/Badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatARS, formatFechaAR, formatHoraAR } from '@/lib/format';

const ACCIONES: { value: AccionOverride | 'todos'; label: string }[] = [
  { value: 'todos', label: 'Todas las acciones' },
  { value: 'void', label: 'Anular' },
  { value: 'comp', label: 'Cortesía' },
  { value: 'discount', label: 'Descuento' },
  { value: 'refund', label: 'Reembolso' },
  { value: 'reopen', label: 'Reabrir' },
  { value: 'transfer_table', label: 'Transferir mesa' },
  { value: 'cambio_mozo', label: 'Cambio mozo' },
  { value: 'merge_mesas', label: 'Unir mesas' },
  { value: 'split_check', label: 'Partir cuenta' },
];

export function SettingsAuditoria() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [overrides, setOverrides] = useState<VentaPosOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [filtroAccion, setFiltroAccion] = useState<AccionOverride | 'todos'>('todos');
  const [detalle, setDetalle] = useState<VentaPosOverride | null>(null);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data } = await listOverrides({
      localId,
      accion: filtroAccion === 'todos' ? undefined : filtroAccion,
      limit: 200,
    });
    setOverrides(data);
    setLoading(false);
  }, [localId, filtroAccion]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground">
          Registro inmutable de overrides (anular, descuento, reembolso, etc.).
          Solo lectura.
        </p>
        <Select value={filtroAccion} onValueChange={(v) => setFiltroAccion(v as AccionOverride | 'todos')}>
          <SelectTrigger className="w-[200px] h-10"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ACCIONES.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground">Cargando…</CardContent></Card>
      ) : overrides.length === 0 ? (
        <Card><CardContent className="py-16 text-center">
          <ShieldCheck className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="text-lg font-medium mb-1">Sin overrides registrados</h3>
          <p className="text-sm text-muted-foreground">
            Cuando se anule un item o se aplique un descuento grande, aparecerá acá.
          </p>
        </CardContent></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="grid grid-cols-[140px_120px_100px_140px_140px_1fr_80px] gap-3 px-6 py-3 border-b border-border bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            <div>Fecha / Hora</div><div>Acción</div><div>Venta</div><div>Cajero</div><div>Manager</div><div>Motivo</div><div className="text-right">Detalle</div>
          </div>
          {overrides.map((o, idx) => (
            <div key={o.id} className={`grid grid-cols-[140px_120px_100px_140px_140px_1fr_80px] gap-3 px-6 py-3 items-center text-sm ${idx !== overrides.length - 1 ? 'border-b border-border' : ''}`}>
              <div className="text-xs text-muted-foreground">
                <div>{formatFechaAR(o.created_at)}</div>
                <div>{formatHoraAR(o.created_at)}</div>
              </div>
              <div><AccionBadge accion={o.accion} /></div>
              <div className="font-medium">#{o.venta_id}</div>
              <div className="text-xs text-muted-foreground truncate" title={o.cajero_id}>{o.cajero_id.slice(0, 8)}…</div>
              <div className="text-xs text-muted-foreground truncate" title={o.manager_id}>{o.manager_id.slice(0, 8)}…</div>
              <div className="text-xs text-muted-foreground truncate">{o.motivo}</div>
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={() => void getOverride(o.id).then((r) => r.data && setDetalle(r.data))}>
                  <Eye className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Dialog open={detalle !== null} onOpenChange={(o) => { if (!o) setDetalle(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Detalle del override</DialogTitle>
            {detalle && <DialogDescription>{formatFechaAR(detalle.created_at)} · {formatHoraAR(detalle.created_at)}</DialogDescription>}
          </DialogHeader>
          {detalle && (
            <div className="space-y-2 text-sm">
              <Detail label="Acción" value={<AccionBadge accion={detalle.accion} />} />
              <Detail label="Venta" value={`#${detalle.venta_id}`} />
              {detalle.venta_item_id && <Detail label="Item" value={`#${detalle.venta_item_id}`} />}
              <Detail label="Cajero" value={<code className="text-xs">{detalle.cajero_id}</code>} />
              <Detail label="Manager" value={<code className="text-xs">{detalle.manager_id}</code>} />
              <Detail label="Motivo" value={detalle.motivo} />
              {detalle.monto_afectado && <Detail label="Monto afectado" value={formatARS(Number(detalle.monto_afectado))} />}
              {detalle.valor_anterior && <Detail label="Valor anterior" value={formatARS(Number(detalle.valor_anterior))} />}
              {detalle.valor_nuevo && <Detail label="Valor nuevo" value={formatARS(Number(detalle.valor_nuevo))} />}
              {detalle.ip_origen && <Detail label="IP origen" value={detalle.ip_origen} />}
              {detalle.metadata && (
                <Detail label="Metadata" value={<pre className="text-xs bg-muted rounded p-2 overflow-x-auto">{JSON.stringify(detalle.metadata, null, 2)}</pre>} />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2 py-1 border-b border-border">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function AccionBadge({ accion }: { accion: AccionOverride }) {
  const map: Record<AccionOverride, { label: string; variant: 'red' | 'amber' | 'blue' | 'violet' | 'gray' }> = {
    void:           { label: 'Anular',     variant: 'red' },
    comp:           { label: 'Cortesía',   variant: 'amber' },
    discount:       { label: 'Descuento',  variant: 'amber' },
    refund:         { label: 'Reembolso',  variant: 'red' },
    reopen:         { label: 'Reabrir',    variant: 'blue' },
    transfer_table: { label: 'Mesa',       variant: 'violet' },
    cambio_mozo:    { label: 'Mozo',       variant: 'gray' },
    merge_mesas:    { label: 'Unir',       variant: 'violet' },
    split_check:    { label: 'Partir',     variant: 'violet' },
  };
  const c = map[accion];
  return <Badge variant={c.variant}>{c.label}</Badge>;
}
