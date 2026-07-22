// Hub de la TIENDA ONLINE propia (marketplace). Concentra estadísticas,
// configuración y difusión del marketplace propio en un solo lugar.
// Pestañas (route-driven):
//   /tienda-online                 → Resumen (KPIs + estado + pedidos)
//   /tienda-online/configuracion   → Configuración (TiendaOnlineConfig)
//   /tienda-online/difusion        → Difusión (link + QR + marketplace)
// Sin backend nuevo: stats de fn_reporte_ventas_por_canal_comanda (canal
// tienda-propia), pedidos de ventas_pos origen='tienda_online', config de
// localSettingsService.
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Store, BarChart3, Settings2, Share2, ExternalLink, Copy, ShoppingBag,
  CheckCircle2, XCircle,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { listLocalesAccesibles, type LocalSimple } from '@/services/configService';
import { getVentasPorCanal, type VentasPorCanal } from '@/services/reportesService';
import { listPedidosPorAprobar } from '@/services/tiendaService';
import { getLocalSettings, getMarketplaceLocal } from '@/services/localSettingsService';
import { formatARS } from '@/lib/format';
import { QrCanvas } from '@/components/QrCanvas';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { TiendaOnlineConfig } from './TiendaOnlineConfig';

type Tab = 'resumen' | 'configuracion' | 'difusion';

function fechaLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function TiendaOnlineHub() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [localId, setLocalActivo] = useLocalActivo(user);
  const [locales, setLocales] = useState<LocalSimple[]>([]);

  useEffect(() => { listLocalesAccesibles().then((r) => setLocales(r.data)); }, []);

  const tab: Tab = location.pathname.endsWith('/configuracion') ? 'configuracion'
    : location.pathname.endsWith('/difusion') ? 'difusion' : 'resumen';

  const tabs: { id: Tab; label: string; icon: typeof BarChart3; href: string }[] = [
    { id: 'resumen',       label: 'Resumen',       icon: BarChart3, href: '/tienda-online' },
    { id: 'configuracion', label: 'Configuración', icon: Settings2, href: '/tienda-online/configuracion' },
    { id: 'difusion',      label: 'Difusión',      icon: Share2,    href: '/tienda-online/difusion' },
  ];

  return (
    <div className="space-y-5 container py-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Store className="h-6 w-6" /> Tienda online
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">Tu marketplace propio: estadísticas, configuración y difusión en un solo lugar.</p>
        </div>
        {locales.length > 1 && (
          <div className="flex items-center gap-2">
            <Label className="text-sm">Local</Label>
            <Select value={localId !== null ? String(localId) : ''} onValueChange={(v) => setLocalActivo(Number(v))}>
              <SelectTrigger className="w-[220px] h-10"><SelectValue placeholder="Elegir local…" /></SelectTrigger>
              <SelectContent>{locales.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.nombre}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = t.id === tab;
          return (
            <button key={t.id} type="button" onClick={() => navigate(t.href)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}>
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {localId === null ? (
        <div className="py-12 text-center text-muted-foreground">Elegí un local para ver su tienda.</div>
      ) : tab === 'configuracion' ? (
        <TiendaOnlineConfig />
      ) : tab === 'difusion' ? (
        <Difusion localId={localId} />
      ) : (
        <Resumen localId={localId} onIrConfig={() => navigate('/tienda-online/configuracion')} />
      )}
    </div>
  );
}

// ─── Resumen (estadísticas + estado + pedidos) ──────────────────────────────
const RANGOS = [
  { dias: 7, label: '7 días' },
  { dias: 30, label: '30 días' },
  { dias: 90, label: '90 días' },
];

function Resumen({ localId, onIrConfig }: { localId: number; onIrConfig: () => void }) {
  const navigate = useNavigate();
  const [dias, setDias] = useState(30);
  const [canal, setCanal] = useState<VentasPorCanal | null>(null);
  const [porAceptar, setPorAceptar] = useState(0);
  const [estado, setEstado] = useState<{ activa: boolean; visible: boolean; slug: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const rango = useMemo(() => {
    const hasta = fechaLocal(new Date());
    const desde = fechaLocal(new Date(Date.now() - dias * 86400000));
    return { desde, hasta };
  }, [dias]);

  useEffect(() => {
    let vivo = true;
    setLoading(true);
    Promise.all([
      getVentasPorCanal(localId, rango.desde, rango.hasta),
      listPedidosPorAprobar(localId),
      getLocalSettings(localId),
      getMarketplaceLocal(localId),
    ]).then(([canales, pedidos, settings, mp]) => {
      if (!vivo) return;
      const row = (canales.data ?? []).find((c) => c.canal_nombre?.toLowerCase().includes('tienda')) ?? null;
      setCanal(row);
      setPorAceptar(pedidos.data.length);
      setEstado(settings.data ? {
        activa: settings.data.tienda_activa ?? true,
        visible: mp.data?.visible_marketplace ?? false,
        slug: settings.data.slug ?? '',
      } : null);
      setLoading(false);
    });
    return () => { vivo = false; };
  }, [localId, rango.desde, rango.hasta]);

  return (
    <div className="space-y-5">
      {/* Estado + pedidos por aceptar */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card className={estado && !estado.activa ? 'border-amber-500/40' : undefined}>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground mb-1">Estado de la tienda</div>
            {estado ? (
              <div className="space-y-1.5">
                <Badge ok={estado.activa} labelOk="Tienda activa" labelNo="Tienda apagada" />
                <Badge ok={estado.visible} labelOk="Visible en marketplace" labelNo="Oculta del marketplace" />
              </div>
            ) : <div className="text-sm text-muted-foreground">—</div>}
          </CardContent>
        </Card>
        <Card className={porAceptar > 0 ? 'border-primary/50' : undefined}>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground mb-1">Pedidos esperando aprobación</div>
            <div className="text-3xl font-semibold tabular-nums">{porAceptar}</div>
            {porAceptar > 0 && (
              <Button size="sm" variant="outline" className="mt-2" onClick={() => navigate('/pos/pedidos')}>
                <ShoppingBag className="h-4 w-4 mr-1.5" /> Ir a pedidos
              </Button>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-xs text-muted-foreground mb-2">Accesos rápidos</div>
            <div className="flex flex-col gap-1.5 items-start">
              <button type="button" onClick={onIrConfig} className="text-sm text-primary hover:underline inline-flex items-center gap-1"><Settings2 className="h-3.5 w-3.5" /> Configurar la tienda</button>
              <button type="button" onClick={() => navigate('/reportes/canales')} className="text-sm text-primary hover:underline inline-flex items-center gap-1"><BarChart3 className="h-3.5 w-3.5" /> Reporte por canales</button>
              {estado?.slug && <a href={`/tienda/${estado.slug}`} target="_blank" rel="noopener" className="text-sm text-primary hover:underline inline-flex items-center gap-1"><ExternalLink className="h-3.5 w-3.5" /> Ver mi tienda</a>}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* KPIs de ventas online */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Ventas por la tienda online</CardTitle>
          <div className="flex gap-1">
            {RANGOS.map((r) => (
              <button key={r.dias} type="button" onClick={() => setDias(r.dias)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                  dias === r.dias ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'
                }`}>{r.label}</button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-24 flex items-center justify-center text-sm text-muted-foreground">Cargando…</div>
          ) : !canal || canal.cantidad_ventas === 0 ? (
            <div className="h-24 flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
              <span>Sin ventas por la tienda online en este período.</span>
              <span className="text-xs mt-1">Los pedidos que entran por <code className="px-1 rounded bg-muted">/tienda/{estado?.slug ?? '…'}</code> aparecen acá.</span>
            </div>
          ) : (
            <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
              <Kpi label="Ventas online" value={formatARS(canal.total_ventas)} />
              <Kpi label="Pedidos" value={String(canal.cantidad_ventas)} />
              <Kpi label="Ticket promedio" value={formatARS(canal.ticket_promedio)} />
              <Kpi label="Margen neto" value={formatARS(canal.margen_neto)} />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Difusión (link + QR + marketplace) ─────────────────────────────────────
function Difusion({ localId }: { localId: number }) {
  const [slug, setSlug] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let vivo = true;
    Promise.all([getLocalSettings(localId), getMarketplaceLocal(localId)]).then(([s, mp]) => {
      if (!vivo) return;
      setSlug(s.data?.slug ?? null);
      setVisible(mp.data?.visible_marketplace ?? false);
    });
    return () => { vivo = false; };
  }, [localId]);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const tiendaUrl = slug ? `${origin}/tienda/${slug}` : null;

  function copiar(url: string) {
    void navigator.clipboard.writeText(url).then(() => toast.success('Link copiado'), () => toast.error('No se pudo copiar'));
  }

  if (slug === null) {
    return (
      <Card><CardContent className="pt-6 text-sm text-muted-foreground">
        Todavía no configuraste el <strong>link (slug)</strong> de tu tienda. Andá a <strong>Configuración</strong> y elegí uno.
      </CardContent></Card>
    );
  }

  return (
    <div className="grid gap-5 md:grid-cols-[1fr_auto]">
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Link de tu tienda</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 rounded-md bg-muted text-sm break-all">{tiendaUrl}</code>
              <Button size="sm" variant="outline" onClick={() => tiendaUrl && copiar(tiendaUrl)}><Copy className="h-4 w-4 mr-1.5" /> Copiar</Button>
              <Button size="sm" variant="outline" asChild><a href={tiendaUrl!} target="_blank" rel="noopener"><ExternalLink className="h-4 w-4" /></a></Button>
            </div>
            <p className="text-xs text-muted-foreground">Compartí este link en tu Instagram (bio/historias), WhatsApp y Google. Los clientes piden directo, sin comisión de apps.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Marketplace</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {visible
                ? <>Tu local está <strong className="text-foreground">visible</strong> en el marketplace público — clientes nuevos te pueden descubrir.</>
                : <>Tu local está <strong className="text-foreground">oculto</strong> del marketplace. Activá "Visible en el marketplace" en Configuración para que te descubran.</>}
            </p>
            <a href={`${origin}/marketplace`} target="_blank" rel="noopener" className="text-sm text-primary hover:underline inline-flex items-center gap-1"><ExternalLink className="h-3.5 w-3.5" /> Ver marketplace</a>
          </CardContent>
        </Card>
      </div>

      {tiendaUrl && (
        <Card>
          <CardHeader><CardTitle className="text-base">QR para imprimir</CardTitle></CardHeader>
          <CardContent className="flex flex-col items-center gap-2">
            <div className="bg-white p-3 rounded-lg"><QrCanvas value={tiendaUrl} size={200} /></div>
            <p className="text-xs text-muted-foreground text-center max-w-[220px]">Poné el QR en la mesa, la vidriera o el mostrador para que escaneen y pidan.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Átomos ─────────────────────────────────────────────────────────────────
function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function Badge({ ok, labelOk, labelNo }: { ok: boolean; labelOk: string; labelNo: string }) {
  return (
    <div className={`inline-flex items-center gap-1.5 text-sm ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
      {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      {ok ? labelOk : labelNo}
    </div>
  );
}
