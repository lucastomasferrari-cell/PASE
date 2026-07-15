// Configuración del LOCAL a nivel POS. La config de la TIENDA ONLINE
// (slug, delivery, horarios, marketplace, QR MP) se mudó a su hub propio
// (Tienda online → Configuración) el 15-jul para concentrar el marketplace.
// Acá quedan solo los ajustes operativos del POS + un puntero al hub.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Store, ArrowUpRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { getLocalSettings, updateLocalSettings, type LocalSettingsPatch } from '@/services/localSettingsService';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import type { ComandaLocalSettings, PosModo } from '@/types/database';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { featureFlags, setFeatureFlag } from '@/lib/featureFlags';

const MODOS: { value: PosModo; label: string }[] = [
  { value: 'salon', label: 'Salón' },
  { value: 'mostrador', label: 'Mostrador' },
  { value: 'pedidos', label: 'Pedidos' },
];

export function SettingsLocal() {
  const { user } = useAuth();
  const [localId, setLocalActivo] = useLocalActivo(user);
  const [locales, setLocales] = useState<LocalSimple[]>([]);
  const [settings, setSettings] = useState<ComandaLocalSettings | null>(null);
  const [patch, setPatch] = useState<LocalSettingsPatch>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => { listLocalesAccesibles().then((r) => setLocales(r.data)); }, []);

  useEffect(() => {
    if (localId === null) return;
    getLocalSettings(localId).then((r) => { setSettings(r.data); setPatch({}); });
  }, [localId]);

  if (!settings) return <div className="py-12 text-center text-muted-foreground">Cargando…</div>;

  const merged = { ...settings, ...patch };

  function setField<K extends keyof LocalSettingsPatch>(key: K, value: LocalSettingsPatch[K]) {
    setPatch((p) => ({ ...p, [key]: value }));
  }

  async function guardar() {
    if (!settings) return;
    if (Object.keys(patch).length === 0) { toast.info('Sin cambios'); return; }
    setSaving(true);
    const { error } = await updateLocalSettings(settings.id, patch);
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success('Configuración guardada');
    const { data } = await getLocalSettings(settings.local_id);
    if (data) setSettings(data);
    setPatch({});
  }

  function toggleModo(modo: PosModo) {
    const current = merged.features_pos_modos ?? ['salon', 'mostrador', 'pedidos'];
    const next = current.includes(modo) ? current.filter((m) => m !== modo) : [...current, modo];
    if (next.length === 0) { toast.error('Tenés que habilitar al menos un modo'); return; }
    setField('features_pos_modos', next);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Label>Local:</Label>
        <Select value={String(localId)} onValueChange={(v) => setLocalActivo(Number(v))}>
          <SelectTrigger className="w-[280px] h-10"><SelectValue /></SelectTrigger>
          <SelectContent>{locales.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.nombre}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {/* Puntero al hub de la tienda online */}
      <Link to="/tienda-online/configuracion"
        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 hover:border-primary/50 transition-colors">
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10 text-primary"><Store className="h-5 w-5" /></div>
          <div>
            <div className="text-sm font-medium">Tienda online</div>
            <div className="text-xs text-muted-foreground">Slug/link, delivery, horarios, marketplace y QR de MP se configuran en su propio hub.</div>
          </div>
        </div>
        <ArrowUpRight className="h-4 w-4 text-muted-foreground shrink-0" />
      </Link>

      <Card>
        <CardHeader><CardTitle>Ajustes del POS</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Auto-lock POS (min)">
              <Input type="number" min={0} max={240} value={merged.autolock_minutos ?? 60}
                onChange={(e) => setField('autolock_minutos', Number(e.target.value))} className="h-11" />
              <p className="text-[10px] text-muted-foreground mt-1">
                Minutos sin tocar el POS antes de pedir PIN otra vez. <strong>0 = nunca</strong> (recomendado para servicio).
              </p>
            </Field>
            <Field label="Descuento efectivo (%)">
              <Input type="number" min={0} max={100} step={0.5} value={merged.descuento_efectivo_pct ?? 0}
                onChange={(e) => setField('descuento_efectivo_pct', Number(e.target.value))} className="h-11" />
              <p className="text-[10px] text-muted-foreground mt-1">
                Aparece como "Aplicar descuento en efectivo" en Opciones del POS. <strong>0 = deshabilitado</strong>.
              </p>
            </Field>
          </div>
          <ToggleField label="Usar cursos en el POS" checked={merged.usar_cursos ?? true} onChange={(v) => setField('usar_cursos', v)} />
          <p className="text-[10px] text-muted-foreground -mt-1 ml-1">
            Restaurantes de mantel (entrada → principal → postre) mandan cada round a la cocina cuando terminan el anterior. Si mandás todo junto (sushi, fast casual, café), apagalo y la UI queda más simple.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Modos POS habilitados</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">Aparecen en el sidebar del POS. Un foodtruck puede tener solo Mostrador.</p>
          <div className="space-y-2">
            {MODOS.map((m) => (
              <ToggleField key={m.value} label={m.label}
                checked={(merged.features_pos_modos ?? ['salon', 'mostrador', 'pedidos']).includes(m.value)}
                onChange={() => toggleModo(m.value)} />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Laboratorio (experimental)</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            Features en testing. Activá uno por vez y testealo antes de producción. Cualquier cambio recarga la app.
          </p>
          <div className="space-y-2">
            <ToggleField label="Offline-first (POS funciona sin internet — sync al volver)"
              checked={featureFlags.offlineFirstVentas} onChange={(v) => setFeatureFlag('offline_first_ventas', v)} />
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Offline-first: todas las operaciones del POS escriben primero a la base local del browser y sincronizan cuando vuelve internet. Las URLs tienen IDs negativos temporales mientras estés offline — es normal, se reemplazan al sincronizar.
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={guardar} disabled={saving || Object.keys(patch).length === 0}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>;
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border p-3">
      <Label className="cursor-pointer">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
