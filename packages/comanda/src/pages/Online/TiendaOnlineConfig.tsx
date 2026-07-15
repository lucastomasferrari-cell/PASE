// Configuración de la TIENDA ONLINE propia (marketplace). Extraído de
// SettingsLocal (15-jul) para concentrar todo el marketplace en su hub.
// Campos repartidos en dos tablas (mismo patrón que antes):
//   - comanda_local_settings (patch): slug, tienda_activa, acepta_delivery,
//     costo_envio, tiempos, horarios, contacto, mp_qr_url.
//   - locales (mpPatch): visible_marketplace, descripción, tags, foto,
//     provincia/localidad, radio_delivery_km.
// Un solo botón "Guardar" persiste ambos patches. Sin backend nuevo.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Upload, Trash2, ImageIcon, Store, ExternalLink, X, Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { WarningIntegracionFalta } from '@/components/WarningIntegracionFalta';
import { useLocalActivo } from '@/lib/localActivo';
import {
  getLocalSettings, updateLocalSettings, validarSlugUnico, subirMpQr, eliminarMpQr,
  getMarketplaceLocal, updateMarketplaceLocal, subirMarketplaceFoto,
  type LocalSettingsPatch, type MarketplaceLocal, type MarketplacePatch,
} from '@/services/localSettingsService';
import type { ComandaLocalSettings } from '@/types/database';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MoneyInput } from '@/components/MoneyInput';
import { PROVINCIAS_AR, buscarLocalidades } from '@/services/direccionesService';
import { useDebouncedValue } from '@pase/shared/utils';

export function TiendaOnlineConfig() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [settings, setSettings] = useState<ComandaLocalSettings | null>(null);
  const [patch, setPatch] = useState<LocalSettingsPatch>({});
  const [uploading, setUploading] = useState(false);

  const [mp, setMp] = useState<MarketplaceLocal | null>(null);
  const [mpPatch, setMpPatch] = useState<MarketplacePatch>({});
  const [saving, setSaving] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const [localidadQuery, setLocalidadQuery] = useState('');
  const [localidadOpts, setLocalidadOpts] = useState<string[]>([]);
  const debouncedLocQuery = useDebouncedValue(localidadQuery, 300);

  useEffect(() => {
    if (localId === null) return;
    getLocalSettings(localId).then((r) => { setSettings(r.data); setPatch({}); });
    getMarketplaceLocal(localId).then((r) => { setMp(r.data); setMpPatch({}); });
  }, [localId]);

  useEffect(() => {
    const prov = mp?.provincia ?? mpPatch.provincia;
    if (!prov) { setLocalidadOpts([]); return; }
    void buscarLocalidades(prov, debouncedLocQuery).then((opts) => setLocalidadOpts(opts));
  }, [mp?.provincia, mpPatch.provincia, debouncedLocQuery]);

  if (localId === null) {
    return <div className="py-12 text-center text-muted-foreground">Elegí un local arriba.</div>;
  }
  if (!settings) return <div className="py-12 text-center text-muted-foreground">Cargando…</div>;

  const merged = { ...settings, ...patch };
  const mpMerged: MarketplaceLocal | null = mp ? { ...mp, ...mpPatch } as MarketplaceLocal : null;

  function setField<K extends keyof LocalSettingsPatch>(key: K, value: LocalSettingsPatch[K]) {
    setPatch((p) => ({ ...p, [key]: value }));
  }
  function setMpField<K extends keyof MarketplacePatch>(key: K, value: MarketplacePatch[K]) {
    setMpPatch((p) => ({ ...p, [key]: value }));
  }

  const hayCambios = Object.keys(patch).length > 0 || Object.keys(mpPatch).length > 0;

  async function guardar() {
    if (!settings || localId === null) return;
    if (!hayCambios) { toast.info('Sin cambios'); return; }

    if (patch.slug && patch.slug !== settings.slug) {
      if (!/^[a-z0-9-]+$/.test(patch.slug)) {
        toast.error('Slug inválido', { description: 'Solo minúsculas, números y guiones (sin espacios ni acentos).' });
        return;
      }
      if (patch.slug.length < 2 || patch.slug.length > 50) { toast.error('El slug debe tener entre 2 y 50 caracteres'); return; }
      const { disponible } = await validarSlugUnico(patch.slug, settings.local_id);
      if (!disponible) { toast.error('Ya hay otro local con este slug. Elegí otro.'); return; }
    }

    setSaving(true);
    let ok = true;
    if (Object.keys(patch).length > 0) {
      const { error } = await updateLocalSettings(settings.id, patch);
      if (error) { toast.error(error); ok = false; }
    }
    if (ok && Object.keys(mpPatch).length > 0) {
      const { error } = await updateMarketplaceLocal(localId, mpPatch);
      if (error) {
        ok = false;
        if (error.includes('column') && error.includes('visible_marketplace')) {
          toast.error('Migración 202605151970 pendiente', { description: 'Aplicala en Supabase antes de usar esto.' });
        } else { toast.error(error); }
      }
    }
    setSaving(false);
    if (!ok) return;
    toast.success('Tienda actualizada');
    const [s, m] = await Promise.all([getLocalSettings(localId), getMarketplaceLocal(localId)]);
    if (s.data) setSettings(s.data);
    setMp(m.data);
    setPatch({});
    setMpPatch({});
  }

  async function handleUploadQr(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !settings || !user?.tenant_id) return;
    if (!file.type.startsWith('image/')) { toast.error('El archivo debe ser una imagen'); e.target.value = ''; return; }
    if (file.size > 2 * 1024 * 1024) { toast.error('Imagen muy grande', { description: 'Máximo 2 MB.' }); e.target.value = ''; return; }
    setUploading(true);
    const { url, error } = await subirMpQr(user.tenant_id, settings.local_id, file);
    if (error || !url) { toast.error(error ?? 'Error subiendo'); setUploading(false); return; }
    const { error: upErr } = await updateLocalSettings(settings.id, { mp_qr_url: url });
    setUploading(false);
    if (upErr) { toast.error(upErr); return; }
    toast.success('QR de MP guardado');
    const { data } = await getLocalSettings(settings.local_id);
    if (data) setSettings(data);
    e.target.value = '';
  }

  async function handleDeleteQr() {
    if (!settings || !user?.tenant_id) return;
    if (!confirm('¿Eliminar el QR de MP?')) return;
    await eliminarMpQr(user.tenant_id, settings.local_id);
    await updateLocalSettings(settings.id, { mp_qr_url: null });
    toast.success('QR eliminado');
    const { data } = await getLocalSettings(settings.local_id);
    if (data) setSettings(data);
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
    setMpField('marketplace_tags', (mpMerged?.marketplace_tags ?? []).filter((t) => t !== tag));
  }

  return (
    <div className="space-y-6">
      {/* Estado + link público */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Store className="h-5 w-5" /> Estado de la tienda</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <ToggleField label="Tienda online activa" checked={merged.tienda_activa ?? true} onChange={(v) => setField('tienda_activa', v)} />
          {mpMerged && (
            <ToggleField label="Visible en el marketplace (/marketplace)" checked={mpMerged.visible_marketplace ?? false} onChange={(v) => setMpField('visible_marketplace', v)} />
          )}
          <Field label="Link público (slug)">
            <Input value={merged.slug} onChange={(e) => setField('slug', e.target.value.toLowerCase().trim())} placeholder="villa-crespo" className="h-11" pattern="^[a-z0-9-]+$" />
            {merged.slug && (
              <p className="text-xs text-muted-foreground">
                Tu tienda: <code className="px-1 py-0.5 rounded bg-muted text-[10px]">/tienda/{merged.slug}</code>
              </p>
            )}
          </Field>
          {(merged.tienda_activa ?? true) && (
            <>
              <WarningIntegracionFalta provider="email" mensaje="Sin email conectado, los clientes no reciben confirmación de sus pedidos." />
              <WarningIntegracionFalta provider="whatsapp_api" tono="info" mensaje="Opcional: WhatsApp Business para confirmar pedidos por WA además del email." />
            </>
          )}
        </CardContent>
      </Card>

      {/* Contacto público */}
      <Card>
        <CardHeader><CardTitle>Datos de contacto</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Dirección"><Input value={merged.direccion ?? ''} onChange={(e) => setField('direccion', e.target.value)} className="h-11" /></Field>
            <Field label="Teléfono"><Input value={merged.telefono ?? ''} onChange={(e) => setField('telefono', e.target.value)} className="h-11" /></Field>
            <Field label="Instagram"><Input value={merged.instagram ?? ''} onChange={(e) => setField('instagram', e.target.value)} placeholder="@neko" className="h-11" /></Field>
            <Field label="Web"><Input value={merged.web ?? ''} onChange={(e) => setField('web', e.target.value)} placeholder="https://…" className="h-11" /></Field>
          </div>
        </CardContent>
      </Card>

      {/* Entrega */}
      <Card>
        <CardHeader><CardTitle>Entrega y tiempos</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <ToggleField label="Acepta delivery" checked={merged.acepta_delivery ?? true} onChange={(v) => setField('acepta_delivery', v)} />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Costo envío default"><MoneyInput value={Number(merged.costo_envio_default ?? 0)} onChange={(v) => setField('costo_envio_default', v)} /></Field>
            <Field label="Radio máximo de entrega (km)">
              <Input type="number" step="0.5" min={0.5} max={50} value={mpMerged?.radio_delivery_km ?? ''}
                onChange={(e) => setMpField('radio_delivery_km', e.target.value === '' ? null : Number(e.target.value))}
                placeholder="Vacío = sin límite" className="h-11" />
            </Field>
            <Field label="Tiempo retiro (min)"><Input type="number" min={0} value={merged.tiempo_retiro_min ?? 15} onChange={(e) => setField('tiempo_retiro_min', Number(e.target.value))} className="h-11" /></Field>
            <Field label="Tiempo delivery (min)"><Input type="number" min={0} value={merged.tiempo_delivery_min ?? 35} onChange={(e) => setField('tiempo_delivery_min', Number(e.target.value))} className="h-11" /></Field>
          </div>
          <p className="text-xs text-muted-foreground">
            El radio se valida en el checkout: si el cliente está fuera, no puede pagar. Sugerido CABA: 3-5 km. Vacío = sin límite.
          </p>
        </CardContent>
      </Card>

      {/* Horarios */}
      <Card>
        <CardHeader>
          <CardTitle>Horarios de atención</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Formato <code className="px-1 py-0.5 rounded bg-muted text-[10px]">HH:MM-HH:MM</code>. Varios turnos con coma:
            {' '}<code className="px-1 py-0.5 rounded bg-muted text-[10px]">12:00-15:00,20:00-23:30</code>. Vacío = cerrado. Alimenta el badge "Abierto ahora".
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {[
            { key: 'horario_lun' as const, label: 'Lunes' }, { key: 'horario_mar' as const, label: 'Martes' },
            { key: 'horario_mie' as const, label: 'Miércoles' }, { key: 'horario_jue' as const, label: 'Jueves' },
            { key: 'horario_vie' as const, label: 'Viernes' }, { key: 'horario_sab' as const, label: 'Sábado' },
            { key: 'horario_dom' as const, label: 'Domingo' },
          ].map((d) => (
            <div key={d.key} className="grid grid-cols-[120px_1fr] items-center gap-2">
              <Label className="text-sm">{d.label}</Label>
              <Input value={merged[d.key] ?? ''} onChange={(e) => setField(d.key, e.target.value || null)}
                placeholder="Ej: 12:00-15:00,20:00-23:30 (vacío = cerrado)" className="h-9 text-sm font-mono" />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Presentación en el marketplace */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Store className="h-5 w-5" /> Presentación en el marketplace</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Con "Visible" activado, aparecés en{' '}
            <a href="/marketplace" target="_blank" rel="noopener" className="text-primary hover:underline inline-flex items-center gap-0.5">/marketplace <ExternalLink className="h-3 w-3" /></a>{' '}
            para que clientes nuevos te descubran.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {!mpMerged ? <div className="text-sm text-muted-foreground">Cargando…</div> : (
            <>
              <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-3">
                <div className="text-xs font-semibold text-primary uppercase tracking-wide">📍 Ubicación del local</div>
                <p className="text-xs text-muted-foreground -mt-1">
                  Sin esto, el autocomplete de dirección del cliente trae direcciones de todo el país.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Provincia">
                    <Select value={mpMerged.provincia ?? '_none'} onValueChange={(v) => { setMpField('provincia', v === '_none' ? null : v); setMpField('localidad', null); }}>
                      <SelectTrigger className="h-10"><SelectValue placeholder="Elegir provincia…" /></SelectTrigger>
                      <SelectContent className="max-h-72">
                        <SelectItem value="_none">— Sin configurar —</SelectItem>
                        {PROVINCIAS_AR.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Localidad (opcional)">
                    {!mpMerged.provincia ? (
                      <div className="h-10 px-3 flex items-center text-xs text-muted-foreground italic border border-dashed border-border rounded-md">Elegí provincia primero</div>
                    ) : (
                      <>
                        <Input value={localidadQuery || mpMerged.localidad || ''} onChange={(e) => { setLocalidadQuery(e.target.value); setMpField('localidad', e.target.value || null); }}
                          placeholder="Ej: Belgrano" className="h-10" list={`localidades-${localId}`} />
                        <datalist id={`localidades-${localId}`}>{localidadOpts.map((l) => <option key={l} value={l} />)}</datalist>
                      </>
                    )}
                  </Field>
                </div>
              </div>

              <Field label="Descripción corta (1-2 frases)">
                <Textarea value={mpMerged.marketplace_descripcion ?? ''} onChange={(e) => setMpField('marketplace_descripcion', e.target.value || null)} rows={2}
                  placeholder="Ej: Sushi premium con delivery en CABA · Más de 20 variedades." maxLength={200} />
                <p className="text-[10px] text-muted-foreground text-right">{(mpMerged.marketplace_descripcion ?? '').length}/200</p>
              </Field>

              <Field label="Tags (tipo de cocina / características)">
                <div className="flex gap-1.5 flex-wrap mb-2">
                  {(mpMerged.marketplace_tags ?? []).map((t) => (
                    <span key={t} className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-primary/10 text-primary text-xs">
                      {t}<button type="button" onClick={() => quitarTag(t)} className="hover:bg-primary/20 rounded-full p-0.5" aria-label={`Quitar ${t}`}><X className="h-3 w-3" /></button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input value={tagDraft} onChange={(e) => setTagDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); agregarTag(); } }}
                    placeholder="Ej: Sushi, Vegano, Apto celíaco…" className="h-10" />
                  <Button type="button" variant="outline" onClick={agregarTag} disabled={!tagDraft.trim()}><Plus className="h-4 w-4" /></Button>
                </div>
              </Field>

              <Field label="Foto de portada (16:10)">
                {mpMerged.marketplace_foto_url && (
                  <img src={mpMerged.marketplace_foto_url} alt="Portada" className="mb-2 rounded-md border border-border max-h-40 w-full object-cover"
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                )}
                <div className="flex gap-2 items-center">
                  <label className="inline-flex items-center gap-1 px-3 h-9 rounded-md border border-input bg-background text-sm hover:bg-accent cursor-pointer">
                    <Upload className="h-3.5 w-3.5" />{mpMerged.marketplace_foto_url ? 'Cambiar foto' : 'Subir foto'}
                    <input type="file" accept=".png,.jpg,.jpeg,.webp" className="hidden" onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file || !user?.tenant_id || localId === null) return;
                      const { url, error } = await subirMarketplaceFoto(user.tenant_id, localId, file);
                      if (error || !url) { toast.error(error ?? 'Error subiendo'); return; }
                      setMpField('marketplace_foto_url', url);
                      toast.success('Foto subida — recordá Guardar');
                      e.target.value = '';
                    }} />
                  </label>
                  {mpMerged.marketplace_foto_url && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setMpField('marketplace_foto_url', null)}><Trash2 className="h-3.5 w-3.5 mr-1" /> Quitar</Button>
                  )}
                </div>
                <Input value={mpMerged.marketplace_foto_url ?? ''} onChange={(e) => setMpField('marketplace_foto_url', e.target.value || null)}
                  placeholder="…o pegá una URL externa (opcional)" className="h-9 text-xs mt-2" />
              </Field>
            </>
          )}
        </CardContent>
      </Card>

      {/* Pago — QR de MercadoPago */}
      <Card>
        <CardHeader><CardTitle>QR de MercadoPago</CardTitle></CardHeader>
        <CardContent>
          {settings.mp_qr_url ? (
            <div className="space-y-3">
              <img src={settings.mp_qr_url} alt="QR MP" className="max-w-[200px] rounded border border-border" />
              <Button variant="outline" onClick={handleDeleteQr} disabled={uploading}><Trash2 className="h-4 w-4 mr-2" /> Eliminar</Button>
            </div>
          ) : (
            <div className="rounded-md border-2 border-dashed border-border p-8 text-center">
              <ImageIcon className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm text-muted-foreground mb-4">PNG / JPG / WEBP</p>
              <label className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground cursor-pointer hover:bg-primary-hover transition-colors">
                <Upload className="h-4 w-4" />{uploading ? 'Subiendo…' : 'Subir QR'}
                <input type="file" accept=".png,.jpg,.jpeg,.webp,image/*" className="hidden" onChange={handleUploadQr} disabled={uploading} />
              </label>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="sticky bottom-0 flex justify-end bg-gradient-to-t from-background to-transparent py-3">
        <Button onClick={guardar} disabled={saving || !hayCambios}>{saving ? 'Guardando…' : 'Guardar cambios'}</Button>
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
