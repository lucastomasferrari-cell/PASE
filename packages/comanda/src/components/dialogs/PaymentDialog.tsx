import { useEffect, useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Trash2, Plus, CheckCircle2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { MoneyInput } from '@/components/MoneyInput';
import { listMetodosCobroActivos } from '@/services/configService';
import type { MetodoCobro, VentaPos } from '@/types/database';
import { formatARS } from '@/lib/format';
import { newIdempotencyKey, agregarPago } from '@/services/pagosService';
import { cn } from '@/lib/utils';

interface PagoEnCurso {
  id: string;             // local (UUID) — se asocia con idempotencyKey
  idempotencyKey: string; // estable, se reusa si retry
  metodo: string;
  monto: number;
  vuelto?: number | null;
  confirmado: boolean;    // true cuando ya se mandó al backend OK
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venta: VentaPos;
  empleadoId: string;
  onCobrado: () => void;
}

const PROPINA_PCTS = [0, 0.10, 0.15, 0.20];

// Billetes típicos AR 2026. "Exacto" siempre primero; el resto solo aparecen
// si son > que el monto a cobrar (no tiene sentido mostrar $1000 si vas a
// cobrar $4500).
const BILLETES_AR = [1000, 2000, 5000, 10000, 20000];

// Multi-pago + propina + vuelto. Suma parcial vs total con indicador visual.
// Cada pago tiene idempotencyKey estable; si la red falla, retry no duplica.
export function PaymentDialog({ open, onOpenChange, venta, empleadoId, onCobrado }: Props) {
  const [metodos, setMetodos] = useState<MetodoCobro[]>([]);
  const [propina, setPropina] = useState<number>(0);
  const [pagos, setPagos] = useState<PagoEnCurso[]>([]);
  const [montoNuevo, setMontoNuevo] = useState<number>(0);
  const [metodoNuevo, setMetodoNuevo] = useState<string>('efectivo');
  const [montoEntregado, setMontoEntregado] = useState<number>(0);
  const [confirmando, setConfirmando] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPagos([]); setPropina(0); setMontoNuevo(0); setMontoEntregado(0); setConfirmando(false);
    listMetodosCobroActivos(venta.local_id).then((r) => {
      setMetodos(r.data);
      if (r.data.length > 0 && r.data[0]) setMetodoNuevo(r.data[0].slug);
    });
  }, [open, venta.local_id]);

  const subtotalSinPropina = Number(venta.subtotal) - Number(venta.descuento_total);
  const totalConPropina = subtotalSinPropina + propina;
  const sumaPagos = useMemo(() => pagos.reduce((s, p) => s + p.monto, 0), [pagos]);
  const restante = Math.max(0, totalConPropina - sumaPagos);
  const cubrió = sumaPagos >= totalConPropina - 0.01;

  // Si el monto del nuevo pago es 0, autocompletar con el restante
  useEffect(() => {
    if (montoNuevo === 0 && restante > 0) setMontoNuevo(restante);
  }, [restante, montoNuevo]);

  const metodoActual = metodos.find((m) => m.slug === metodoNuevo);
  const pideVuelto = metodoActual?.pide_vuelto ?? false;
  const vueltoCalc = pideVuelto && montoEntregado >= montoNuevo ? montoEntregado - montoNuevo : 0;

  // Cuando el cajero cambia a un método que pide vuelto y aún no tocó "Cliente
  // entrega", asumimos "Exacto" (caso 80%) y dejamos que toque billete si
  // quiere cambiar. Evita un input vacío que confunde + deja "Exacto"
  // highlighteado por default.
  useEffect(() => {
    if (pideVuelto && montoEntregado === 0 && montoNuevo > 0) {
      setMontoEntregado(montoNuevo);
    }
  }, [pideVuelto, montoNuevo, montoEntregado]);

  function agregarPagoLocal() {
    if (montoNuevo <= 0) { toast.error('Monto inválido'); return; }
    if (montoNuevo > restante + 0.01) {
      toast.error('Monto supera lo que falta cobrar');
      return;
    }
    setPagos((p) => [...p, {
      id: crypto.randomUUID?.() ?? `local-${Date.now()}-${Math.random()}`,
      idempotencyKey: newIdempotencyKey(),
      metodo: metodoNuevo,
      monto: montoNuevo,
      vuelto: pideVuelto ? vueltoCalc : null,
      confirmado: false,
    }]);
    setMontoNuevo(0);
    setMontoEntregado(0);
  }

  function eliminarPago(id: string) {
    setPagos((p) => p.filter((x) => x.id !== id));
  }

  async function confirmar() {
    // 1-click UX: si el cajero NO presionó "+ Agregar pago" pero el form
    // tiene un monto que cubre todo, auto-agregar el pago antes de procesar.
    // Caso de uso 99%: 1 método + total exacto → tocar "Cobrar" y listo.
    let pagosAEnviar = pagos;
    if (pagos.length === 0 && montoNuevo > 0 && Math.abs(montoNuevo - totalConPropina) < 0.01) {
      pagosAEnviar = [{
        id: crypto.randomUUID?.() ?? `local-${Date.now()}-${Math.random()}`,
        idempotencyKey: newIdempotencyKey(),
        metodo: metodoNuevo,
        monto: montoNuevo,
        vuelto: pideVuelto ? vueltoCalc : null,
        confirmado: false,
      }];
    } else if (!cubrió) {
      toast.error('Faltan pagos para cubrir el total');
      return;
    }
    setConfirmando(true);
    let propinaRestante = propina;
    for (const p of pagosAEnviar) {
      if (p.confirmado) continue;
      const propinaIncl = Math.min(propinaRestante, p.monto);
      propinaRestante -= propinaIncl;
      const { error } = await agregarPago({
        ventaId: venta.id,
        metodo: p.metodo,
        monto: p.monto,
        idempotencyKey: p.idempotencyKey,
        cobradoPor: empleadoId,
        vuelto: p.vuelto ?? null,
        propinaIncluida: propinaIncl,
      });
      if (error) {
        toast.error(`Error procesando pago: ${error}`);
        setConfirmando(false);
        return;
      }
      p.confirmado = true;
    }
    toast.success('Venta cobrada');
    onCobrado();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Cobrar venta #{venta.numero_local}</DialogTitle>
          <DialogDescription>
            Subtotal: <strong>{formatARS(subtotalSinPropina)}</strong>
          </DialogDescription>
        </DialogHeader>

        {/* Propina */}
        <div className="space-y-2">
          <Label>Propina</Label>
          <div className="flex gap-2 items-center flex-wrap">
            {PROPINA_PCTS.map((p) => {
              const monto = Math.round(subtotalSinPropina * p);
              const sel = Math.abs(propina - monto) < 0.01;
              return (
                <Button
                  key={p}
                  type="button"
                  variant={sel ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPropina(monto)}
                  className="rounded-full"
                >
                  {p === 0 ? 'Sin' : `${p * 100}%`}
                </Button>
              );
            })}
            <div className="flex-1 min-w-[120px]">
              <MoneyInput value={propina} onChange={setPropina} />
            </div>
          </div>
        </div>

        {/* Total + estado de cobro */}
        <div className={cn(
          'rounded-md p-3 flex justify-between items-center text-base',
          cubrió ? 'bg-success/10' : 'bg-primary/10',
        )}>
          <strong>Total a cobrar</strong>
          <strong className="tabular-nums text-lg">{formatARS(totalConPropina)}</strong>
        </div>

        {/* Pagos parciales */}
        {pagos.length > 0 && (
          <div className="space-y-2">
            <Label>Pagos registrados</Label>
            <div className="space-y-1">
              {pagos.map((p) => {
                const m = metodos.find((x) => x.slug === p.metodo);
                return (
                  <div key={p.id} className="flex items-center justify-between p-2 rounded bg-muted text-sm">
                    <div>
                      <strong>{m?.emoji} {m?.nombre ?? p.metodo}</strong>
                      <span className="ml-2 tabular-nums">{formatARS(p.monto)}</span>
                      {p.vuelto && p.vuelto > 0 && (
                        <span className="ml-2 text-xs text-warning">vuelto: {formatARS(p.vuelto)}</span>
                      )}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => eliminarPago(p.id)}
                      disabled={confirmando}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-sm font-medium pt-1">
              <span>Restante</span>
              <span className={cn('tabular-nums', cubrió ? 'text-success' : 'text-warning')}>
                {formatARS(restante)}
              </span>
            </div>
          </div>
        )}

        {/* Form pago nuevo */}
        {!cubrió && (
          <div className="space-y-3 border-t border-border pt-4">
            <Label>Agregar pago</Label>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2">
              {metodos.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMetodoNuevo(m.slug)}
                  className={cn(
                    'p-2 rounded-md text-sm border transition-colors h-11',
                    metodoNuevo === m.slug
                      ? 'border-primary border-2 bg-primary/5'
                      : 'border-input bg-background hover:bg-accent',
                  )}
                >
                  {m.emoji} {m.nombre}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">Monto</Label>
                <MoneyInput value={montoNuevo} onChange={setMontoNuevo} />
              </div>
              {pideVuelto && (
                <div>
                  <Label className="text-xs text-muted-foreground">Cliente entrega</Label>
                  <MoneyInput value={montoEntregado} onChange={setMontoEntregado} />
                </div>
              )}
            </div>

            {/* Atajos billete para efectivo — gran win velocidad cajero */}
            {pideVuelto && montoNuevo > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Cliente paga con</Label>
                <div className="flex gap-1.5 flex-wrap">
                  <Button
                    type="button"
                    variant={montoEntregado === montoNuevo ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setMontoEntregado(montoNuevo)}
                    className="rounded-full"
                  >
                    Exacto
                  </Button>
                  {BILLETES_AR.filter((b) => b > montoNuevo).slice(0, 4).map((b) => (
                    <Button
                      key={b}
                      type="button"
                      variant={montoEntregado === b ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setMontoEntregado(b)}
                      className="rounded-full tabular-nums"
                    >
                      {formatARS(b)}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {pideVuelto && vueltoCalc > 0 && (
              <div className="p-2 rounded-md bg-warning/10 text-warning-foreground text-sm flex items-center justify-between">
                <span>Vuelto</span>
                <strong className="tabular-nums text-base">{formatARS(vueltoCalc)}</strong>
              </div>
            )}
            {pideVuelto && montoEntregado > 0 && montoEntregado < montoNuevo && (
              <div className="p-2 rounded-md bg-destructive/10 text-destructive text-xs">
                ⚠ Falta {formatARS(montoNuevo - montoEntregado)} para cubrir el monto
              </div>
            )}
            {/* Solo aparece si querés split (otro pago aparte del actual). */}
            <Button
              type="button"
              variant="outline"
              onClick={agregarPagoLocal}
              disabled={montoNuevo <= 0 || montoNuevo >= restante - 0.01 || confirmando}
              className="w-full"
            >
              <Plus className="h-4 w-4 mr-2" />
              Otro pago (split)
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirmando}>
            Cancelar
          </Button>
          <Button
            variant="success"
            onClick={confirmar}
            disabled={confirmando || (pagos.length === 0 && (montoNuevo <= 0 || Math.abs(montoNuevo - totalConPropina) > 0.01)) || (pagos.length > 0 && !cubrió)}
          >
            <CheckCircle2 className="h-4 w-4 mr-2" />
            {confirmando ? 'Procesando…' : `Cobrar ${formatARS(totalConPropina)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
