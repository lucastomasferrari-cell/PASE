import { useEffect, useRef, useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Trash2, Plus, CheckCircle2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogTitle,
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
  id: string;
  idempotencyKey: string;
  metodo: string;
  monto: number;
  vuelto?: number | null;
  cuotas?: number | null;
  confirmado: boolean;
}

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

const PROPINA_FIJA = 0;
const BILLETES_AR = [1000, 2000, 5000, 10000, 20000];

export function PaymentDialog({ open, onOpenChange, venta, items, catalogo, empleadoId, onCobrado }: Props) {
  const [metodos, setMetodos] = useState<MetodoCobro[]>([]);
  const propina = PROPINA_FIJA;
  const [pagos, setPagos] = useState<PagoEnCurso[]>([]);
  const [montoNuevo, setMontoNuevo] = useState<number>(0);
  const [metodoNuevo, setMetodoNuevo] = useState<string>('efectivo');
  const [cuotasNuevo, setCuotasNuevo] = useState<number>(1);
  const [montoEntregado, setMontoEntregado] = useState<number>(0);
  const [confirmando, setConfirmando] = useState(false);
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

  useEffect(() => {
    if (montoNuevo === 0 && restante > 0) setMontoNuevo(restante);
  }, [restante, montoNuevo]);

  const metodoActual = metodos.find((m) => m.slug === metodoNuevo);
  const pideVuelto = metodoActual?.pide_vuelto ?? false;
  const vueltoCalc = pideVuelto && montoEntregado >= montoNuevo ? montoEntregado - montoNuevo : 0;

  useEffect(() => {
    if (pideVuelto && montoEntregado === 0 && montoNuevo > 0) {
      setMontoEntregado(montoNuevo);
    }
  }, [pideVuelto, montoNuevo, montoEntregado]);

  function agregarPagoLocal() {
    if (montoNuevo <= 0) { toast.error('Monto inválido'); return; }
    if (montoNuevo > restante + 0.01) { toast.error('Monto supera lo que falta cobrar'); return; }
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
        if (error) { toast.error(`Error procesando pago: ${error}`); return; }
        p.confirmado = true;
      }
      toast.success('Venta cobrada');
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

  const itemsActivos = items.filter((i) => i.estado !== 'anulado');
  const cursos = Array.from(new Set(itemsActivos.map((i) => i.curso ?? 1))).sort((a, b) => a - b);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogTitle className="sr-only">Cobrar venta #{venta.numero_local}</DialogTitle>
        <DialogDescription className="sr-only">Registrar el cobro de la venta</DialogDescription>

        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* ── IZQUIERDA: comanda ─────────────────────────────────── */}
          <div className="w-[44%] shrink-0 flex flex-col border-r border-border/40 bg-card/60">
            {/* Header comanda */}
            <div className="px-4 pt-4 pb-3 border-b border-border/40">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Comanda</span>
                <span className="text-xs text-muted-foreground">#{venta.numero_local}</span>
              </div>
              {/* Meta: mesa / cliente / covers */}
              <div className="mt-1.5 space-y-0.5">
                {venta.mesa_id && (
                  <div className="text-xs text-foreground/70">
                    <span className="font-medium">Mesa</span>
                  </div>
                )}
                {venta.cliente_nombre && (
                  <div className="text-xs text-foreground/70">
                    <span className="font-medium">Cliente</span> · {venta.cliente_nombre}
                  </div>
                )}
                {(venta as unknown as { covers?: number }).covers && (
                  <div className="text-xs text-foreground/70">
                    <span className="font-medium">Comensales</span> · {(venta as unknown as { covers?: number }).covers}
                  </div>
                )}
                {venta.tab_nombre && (
                  <div className="text-xs text-foreground/70">
                    <span className="font-medium">Tab</span> · {venta.tab_nombre}
                  </div>
                )}
                {venta.notas && (
                  <div className="text-xs italic text-warning/80 mt-1">{venta.notas}</div>
                )}
              </div>
            </div>

            {/* Items */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {cursos.map((curso) => {
                const its = itemsActivos.filter((i) => (i.curso ?? 1) === curso);
                return (
                  <div key={curso}>
                    {cursos.length > 1 && (
                      <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5 pb-0.5 border-b border-border/30">
                        Curso {curso}
                      </div>
                    )}
                    <div className="space-y-1">
                      {its.map((it) => {
                        const cat = catalogo.find((c) => c.id === it.item_id);
                        const nombre = it.nombre_display ?? cat?.nombre ?? `Item #${it.item_id}`;
                        return (
                          <div key={it.id} className="flex items-baseline justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <span className="text-xs text-muted-foreground tabular-nums mr-1">{it.cantidad}×</span>
                              <span className="text-xs text-foreground leading-snug">{nombre}</span>
                              {it.es_cortesia && (
                                <span className="ml-1 text-[9px] px-1 py-0.5 rounded bg-success/15 text-success font-bold uppercase">Cortesía</span>
                              )}
                              {it.modificadores && it.modificadores.length > 0 && (
                                <div className="text-[10px] text-muted-foreground/70 truncate pl-3">
                                  {it.modificadores.map((m) => m.nombre).join(' · ')}
                                </div>
                              )}
                            </div>
                            <span className="text-xs tabular-nums shrink-0 text-foreground/80">
                              {it.es_cortesia ? <span className="text-success">$0</span> : formatARS(it.subtotal)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Totales — pie de la comanda */}
            <div className="px-4 py-3 border-t border-border/40 space-y-1">
              {Number(venta.descuento_total) > 0 && (
                <>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Subtotal</span>
                    <span className="tabular-nums">{formatARS(venta.subtotal)}</span>
                  </div>
                  <div className="flex justify-between text-xs text-success">
                    <span>Descuento</span>
                    <span className="tabular-nums">−{formatARS(venta.descuento_total)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between text-sm font-semibold pt-0.5">
                <span>Total</span>
                <span className="tabular-nums">{formatARS(totalConPropina)}</span>
              </div>
            </div>
          </div>

          {/* ── DERECHA: cobro ─────────────────────────────────────── */}
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">

            {/* Monto restante */}
            <div className="px-4 pt-4 pb-3 border-b border-border/40 shrink-0">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-0.5">
                {cubrió ? 'Total cobrado' : sumaPagos > 0 ? 'Falta cobrar' : 'Total a cobrar'}
              </div>
              <div className={cn(
                'text-3xl font-bold tabular-nums tracking-tight leading-none',
                cubrió ? 'text-success' : 'text-primary',
              )}>
                {formatARS(cubrió ? totalConPropina : restante)}
              </div>
              {sumaPagos > 0 && !cubrió && (
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  Pagado {formatARS(sumaPagos)} de {formatARS(totalConPropina)}
                </div>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 min-h-0">

              {/* Pagos ya registrados (split) */}
              {pagos.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Pagos registrados</div>
                  {pagos.map((p) => {
                    const m = metodos.find((x) => x.slug === p.metodo);
                    return (
                      <div key={p.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-1.5 text-xs">
                        <div className="min-w-0">
                          <span className="font-medium">{m?.emoji} {m?.nombre ?? p.metodo}</span>
                          <span className="ml-2 tabular-nums text-muted-foreground">{formatARS(p.monto)}</span>
                          {p.cuotas && p.cuotas > 1 && (
                            <span className="ml-1 text-muted-foreground">· {p.cuotas}c</span>
                          )}
                          {p.vuelto && p.vuelto > 0 && (
                            <span className="ml-1 text-warning">· vuelto {formatARS(p.vuelto)}</span>
                          )}
                        </div>
                        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => eliminarPago(p.id)} disabled={confirmando}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}

              {!cubrió && (
                <>
                  {/* Medios de pago */}
                  <div className="space-y-2">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">¿Cómo paga?</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {metodos.map((m) => {
                        const sel = metodoNuevo === m.slug;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            aria-pressed={sel}
                            onClick={() => setMetodoNuevo(m.slug)}
                            className={cn(
                              'flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors duration-150',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              sel
                                ? 'bg-primary/15 ring-1 ring-primary text-foreground'
                                : 'bg-muted/40 hover:bg-muted text-foreground/80',
                            )}
                          >
                            <span className="text-base leading-none shrink-0">{m.emoji}</span>
                            <span className="text-xs font-medium leading-tight line-clamp-1">{m.nombre}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Monto + cliente entrega */}
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Monto</Label>
                        <MoneyInput value={montoNuevo} onChange={setMontoNuevo} />
                      </div>
                      {pideVuelto && (
                        <div className="space-y-1">
                          <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Cliente entrega</Label>
                          <MoneyInput value={montoEntregado} onChange={setMontoEntregado} />
                        </div>
                      )}
                    </div>

                    {/* Cuotas */}
                    {metodoAceptaCuotas(metodoNuevo) && (
                      <div className="space-y-1">
                        <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Cuotas</Label>
                        <div className="grid grid-cols-6 gap-1">
                          {OPCIONES_CUOTAS.map((n) => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => setCuotasNuevo(n)}
                              className={cn(
                                'h-8 rounded-md text-xs font-medium transition-colors duration-150',
                                cuotasNuevo === n ? 'bg-primary/15 ring-1 ring-primary' : 'bg-muted/40 hover:bg-muted',
                              )}
                            >
                              {n === 1 ? '1' : `${n}c`}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Atajos billete efectivo */}
                    {pideVuelto && montoNuevo > 0 && (
                      <div className="space-y-1">
                        <Label className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Paga con</Label>
                        <div className="flex flex-wrap gap-1">
                          <button
                            type="button"
                            onClick={() => setMontoEntregado(montoNuevo)}
                            className={cn(
                              'h-8 px-3 rounded-full text-xs font-medium transition-colors duration-150',
                              montoEntregado === montoNuevo ? 'bg-primary text-primary-foreground' : 'bg-muted/40 hover:bg-muted',
                            )}
                          >
                            Exacto
                          </button>
                          {BILLETES_AR.filter((b) => b > montoNuevo).slice(0, 3).map((b) => (
                            <button
                              key={b}
                              type="button"
                              onClick={() => setMontoEntregado(b)}
                              className={cn(
                                'h-8 px-3 rounded-full text-xs font-medium tabular-nums transition-colors duration-150',
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
                      <div className="flex items-center justify-between rounded-lg bg-warning/10 px-3 py-2">
                        <span className="text-xs text-warning-foreground">Vuelto</span>
                        <strong className="text-sm tabular-nums text-warning">{formatARS(vueltoCalc)}</strong>
                      </div>
                    )}

                    {/* Split */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={agregarPagoLocal}
                      disabled={montoNuevo <= 0 || montoNuevo >= restante - 0.01 || confirmando}
                      className="w-full border border-dashed border-border/40 text-muted-foreground hover:text-foreground text-xs"
                    >
                      <Plus className="h-3.5 w-3.5 mr-1.5" />
                      Dividir en otro pago
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-border/40 shrink-0 flex gap-2">
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => onOpenChange(false)} disabled={confirmando}>
                Cancelar
              </Button>
              <Button
                variant="default"
                size="default"
                className="flex-1"
                onClick={confirmar}
                disabled={confirmando || (pagos.length === 0 && (montoNuevo <= 0 || Math.abs(montoNuevo - totalConPropina) > 0.01)) || (pagos.length > 0 && !cubrió)}
              >
                <CheckCircle2 className="h-4 w-4 mr-1.5" />
                {confirmando ? 'Procesando…' : `Cobrar ${formatARS(totalConPropina)}`}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
