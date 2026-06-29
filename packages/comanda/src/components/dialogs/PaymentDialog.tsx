import { useEffect, useRef, useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Trash2, Plus, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { MoneyInput } from '@/components/MoneyInput';
import { listMetodosCobroActivos } from '@/services/configService';
import type { MetodoCobro, VentaPos, VentaPosItem } from '@/types/database';
import type { ItemConGrupo } from '@/services/itemsService';
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
// Reconoce por slug (configurable en medios_cobro, catálogo único).
function metodoAceptaCuotas(slug: string): boolean {
  const s = slug.toLowerCase();
  return s.includes('credit') || s === 'tc' || s.includes('tarjeta_credito');
}

const OPCIONES_CUOTAS = [1, 3, 6, 9, 12, 18];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  venta: VentaPos;
  items: VentaPosItem[];
  catalogo: ItemConGrupo[];
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
export function PaymentDialog({ open, onOpenChange, venta, items, catalogo, empleadoId, onCobrado }: Props) {
  const [ticketExpandido, setTicketExpandido] = useState(true);
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
  // Ref-based guard contra doble-click (fix sistémico 2026-05-18). En cobro
  // es crítico: si el cajero toca "Cobrar" dos veces, se generan 2 pagos
  // contra el mismo idempotencyKey — el segundo lo rechaza el backend pero
  // ensucia logs. Ref sincrónico ataja antes del re-render.
  const confirmandoRef = useRef(false);

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
    if (confirmandoRef.current) return;
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
    confirmandoRef.current = true;
    setConfirmando(true);
    try {
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
          return;
        }
        p.confirmado = true;
      }
      toast.success('Venta cobrada');
      // Fire-and-forget impresión del ticket de cliente. Si falla (sin
      // impresora, server caído, etc) NO bloqueamos el flow del POS — la
      // venta ya está cobrada. El operador puede reimprimir desde el
      // detalle del pedido.
      void (async () => {
        try {
          const { imprimirTicket } = await import('@/services/printerService');
          const { listVentasItems } = await import('@/services/ventasService');
          const itemsR = await listVentasItems(venta.id);
          await imprimirTicket({
            titulo: 'COMANDA',
            items: itemsR.data.map((it) => ({
              nombre: 'Item ' + it.item_id,
              cantidad: Number(it.cantidad),
              subtotal: Number(it.subtotal),
            })),
            total: Number(venta.total),
            pagos: pagosAEnviar.map((p) => ({
              metodo: p.metodo,
              monto: p.monto,
              cuotas: p.cuotas ?? null,
            })),
            fechaHora: new Date().toLocaleString('es-AR'),
            venta_id: venta.numero_local ?? venta.id,
            propina,
          });
        } catch (err) {
          console.warn('[print ticket] falló (no bloquea):', err);
        }
      })();
      onCobrado();
      onOpenChange(false);
    } finally {
      confirmandoRef.current = false;
      setConfirmando(false);
    }
  }

  // Agrupar items por curso (excluir anulados)
  const itemsActivos = items.filter((i) => i.estado !== 'anulado');
  const cursos = Array.from(new Set(itemsActivos.map((i) => i.curso ?? 1))).sort((a, b) => a - b);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 shrink-0 text-left space-y-0">
          <DialogTitle className="text-base font-semibold">
            Cobrar venta #{venta.numero_local}
          </DialogTitle>
          <DialogDescription className="sr-only">Registrar el cobro de la venta</DialogDescription>
        </DialogHeader>

        {/* Detalle del ticket — expandible */}
        <div className="shrink-0 border-b border-border">
          <button
            type="button"
            onClick={() => setTicketExpandido((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          >
            <span>Detalle de la cuenta</span>
            {ticketExpandido ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          {ticketExpandido && (
            <div className="px-5 pb-3 space-y-3 max-h-52 overflow-y-auto">
              {cursos.map((curso) => {
                const its = itemsActivos.filter((i) => i.curso === curso);
                return (
                  <div key={curso}>
                    {cursos.length > 1 && (
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                        Curso {curso}
                      </div>
                    )}
                    {its.map((it) => {
                      const cat = catalogo.find((c) => c.id === it.item_id);
                      const nombre = it.nombre_display ?? cat?.nombre ?? `Item #${it.item_id}`;
                      return (
                        <div key={it.id} className="flex items-start justify-between gap-2 py-0.5">
                          <div className="min-w-0 flex-1">
                            <span className="text-sm">
                              <span className="text-muted-foreground mr-1">{it.cantidad}×</span>
                              {nombre}
                            </span>
                            {it.es_cortesia && (
                              <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-success/15 text-success font-bold uppercase">Cortesía</span>
                            )}
                            {it.modificadores && it.modificadores.length > 0 && (
                              <div className="text-[10px] text-muted-foreground truncate">
                                {it.modificadores.map((m) => m.nombre).join(' · ')}
                              </div>
                            )}
                            {it.notas && (
                              <div className="text-[10px] text-warning italic truncate">{it.notas}</div>
                            )}
                          </div>
                          <span className="text-sm tabular-nums shrink-0">
                            {it.es_cortesia ? <span className="text-success">$0</span> : formatARS(it.subtotal)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
              {/* Subtotales */}
              <div className="border-t border-border pt-2 space-y-0.5">
                {Number(venta.descuento_total) > 0 && (
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Subtotal</span>
                    <span className="tabular-nums">{formatARS(venta.subtotal)}</span>
                  </div>
                )}
                {Number(venta.descuento_total) > 0 && (
                  <div className="flex justify-between text-sm text-success">
                    <span>Descuento</span>
                    <span className="tabular-nums">−{formatARS(venta.descuento_total)}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{formatARS(totalConPropina)}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Total — el foco de la pantalla */}
        <div className="px-5 shrink-0">
          <div className={cn(
            'rounded-2xl px-5 py-4 transition-colors duration-200',
            cubrió ? 'bg-success/15' : 'bg-muted/50',
          )}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {cubrió ? 'Total cobrado' : sumaPagos > 0 ? 'Falta cobrar' : 'Total a cobrar'}
              </span>
              {sumaPagos > 0 && !cubrió && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  Pagado {formatARS(sumaPagos)} de {formatARS(totalConPropina)}
                </span>
              )}
            </div>
            <div className={cn(
              'mt-1 text-[2.5rem] leading-none font-semibold tabular-nums tracking-tight',
              cubrió ? 'text-success' : 'text-foreground',
            )}>
              {formatARS(cubrió ? totalConPropina : restante)}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 min-h-0">

          {/* Pagos ya registrados (split) */}
          {pagos.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Pagos registrados</div>
              <div className="space-y-1.5">
                {pagos.map((p) => {
                  const m = metodos.find((x) => x.slug === p.metodo);
                  return (
                    <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <span className="font-medium">{m?.emoji} {m?.nombre ?? p.metodo}</span>
                        <span className="ml-2 tabular-nums text-muted-foreground">{formatARS(p.monto)}</span>
                        {p.cuotas && p.cuotas > 1 && (
                          <span className="ml-2 text-xs text-muted-foreground">· {p.cuotas} cuotas de {formatARS(p.monto / p.cuotas)}</span>
                        )}
                        {p.vuelto && p.vuelto > 0 && (
                          <span className="ml-2 text-xs text-warning">· vuelto {formatARS(p.vuelto)}</span>
                        )}
                      </div>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => eliminarPago(p.id)} disabled={confirmando}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!cubrió && (
            <>
              {/* Medios de pago — grilla de tiles */}
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">¿Cómo paga?</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {metodos.map((m) => {
                    const sel = metodoNuevo === m.slug;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={sel}
                        onClick={() => setMetodoNuevo(m.slug)}
                        className={cn(
                          'flex flex-col items-center justify-center gap-1 rounded-xl px-2 py-3 min-h-[64px] text-center transition-colors duration-150',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          sel
                            ? 'bg-primary/15 ring-2 ring-primary text-foreground'
                            : 'bg-muted/40 hover:bg-muted text-foreground/90',
                        )}
                      >
                        <span className="text-xl leading-none">{m.emoji}</span>
                        <span className="text-xs font-medium leading-tight line-clamp-2">{m.nombre}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Monto + (cliente entrega) */}
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Monto</Label>
                    <MoneyInput value={montoNuevo} onChange={setMontoNuevo} />
                  </div>
                  {pideVuelto && (
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Cliente entrega</Label>
                      <MoneyInput value={montoEntregado} onChange={setMontoEntregado} />
                    </div>
                  )}
                </div>

                {/* Cuotas: solo si el método es de crédito (típico AR) */}
                {metodoAceptaCuotas(metodoNuevo) && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Cuotas</Label>
                    <div className="grid grid-cols-6 gap-1.5">
                      {OPCIONES_CUOTAS.map((n) => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setCuotasNuevo(n)}
                          className={cn(
                            'h-10 rounded-lg text-xs font-medium transition-colors duration-150',
                            cuotasNuevo === n
                              ? 'bg-primary/15 ring-2 ring-primary'
                              : 'bg-muted/40 hover:bg-muted',
                          )}
                        >
                          {n === 1 ? '1 pago' : `${n}c`}
                        </button>
                      ))}
                    </div>
                    {cuotasNuevo > 1 && montoNuevo > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        {cuotasNuevo} cuotas de {formatARS(montoNuevo / cuotasNuevo)}
                      </p>
                    )}
                  </div>
                )}

                {/* Atajos billete para efectivo — gran win velocidad cajero */}
                {pideVuelto && montoNuevo > 0 && (
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground">Cliente paga con</Label>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() => setMontoEntregado(montoNuevo)}
                        className={cn(
                          'h-10 px-4 rounded-full text-sm font-medium transition-colors duration-150',
                          montoEntregado === montoNuevo ? 'bg-primary text-primary-foreground' : 'bg-muted/40 hover:bg-muted',
                        )}
                      >
                        Exacto
                      </button>
                      {BILLETES_AR.filter((b) => b > montoNuevo).slice(0, 4).map((b) => (
                        <button
                          key={b}
                          type="button"
                          onClick={() => setMontoEntregado(b)}
                          className={cn(
                            'h-10 px-4 rounded-full text-sm font-medium tabular-nums transition-colors duration-150',
                            montoEntregado === b ? 'bg-primary text-primary-foreground' : 'bg-muted/40 hover:bg-muted',
                          )}
                        >
                          {formatARS(b)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {pideVuelto && vueltoCalc > 0 && (
                  <div className="flex items-center justify-between rounded-lg bg-warning/15 px-3 py-2.5 text-warning-foreground">
                    <span className="text-sm">Vuelto</span>
                    <strong className="tabular-nums text-lg">{formatARS(vueltoCalc)}</strong>
                  </div>
                )}
                {pideVuelto && montoEntregado > 0 && montoEntregado < montoNuevo && (
                  <div className="rounded-lg bg-destructive/15 px-3 py-2 text-xs text-destructive">
                    Falta {formatARS(montoNuevo - montoEntregado)} para cubrir el monto
                  </div>
                )}

                {/* Dividir el pago (split) */}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={agregarPagoLocal}
                  disabled={montoNuevo <= 0 || montoNuevo >= restante - 0.01 || confirmando}
                  className="w-full border border-dashed border-border text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Dividir en otro pago
                </Button>
              </div>
            </>
          )}

        </div>

        <DialogFooter className="px-5 py-4 border-t border-border shrink-0 flex-row gap-2">
          <Button variant="outline" size="lg" className="flex-1 sm:flex-none" onClick={() => onOpenChange(false)} disabled={confirmando}>
            Cancelar
          </Button>
          <Button
            variant="success"
            size="xl"
            className="flex-[2]"
            onClick={confirmar}
            disabled={confirmando || (pagos.length === 0 && (montoNuevo <= 0 || Math.abs(montoNuevo - totalConPropina) > 0.01)) || (pagos.length > 0 && !cubrió)}
          >
            <CheckCircle2 className="h-5 w-5 mr-2" />
            {confirmando ? 'Procesando…' : `Cobrar ${formatARS(totalConPropina)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
