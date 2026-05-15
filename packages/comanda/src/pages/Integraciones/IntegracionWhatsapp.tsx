import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MessageCircle, Save, ExternalLink, Copy, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Integración WhatsApp simple — link wa.me para que el cliente contacte al
// local desde menú QR / tienda online. Setea telefono local; la URL
// wa.me se genera client-side.
//
// Versión MVP. Integración API real (auto-respuesta, mensajes desde el POS)
// queda para fase futura (requiere WhatsApp Business API + verificación).

export function IntegracionWhatsapp() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [telefono, setTelefono] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    if (!localId) return;
    setLoading(true);
    db.from('comanda_local_settings')
      .select('telefono')
      .eq('local_id', localId)
      .maybeSingle()
      .then(({ data }) => {
        const tel = (data as { telefono: string | null } | null)?.telefono ?? '';
        setTelefono(tel);
        setOriginal(tel);
        setLoading(false);
      });
  }, [localId]);

  const dirty = telefono !== original;

  // Normalizar para wa.me: solo dígitos, agregar 549 si arranca con 11/15.
  function wameUrl(tel: string): string {
    const cleaned = tel.replace(/\D/g, '');
    if (!cleaned) return '';
    // Si arranca con 11 (área CABA) o 15, asumir AR y agregar 549.
    if (/^(11|15)/.test(cleaned)) return `https://wa.me/549${cleaned}`;
    if (/^54/.test(cleaned)) return `https://wa.me/${cleaned}`;
    return `https://wa.me/${cleaned}`;
  }

  async function guardar() {
    if (!localId) return;
    setSaving(true);
    const { error } = await db.from('comanda_local_settings')
      .update({ telefono: telefono.trim() || null }).eq('local_id', localId);
    setSaving(false);
    if (error) toast.error(error.message);
    else { toast.success('WhatsApp configurado'); setOriginal(telefono); }
  }

  function copiarLink() {
    const url = wameUrl(telefono);
    if (!url) return;
    void navigator.clipboard.writeText(url).then(() => {
      setCopiado(true);
      toast.success('Link copiado');
      setTimeout(() => setCopiado(false), 2000);
    });
  }

  if (loading) return <div className="container py-8 text-center text-muted-foreground">Cargando…</div>;

  const url = wameUrl(telefono);

  return (
    <div className="container max-w-xl py-6 space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <MessageCircle className="h-6 w-6 text-green-600" />
          WhatsApp del local
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Número que aparece en menú QR + tienda online para que el cliente te escriba.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Número de contacto</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="tel">Teléfono</Label>
            <Input
              id="tel"
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              placeholder="11 1234 5678"
              inputMode="tel"
              className="h-11"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Sin código país. Si arranca con 11 o 15 te agrego el 549 automático para AR.
            </p>
          </div>

          {url && (
            <div className="rounded-md border border-success/30 bg-success/5 p-3 space-y-2">
              <div className="text-xs text-muted-foreground">Link generado:</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-background px-2 py-1.5 rounded border break-all">
                  {url}
                </code>
                <Button size="sm" variant="outline" onClick={copiarLink}>
                  {copiado ? <CheckCircle2 className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
                </Button>
                <Button size="sm" variant="outline" asChild>
                  <a href={url} target="_blank" rel="noopener">
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Al tocarlo abre WhatsApp con la conversación con vos lista para escribir.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={guardar} disabled={!dirty || saving}>
          <Save className="h-4 w-4 mr-2" />
          {saving ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>

      <Card className="border-dashed">
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold mb-1">🚧 Próximamente</h3>
          <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
            <li>Avisar al cliente "tu pedido está listo" via WhatsApp automático.</li>
            <li>Recibir pedidos por WhatsApp Business API en el Pedidos Hub.</li>
            <li>Plantillas: confirmación, cambio de estado, recordatorio entrega.</li>
          </ul>
          <p className="text-[10px] text-muted-foreground mt-2">
            Requiere WhatsApp Business API + verificación de número (Meta). Se hace en fase posterior.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
