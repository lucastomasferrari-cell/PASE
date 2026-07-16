import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, Minus, Plus, Users } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { listVentasItems, asignarComensalItem } from '@/services/ventasService';
import { listItems, type ItemConGrupo } from '@/services/itemsService';
import { listMetodosCobroActivos } from '@/services/configService';
import { agregarPago, newIdempotencyKey } from '@/services/pagosService';
import { calcularCuentasPorComensal, type CuentaComensal } from '@/lib/comensalSplit';
import type { MetodoCobro, VentaPos, VentaPosItem } from '@/types/database';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venta: VentaPos;
  empleadoId: string;
  /** Llamado cuando se cobró el total (todos los comensales) y la venta cerró. */
  onCobrado: () => void;
}

// Order-by-seat (increment 3): asignar cada ítem a un comensal y cobrar a cada
// uno por separado. Se usa AL FINAL, antes de pagar (no al abrir la mesa).
// Distinto de "Partir cuenta" (SplitCheckDialog), que mueve ítems a un ticket
// nuevo. Acá la cuenta sigue siendo UNA sola; cada comensal paga su parte con
// fn_agregar_pago_venta_comanda (pago parcial) y cuando la suma cubre el total
// la venta se cierra sola.
export function ComensalSplitDialog({ open, onOpenChange, venta, empleadoId, onCobrado }: Props) {
  const [items, setItems] = useState<VentaPosItem[]>([]);
  const [catalogo, setCatalogo] = useState<ItemConGrupo[]>([]);
  const [metodos, setMetodos] = useState<MetodoCobro[]>([]);
  const [loading, setLoading] = useState(true);
  const [numComensales, setNumComensales] = useState(2);
  const [metodoPorComensal, setMetodoPorComensal] = useState<Record<number, string>>({});
  const [pagados, setPagados] = useState<Set<number>>(new Set());
  const [cobrando, setCobrando] = useState<number | null>(null);
  // Keys de idempotencia estables por comensal (retry no duplica el pago).
  const keysRef = useRef<Record<number, string>>({});

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setPagados(new Set());
    keysRef.current = {};
    Promise.all([
      listVentasItems(venta.id),
      listItems({ tenantId: venta.tenant_id, localId: venta.local_id }),
      listMetodosCobroActivos(venta.local_id),
    ]).then(([itemsRes, catRes, metRes]) => {
      const vivos = itemsRes.data.filter((i) => i.estado !== 'anulado');
      setItems(vivos);
      setCatalogo(catRes.data);
      setMetodos(metRes.data);
      const maxAsig = vivos.reduce((m, i) => Math.max(m, i.comensal ?? 0), 0);
      setNumComensales(Math.max(2, venta.comensales ?? 0, maxAsig));
      setLoading(false);
    });
  }, [open, venta.id, venta.tenant_id, venta.local_id, venta.comensales]);

  const minComensales = useMemo(
    () => Math.max(1, items.reduce((m, i) => Math.max(m, i.comensal ?? 0), 0)),
    [items],
  );

  const reparto = useMemo(
    () => calcularCuentasPorComensal(
      items.map((i) => ({ id: i.id, comensal: i.comensal, subtotal: Number(i.subtotal) })),
      numComensales,
      Number(venta.descuento_total),
    ),
    [items, numComensales, venta.descuento_total],
  );

  function nombreItem(it: VentaPosItem): string {
    return catalogo.find((c) => c.id === it.item_id)?.nombre ?? `Item #${it.item_id}`;
  }

  async function asignar(itemId: number, comensal: number | null) {
    const prev = items;
    // Optimista: refleja el cambio ya; si falla, revierte.
    setItems((arr) => arr.map((i) => (i.id === itemId ? { ...i, comensal } : i)));
    const { error } = await asignarComensalItem(itemId, comensal ?? 0);
    if (error) {
      setItems(prev);
      toast.error(error);
    }
  }

  function metodoDe(comensal: number): string {
    return metodoPorComensal[comensal] ?? metodos[0]?.slug ?? 'efectivo';
  }

  async function cobrarComensal(cuenta: CuentaComensal) {
    if (cuenta.monto <= 0) { toast.error('Ese comensal no tiene consumo'); return; }
    if (pagados.has(cuenta.comensal)) return;
    setCobrando(cuenta.comensal);
    if (!keysRef.current[cuenta.comensal]) keysRef.current[cuenta.comensal] = newIdempotencyKey();
    const { error } = await agregarPago({
      ventaId: venta.id,
      metodo: metodoDe(cuenta.comensal),
      monto: cuenta.monto,
      idempotencyKey: keysRef.current[cuenta.comensal]!,
      cobradoPor: empleadoId,
    });
    setCobrando(null);
    if (error) { toast.error(error); return; }
    const next = new Set(pagados).add(cuenta.comensal);
    setPagados(next);
    toast.success(`Comensal ${cuenta.comensal} cobrado — ${formatARS(cuenta.monto)}`);
    // ¿Quedó todo cubierto? (todos los comensales con monto > 0 pagados)
    const pendientes = reparto.cuentas.filter((c) => c.monto > 0 && !next.has(c.comensal));
    if (pendientes.length === 0) {
      toast.success('Cuenta saldada por comensal ✓');
      onCobrado();
      onOpenChange(false);
    }
  }

  const totalCobrado = reparto.cuentas
    .filter((c) => pagados.has(c.comensal))
    .reduce((s, c) => s + c.monto, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[92vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 shrink-0">
          <DialogTitle>Dividir por comensal</DialogTitle>
          <DialogDescription>
            Asigná cada ítem a un comensal y cobrá a cada uno por separado. Lo que dejes
            sin asignar se reparte en partes iguales.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-12 text-center text-muted-foreground">Cargando…</div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">
            {/* Stepper de comensales */}
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Users className="h-4 w-4" /> Comensales
              </div>
              <div className="flex items-center gap-3">
                <Button
                  type="button" variant="outline" size="icon" className="h-8 w-8"
                  disabled={numComensales <= minComensales}
                  onClick={() => setNumComensales((n) => Math.max(minComensales, n - 1))}
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <span className="w-6 text-center text-lg font-semibold tabular-nums">{numComensales}</span>
                <Button
                  type="button" variant="outline" size="icon" className="h-8 w-8"
                  disabled={numComensales >= 50}
                  onClick={() => setNumComensales((n) => Math.min(50, n + 1))}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Ítems con selector de comensal */}
            <div className="border border-border rounded-md divide-y divide-border">
              {items.map((it) => (
                <div key={it.id} className="p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {Number(it.cantidad)}× {nombreItem(it)}
                      </div>
                    </div>
                    <strong className="tabular-nums text-sm">{formatARS(it.subtotal)}</strong>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() => asignar(it.id, null)}
                      className={cn(
                        'px-2 h-7 rounded text-xs border transition-colors',
                        it.comensal == null
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'border-border hover:bg-muted',
                      )}
                    >
                      Compartido
                    </button>
                    {Array.from({ length: numComensales }, (_, i) => i + 1).map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => asignar(it.id, c)}
                        className={cn(
                          'w-7 h-7 rounded text-xs border tabular-nums transition-colors',
                          it.comensal === c
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'border-border hover:bg-muted',
                        )}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Tarjetas por comensal con cobro */}
            <div className="grid gap-2 sm:grid-cols-2">
              {reparto.cuentas.map((cuenta) => {
                const pagado = pagados.has(cuenta.comensal);
                return (
                  <div
                    key={cuenta.comensal}
                    className={cn(
                      'rounded-md border p-3 space-y-2',
                      pagado ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-border',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold">Comensal {cuenta.comensal}</span>
                      <strong className="tabular-nums">{formatARS(cuenta.monto)}</strong>
                    </div>
                    {pagado ? (
                      <div className="flex items-center gap-1 text-sm text-emerald-600 font-medium">
                        <Check className="h-4 w-4" /> Pagado
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <select
                          value={metodoDe(cuenta.comensal)}
                          onChange={(e) => setMetodoPorComensal((m) => ({ ...m, [cuenta.comensal]: e.target.value }))}
                          className="flex-1 h-8 rounded border border-border bg-background px-2 text-sm"
                        >
                          {metodos.map((m) => (
                            <option key={m.slug} value={m.slug}>{m.emoji ? `${m.emoji} ` : ''}{m.nombre}</option>
                          ))}
                        </select>
                        <Button
                          type="button" size="sm"
                          disabled={cuenta.monto <= 0 || cobrando !== null}
                          onClick={() => cobrarComensal(cuenta)}
                        >
                          {cobrando === cuenta.comensal ? '…' : 'Cobrar'}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <DialogFooter className="px-6 py-4 border-t shrink-0 items-center sm:justify-between gap-2">
          <div className="text-sm text-muted-foreground">
            Cobrado <strong className="text-foreground tabular-nums">{formatARS(totalCobrado)}</strong>
            {' '}de{' '}<span className="tabular-nums">{formatARS(reparto.neto)}</span>
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cerrar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
