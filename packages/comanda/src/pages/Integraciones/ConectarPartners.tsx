import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, CheckCircle2, ExternalLink } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// Pantalla guía para que el dueño copie los URLs de webhook que tiene
// que pegar en los paneles de cada partner externo (Rappi, PedidosYa, MP).

const BASE = typeof window !== 'undefined' ? window.location.origin : 'https://pase-yndx.vercel.app';

interface PartnerCardProps {
  nombre: string;
  emoji: string;
  url: string;
  descripcion: string;
  pasos: string[];
  docsUrl?: string;
}

export function ConectarPartners() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);

  const localQS = localId ? `&local_id=${localId}` : '';

  const partners: PartnerCardProps[] = [
    {
      nombre: 'MercadoPago Checkout',
      emoji: '💳',
      url: `${BASE}/api/tienda-mp?action=webhook`,
      descripcion: 'Cobros online en la tienda. Notifica cuando un cliente paga.',
      pasos: [
        'Entrar a https://www.mercadopago.com.ar/developers → Tu aplicación → Webhooks.',
        'Pegar la URL de arriba en "URL de producción".',
        'Marcar evento: "Pagos" (payment).',
        'Guardar.',
      ],
      docsUrl: 'https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks',
    },
    {
      nombre: 'Rappi Partner API',
      emoji: '🟠',
      url: `${BASE}/api/tienda-mp?action=rappi-webhook${localQS}`,
      descripcion: 'Recibe pedidos de Rappi automáticamente en el POS.',
      pasos: [
        'Contactar al comercial de Rappi para alta como Partner (formulario en restaurants.rappi.com).',
        'Una vez aprobado, en el panel partner pegar la URL de arriba en "Webhook URL".',
        'Marcar evento: "Nuevo pedido".',
        'Si tenés varios locales, repetir el setup cambiando local_id.',
      ],
      docsUrl: 'https://restaurants.rappi.com.ar',
    },
    {
      nombre: 'PedidosYa POS Integration',
      emoji: '🟣',
      url: `${BASE}/api/tienda-mp?action=pedidosya-webhook${localQS}`,
      descripcion: 'Recibe pedidos de PedidosYa automáticamente en el POS.',
      pasos: [
        'Solicitar a tu Account Manager de PedidosYa el alta en "PedidosYa POS Integration".',
        'En el panel POS Integration pegar la URL de arriba.',
        'Configurar el mapeo de items (SKU) si lo solicita.',
        'Pedirles que envíen un pedido de prueba para validar.',
      ],
      docsUrl: 'https://www.pedidosya.com.ar',
    },
  ];

  function copiar(url: string) {
    void navigator.clipboard.writeText(url).then(() => {
      toast.success('URL copiada al portapapeles');
    });
  }

  return (
    <div className="container max-w-3xl py-6 space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Conectar partners externos</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Cada partner tiene un panel donde pegás esta URL para que sus pedidos lleguen
          automáticamente a tu POS.
        </p>
      </header>

      {!localId && (
        <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
          ⚠ Seleccioná un local primero. Las URLs se generan con el local_id activo para que
          el partner sepa a qué sucursal mandar el pedido.
        </div>
      )}

      {partners.map((p) => (
        <PartnerCard key={p.nombre} {...p} onCopy={copiar} />
      ))}

      <Card className="border-dashed">
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-2">🔍 Cómo verificar que funciona</h3>
          <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
            <li>Configurar la URL en el panel del partner.</li>
            <li>Pedirles que envíen un pedido de prueba (o hacelo vos como cliente).</li>
            <li>Andar a <strong>Integraciones → Log webhooks</strong>: deberías ver el evento recibido.</li>
            <li>Si la venta se creó OK, aparece con badge verde y link al pedido.</li>
            <li>Si tiene error, expandís el payload para debuggear.</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function PartnerCard({ nombre, emoji, url, descripcion, pasos, docsUrl, onCopy }: PartnerCardProps & { onCopy: (url: string) => void }) {
  const [copiado, setCopiado] = useState(false);
  function handleCopy() {
    onCopy(url);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <span className="text-2xl">{emoji}</span>
          {nombre}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{descripcion}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* URL */}
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3">
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">URL del webhook</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-background px-2 py-1.5 rounded border break-all">
              {url}
            </code>
            <Button size="sm" variant="outline" onClick={handleCopy}>
              {copiado ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* Pasos */}
        <div>
          <div className="text-xs font-semibold mb-1.5">Pasos:</div>
          <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
            {pasos.map((p, i) => <li key={i}>{p}</li>)}
          </ol>
        </div>

        {docsUrl && (
          <a
            href={docsUrl}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            Docs del partner
          </a>
        )}
      </CardContent>
    </Card>
  );
}
