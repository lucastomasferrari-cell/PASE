// IntegracionPartnerScreen — pantalla genérica para configurar un partner
// externo (Rappi / PedidosYa / Deliverect). Cada ruta concreta
// (/integraciones/rappi, /integraciones/pedidosya, /integraciones/deliverect)
// instancia este componente con su `provider` prop.
//
// Lo que ofrece:
//   - Estado actual de la integración (configurada / activa / error).
//   - Form de credenciales (campos específicos del provider).
//   - URL de webhook + secret que el dueño tiene que configurar en el
//     panel del partner (Rappi Partner, PeYa Partner, Deliverect).
//   - Tabla de mapeo locales externos → local_id COMANDA.
//   - Botón "Eliminar credenciales" (deshabilita la integración).

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Plug, CheckCircle2, AlertCircle, Trash2, Plus, Copy, Zap, RefreshCw, Download, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  getIntegracion, upsertIntegracion, eliminarIntegracion,
  listMapeos, upsertMapeo, eliminarMapeo,
  rappiTestConnection, rappiSyncMenu, rappiImportMenu,
  pedidosyaTestConnection, pedidosyaSyncMenu, pedidosyaImportMenu,
  type ExternalProvider, type IntegracionPublica, type MapeoLocal,
} from '@/services/integracionesService';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';

interface ProviderConfig {
  provider: ExternalProvider;
  nombre: string;
  emoji: string;
  /** Campos de credentials que el dueño tiene que cargar. */
  credFields: Array<{ key: string; label: string; type?: 'text' | 'password'; placeholder?: string; help?: string }>;
  /** URL del webhook que el partner debe golpear. Se muestra para que el dueño lo copie al panel del partner. */
  webhookPath: string;
  /** Texto explicativo sobre cómo conseguir credenciales. */
  onboardingHelp: React.ReactNode;
}

const CONFIGS: Record<ExternalProvider, ProviderConfig> = {
  'rappi': {
    provider: 'rappi',
    nombre: 'Rappi',
    emoji: '🛵',
    credFields: [
      { key: 'api_key', label: 'API Key', placeholder: 'rappi_...', help: 'Generada en Rappi Partner Portal.' },
      { key: 'api_secret', label: 'API Secret', type: 'password' },
      { key: 'webhook_secret', label: 'Webhook Secret (HMAC)', type: 'password', help: 'Se usa para verificar firma de los webhooks.' },
      { key: 'partner_id', label: 'Partner ID', placeholder: '12345' },
    ],
    webhookPath: '/api/tienda-mp?action=rappi-webhook',
    onboardingHelp: (
      <>
        Necesitás cuenta de <strong>Rappi Partner API</strong>. Onboarding desde{' '}
        <a href="https://www.rappi.com.ar/partner" target="_blank" rel="noopener noreferrer" className="text-primary underline">rappi.com.ar/partner</a>.
        El alta puede tardar 2-4 semanas — incluye firma de contrato comercial + setup técnico con su equipo.
      </>
    ),
  },
  'pedidos-ya': {
    provider: 'pedidos-ya',
    nombre: 'PedidosYa',
    emoji: '🟥',
    credFields: [
      { key: 'client_id', label: 'Client ID', placeholder: 'app_...' },
      { key: 'client_secret', label: 'Client Secret', type: 'password' },
      { key: 'webhook_secret', label: 'Webhook Secret', type: 'password' },
      { key: 'restaurant_id', label: 'Restaurant ID (corporate)', placeholder: 'restaurant_xxx' },
    ],
    webhookPath: '/api/tienda-mp?action=pedidosya-webhook',
    onboardingHelp: (
      <>
        Pedí acceso al programa <strong>PedidosYa POS Integration</strong> desde tu cuenta de PartnerCenter
        (<a href="https://www.pedidosya.com.ar/partners" target="_blank" rel="noopener noreferrer" className="text-primary underline">pedidosya.com.ar/partners</a>).
        Te asignan un técnico de PeYa que valida la integración antes de pasarte a producción.
      </>
    ),
  },
  // Deliverect eliminado 17-jul (Lucas): "no sé ni qué es".
};

interface Props {
  provider: ExternalProvider;
}

export function IntegracionPartnerScreen({ provider }: Props) {
  const cfg = CONFIGS[provider];
  const [integ, setInteg] = useState<IntegracionPublica | null>(null);
  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [notas, setNotas] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [eliminando, setEliminando] = useState(false);

  const [mapeos, setMapeos] = useState<MapeoLocal[]>([]);
  const [locales, setLocales] = useState<LocalSimple[]>([]);
  const [nuevoMapeo, setNuevoMapeo] = useState({ external_local_id: '', local_id: '' });

  // Operaciones específicas Rappi
  const [testeando, setTesteando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);
  const [importando, setImportando] = useState(false);
  const [usaProduccion, setUsaProduccion] = useState(false); // toggle staging/prod
  const [importPreview, setImportPreview] = useState<{
    grupos_a_crear: number;
    grupos_a_actualizar: number;
    items_a_crear: number;
    items_a_actualizar: number;
    items_ignorados: number;
  } | null>(null);

  // Cargar todo al montar / cambiar provider
  useEffect(() => {
    setLoading(true);
    Promise.all([
      getIntegracion(provider),
      listMapeos(provider),
      listLocalesAccesibles(),
    ]).then(([i, m, l]) => {
      setInteg(i.data);
      setNotas(i.data?.notas ?? '');
      setCredentials({});
      setMapeos(m.data);
      setLocales(l.data);
      setLoading(false);
    });
  }, [provider]);

  const webhookUrl = typeof window !== 'undefined' ? `${window.location.origin}${cfg.webhookPath}` : cfg.webhookPath;

  async function handleGuardarCreds() {
    if (savingRef.current) return;

    // Si no completaron ningún campo, abortar
    const tieneAlMenosUnCampo = Object.values(credentials).some((v) => v.trim());
    if (!tieneAlMenosUnCampo && !notas.trim()) {
      toast.error('Cargá al menos un campo de credenciales');
      return;
    }

    savingRef.current = true;
    setSaving(true);
    try {
      const r = await upsertIntegracion({
        provider,
        credentials: Object.fromEntries(
          Object.entries(credentials).filter(([_, v]) => v.trim()),
        ),
        notas: notas.trim() || null,
      });
      if (!r.ok) {
        toast.error(`Error guardando: ${r.error}`);
        return;
      }
      toast.success('Credenciales guardadas');
      // Recargar (sin las creds visibles)
      const fresh = await getIntegracion(provider);
      setInteg(fresh.data);
      setCredentials({});
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function handleEliminar() {
    if (!confirm(`¿Eliminar credenciales de ${cfg.nombre}? Esto deshabilita los webhooks de pedidos hasta que vuelvas a configurar.`)) return;
    setEliminando(true);
    try {
      const r = await eliminarIntegracion(provider);
      if (!r.ok) {
        toast.error(`Error: ${r.error}`);
        return;
      }
      toast.success('Credenciales eliminadas');
      setInteg(null);
      setCredentials({});
      setNotas('');
    } finally {
      setEliminando(false);
    }
  }

  async function handleAgregarMapeo() {
    if (!nuevoMapeo.external_local_id.trim() || !nuevoMapeo.local_id) {
      toast.error('Completá external_local_id + local de COMANDA');
      return;
    }
    const r = await upsertMapeo({
      provider,
      externalLocalId: nuevoMapeo.external_local_id.trim(),
      localId: parseInt(nuevoMapeo.local_id),
    });
    if (!r.ok) {
      toast.error(`Error: ${r.error}`);
      return;
    }
    toast.success('Mapeo agregado');
    setNuevoMapeo({ external_local_id: '', local_id: '' });
    const fresh = await listMapeos(provider);
    setMapeos(fresh.data);
  }

  async function handleEliminarMapeo(id: number) {
    if (!confirm('¿Eliminar este mapeo? Los webhooks que lleguen con este external_local_id quedarán huérfanos.')) return;
    const r = await eliminarMapeo(id);
    if (!r.ok) { toast.error(`Error: ${r.error}`); return; }
    toast.success('Mapeo eliminado');
    const fresh = await listMapeos(provider);
    setMapeos(fresh.data);
  }

  function copiarUrl() {
    navigator.clipboard.writeText(webhookUrl).then(() => {
      toast.success('URL copiada');
    }).catch(() => toast.error('No se pudo copiar'));
  }

  // Wrapper genérico: rappi usa store_id, peya usa restaurant_id.
  // Devolvemos las funciones específicas según el provider.
  function getProviderOps() {
    if (provider === 'rappi') {
      return {
        test: () => rappiTestConnection(usaProduccion),
        sync: (localId: number | null, externalId: string) => rappiSyncMenu({
          store_id: externalId, local_id: localId, production: usaProduccion,
        }),
        importMenu: (localId: number | null, externalId: string, dry: boolean) => rappiImportMenu({
          store_id: externalId, local_id: localId, production: usaProduccion, dry_run: dry,
        }),
        externalIdLabel: 'store_id de Rappi',
        externalIdPlaceholder: 'store_id de Rappi (ej: 12345)',
      };
    }
    if (provider === 'pedidos-ya') {
      return {
        test: () => pedidosyaTestConnection(usaProduccion),
        sync: (localId: number | null, externalId: string) => pedidosyaSyncMenu({
          restaurant_id: externalId, local_id: localId, production: usaProduccion,
        }),
        importMenu: (localId: number | null, externalId: string, dry: boolean) => pedidosyaImportMenu({
          restaurant_id: externalId, local_id: localId, production: usaProduccion, dry_run: dry,
        }),
        externalIdLabel: 'restaurant_id de PedidosYa',
        externalIdPlaceholder: 'restaurant_id de PeYa (ej: rest_xyz)',
      };
    }
    return null; // provider sin operaciones cableadas
  }

  async function handleTestConnection() {
    const ops = getProviderOps();
    if (!ops) return;
    setTesteando(true);
    try {
      const r = await ops.test();
      if (!r.ok) {
        toast.error(`Conexión ${cfg.nombre} falló`, { description: r.error });
      } else {
        toast.success(`Conexión con ${cfg.nombre} OK`);
      }
      const fresh = await getIntegracion(provider);
      setInteg(fresh.data);
    } finally {
      setTesteando(false);
    }
  }

  async function handleSyncMenu(localId: number | null, externalId: string) {
    const ops = getProviderOps();
    if (!ops) return;
    setSincronizando(true);
    try {
      const r = await ops.sync(localId, externalId);
      if (!r.ok) {
        toast.error('Sync menú falló', { description: r.error });
      } else {
        const d = r.data as { productos_sincronizados?: number; categorias_sincronizadas?: number };
        toast.success(`Menú sincronizado: ${d?.productos_sincronizados ?? '?'} productos, ${d?.categorias_sincronizadas ?? '?'} categorías`);
      }
      const fresh = await getIntegracion(provider);
      setInteg(fresh.data);
    } finally {
      setSincronizando(false);
    }
  }

  /**
   * Import en 2 pasos: dry-run preview → confirm.
   */
  async function handlePreviewImport(localId: number | null, externalId: string) {
    const ops = getProviderOps();
    if (!ops) return;
    setImportando(true);
    setImportPreview(null);
    try {
      const r = await ops.importMenu(localId, externalId, true);
      if (!r.ok) {
        toast.error(`No se pudo leer el menú de ${cfg.nombre}`, { description: r.error });
        return;
      }
      const data = r.data as { summary: typeof importPreview };
      setImportPreview(data.summary);
    } finally {
      setImportando(false);
    }
  }

  async function handleConfirmImport(localId: number | null, externalId: string) {
    const ops = getProviderOps();
    if (!ops) return;
    setImportando(true);
    try {
      const r = await ops.importMenu(localId, externalId, false);
      if (!r.ok) {
        toast.error('Import falló', { description: r.error });
        return;
      }
      const d = r.data as { summary: NonNullable<typeof importPreview> };
      toast.success(
        `Menú importado: ${d.summary.items_a_crear} items nuevos, ${d.summary.items_a_actualizar} actualizados`,
      );
      setImportPreview(null);
      const fresh = await getIntegracion(provider);
      setInteg(fresh.data);
    } finally {
      setImportando(false);
    }
  }

  if (loading) return <div className="py-12 text-center text-muted-foreground">Cargando…</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <div className="text-3xl">{cfg.emoji}</div>
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            Integración con {cfg.nombre}
            {integ?.estado === 'active' ? (
              <span className="inline-flex items-center gap-1 text-xs font-normal text-success">
                <CheckCircle2 className="h-3.5 w-3.5" /> Activa
              </span>
            ) : integ?.estado === 'error' ? (
              <span className="inline-flex items-center gap-1 text-xs font-normal text-destructive">
                <AlertCircle className="h-3.5 w-3.5" /> Error
              </span>
            ) : integ ? (
              <span className="inline-flex items-center gap-1 text-xs font-normal text-warning">
                <Plug className="h-3.5 w-3.5" /> Configurada (sin testear)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                <Plug className="h-3.5 w-3.5" /> Sin configurar
              </span>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            Recibí pedidos de {cfg.nombre} directo al POS y mantené los estados sincronizados.
          </p>
        </div>
      </div>

      {/* Onboarding help */}
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm">
        <div className="font-medium mb-1 text-primary">¿Cómo arranco?</div>
        <div className="text-foreground/80">{cfg.onboardingHelp}</div>
      </div>

      {/* Credenciales */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">Credenciales API</CardTitle>
          {integ && (
            <Button variant="ghost" size="sm" onClick={handleEliminar} disabled={eliminando} className="text-destructive h-8">
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              {eliminando ? 'Eliminando…' : 'Eliminar'}
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Por seguridad, los valores NO se muestran después de guardar. Si querés cambiarlos, pegalos de nuevo.
          </p>
          <div className="grid grid-cols-2 gap-3">
            {cfg.credFields.map((f) => (
              <div key={f.key} className="space-y-1.5">
                <Label htmlFor={f.key}>{f.label}</Label>
                <Input
                  id={f.key}
                  type={f.type ?? 'text'}
                  value={credentials[f.key] ?? ''}
                  onChange={(e) => setCredentials((c) => ({ ...c, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className={`h-10 ${f.type === 'password' ? 'font-mono text-xs' : ''}`}
                />
                {f.help && <p className="text-[10px] text-muted-foreground">{f.help}</p>}
              </div>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label>Notas (opcional)</Label>
            <Textarea
              value={notas}
              onChange={(e) => setNotas(e.target.value)}
              rows={2}
              placeholder="Ej: Cuenta de prueba, contacto del técnico, etc."
            />
          </div>
          <div className="flex justify-end pt-1">
            <Button onClick={handleGuardarCreds} disabled={saving}>
              {saving ? 'Guardando…' : integ ? 'Actualizar' : 'Guardar credenciales'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Operaciones (Rappi y PeYa, con creds cargadas) */}
      {(provider === 'rappi' || provider === 'pedidos-ya') && integ && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-500" />
              Operaciones
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-3 rounded-md border border-border p-3 text-sm">
              <input
                type="checkbox"
                id="usaProduccion"
                checked={usaProduccion}
                onChange={(e) => setUsaProduccion(e.target.checked)}
                className="h-4 w-4"
              />
              <label htmlFor="usaProduccion" className="cursor-pointer">
                Usar endpoints de <strong>producción</strong> (sin marcar = staging/sandbox)
              </label>
            </div>

            <div className="flex flex-col gap-2">
              <Button variant="outline" onClick={handleTestConnection} disabled={testeando} className="w-fit">
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${testeando ? 'animate-spin' : ''}`} />
                {testeando ? 'Probando…' : 'Probar conexión OAuth'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Intenta autenticar contra el endpoint OAuth de {cfg.nombre}.
                Si pasa, marcamos la integración como <strong>activa</strong>.
              </p>
            </div>

            {/* Selector de store + local — compartido entre import y sync */}
            <div className="rounded-md border border-dashed border-border p-3 space-y-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Sincronizar catálogo con {cfg.nombre}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Select
                  onValueChange={(v) => (window as Window & { _partner_local?: string })._partner_local = v}
                >
                  <SelectTrigger className="h-10"><SelectValue placeholder="Local COMANDA…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">Todos los locales</SelectItem>
                    {locales.map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>{l.nombre}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  placeholder={getProviderOps()?.externalIdPlaceholder ?? 'ID externo…'}
                  className="h-10 font-mono text-xs"
                  id="partner-external-id-input"
                  onChange={(e) => (window as Window & { _partner_external?: string })._partner_external = e.target.value}
                />
              </div>

              {/* Import — Datalive-style: pegás ID y trae todo */}
              <div className="rounded-md bg-primary/5 border border-primary/20 p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <Download className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  <div className="text-xs">
                    <strong className="text-foreground">Importar menú DESDE {cfg.nombre}</strong>
                    <p className="text-muted-foreground mt-0.5">
                      Si ya vendés en {cfg.nombre} y tu catálogo está allá, traelo a COMANDA en
                      1 click. Mapeamos categorías → grupos, productos → items con
                      SKU pre-poblado. Idempotente — si volvés a importar,
                      actualiza en vez de duplicar.
                    </p>
                  </div>
                </div>

                {importPreview && (
                  <div className="rounded-md bg-background border border-border p-2 text-xs space-y-0.5">
                    <div className="font-medium mb-1">Preview — esto se va a hacer:</div>
                    <div>• {importPreview.grupos_a_crear} grupos nuevos, {importPreview.grupos_a_actualizar} actualizados</div>
                    <div>• {importPreview.items_a_crear} items nuevos, {importPreview.items_a_actualizar} actualizados</div>
                    {importPreview.items_ignorados > 0 && (
                      <div className="text-warning">• {importPreview.items_ignorados} items ignorados (sin nombre o precio)</div>
                    )}
                  </div>
                )}

                <div className="flex gap-2">
                  {!importPreview ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const w = window as Window & { _partner_local?: string; _partner_external?: string };
                        const extId = w._partner_external?.trim();
                        if (!extId) { toast.error(`Pegá el ${getProviderOps()?.externalIdLabel ?? 'ID externo'}`); return; }
                        const localStr = w._partner_local ?? '0';
                        const localId = localStr === '0' ? null : parseInt(localStr);
                        handlePreviewImport(localId, extId);
                      }}
                      disabled={importando}
                      className="h-9"
                    >
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      {importando ? `Leyendo ${cfg.nombre}…` : 'Vista previa import'}
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        onClick={() => {
                          const w = window as Window & { _partner_local?: string; _partner_external?: string };
                          const extId = w._partner_external?.trim() ?? '';
                          const localStr = w._partner_local ?? '0';
                          const localId = localStr === '0' ? null : parseInt(localStr);
                          handleConfirmImport(localId, extId);
                        }}
                        disabled={importando}
                        className="h-9"
                      >
                        {importando ? 'Importando…' : 'Confirmar import'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setImportPreview(null)} disabled={importando} className="h-9">
                        Cancelar
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Sync — push del menú COMANDA al partner */}
              <div className="rounded-md border border-border p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <Upload className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="text-xs">
                    <strong className="text-foreground">Empujar menú COMANDA → {cfg.nombre}</strong>
                    <p className="text-muted-foreground mt-0.5">
                      Si tu fuente de verdad es COMANDA (no {cfg.nombre}), usá esto para
                      pushear todos los items visible_tienda al catálogo de {cfg.nombre}.
                      Sobrescribe lo que esté allá.
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const w = window as Window & { _partner_local?: string; _partner_external?: string };
                    const extId = w._partner_external?.trim();
                    if (!extId) { toast.error(`Pegá el ${getProviderOps()?.externalIdLabel ?? 'ID externo'}`); return; }
                    const localStr = w._partner_local ?? '0';
                    const localId = localStr === '0' ? null : parseInt(localStr);
                    handleSyncMenu(localId, extId);
                  }}
                  disabled={sincronizando}
                  className="h-9"
                >
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  {sincronizando ? 'Sincronizando…' : `Push menú a ${cfg.nombre}`}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Webhook URL */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">URL de webhook</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Configurá esta URL en el panel de {cfg.nombre} para que sus servidores nos avisen cuando llegue un pedido nuevo:
          </p>
          <div className="flex gap-2">
            <Input value={webhookUrl} readOnly className="h-10 font-mono text-xs flex-1" />
            <Button variant="outline" onClick={copiarUrl} className="h-10">
              <Copy className="h-3.5 w-3.5 mr-1.5" />
              Copiar
            </Button>
          </div>
          {integ?.last_test_at && (
            <p className="text-[11px] text-muted-foreground">
              Último test: {new Date(integ.last_test_at).toLocaleString('es-AR')}
              {integ.last_error && <span className="text-destructive ml-2">— {integ.last_error}</span>}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Mapeo locales */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Mapeo de locales</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Cuando {cfg.nombre} mande un pedido, viene con SU id de local.
            Mapeamos ese id al local de COMANDA para que el pedido aparezca
            en el POS correcto. Si no hay mapeo, el pedido se rechaza con
            error visible en logs.
          </p>

          {/* Tabla mapeos existentes */}
          {mapeos.length > 0 && (
            <div className="rounded-md border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-[11px] uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2">External ID</th>
                    <th className="text-left px-3 py-2">Local COMANDA</th>
                    <th className="text-left px-3 py-2">Estado</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {mapeos.map((m) => {
                    const local = locales.find((l) => l.id === m.local_id);
                    return (
                      <tr key={m.id} className="border-t border-border">
                        <td className="px-3 py-2 font-mono text-xs">{m.external_local_id}</td>
                        <td className="px-3 py-2">{local?.nombre ?? `(local ${m.local_id})`}</td>
                        <td className="px-3 py-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${m.activo ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}>
                            {m.activo ? 'Activo' : 'Pausado'}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button variant="ghost" size="sm" onClick={() => handleEliminarMapeo(m.id)} className="h-7 w-7 p-0 text-destructive">
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Agregar nuevo */}
          <div className="rounded-md border border-dashed border-border p-3 space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agregar mapeo nuevo</div>
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
              <Input
                value={nuevoMapeo.external_local_id}
                onChange={(e) => setNuevoMapeo((m) => ({ ...m, external_local_id: e.target.value }))}
                placeholder={`ID en ${cfg.nombre} (ej: store_xxx)`}
                className="h-10 font-mono text-xs"
              />
              <Select value={nuevoMapeo.local_id} onValueChange={(v) => setNuevoMapeo((m) => ({ ...m, local_id: v }))}>
                <SelectTrigger className="h-10"><SelectValue placeholder="Local COMANDA…" /></SelectTrigger>
                <SelectContent>
                  {locales.map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>{l.nombre}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={handleAgregarMapeo}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
