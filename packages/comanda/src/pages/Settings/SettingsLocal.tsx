import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Upload, Trash2, ImageIcon } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import {
  getLocalSettings, updateLocalSettings, validarSlugUnico, subirMpQr, eliminarMpQr,
  type LocalSettingsPatch,
} from '@/services/localSettingsService';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import type { ComandaLocalSettings, PosModo } from '@/types/database';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput } from '@/components/MoneyInput';

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
  const [uploading, setUploading] = useState(false);

  useEffect(() => { listLocalesAccesibles().then((r) => setLocales(r.data)); }, []);

  useEffect(() => {
    if (localId === null) return;
    getLocalSettings(localId).then((r) => {
      setSettings(r.data);
      setPatch({});
    });
  }, [localId]);

  if (!settings) return <div className="py-12 text-center text-muted-foreground">Cargando…</div>;

  const merged = { ...settings, ...patch };

  function setField<K extends keyof LocalSettingsPatch>(key: K, value: LocalSettingsPatch[K]) {
    setPatch((p) => ({ ...p, [key]: value }));
  }

  async function refrescar() {
    if (localId === null) return;
    const { data } = await getLocalSettings(localId);
    if (data) setSettings(data);
    setPatch({});
  }

  async function guardar() {
    if (!settings || !user?.tenant_id) return;
    if (Object.keys(patch).length === 0) { toast.info('Sin cambios'); return; }

    if (patch.slug && patch.slug !== settings.slug) {
      const { disponible } = await validarSlugUnico(patch.slug, settings.local_id);
      if (!disponible) { toast.error('Slug ya usado por otro local'); return; }
    }
    setSaving(true);
    const { error } = await updateLocalSettings(settings.id, patch);
    setSaving(false);
    if (error) { toast.error(error); return; }
    toast.success('Configuración guardada');
    await refrescar();
  }

  async function handleUploadQr(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !settings || !user?.tenant_id) return;
    setUploading(true);
    const { url, error } = await subirMpQr(user.tenant_id, settings.local_id, file);
    if (error || !url) { toast.error(error ?? 'Error subiendo'); setUploading(false); return; }
    const { error: upErr } = await updateLocalSettings(settings.id, { mp_qr_url: url });
    setUploading(false);
    if (upErr) { toast.error(upErr); return; }
    toast.success('QR de MP guardado');
    await refrescar();
    e.target.value = '';
  }

  async function handleDeleteQr() {
    if (!settings || !user?.tenant_id) return;
    if (!confirm('¿Eliminar QR de MP?')) return;
    await eliminarMpQr(user.tenant_id, settings.local_id);
    await updateLocalSettings(settings.id, { mp_qr_url: null });
    toast.success('QR eliminado');
    await refrescar();
  }

  function toggleModo(modo: PosModo) {
    const current = merged.features_pos_modos ?? ['salon', 'mostrador', 'pedidos'];
    const next = current.includes(modo)
      ? current.filter((m) => m !== modo)
      : [...current, modo];
    if (next.length === 0) { toast.error('Tenés que habilitar al menos un modo'); return; }
    setField('features_pos_modos', next);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Label>Local:</Label>
        <Select value={String(localId)} onValueChange={(v) => setLocalActivo(Number(v))}>
          <SelectTrigger className="w-[280px] h-10"><SelectValue /></SelectTrigger>
          <SelectContent>
            {locales.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.nombre}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader><CardTitle>Datos del local</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Slug público (tienda online)">
              <Input
                value={merged.slug}
                onChange={(e) => setField('slug', e.target.value.toLowerCase().trim())}
                placeholder="villa-crespo"
                className="h-11"
              />
            </Field>
            <Field label="Dirección">
              <Input
                value={merged.direccion ?? ''}
                onChange={(e) => setField('direccion', e.target.value)}
                className="h-11"
              />
            </Field>
            <Field label="Teléfono">
              <Input
                value={merged.telefono ?? ''}
                onChange={(e) => setField('telefono', e.target.value)}
                className="h-11"
              />
            </Field>
            <Field label="Instagram">
              <Input
                value={merged.instagram ?? ''}
                onChange={(e) => setField('instagram', e.target.value)}
                placeholder="@neko"
                className="h-11"
              />
            </Field>
            <Field label="Web">
              <Input
                value={merged.web ?? ''}
                onChange={(e) => setField('web', e.target.value)}
                placeholder="https://…"
                className="h-11"
              />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>QR de MercadoPago</CardTitle></CardHeader>
        <CardContent>
          {settings.mp_qr_url ? (
            <div className="space-y-3">
              <img src={settings.mp_qr_url} alt="QR MP" className="max-w-[200px] rounded border border-border" />
              <Button variant="outline" onClick={handleDeleteQr} disabled={uploading}>
                <Trash2 className="h-4 w-4 mr-2" />
                Eliminar
              </Button>
            </div>
          ) : (
            <div className="rounded-md border-2 border-dashed border-border p-8 text-center">
              <ImageIcon className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-4">PNG / JPG / WEBP</p>
              <label className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground cursor-pointer hover:bg-primary-hover transition-colors">
                <Upload className="h-4 w-4" />
                {uploading ? 'Subiendo…' : 'Subir QR'}
                <input type="file" accept=".png,.jpg,.jpeg,.webp,image/*" className="hidden"
                  onChange={handleUploadQr} disabled={uploading} />
              </label>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Tienda online y delivery</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Costo envío default">
              <MoneyInput value={Number(merged.costo_envio_default ?? 0)} onChange={(v) => setField('costo_envio_default', v)} />
            </Field>
            <Field label="Tiempo retiro (min)">
              <Input type="number" min={0} value={merged.tiempo_retiro_min ?? 15}
                onChange={(e) => setField('tiempo_retiro_min', Number(e.target.value))} className="h-11" />
            </Field>
            <Field label="Tiempo delivery (min)">
              <Input type="number" min={0} value={merged.tiempo_delivery_min ?? 35}
                onChange={(e) => setField('tiempo_delivery_min', Number(e.target.value))} className="h-11" />
            </Field>
            <Field label="Auto-lock POS (min)">
              <Input type="number" min={1} max={60} value={merged.autolock_minutos ?? 3}
                onChange={(e) => setField('autolock_minutos', Number(e.target.value))} className="h-11" />
            </Field>
          </div>
          <div className="space-y-2">
            <ToggleField
              label="Tienda online activa"
              checked={merged.tienda_activa ?? true}
              onChange={(v) => setField('tienda_activa', v)}
            />
            <ToggleField
              label="Acepta delivery"
              checked={merged.acepta_delivery ?? true}
              onChange={(v) => setField('acepta_delivery', v)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Modos POS habilitados</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            Aparecen en el sidebar del POS. Por ej. un foodtruck puede tener solo Mostrador.
          </p>
          <div className="space-y-2">
            {MODOS.map((m) => (
              <ToggleField
                key={m.value}
                label={m.label}
                checked={(merged.features_pos_modos ?? ['salon','mostrador','pedidos']).includes(m.value)}
                onChange={() => toggleModo(m.value)}
              />
            ))}
          </div>
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
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border p-3">
      <Label className="cursor-pointer">{label}</Label>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
