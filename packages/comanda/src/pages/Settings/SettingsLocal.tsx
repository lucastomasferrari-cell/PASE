import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Upload, Trash2, ImageIcon, Store, ExternalLink, X, Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import {
  getLocalSettings, updateLocalSettings, validarSlugUnico, subirMpQr, eliminarMpQr,
  getMarketplaceLocal, updateMarketplaceLocal,
  type LocalSettingsPatch, type MarketplaceLocal, type MarketplacePatch,
} from '@/services/localSettingsService';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import type { ComandaLocalSettings, PosModo } from '@/types/database';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
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

  // Marketplace state (tabla `locales`)
  const [mp, setMp] = useState<MarketplaceLocal | null>(null);
  const [mpPatch, setMpPatch] = useState<MarketplacePatch>({});
  const [savingMp, setSavingMp] = useState(false);
  const [tagDraft, setTagDraft] = useState('');

  useEffect(() => {
    if (localId === null) return;
    getLocalSettings(localId).then((r) => {
      setSettings(r.data);
      setPatch({});
    });
    getMarketplaceLocal(localId).then((r) => {
      setMp(r.data);
      setMpPatch({});
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
      // Validación cliente: solo letras minúsculas, números y guiones.
      if (!/^[a-z0-9-]+$/.test(patch.slug)) {
        toast.error('Slug inválido', {
          description: 'Solo letras minúsculas, números y guiones (sin espacios ni acentos).',
        });
        return;
      }
      if (patch.slug.length < 2 || patch.slug.length > 50) {
        toast.error('Slug debe tener entre 2 y 50 caracteres');
        return;
      }
      const { disponible } = await validarSlugUnico(patch.slug, settings.local_id);
      if (!disponible) {
        toast.error('Ya hay otro local con este slug. Elegí otro.');
        return;
      }
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
    // Validación cliente: imagen + < 2MB
    if (!file.type.startsWith('image/')) {
      toast.error('El archivo debe ser una imagen (PNG/JPG/WEBP)');
      e.target.value = '';
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error('Imagen muy grande', { description: 'Máximo 2 MB.' });
      e.target.value = '';
      return;
    }
    setUploading(true);
    const { url, error } = await subirMpQr(user.tenant_id, settings.local_id, file);
    if (error || !url) { toast.error(error ?? 'Error subiendo'); setUploading(false); return; }
    const { error: upErr } = await updateLocalSettings(settings.id, { mp_qr_url: url });
    setUploading(false);
    if (upErr) { toast.error(upErr); return; }
    toast.success('QR de MP guardado correctamente');
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

  // ── Marketplace helpers ────────────────────────────────────────────────
  const mpMerged: MarketplaceLocal | null = mp ? { ...mp, ...mpPatch } as MarketplaceLocal : null;

  function setMpField<K extends keyof MarketplacePatch>(key: K, value: MarketplacePatch[K]) {
    setMpPatch((p) => ({ ...p, [key]: value }));
  }

  function agregarTag() {
    const t = tagDraft.trim();
    if (!t) return;
    const actuales = mpMerged?.marketplace_tags ?? [];
    if (actuales.includes(t)) { setTagDraft(''); return; }
    setMpField('marketplace_tags', [...actuales, t]);
    setTagDraft('');
  }

  function quitarTag(tag: string) {
    const actuales = mpMerged?.marketplace_tags ?? [];
    setMpField('marketplace_tags', actuales.filter((t) => t !== tag));
  }

  async function guardarMp() {
    if (!mp || localId === null) return;
    if (Object.keys(mpPatch).length === 0) { toast.info('Sin cambios marketplace'); return; }
    setSavingMp(true);
    const { error } = await updateMarketplaceLocal(localId, mpPatch);
    setSavingMp(false);
    if (error) {
      // Detectar el error típico de la migration sin aplicar
      if (error.includes('column') && error.includes('visible_marketplace')) {
        toast.error('Migration 202605151970 pendiente', {
          description: 'Aplicá la migration desde Supabase SQL Editor antes de usar esto.',
        });
      } else {
        toast.error(error);
      }
      return;
    }
    toast.success('Marketplace actualizado');
    // refrescar
    const { data } = await getMarketplaceLocal(localId);
    setMp(data);
    setMpPatch({});
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
                pattern="^[a-z0-9-]+$"
              />
              {merged.slug && (
                <p className="text-xs text-muted-foreground">
                  Tu tienda va a estar en:{' '}
                  <code className="px-1 py-0.5 rounded bg-muted text-[10px]">
                    /tienda/{merged.slug}
                  </code>
                </p>
              )}
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

      {/* MARKETPLACE — sprint 8 (campos viven en tabla `locales`) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Store className="h-5 w-5" />
            Marketplace público
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Si activás "Visible", este local aparece en{' '}
            <a href="/marketplace" target="_blank" rel="noopener" className="text-primary hover:underline inline-flex items-center gap-0.5">
              /marketplace <ExternalLink className="h-3 w-3" />
            </a>{' '}
            para que clientes nuevos te descubran y entren a tu tienda online sin intermediarios.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {!mpMerged ? (
            <div className="text-sm text-muted-foreground">Cargando…</div>
          ) : (
            <>
              <ToggleField
                label="Visible en marketplace"
                checked={mpMerged.visible_marketplace ?? false}
                onChange={(v) => setMpField('visible_marketplace', v)}
              />

              <Field label="Descripción corta (1-2 frases)">
                <Textarea
                  value={mpMerged.marketplace_descripcion ?? ''}
                  onChange={(e) => setMpField('marketplace_descripcion', e.target.value || null)}
                  rows={2}
                  placeholder="Ej: Sushi premium con delivery en CABA · Más de 20 variedades de rolls."
                  maxLength={200}
                />
                <p className="text-[10px] text-muted-foreground text-right">
                  {(mpMerged.marketplace_descripcion ?? '').length}/200
                </p>
              </Field>

              <Field label="Tags (tipo de cocina / características)">
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {(mpMerged.marketplace_tags ?? []).map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-primary/10 text-primary text-xs">
                      {t}
                      <button
                        type="button"
                        onClick={() => quitarTag(t)}
                        className="hover:bg-primary/20 rounded-full p-0.5"
                        aria-label={`Quitar ${t}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); agregarTag(); }
                    }}
                    placeholder="Ej: Sushi, Vegano, Delivery, Apto celíaco…"
                    className="h-10"
                  />
                  <Button type="button" variant="outline" onClick={agregarTag} disabled={!tagDraft.trim()}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Enter para agregar. Los clientes pueden filtrar por estos tags.
                </p>
              </Field>

              <Field label="URL de foto de portada (16:10)">
                <Input
                  value={mpMerged.marketplace_foto_url ?? ''}
                  onChange={(e) => setMpField('marketplace_foto_url', e.target.value || null)}
                  placeholder="https://images.unsplash.com/photo-..."
                  className="h-11"
                />
                {mpMerged.marketplace_foto_url && (
                  <img
                    src={mpMerged.marketplace_foto_url}
                    alt="Preview"
                    className="mt-2 rounded-md border border-border max-h-40 object-cover"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
              </Field>

              <div className="flex justify-end">
                <Button onClick={guardarMp} disabled={savingMp || Object.keys(mpPatch).length === 0}>
                  {savingMp ? 'Guardando…' : 'Guardar marketplace'}
                </Button>
              </div>
            </>
          )}
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
