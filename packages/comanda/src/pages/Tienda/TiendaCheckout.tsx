import { useCallback, useState, useSyncExternalStore } from 'react';
import { useNavigate, useOutletContext, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { crearPedidoPublico } from '@/services/tiendaService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatARS } from '@/lib/format';
import { cn } from '@/lib/utils';
import { carritoStore, calcularSubtotal } from './carritoStore';
import type { TiendaCtx } from './TiendaLayout';

const TEL_AR = /^\+?54?\s?\d{10,11}$/;

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
  const [metodoPago, setMetodoPago] = useState<'pagar_al_recibir' | 'mp_qr'>('pagar_al_recibir');
  const [enviando, setEnviando] = useState(false);

  const subtotal = calcularSubtotal(carrito.items);
  const costoEnvio = carrito.tipoEntrega === 'delivery' ? Number(local.costo_envio_default) || 0 : 0;
  const total = subtotal + costoEnvio;

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
          <div className="flex justify-between text-base font-medium pt-2.5 border-t border-gray-200">
            <span>Total</span><span>{formatARS(total)}</span>
          </div>
        </div>
      </Section>

      {/* Sticky CTA mobile / inline desktop */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-4 md:static md:bg-transparent md:border-0 md:p-0 md:mt-8 z-30">
        <div className="max-w-2xl mx-auto md:max-w-none">
          <Button
            onClick={confirmar}
            disabled={enviando}
            className="w-full h-12 text-base font-medium"
          >
            {enviando ? 'Enviando…' : `Confirmar pedido · ${formatARS(total)}`}
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
