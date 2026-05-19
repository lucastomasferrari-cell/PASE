import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, Phone, MapPin, Home, Clock, CreditCard,
  Printer, MoreVertical, CheckCircle2, ChefHat, X, MessageSquareWarning, Edit3,
  MessageCircle,
} from 'lucide-react';
import { whatsAppUrl, mensajeGenericoCliente } from '@/lib/whatsapp';
import {
  getPedidoDetalle,
  aprobarPedidoService, marcarListoService, marcarEntregadoService,
  cancelarPedidoService, calcularEstadoPago,
  type PedidoDetalleData,
} from '@/services/pedidosService';
import {
  notificarPedidoListo, notificarPedidoEntregado, notificarPedidoRechazado,
} from '@/services/tiendaService';
import { formatARS, formatHora } from '@/lib/format';
import { CanalBadge } from '@/components/CanalBadge';
import { BadgePago } from '@/components/BadgePago';
import { UrgencyTimer } from '@/components/UrgencyTimer';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ManagerOverrideDialog } from '@/components/dialogs/ManagerOverrideDialog';
import { useRealtimeTable } from '@/lib/useRealtimeTable';
import { useAuthPos } from '@/lib/authPos';
import { cn } from '@/lib/utils';

// Vista detallada de pedido — patrón Toast Storefront Orders.
// Sidebar 280px con 4 secciones (Cliente / Entrega / Tiempo / Pago).
// Center: banner aclaración + lista items con modificadores + cálculo total con comisión visible.
// Footer fijo: Editar / Cancelar (requiere PIN manager) / Marcar listo.

export function PedidoDetalle() {
  const { ventaId } = useParams<{ ventaId: string }>();
  const navigate = useNavigate();
  const id = Number(ventaId);
  const { empleado } = useAuthPos();
  const [data, setData] = useState<PedidoDetalleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [accionLoading, setAccionLoading] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const reload = useCallback(async () => {
    if (!Number.isFinite(id) || id <= 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const r = await getPedidoDetalle(id);
    if (r.error) {
      toast.error(r.error);
      setData(null);
    } else {
      setData(r.data);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  // Realtime: si la cocina marca un item listo (KDS) o el cajero edita
  // el pedido desde otro device, se refleja sin F5. Filtro por venta_id.
  useRealtimeTable({
    table: 'ventas_pos',
    onChange: () => reload(),
    extraFilter: Number.isFinite(id) && id > 0 ? `id=eq.${id}` : undefined,
    enabled: Number.isFinite(id) && id > 0,
  });
  useRealtimeTable({
    table: 'ventas_pos_items',
    onChange: () => reload(),
    extraFilter: Number.isFinite(id) && id > 0 ? `venta_id=eq.${id}` : undefined,
    enabled: Number.isFinite(id) && id > 0,
  });

  if (loading) {
    return <div className="container py-8 text-center text-muted-foreground">Cargando…</div>;
  }
  if (!data) {
    return (
      <div className="container py-8 text-center">
        <p className="text-muted-foreground">Pedido no encontrado.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/pos/pedidos')}>
          ← Volver a pedidos
        </Button>
      </div>
    );
  }

  // Cross-local guard
  if (empleado && data.venta.local_id !== empleado.local_id) {
    return (
      <div className="container max-w-md py-12">
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-center">
          <div className="text-3xl mb-2">⚠️</div>
          <h2 className="text-lg font-semibold mb-2">Pedido de otro local</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Este pedido pertenece a otro local. Cambiá el local activo en el sidebar de PASE.
          </p>
          <Button variant="outline" onClick={() => navigate('/pos/pedidos')}>
            ← Volver a pedidos
          </Button>
        </div>
      </div>
    );
  }

  const { venta, items, pagos, canal } = data;
  const estadoPago = calcularEstadoPago(Number(venta.total), pagos);

  // ─── Acciones ──────────────────────────────────────────────────────────────
  const handleAprobar = async () => {
    setAccionLoading(true);
    const r = await aprobarPedidoService(venta.id);
    setAccionLoading(false);
    if (r.error) toast.error(r.error);
    else { toast.success('Pedido aprobado'); reload(); }
  };
  const handleMarcarListo = async () => {
    setAccionLoading(true);
    const r = await marcarListoService(venta.id);
    setAccionLoading(false);
    if (r.error) toast.error(r.error);
    else {
      toast.success('Pedido marcado como listo');
      // Gap #4: avisar al cliente. Fire-and-forget — idempotente server-side.
      if (venta.origen === 'tienda_online') void notificarPedidoListo({ ventaId: venta.id });
      reload();
    }
  };
  const handleEntregado = async () => {
    setAccionLoading(true);
    const r = await marcarEntregadoService(venta.id);
    setAccionLoading(false);
    if (r.error) toast.error(r.error);
    else {
      toast.success('Pedido entregado');
      // Gap #4: invitación a calificar — solo si era pedido del marketplace.
      if (venta.origen === 'tienda_online') void notificarPedidoEntregado({ ventaId: venta.id });
      navigate('/pos/pedidos');
    }
  };
  const handleCancelarConfirmado = async (managerId: string, motivo: string) => {
    setAccionLoading(true);
    const r = await cancelarPedidoService(venta.id, managerId, motivo);
    setAccionLoading(false);
    setCancelOpen(false);
    if (r.error) toast.error(r.error);
    else {
      toast.success('Pedido cancelado');
      // Gap #4: avisar al cliente del rechazo con el motivo. Solo marketplace.
      if (venta.origen === 'tienda_online') {
        void notificarPedidoRechazado({ ventaId: venta.id, motivo });
      }
      navigate('/pos/pedidos');
    }
  };

  // ─── Cálculo total con comisión ────────────────────────────────────────────
  const subtotalItems = Number(venta.subtotal);
  const totalCobrado = Number(venta.total);
  const comisionPct = Number(canal?.comision_externa_pct ?? 0);
  const comisionMonto = totalCobrado * (comisionPct / 100);
  const cobramos = totalCobrado - comisionMonto;

  // Botón principal del footer cambia según estado.
  // Capitalizo el nombre del campo `Icon` para que JSX lo trate como componente.
  const accionPrincipal =
    venta.estado === 'necesita_aprobacion' ? { label: 'Aprobar pedido', Icon: CheckCircle2, onClick: handleAprobar } :
    venta.estado === 'enviada' ? { label: 'Marcar listo', Icon: ChefHat, onClick: handleMarcarListo } :
    venta.estado === 'lista' ? { label: 'Marcar entregado', Icon: CheckCircle2, onClick: handleEntregado } :
    null;

  // Pago: cuál fue el método (si pagó online).
  const pagoOnline = pagos[0] ?? null;
  const metodoPagoLabel = pagoOnline?.metodo ?? '—';

  return (
    <div className="container py-4 pb-24">
      {/* HEADER */}
      <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => navigate('/pos/pedidos')} className="-ml-2">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Volver a pedidos
          </Button>
          {canal && <CanalBadge slug={canal.slug} label={canal.nombre} emoji={canal.emoji} />}
          <h1 className="text-xl font-bold tabular-nums">#{venta.numero_local}</h1>
          <BadgePago estadoPago={estadoPago} tipoEntrega={venta.tipo_entrega} size="md" />
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const { reimprimirComanda } = await import('@/services/ventasService');
              const r = await reimprimirComanda(venta.id);
              if (r.error) toast.error(r.error);
              else toast.success('Comanda reenviada a impresora(s) de cocina');
            }}
            title="Reenviar comanda completa a las impresoras de cocina"
          >
            <Printer className="h-4 w-4 mr-1" />
            Reimprimir
          </Button>
          <Button variant="outline" size="sm" disabled title="Próximamente">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* CONTENT: sidebar + center */}
      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* SIDEBAR — 4 secciones */}
        <aside className="space-y-3">
          {/* Cliente */}
          <Card>
            <CardContent className="p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Cliente</div>
              <div className="font-medium text-sm">{venta.cliente_nombre ?? '—'}</div>
              {venta.cliente_telefono && (
                <div className="flex items-center gap-3 text-xs">
                  <a href={`tel:${venta.cliente_telefono}`} className="flex items-center gap-1.5 text-primary hover:underline">
                    <Phone className="h-3 w-3" /> {venta.cliente_telefono}
                  </a>
                  {(() => {
                    const wp = whatsAppUrl(
                      venta.cliente_telefono,
                      mensajeGenericoCliente(venta.cliente_nombre ?? '', venta.numero_local),
                    );
                    return wp ? (
                      <a href={wp} target="_blank" rel="noopener" className="flex items-center gap-1 text-green-700 hover:underline">
                        <MessageCircle className="h-3 w-3" /> WhatsApp
                      </a>
                    ) : null;
                  })()}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Entrega */}
          <Card>
            <CardContent className="p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Entrega</div>
              {venta.tipo_entrega === 'delivery' ? (
                <>
                  <div className="flex items-start gap-1.5 text-sm">
                    <MapPin className="h-3.5 w-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
                    <span>{venta.cliente_direccion ?? 'Sin dirección'}</span>
                  </div>
                  {/* Mapa + acciones — solo si tenemos lat/lon */}
                  {venta.cliente_lat != null && venta.cliente_lon != null && (
                    <div className="space-y-1.5 mt-1">
                      {/* Mini-mapa estático con OpenStreetMap (sin API key) */}
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${venta.cliente_lat},${venta.cliente_lon}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block relative rounded-md overflow-hidden border border-border hover:opacity-90"
                        title="Abrir en Google Maps"
                      >
                        <img
                          src={`https://staticmap.openstreetmap.de/staticmap.php?center=${venta.cliente_lat},${venta.cliente_lon}&zoom=16&size=400x180&markers=${venta.cliente_lat},${venta.cliente_lon},red-pushpin`}
                          alt="Ubicación cliente"
                          className="w-full h-32 object-cover"
                          loading="lazy"
                          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                        />
                      </a>
                      <div className="flex gap-1.5 text-[10px]">
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${venta.cliente_lat},${venta.cliente_lon}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          Abrir en Google Maps
                        </a>
                        <span className="text-muted-foreground">·</span>
                        <a
                          href={`https://waze.com/ul?ll=${venta.cliente_lat},${venta.cliente_lon}&navigate=yes`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          Waze
                        </a>
                      </div>
                    </div>
                  )}
                </>
              ) : venta.tipo_entrega === 'retiro' ? (
                <div className="flex items-center gap-1.5 text-sm">
                  <Home className="h-3.5 w-3.5 text-muted-foreground" /> Retiro en local
                </div>
              ) : (
                <div className="text-sm text-muted-foreground italic">No especificado</div>
              )}
            </CardContent>
          </Card>

          {/* Tiempo */}
          <Card>
            <CardContent className="p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Tiempo</div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                Recibido {formatHora(venta.created_at)}
              </div>
              <div className="pt-1">
                <div className="text-[10px] text-muted-foreground">Transcurrido</div>
                <UrgencyTimer desdeIso={venta.created_at} className="text-base" />
              </div>
              {venta.programada_para && (
                <div className="pt-1 text-xs">
                  <div className="text-[10px] text-muted-foreground">Programado para</div>
                  <span className="font-medium">{formatHora(venta.programada_para)}</span>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Pago */}
          <Card>
            <CardContent className="p-3 space-y-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Pago</div>
              <BadgePago estadoPago={estadoPago} tipoEntrega={venta.tipo_entrega} size="md" />
              {pagoOnline && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-1">
                  <CreditCard className="h-3 w-3" />
                  Método: <span className="font-medium text-foreground capitalize">{metodoPagoLabel}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </aside>

        {/* CENTER: aclaración + items + cálculo */}
        <main className="space-y-3">
          {/* Banner aclaración cliente (Toast pattern: imposible no verlo) */}
          {venta.notas?.trim() && (
            <div className="rounded-lg bg-warning/15 border-l-4 border-warning px-4 py-3 flex items-start gap-2">
              <MessageSquareWarning className="h-4 w-4 text-warning flex-shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-semibold text-warning uppercase tracking-wide mb-0.5">Aclaración del cliente</div>
                <p className="text-sm text-warning-foreground italic">{venta.notas}</p>
              </div>
            </div>
          )}

          {/* Items con modificadores */}
          <Card>
            <CardContent className="p-0">
              <div className="px-4 py-2.5 border-b">
                <h2 className="font-semibold text-sm">Items del pedido</h2>
              </div>
              {items.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-muted-foreground italic">Sin items.</div>
              ) : (
                <ul className="divide-y">
                  {items.map((it) => {
                    const mods = it.modificadores ?? [];
                    const subtotal = Number(it.subtotal);
                    return (
                      <li key={it.id} className="px-4 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm">
                              <span className="tabular-nums">{Number(it.cantidad)}×</span>{' '}
                              {it.item_emoji && <span className="mr-1">{it.item_emoji}</span>}
                              {it.item_nombre}
                            </div>
                            {mods.length > 0 && (
                              <ul className="mt-1 ml-4 text-xs text-muted-foreground space-y-0.5">
                                {mods.map((m, i) => (
                                  <li key={i}>
                                    · {m.nombre}
                                    {Number(m.precio_extra) > 0 && (
                                      <span className="ml-1">(+{formatARS(Number(m.precio_extra))})</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                          <span className="text-sm tabular-nums font-medium flex-shrink-0">{formatARS(subtotal)}</span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Cálculo con comisión visible (Toast pattern: transparencia financiera) */}
          <Card>
            <CardContent className="p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Subtotal items</span>
                <span className="tabular-nums">{formatARS(subtotalItems)}</span>
              </div>
              {Number(venta.descuento_total) > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Descuento</span>
                  <span className="tabular-nums text-success">- {formatARS(Number(venta.descuento_total))}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-semibold pt-2 border-t">
                <span>Total al cliente</span>
                <span className="tabular-nums">{formatARS(totalCobrado)}</span>
              </div>
              {comisionPct > 0 && (
                <>
                  <div className="flex justify-between text-sm">
                    <span className="text-destructive">Comisión {canal?.nombre} ({comisionPct}%)</span>
                    <span className="tabular-nums text-destructive">- {formatARS(comisionMonto)}</span>
                  </div>
                  <div className="flex justify-between text-base font-bold pt-2 border-t border-success/30">
                    <span className="text-success">Cobramos neto</span>
                    <span className="tabular-nums text-success">{formatARS(cobramos)}</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </main>
      </div>

      {/* FOOTER FIJO con 3 botones */}
      {accionPrincipal && (
        <div className="fixed bottom-0 left-0 right-0 bg-background border-t shadow-lg px-4 py-3 z-10">
          <div className="container flex items-center gap-2 justify-end">
            <Button variant="outline" size="lg" disabled className="hidden sm:inline-flex" title="Próximamente">
              <Edit3 className="h-4 w-4 mr-2" />
              Editar
            </Button>
            <Button
              variant="destructive"
              size="lg"
              onClick={() => setCancelOpen(true)}
              disabled={accionLoading}
            >
              <X className="h-4 w-4 mr-2" />
              Cancelar
            </Button>
            <Button
              variant="success"
              size="lg"
              className={cn('sm:min-w-[220px]')}
              onClick={accionPrincipal.onClick}
              disabled={accionLoading}
            >
              <accionPrincipal.Icon className="h-4 w-4 mr-2" />
              {accionPrincipal.label}
            </Button>
          </div>
        </div>
      )}

      {/* DIALOG: Cancelar requiere PIN manager + motivo (≥10 chars) */}
      <ManagerOverrideDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        accion="Cancelar pedido"
        descripcion={`Cancelar pedido #${venta.numero_local} (${canal?.nombre ?? 'sin canal'}). Esta acción es irreversible — anula la venta y libera la mesa si la tenía asignada.`}
        onAuthorized={async ({ managerId, motivo }) => {
          await handleCancelarConfirmado(managerId, motivo);
        }}
      />
    </div>
  );
}
