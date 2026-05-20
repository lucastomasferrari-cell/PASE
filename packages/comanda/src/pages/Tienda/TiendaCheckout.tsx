import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useNavigate, useOutletContext, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { crearPedidoPublico, notificarPedidoRecibido, calcularETALocal, type ETACalculado } from '@/services/tiendaService';
import { setPedidoGeo, precisarConGoogle } from '@/services/direccionesService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';
import { haversineKm } from '@/lib/geo';
import { carritoStore, calcularSubtotal } from './carritoStore';
import type { TiendaCtx } from './TiendaLayout';

const TEL_AR = /^\+?54?\s?\d{10,11}$/;

const MOTIVO_CUPON_LABELS: Record<string, string> = {
  CUPON_INVALIDO: 'Ese código no existe',
  CUPON_NO_VIGENTE_AUN: 'El cupón empieza más adelante',
  CUPON_VENCIDO: 'El cupón está vencido',
  MONTO_MIN_NO_ALCANZADO: 'Tu pedido no llega al mínimo requerido',
  CUPON_AGOTADO: 'Ese cupón se agotó',
  YA_USASTE_ESTE_CUPON: 'Ya usaste este cupón',
  SOLO_PRIMERA_COMPRA: 'Este cupón es solo para clientes nuevos',
};

export function TiendaCheckout() {
  const { local } = useOutletContext<TiendaCtx>();
  const navigate = useNavigate();
  // Sprint 7 HIGH #3: subscribe debe incluir local.slug en deps.
  const subscribe = useCallback((cb: () => void) => carritoStore.subscribe(cb), [local.slug]);
  const getSnapshot = useCallback(() => carritoStore.get(local.slug), [local.slug]);
  const carrito = useSyncExternalStore(subscribe, getSnapshot);

  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail] = useState('');
  const [notasRepartidor, setNotasRepartidor] = useState('');
  const [notas, setNotas] = useState('');
  const [metodoPago, setMetodoPago] = useState<'pagar_al_recibir' | 'mp_qr' | 'mp_checkout'>('pagar_al_recibir');
  const [enviando, setEnviando] = useState(false);
  // Programar pedido a futuro (Lucas 2026-05-19, Marketplace Gap #2).
  // Modo "ahora" (default): el comerciante lo prepara apenas lo aprueba.
  // Modo "programar": el cliente elige fecha+hora. La RPC valida que sea
  // entre 15min y 14 días desde now().
  const [modoEntrega, setModoEntrega] = useState<'ahora' | 'programar'>('ahora');
  const [fechaProgramada, setFechaProgramada] = useState<string>('');
  // Idempotency key — se genera al montar el form. Si el cliente hace
  // doble click en Pagar, la 2da llamada con misma key devuelve el
  // mismo venta_id (no crea pedido duplicado).
  const [idempotencyKey] = useState<string>(() => crypto.randomUUID());

  // ETA dinámico: el RPC suma minutos por cada pedido en cola. Refresca
  // cuando cambia el tipo_entrega. Si el RPC falla (red, etc), fallback
  // a los tiempos fijos de local_settings.
  const [eta, setEta] = useState<ETACalculado | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await calcularETALocal(local.slug, carrito.tipoEntrega);
      if (!cancelled && data) setEta(data);
    })();
    return () => { cancelled = true; };
  }, [local.slug, carrito.tipoEntrega]);

  // ETA a mostrar: usa el dinámico si está disponible, sino fallback a
  // los tiempos estáticos del local.
  const etaMin = eta?.eta_minutos
    ?? (carrito.tipoEntrega === 'delivery' ? local.tiempo_delivery_min ?? 45 : local.tiempo_retiro_min ?? 20);
  const etaBadgeCola = eta && eta.pedidos_en_cola > 0
    ? ` (con ${eta.pedidos_en_cola} pedido${eta.pedidos_en_cola === 1 ? '' : 's'} antes tuyo)`
    : '';

  const subtotal = calcularSubtotal(carrito.items);
  const costoEnvio = carrito.tipoEntrega === 'delivery' ? Number(local.costo_envio_default) || 0 : 0;

  // Cupón aplicado (cliente lo valida con el endpoint público; descuento
  // real se aplica server-side al crear pedido)
  const [cuponCode, setCuponCode] = useState('');
  const [cuponDescuento, setCuponDescuento] = useState(0);
  const [cuponValidando, setCuponValidando] = useState(false);
  const [cuponMotivo, setCuponMotivo] = useState<string | null>(null);

  const total = subtotal + costoEnvio - cuponDescuento;

  async function validarCuponLocal() {
    if (!cuponCode.trim()) return;
    setCuponValidando(true);
    setCuponMotivo(null);
    const { validarCupon } = await import('@/services/cuponesService');
    const { data, error } = await validarCupon({
      slug: local.slug,
      code: cuponCode.trim(),
      montoCompra: subtotal + costoEnvio,
      clienteTelefono: telefono || undefined,
    });
    setCuponValidando(false);
    if (error || !data) {
      setCuponDescuento(0);
      setCuponMotivo(error || 'Error');
      toast.error(error || 'No se pudo validar el cupón');
      return;
    }
    if (!data.valido) {
      setCuponDescuento(0);
      setCuponMotivo(data.motivo);
      toast.error(MOTIVO_CUPON_LABELS[data.motivo] ?? data.motivo);
      return;
    }
    setCuponDescuento(Number(data.descuento));
    setCuponMotivo(null);
    toast.success(`Cupón aplicado: -${formatARS(Number(data.descuento))}`);
  }

  function quitarCupon() {
    setCuponCode('');
    setCuponDescuento(0);
    setCuponMotivo(null);
  }

  // Validación zona delivery (Fase B 2026-05-18). Si el local definió
  // radio_delivery_km Y tenemos lat/lon del local + del cliente, calculamos
  // distancia haversine. Si excede el radio, bloqueamos "Pagar".
  // - Sin coords del cliente: dejamos pasar (mejor false-negativo que false-positivo
  //   por no tener autocomplete bueno; la verificación visual del comerciante puede
  //   atrapar errores grandes en POS al aprobar).
  // - Sin radio configurado: sin límite.
  const radioKm = Number(local.radio_delivery_km ?? 0);
  const tieneRadio = radioKm > 0;
  const tieneCoordsLocal = local.lat != null && local.lon != null;
  const tieneCoordsCliente = carrito.direccion_lat != null && carrito.direccion_lon != null;
  const distanciaKm = tieneRadio && tieneCoordsLocal && tieneCoordsCliente
    ? haversineKm(
        Number(local.lat), Number(local.lon),
        Number(carrito.direccion_lat), Number(carrito.direccion_lon),
      )
    : null;
  const fueraDeZona = carrito.tipoEntrega === 'delivery'
    && distanciaKm != null
    && distanciaKm > radioKm;

  if (carrito.items.length === 0) {
    return (
      <div className="max-w-md mx-auto p-12 text-center">
        <div className="text-4xl mb-3">🛒</div>
        <p className="text-sm font-medium">Tu pedido está vacío</p>
        <p className="text-sm text-foreground/60 mt-1">Agregá algo de la carta antes de pagar.</p>
        <Link to={`/tienda/${local.slug}`} className="inline-block mt-6 text-sm underline text-primary">
          Volver a la carta
        </Link>
      </div>
    );
  }

  const tieneMpQr = !!local.mp_qr_url && local.mp_qr_url.trim().length > 0;

  async function confirmar() {
    if (!nombre.trim()) { toast.error('Ingresá tu nombre'); return; }
    if (!telefono.trim()) { toast.error('Ingresá tu teléfono'); return; }
    // Validación permisiva: warn si no matchea, no bloquea (decisión Lucas).
    if (!TEL_AR.test(telefono.replace(/\s/g, ''))) {
      toast.warning('Revisá el formato del teléfono', { description: 'Esperamos 10-11 dígitos AR.' });
    }
    if (carrito.tipoEntrega === 'delivery' && !carrito.direccion.trim()) {
      toast.error('Falta la dirección de entrega'); return;
    }
    if (fueraDeZona) {
      toast.error('Fuera de la zona de entrega', {
        description: `Estás a ${distanciaKm?.toFixed(1)} km del local. El radio máximo es ${radioKm} km.`,
      });
      return;
    }
    // Validación programación: la fecha debe ser válida + al menos 15min en el futuro.
    let programadaParaIso: string | null = null;
    if (modoEntrega === 'programar') {
      if (!fechaProgramada) {
        toast.error('Elegí fecha y hora para programar el pedido');
        return;
      }
      const date = new Date(fechaProgramada);
      if (isNaN(date.getTime())) {
        toast.error('Fecha inválida');
        return;
      }
      const minMs = Date.now() + 15 * 60 * 1000;
      const maxMs = Date.now() + 14 * 24 * 60 * 60 * 1000;
      if (date.getTime() < minMs) {
        toast.error('La hora elegida ya pasó', { description: 'Programá al menos 15 minutos en el futuro.' });
        return;
      }
      if (date.getTime() > maxMs) {
        toast.error('Fecha demasiado lejana', { description: 'Máximo 14 días.' });
        return;
      }
      programadaParaIso = date.toISOString();
    }
    setEnviando(true);
    const { ventaId, error } = await crearPedidoPublico({
      localSlug: local.slug,
      cliente: { nombre: nombre.trim(), telefono: telefono.trim(), email: email.trim() || null },
      tipoEntrega: carrito.tipoEntrega,
      direccion: carrito.tipoEntrega === 'delivery' ? carrito.direccion.trim() : null,
      items: carrito.items.map((it) => ({
        item_id: it.item_id,
        cantidad: it.cantidad,
        modificadores: it.modificadores.length > 0 ? it.modificadores : undefined,
        notas: it.notas || undefined,
      })),
      metodoPagoPreferido: metodoPago,
      notas: [notas.trim(), notasRepartidor.trim() && `Repartidor: ${notasRepartidor.trim()}`]
        .filter(Boolean).join(' · ') || null,
      programadaPara: programadaParaIso,
      idempotencyKey,
    });
    setEnviando(false);
    if (error || !ventaId) {
      toast.error('No se pudo crear el pedido', {
        description: error ?? 'Error desconocido',
        action: { label: 'Reintentar', onClick: confirmar },
      });
      return;
    }
    sessionStorage.setItem(`comanda-tel-${ventaId}`, telefono.trim());

    // Fase B item 3 — Email "Recibimos tu pedido". Solo se manda si el
    // cliente puso email. Idempotente server-side: si se reintenta, no
    // duplica. No bloqueamos el flow si falla (mejor pedido sin email
    // que error 500 después de cobrar).
    if (email.trim()) {
      void notificarPedidoRecibido({ ventaId, email: email.trim() });
    }

    // Geocoding: si tenemos lat/lon del autocomplete (GeoRef), guardarlas.
    // Si hay API key de Google, intentar precisar (mejor lat/lon del número
    // específico, no del centroide de la calle). Best-effort, no bloquea.
    if (carrito.tipoEntrega === 'delivery' && carrito.direccion.trim()) {
      let lat = carrito.direccion_lat ?? null;
      let lon = carrito.direccion_lon ?? null;
      // Mejorar con Google si está disponible
      try {
        const preciso = await precisarConGoogle(carrito.direccion);
        if (preciso) { lat = preciso.lat; lon = preciso.lon; }
      } catch { /* silent */ }
      if (lat != null && lon != null) {
        void setPedidoGeo(ventaId, lat, lon);  // fire and forget
      }
    }

    // Si el cliente eligió "Pagar online con MercadoPago", crear preference
    // y redirigir a init_point. La venta queda en estado original; el webhook
    // /api/tienda-mp?action=webhook la marca como cobrada cuando MP confirma.
    if (metodoPago === 'mp_checkout') {
      try {
        const itemsForMp = carrito.items.map((it) => {
          const extras = it.modificadores.reduce((s, m) => s + Number(m.precio_extra || 0), 0);
          return {
            title: it.nombre || `Item #${it.item_id}`,
            qty: it.cantidad,
            unit_price: Number(it.precio) + extras,
          };
        });
        if (costoEnvio > 0) {
          itemsForMp.push({ title: 'Envío', qty: 1, unit_price: costoEnvio });
        }
        const r = await fetch('/api/tienda-mp?action=preference', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            venta_id: ventaId,
            items: itemsForMp,
            total,
            back_url_success: `${window.location.origin}/tienda/${local.slug}/confirmacion/${ventaId}`,
          }),
        });
        if (!r.ok) {
          const errBody = await r.json().catch(() => ({ error: 'Error de red' }));
          throw new Error(errBody.error || `HTTP ${r.status}`);
        }
        const { init_point } = await r.json();
        carritoStore.clear();
        // Redirige fuera de la SPA al checkout de MP. Al volver, la
        // confirmación verá el pago si el webhook ya pasó.
        window.location.href = init_point;
        return;
      } catch (err) {
        toast.error('No se pudo iniciar el pago online', {
          description: err instanceof Error ? err.message : 'Error desconocido',
        });
        return;
      }
    }

    carritoStore.clear();
    navigate(`/tienda/${local.slug}/confirmacion/${ventaId}`);
  }

  return (
    <div className="max-w-2xl mx-auto px-5 py-6 pb-32">
      <Link
        to={`/tienda/${local.slug}`}
        className="inline-flex items-center gap-2 text-sm text-foreground/60 hover:text-foreground transition-colors mb-6"
      >
        <ArrowLeft className="h-4 w-4" /> Volver al menú
      </Link>

      {/* Datos de contacto */}
      <Section titulo="Datos de contacto">
        <FormField label="Nombre completo *" htmlFor="nombre">
          <Input
            id="nombre" value={nombre} onChange={(e) => setNombre(e.target.value)}
            placeholder="Juan Pérez" autoComplete="name"
            className="h-12"
          />
        </FormField>
        <FormField label="Teléfono *" htmlFor="tel">
          <Input
            id="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)}
            placeholder="11 1234 5678" type="tel" autoComplete="tel"
            className="h-12"
          />
        </FormField>
        <FormField label="Email (opcional)" htmlFor="email">
          <Input
            id="email" value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="vos@email.com" type="email" autoComplete="email"
            className="h-12"
          />
        </FormField>
      </Section>

      {/* Dirección entrega (solo delivery) */}
      {carrito.tipoEntrega === 'delivery' && (
        <Section titulo="Dirección de entrega">
          <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm">
            <span className="text-foreground/60 text-xs uppercase tracking-wide">Entregamos en</span>
            <div className="font-medium mt-1">{carrito.direccion}</div>
            <Link to={`/tienda/${local.slug}`} className="text-xs text-primary underline mt-1.5 inline-block">
              Editar dirección
            </Link>
          </div>
          <FormField label="Notas para el repartidor" htmlFor="rep">
            <Textarea
              id="rep" value={notasRepartidor} onChange={(e) => setNotasRepartidor(e.target.value)}
              placeholder="Tocar timbre 2B, dejarlo con encargado, etc."
              rows={2}
            />
          </FormField>
        </Section>
      )}

      {/* ¿Cuándo querés el pedido? */}
      <Section titulo="¿Cuándo querés el pedido?">
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setModoEntrega('ahora')}
            className={cn(
              'w-full text-left p-4 rounded-md border-2 transition-colors',
              modoEntrega === 'ahora'
                ? 'border-primary bg-primary/5'
                : 'border-gray-200 hover:border-gray-300',
            )}
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">⚡</span>
              <div className="flex-1">
                <div className="font-medium text-sm">Lo antes posible</div>
                <div className="text-xs text-foreground/60 mt-0.5">
                  {carrito.tipoEntrega === 'delivery'
                    ? `Llega en ~${etaMin} min${etaBadgeCola}.`
                    : `Listo en ~${etaMin} min${etaBadgeCola}.`}
                </div>
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setModoEntrega('programar')}
            className={cn(
              'w-full text-left p-4 rounded-md border-2 transition-colors',
              modoEntrega === 'programar'
                ? 'border-primary bg-primary/5'
                : 'border-gray-200 hover:border-gray-300',
            )}
          >
            <div className="flex items-start gap-3">
              <span className="text-2xl">📅</span>
              <div className="flex-1">
                <div className="font-medium text-sm">Programar para más tarde</div>
                <div className="text-xs text-foreground/60 mt-0.5">
                  Elegí fecha y hora. Mínimo 15 min, máximo 14 días.
                </div>
              </div>
            </div>
          </button>
          {modoEntrega === 'programar' && (
            <FormField label="Fecha y hora *" htmlFor="prog">
              <Input
                id="prog"
                type="datetime-local"
                value={fechaProgramada}
                onChange={(e) => setFechaProgramada(e.target.value)}
                min={(() => {
                  // Min = ahora + 15 min, en formato yyyy-MM-ddTHH:mm
                  const d = new Date(Date.now() + 15 * 60 * 1000);
                  const tzOff = d.getTimezoneOffset() * 60000;
                  return new Date(d.getTime() - tzOff).toISOString().slice(0, 16);
                })()}
                max={(() => {
                  const d = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
                  const tzOff = d.getTimezoneOffset() * 60000;
                  return new Date(d.getTime() - tzOff).toISOString().slice(0, 16);
                })()}
                className="h-12"
              />
              {fechaProgramada && (
                <div className="text-xs text-foreground/70 mt-2">
                  Pedido programado para el{' '}
                  <strong>
                    {new Date(fechaProgramada).toLocaleString('es-AR', {
                      weekday: 'long',
                      day: '2-digit',
                      month: 'long',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </strong>
                </div>
              )}
            </FormField>
          )}
        </div>
      </Section>

      {/* Notas generales */}
      <Section titulo="Notas para el local">
        <FormField label="Comentarios sobre tu pedido" htmlFor="notas">
          <Textarea
            id="notas" value={notas} onChange={(e) => setNotas(e.target.value)}
            placeholder="Sin cebolla, sin TACC, etc."
            rows={2}
          />
        </FormField>
      </Section>

      {/* Forma de pago */}
      <Section titulo="Forma de pago">
        <div className="space-y-2">
          <PaymentCard
            active={metodoPago === 'mp_checkout'}
            onClick={() => setMetodoPago('mp_checkout')}
            titulo="Pagar online con MercadoPago"
            descripcion="Tarjeta de crédito, débito, dinero en cuenta MP. El pago queda confirmado al instante."
            emoji="💳"
          />
          <PaymentCard
            active={metodoPago === 'pagar_al_recibir'}
            onClick={() => setMetodoPago('pagar_al_recibir')}
            titulo="Pagar al recibir"
            descripcion="Efectivo, tarjeta o transferencia cuando llegue el pedido."
            emoji="💵"
          />
          {tieneMpQr && (
            <PaymentCard
              active={metodoPago === 'mp_qr'}
              onClick={() => setMetodoPago('mp_qr')}
              titulo="MercadoPago QR"
              descripcion="Escaneá el QR y pagá antes de confirmar."
              emoji="📲"
            />
          )}
          {metodoPago === 'mp_qr' && local.mp_qr_url && (
            <div className="rounded-md border border-gray-200 p-5 text-center">
              <img src={local.mp_qr_url} alt="QR MercadoPago" className="mx-auto max-w-[240px] w-full h-auto" />
              <p className="text-sm text-foreground/70 mt-3">
                Escaneá con tu app, pagá <strong className="text-foreground">{formatARS(total)}</strong> y volvé acá.
              </p>
            </div>
          )}
        </div>
      </Section>

      {/* Cupón */}
      <Section titulo="Cupón">
        {cuponDescuento > 0 ? (
          <div className="flex items-center justify-between p-2.5 bg-green-50 border border-green-200 rounded-md">
            <div className="text-sm">
              <div className="font-medium text-green-800">✓ {cuponCode.toUpperCase()}</div>
              <div className="text-xs text-green-700">−{formatARS(cuponDescuento)} aplicado</div>
            </div>
            <Button variant="ghost" size="sm" onClick={quitarCupon} className="text-red-700">Quitar</Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Input
              value={cuponCode}
              onChange={(e) => setCuponCode(e.target.value.toUpperCase())}
              placeholder="Código (ej: VERANO10)"
              className="font-mono uppercase flex-1"
            />
            <Button variant="outline" onClick={validarCuponLocal} disabled={!cuponCode.trim() || cuponValidando}>
              {cuponValidando ? '…' : 'Aplicar'}
            </Button>
          </div>
        )}
        {cuponMotivo && cuponDescuento === 0 && (
          <p className="text-xs text-red-700 mt-2">
            {MOTIVO_CUPON_LABELS[cuponMotivo] ?? cuponMotivo}
          </p>
        )}
      </Section>

      {/* Resumen */}
      <Section titulo="Resumen">
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between text-foreground/70">
            <span>Subtotal</span><span>{formatARS(subtotal)}</span>
          </div>
          {costoEnvio > 0 && (
            <div className="flex justify-between text-foreground/70">
              <span>Envío</span><span>{formatARS(costoEnvio)}</span>
            </div>
          )}
          {cuponDescuento > 0 && (
            <div className="flex justify-between text-green-700">
              <span>Cupón {cuponCode.toUpperCase()}</span><span>−{formatARS(cuponDescuento)}</span>
            </div>
          )}
          <div className="flex justify-between text-base font-medium pt-2.5 border-t border-gray-200">
            <span>Total</span><span>{formatARS(total)}</span>
          </div>
        </div>
      </Section>

      {/* Banner zona de delivery — solo cuando el local tiene radio configurado
          + tenemos coords + estás fuera de zona. */}
      {fueraDeZona && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm space-y-1">
          <p className="font-medium text-destructive">Fuera de zona de entrega</p>
          <p className="text-foreground/80">
            Esta dirección está a <strong>{distanciaKm?.toFixed(1)} km</strong> del
            local. {local.nombre} entrega hasta <strong>{radioKm} km</strong>.
            Cambiá la dirección o elegí "Retiro en el local".
          </p>
        </div>
      )}

      {/* Sticky CTA mobile / inline desktop */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 md:static md:bg-transparent md:border-0 md:p-0 md:mt-8 z-30">
        <div className="max-w-2xl mx-auto md:max-w-none">
          <Button
            onClick={confirmar}
            disabled={enviando || fueraDeZona}
            className="w-full h-12 text-base font-medium"
          >
            {enviando
              ? 'Enviando…'
              : fueraDeZona
                ? 'Fuera de zona'
                : metodoPago === 'mp_checkout'
                  ? `Pagar online · ${formatARS(total)}`
                  : `Confirmar pedido · ${formatARS(total)}`
            }
          </Button>
        </div>
      </div>
    </div>
  );
}

function Section({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-lg font-medium mb-4">{titulo}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function FormField({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div>
      <Label htmlFor={htmlFor} className="text-xs text-foreground/60 uppercase tracking-wide mb-1.5 block">
        {label}
      </Label>
      {children}
    </div>
  );
}

function PaymentCard({
  active, onClick, titulo, descripcion, emoji,
}: {
  active: boolean;
  onClick: () => void;
  titulo: string;
  descripcion: string;
  emoji: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left p-4 rounded-md border-2 transition-colors',
        active ? 'border-black bg-white' : 'border-gray-200 bg-white hover:border-gray-300',
      )}
      aria-pressed={active}
    >
      <div className="flex items-center gap-3">
        <span className="text-2xl">{emoji}</span>
        <div className="flex-1">
          <div className="text-sm font-medium">{titulo}</div>
          <div className="text-xs text-foreground/60 mt-0.5">{descripcion}</div>
        </div>
        <div className={cn(
          'h-5 w-5 rounded-full border-2 flex items-center justify-center flex-shrink-0',
          active ? 'border-black' : 'border-gray-300',
        )}>
          {active && <div className="h-2.5 w-2.5 rounded-full bg-black" />}
        </div>
      </div>
    </button>
  );
}
