import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Image, Save, Globe, AtSign } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Settings de branding — info del negocio visible al cliente
// (tienda online, menú QR, recibos futuros).

interface Branding {
  direccion: string | null;
  telefono: string | null;
  instagram: string | null;
  web: string | null;
}

const DEFAULT: Branding = { direccion: '', telefono: '', instagram: '', web: '' };

export function SettingsBranding() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [data, setData] = useState<Branding>(DEFAULT);
  const [original, setOriginal] = useState<Branding>(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!localId) return;
    setLoading(true);
    db.from('comanda_local_settings')
      .select('direccion, telefono, instagram, web')
      .eq('local_id', localId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          const merged = { ...DEFAULT, ...(data as Partial<Branding>) };
          setData(merged);
          setOriginal(merged);
        }
        setLoading(false);
      });
  }, [localId]);

  const dirty = JSON.stringify(data) !== JSON.stringify(original);

  async function guardar() {
    if (!localId) return;
    setSaving(true);
    const { error } = await db.from('comanda_local_settings')
      .update(data).eq('local_id', localId);
    setSaving(false);
    if (error) toast.error(error.message);
    else { toast.success('Guardado'); setOriginal(data); }
  }

  if (loading) return <div className="container py-8 text-center text-muted-foreground">Cargando…</div>;

  return (
    <div className="container max-w-xl py-6 space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Branding del local</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Datos visibles al cliente en tienda online y menú QR.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Image className="h-4 w-4" /> Contacto y presencia online
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="dir">Dirección física</Label>
            <Input
              id="dir"
              value={data.direccion ?? ''}
              onChange={(e) => setData((d) => ({ ...d, direccion: e.target.value || null }))}
              placeholder="Av. Cabildo 1234, Belgrano"
            />
          </div>
          <div>
            <Label htmlFor="tel">Teléfono</Label>
            <Input
              id="tel"
              value={data.telefono ?? ''}
              onChange={(e) => setData((d) => ({ ...d, telefono: e.target.value || null }))}
              placeholder="11 1234 5678"
              inputMode="tel"
            />
          </div>
          <div>
            <Label htmlFor="ig" className="flex items-center gap-1.5">
              <AtSign className="h-3.5 w-3.5" /> Instagram
            </Label>
            <Input
              id="ig"
              value={data.instagram ?? ''}
              onChange={(e) => setData((d) => ({ ...d, instagram: e.target.value || null }))}
              placeholder="@minegocio"
            />
          </div>
          <div>
            <Label htmlFor="web" className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5" /> Web
            </Label>
            <Input
              id="web"
              value={data.web ?? ''}
              onChange={(e) => setData((d) => ({ ...d, web: e.target.value || null }))}
              placeholder="https://minegocio.com"
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        {dirty && (
          <Button variant="outline" onClick={() => setData(original)} disabled={saving}>
            Descartar
          </Button>
        )}
        <Button onClick={guardar} disabled={!dirty || saving}>
          <Save className="h-4 w-4 mr-2" />
          {saving ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground text-center">
        Estos datos aparecen en la cabecera de la tienda online + menú QR. Logo + colores
        del local quedan para una fase futura.
      </p>
    </div>
  );
}
