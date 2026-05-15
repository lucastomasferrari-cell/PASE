import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Receipt, Volume2, Save } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Settings {
  cuit: string | null;
  razon_social: string | null;
  condicion_iva: string | null;
  mensaje_recibo: string | null;
  sonido_kds_listo: boolean;
  sonido_pedido_nuevo: boolean;
  notif_push_pedidos: boolean;
}

const DEFAULT: Settings = {
  cuit: '',
  razon_social: '',
  condicion_iva: '',
  mensaje_recibo: '',
  sonido_kds_listo: true,
  sonido_pedido_nuevo: true,
  notif_push_pedidos: false,
};

export function SettingsRecibos() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [data, setData] = useState<Settings>(DEFAULT);
  const [original, setOriginal] = useState<Settings>(DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!localId) return;
    setLoading(true);
    db.from('comanda_local_settings')
      .select('cuit, razon_social, condicion_iva, mensaje_recibo, sonido_kds_listo, sonido_pedido_nuevo, notif_push_pedidos')
      .eq('local_id', localId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          const merged = { ...DEFAULT, ...(data as Partial<Settings>) };
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
      .update(data)
      .eq('local_id', localId);
    setSaving(false);
    if (error) toast.error(error.message);
    else {
      toast.success('Configuración guardada');
      setOriginal(data);
    }
  }

  if (loading) return <div className="container py-8 text-center text-muted-foreground">Cargando…</div>;

  return (
    <div className="container max-w-2xl py-6 space-y-4">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Recibos y notificaciones</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Datos del local que aparecen en ticket + preferencias de avisos.
        </p>
      </header>

      {/* Datos fiscales / recibo */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Receipt className="h-4 w-4" /> Datos para ticket / recibo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="razon">Razón social</Label>
            <Input
              id="razon"
              value={data.razon_social ?? ''}
              onChange={(e) => setData((d) => ({ ...d, razon_social: e.target.value || null }))}
              placeholder="Ej: Neko Sushi SRL"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cuit">CUIT</Label>
              <Input
                id="cuit"
                value={data.cuit ?? ''}
                onChange={(e) => setData((d) => ({ ...d, cuit: e.target.value || null }))}
                placeholder="30-12345678-9"
                inputMode="numeric"
              />
            </div>
            <div>
              <Label htmlFor="iva">Condición IVA</Label>
              <Select value={data.condicion_iva ?? ''} onValueChange={(v) => setData((d) => ({ ...d, condicion_iva: v || null }))}>
                <SelectTrigger id="iva"><SelectValue placeholder="Elegí" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="responsable_inscripto">Responsable Inscripto</SelectItem>
                  <SelectItem value="monotributo">Monotributo</SelectItem>
                  <SelectItem value="exento">Exento</SelectItem>
                  <SelectItem value="consumidor_final">Consumidor Final</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="msg">Mensaje al pie del ticket</Label>
            <Textarea
              id="msg"
              value={data.mensaje_recibo ?? ''}
              onChange={(e) => setData((d) => ({ ...d, mensaje_recibo: e.target.value || null }))}
              rows={2}
              placeholder="Gracias por su visita. Vuelva pronto."
            />
            <p className="text-xs text-muted-foreground mt-1">
              Aparecerá impreso al final del ticket cuando se implemente impresión fiscal.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Notificaciones */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Volume2 className="h-4 w-4" /> Sonidos y notificaciones
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <SwitchRow
            label="Sonido cuando entra pedido nuevo (Pedidos Hub)"
            sub="Bip corto al recibir pedido online o por WhatsApp."
            value={data.sonido_pedido_nuevo}
            onChange={(v) => setData((d) => ({ ...d, sonido_pedido_nuevo: v }))}
          />
          <SwitchRow
            label="Sonido cuando cocina marca ticket listo (KDS)"
            sub="Bip en la pantalla del mozo cuando el plato sale."
            value={data.sonido_kds_listo}
            onChange={(v) => setData((d) => ({ ...d, sonido_kds_listo: v }))}
          />
          <SwitchRow
            label="Notificaciones push del navegador"
            sub="(Próximamente — requiere instalar la app como PWA)"
            value={data.notif_push_pedidos}
            onChange={(v) => setData((d) => ({ ...d, notif_push_pedidos: v }))}
            disabled
          />
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex justify-end gap-2">
        {dirty && (
          <Button variant="outline" onClick={() => setData(original)} disabled={saving}>
            Descartar cambios
          </Button>
        )}
        <Button onClick={guardar} disabled={!dirty || saving}>
          <Save className="h-4 w-4 mr-2" />
          {saving ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </div>
  );
}

interface SwitchRowProps {
  label: string;
  sub: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}
function SwitchRow({ label, sub, value, onChange, disabled }: SwitchRowProps) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-border last:border-0">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{sub}</div>
      </div>
      <Switch checked={value} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
