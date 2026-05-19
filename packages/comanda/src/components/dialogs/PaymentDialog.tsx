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
  cuotas?: number | null; // 3/6/12 típico AR — solo aplica a crédito
  confirmado: boolean;    // true cuando ya se mandó al backend OK
}

// Helper: detectar si el método de cobro es de crédito (acepta cuotas).
// Reconoce por slug (configurable en metodos_cobro).
function metodoAceptaCuotas(slug: string): boolean {
  const s = slug.toLowerCase();
  return s.includes('credit') || s === 'tc' || s.includes('tarjeta_credito');
}

const OPCIONES_CUOTAS = [1, 3, 6, 9, 12, 18];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venta: VentaPos;
  empleadoId: string;
  onCobrado: () => void;
}

// Propina deshabilitada por pedido de Lucas (2026-05-15). El handling
// interno queda en 0 para no romper el resto de la lógica. Cuando se
// vuelva a activar, restaurar la sección UI + el array de porcentajes.
const PROPINA_FIJA = 0;

// Billetes típicos AR 2026. "Exacto" siempre primero; el resto solo aparecen
// si son > que el monto a cobrar (no tiene sentido mostrar $1000 si vas a
// cobrar $4500).
const BILLETES_AR = [1000, 2000, 5000, 10000, 20000];

// Multi-pago + propina + vuelto. Suma parcial vs total con indicador visual.
// Cada pago tiene idempotencyKey estable; si la red falla, retry no duplica.
export function PaymentDialog({ open, onOpenChange, venta, empleadoId, onCobrado }: Props) {
  const [metodos, setMetodos] = useState<MetodoCobro[]>([]);
  // Propina oculta por ahora — mantenemos la variable para no romper la
  // lógica de cobro pero siempre vale 0.
  const propina = PROPINA_FIJA;
  const [pagos, setPagos] = useState<PagoEnCurso[]>([]);
  const [montoNuevo, setMontoNuevo] = useState<number>(0);
  const [metodoNuevo, setMetodoNuevo] = useState<string>('efectivo');
  const [cuotasNuevo, setCuotasNuevo] = useState<number>(1);
  const [montoEntregado, setMontoEntregado] = useState<number>(0);
  const [confirmando, setConfirmando] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPagos([]); setMontoNuevo(0); setMontoEntregado(0); setCuotasNuevo(1); setConfirmando(false);
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
    const aceptaCuotas = metodoAceptaCuotas(metodoNuevo);
    setPagos((p) => [...p, {
      id: crypto.randomUUID?.() ?? `local-${Date.now()}-${Math.random()}`,
      idempotencyKey: newIdempotencyKey(),
      metodo: metodoNuevo,
      monto: montoNuevo,
      vuelto: pideVuelto ? vueltoCalc : null,
      cuotas: aceptaCuotas ? cuotasNuevo : null,
      confirmado: false,
    }]);
    setMontoNuevo(0);
    setMontoEntregado(0);
    setCuotasNuevo(1);
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
      const aceptaCuotas = metodoAceptaCuotas(metodoNuevo);
      pagosAEnviar = [{
        id: crypto.randomUUID?.() ?? `local-${Date.now()}-${Math.random()}`,
        idempotencyKey: newIdempotencyKey(),
        metodo: metodoNuevo,
        monto: montoNuevo,
        vuelto: pideVuelto ? vueltoCalc : null,
        cuotas: aceptaCuotas ? cuotasNuevo : null,
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
        cuotas: p.cuotas ?? null,
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
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 shrink-0">
          <DialogTitle>Cobrar venta #{venta.numero_local}</DialogTitle>
          <DialogDescription>
            Subtotal: <strong>{formatARS(subtotalSinPropina)}</strong>
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">

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
                      {p.cuotas && p.cuotas > 1 && (
                        <span className="ml-2 text-xs text-muted-foreground">en {p.cuotas} cuotas de {formatARS(p.monto / p.cuotas)}</span>
                      )}
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
              {/* Cuotas: solo si el método es de crédito (típico AR) */}
              {metodoAceptaCuotas(metodoNuevo) && (
                <div className={pideVuelto ? "col-span-2" : ""}>
                  <Label className="text-xs text-muted-foreground">Cuotas</Label>
                  <div className="grid grid-cols-6 gap-1">
                    {OPCIONES_CUOTAS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setCuotasNuevo(n)}
                        className={cn(
                          'h-9 rounded-md text-xs border transition-colors',
                          cuotasNuevo === n
                            ? 'border-primary border-2 bg-primary/5 font-semibold'
                            : 'border-input bg-background hover:bg-accent',
                        )}
                      >
                        {n === 1 ? '1 pago' : `${n}c`}
                      </button>
                    ))}
                  </div>
                  {cuotasNuevo > 1 && montoNuevo > 0 && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {cuotasNuevo} cuotas de {formatARS(montoNuevo / cuotasNuevo)}
                    </p>
                  )}
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

        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 gap-2">
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
