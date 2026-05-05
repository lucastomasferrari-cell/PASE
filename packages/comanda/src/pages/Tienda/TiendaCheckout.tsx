import { useState, useSyncExternalStore } from 'react';
import { useNavigate, useOutletContext, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { crearPedidoPublico } from '@/services/tiendaService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { formatARS } from '@/lib/format';
import { carritoStore, calcularSubtotal } from './carritoStore';
import type { TiendaCtx } from './TiendaLayout';

const TEL_AR = /^\+?54?\s?\d{10}$/;

export function TiendaCheckout() {
  const { local } = useOutletContext<TiendaCtx>();
  const navigate = useNavigate();
  const carrito = useSyncExternalStore(
    carritoStore.subscribe,
    () => carritoStore.get(local.slug),
  );

  const [nombre, setNombre] = useState('');
  const [telefono, setTelefono] = useState('');
  const [email, setEmail] = useState('');
  const [notas, setNotas] = useState('');
  const [metodoPago, setMetodoPago] = useState<'pagar_al_recibir' | 'mp_qr'>('pagar_al_recibir');
  const [showQr, setShowQr] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const subtotal = calcularSubtotal(carrito.items);
  const costoEnvio = carrito.tipoEntrega === 'delivery' ? Number(local.costo_envio_default) || 0 : 0;
  const total = subtotal + costoEnvio;

  if (carrito.items.length === 0) {
    return (
      <div className="max-w-md mx-auto p-6 text-center">
        <p className="text-sm text-muted-foreground mb-4">Tu carrito está vacío.</p>
        <Link to={`/tienda/${local.slug}`} className="text-sm underline text-primary">Volver a la carta</Link>
      </div>
    );
  }

  const tieneMpQr = !!local.mp_qr_url && local.mp_qr_url.trim().length > 0;

  async function confirmar() {
    if (!nombre.trim()) { toast.error('Ingresá tu nombre'); return; }
    if (!telefono.trim()) { toast.error('Ingresá tu teléfono'); return; }
    if (!TEL_AR.test(telefono.replace(/\D/g, '').padStart(11, '5'))) {
      toast.warning('Revisá el formato del teléfono', { description: 'Esperamos 10 dígitos AR.' });
      // No bloqueamos.
    }
    if (carrito.tipoEntrega === 'delivery' && !carrito.direccion.trim()) {
      toast.error('Falta la dirección de entrega'); return;
    }
    setEnviando(true);
    // fn_crear_pedido_publico_comanda (Sprint 2) no expone idempotency_key
    // todavía. Si llegara a duplicar pedidos por doble-tap, agregar el
    // parámetro a la RPC. Hoy mitigamos con setEnviando=true.
    const { ventaId, error } = await crearPedidoPublico({
      localSlug: local.slug,
      cliente: { nombre: nombre.trim(), telefono: telefono.trim(), email: email.trim() || null },
      tipoEntrega: carrito.tipoEntrega,
      direccion: carrito.tipoEntrega === 'delivery' ? carrito.direccion.trim() : null,
      items: carrito.items.map(it => ({
        item_id: it.item_id, cantidad: it.cantidad,
        modificadores: it.modificadores.length > 0 ? it.modificadores : undefined,
        notas: it.notas || undefined,
      })),
      metodoPagoPreferido: metodoPago,
      notas: notas.trim() || null,
    });
    setEnviando(false);
    if (error || !ventaId) {
      toast.error('No se pudo crear el pedido', { description: error ?? 'Error desconocido' });
      return;
    }
    // Persistir teléfono para tracking sin tener que repreguntar.
    sessionStorage.setItem(`comanda-tel-${ventaId}`, telefono.trim());
    carritoStore.clear();
    navigate(`/tienda/${local.slug}/confirmacion/${ventaId}`);
  }

  return (
    <div className="max-w-md mx-auto pb-12">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <Link to={`/tienda/${local.slug}`} className="text-muted-foreground"><ArrowLeft className="h-5 w-5" /></Link>
        <h2 className="text-base font-semibold">Tus datos</h2>
      </div>
      <div className="p-4 space-y-3">
        <div>
          <Label htmlFor="nombre">Nombre completo *</Label>
          <Input id="nombre" value={nombre} onChange={e => setNombre(e.target.value)} placeholder="Juan Pérez" autoComplete="name" />
        </div>
        <div>
          <Label htmlFor="tel">Teléfono *</Label>
          <Input id="tel" value={telefono} onChange={e => setTelefono(e.target.value)} placeholder="11 1234 5678" type="tel" autoComplete="tel" />
        </div>
        <div>
          <Label htmlFor="email">Email (opcional)</Label>
          <Input id="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="vos@email.com" type="email" autoComplete="email" />
        </div>
        {carrito.tipoEntrega === 'delivery' && (
          <div className="text-sm rounded-md border border-border p-3 bg-muted/30">
            <span className="text-xs text-muted-foreground">Entrega:</span>
            <div className="font-medium">{carrito.direccion}</div>
          </div>
        )}
        <div>
          <Label htmlFor="notas">Notas para el local</Label>
          <Textarea id="notas" value={notas} onChange={e => setNotas(e.target.value)} placeholder="Sin cebolla, sin TACC, etc." rows={2} />
        </div>
      </div>

      <div className="px-4 py-3 border-t border-border">
        <h3 className="text-sm font-semibold mb-2">Método de pago</h3>
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => { setMetodoPago('pagar_al_recibir'); setShowQr(false); }}
            className={`w-full text-left p-3 rounded-md border ${metodoPago === 'pagar_al_recibir' ? 'border-primary bg-primary/5' : 'border-border'}`}
          >
            <div className="text-sm font-medium">💵 Pagar al recibir</div>
            <div className="text-xs text-muted-foreground">Efectivo, MP o tarjeta cuando llegue el pedido.</div>
          </button>
          {tieneMpQr && (
            <button
              type="button"
              onClick={() => { setMetodoPago('mp_qr'); setShowQr(true); }}
              className={`w-full text-left p-3 rounded-md border ${metodoPago === 'mp_qr' ? 'border-primary bg-primary/5' : 'border-border'}`}
            >
              <div className="text-sm font-medium">📲 MercadoPago QR</div>
              <div className="text-xs text-muted-foreground">Escaneá el QR y pagá antes de confirmar.</div>
            </button>
          )}
          {metodoPago === 'mp_qr' && showQr && local.mp_qr_url && (
            <div className="rounded-md border border-border p-4 text-center">
              <img src={local.mp_qr_url} alt="QR MercadoPago" className="mx-auto max-w-[240px] w-full h-auto" />
              <p className="text-xs text-muted-foreground mt-2">Escaneá, pagá <strong>{formatARS(total)}</strong> y volvé acá.</p>
            </div>
          )}
        </div>
      </div>

      <div className="px-4 py-3 border-t border-border space-y-1 text-sm">
        <div className="flex justify-between"><span>Subtotal</span><span>{formatARS(subtotal)}</span></div>
        {costoEnvio > 0 && <div className="flex justify-between"><span>Envío</span><span>{formatARS(costoEnvio)}</span></div>}
        <div className="flex justify-between text-base font-semibold"><span>Total</span><span>{formatARS(total)}</span></div>
      </div>

      <div className="px-4 pb-6">
        <Button onClick={confirmar} disabled={enviando} className="w-full h-12 text-base font-medium">
          {enviando ? 'Enviando…' : '✓ Confirmar pedido'}
        </Button>
      </div>
    </div>
  );
}
