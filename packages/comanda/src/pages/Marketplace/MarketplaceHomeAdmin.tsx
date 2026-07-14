// Pantalla de inicio del Marketplace (admin). Centraliza el estado de la
// tienda online + accesos rápidos a sus secciones (que viven en otras
// solapas: pedidos, config, precios, reseñas, reportes).
//
// Alta 2026-07-14 (Lucas): "falta una solapa marketplace para tener ahí todas
// las configuraciones, reportes, pedidos, etc." + esta home.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ShoppingBag, Settings as SettingsIcon, DollarSign, Star, BarChart3,
  ExternalLink, CheckCircle2, AlertTriangle, Eye, EyeOff, Truck, Clock, ChevronRight,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { db } from '@/lib/supabase';
import { Card, CardContent } from '@/components/ui/card';
import {
  getMarketplaceLocal, getLocalSettings, type MarketplaceLocal,
} from '@/services/localSettingsService';
import { listarReviewsPublicas, type ReviewsResumen } from '@/services/reviewsService';

type Settings = NonNullable<Awaited<ReturnType<typeof getLocalSettings>>['data']>;

const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'] as const;

export function MarketplaceHomeAdmin() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [mp, setMp] = useState<MarketplaceLocal | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [reviews, setReviews] = useState<ReviewsResumen | null>(null);
  const [pedidos, setPedidos] = useState({ pendientes: 0, hoy: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (localId == null) return;
    let cancel = false;
    (async () => {
      setLoading(true);
      const [mpRes, setRes] = await Promise.all([
        getMarketplaceLocal(localId),
        getLocalSettings(localId),
      ]);
      if (cancel) return;
      setMp(mpRes.data);
      setSettings(setRes.data);
      if (setRes.data?.slug) {
        const rev = await listarReviewsPublicas(setRes.data.slug);
        if (!cancel) setReviews(rev.data);
      }
      const hoyISO = new Date().toISOString().slice(0, 10);
      const base = () =>
        db.from('ventas_pos').select('id', { count: 'exact', head: true })
          .eq('local_id', localId).eq('origen', 'tienda_online').is('deleted_at', null);
      const [pend, hoyCount] = await Promise.all([
        base().eq('estado', 'necesita_aprobacion'),
        base().gte('created_at', hoyISO),
      ]);
      if (!cancel) {
        setPedidos({ pendientes: pend.count ?? 0, hoy: hoyCount.count ?? 0 });
        setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, [localId]);

  if (localId == null) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        Elegí un local para ver su marketplace.
      </div>
    );
  }

  const slug = settings?.slug ?? null;
  const horarioHoy = settings ? (settings as unknown as Record<string, unknown>)[`horario_${DIAS[new Date().getDay()]}`] as string | null : null;
  const online = !!settings?.tienda_activa && !!mp?.visible_marketplace && !!slug;

  const checklist = [
    { ok: !!settings?.tienda_activa, label: 'Tienda activa', href: '/configuracion/local' },
    { ok: !!mp?.visible_marketplace, label: 'Visible en el marketplace', href: '/configuracion/local' },
    { ok: !!slug, label: 'Slug (URL) definido', href: '/configuracion/local' },
    { ok: !!mp?.marketplace_descripcion, label: 'Descripción de la card', href: '/configuracion/local' },
    { ok: !!mp?.marketplace_foto_url, label: 'Foto de portada', href: '/configuracion/local' },
    { ok: (settings?.horario_lun || settings?.horario_mar || settings?.horario_mie), label: 'Horarios cargados', href: '/configuracion/local' },
  ];
  const faltantes = checklist.filter((c) => !c.ok);

  const accesos = [
    { label: 'Pedidos', desc: 'Aprobar y despachar', icon: ShoppingBag, href: '/pos/pedidos', badge: pedidos.pendientes || undefined },
    { label: 'Configuración', desc: 'Datos de la tienda y la card', icon: SettingsIcon, href: '/configuracion/local' },
    { label: 'Lista de precios', desc: 'Canal "Tienda propia"', icon: DollarSign, href: '/menu/lista-precios' },
    { label: 'Reseñas', desc: 'Moderar y publicar', icon: Star, href: '/clientes/resenas' },
    { label: 'Reportes', desc: 'Ventas por canal', icon: BarChart3, href: '/reportes/canales' },
  ];

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Marketplace</h1>
          <p className="text-sm text-muted-foreground">
            Tu tienda online de pedidos. Todo lo del marketplace en un solo lugar.
          </p>
        </div>
        {slug && (
          <a
            href={`/tienda/${slug}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-accent"
          >
            <ExternalLink className="h-4 w-4" /> Ver mi tienda
          </a>
        )}
      </div>

      {/* Estado */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            {online ? (
              <Eye className="h-5 w-5 text-emerald-500" />
            ) : (
              <EyeOff className="h-5 w-5 text-amber-500" />
            )}
            <div>
              <div className="text-sm font-medium">{online ? 'Publicada' : 'No publicada'}</div>
              <div className="text-xs text-muted-foreground">
                {online ? 'Aparece en /marketplace' : 'Completá el checklist para publicarla'}
              </div>
            </div>
          </div>
          {slug && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">URL</span>
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">/tienda/{slug}</code>
            </div>
          )}
          {horarioHoy && (
            <div className="flex items-center gap-1.5 text-sm">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Hoy:</span> {horarioHoy}
            </div>
          )}
          {settings?.acepta_delivery && (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Truck className="h-4 w-4" /> Delivery activo
            </div>
          )}
        </CardContent>
      </Card>

      {/* Métricas */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Metric
          label="Pedidos pendientes"
          value={loading ? '…' : String(pedidos.pendientes)}
          highlight={pedidos.pendientes > 0}
          href="/pos/pedidos"
        />
        <Metric label="Pedidos hoy" value={loading ? '…' : String(pedidos.hoy)} href="/pos/pedidos" />
        <Metric
          label="Rating"
          value={loading ? '…' : reviews?.rating_promedio != null ? `★ ${reviews.rating_promedio.toFixed(1)}` : '—'}
          sub={reviews?.total_reviews ? `${reviews.total_reviews} reseñas` : 'sin reseñas'}
          href="/clientes/resenas"
        />
        <Metric
          label="Estado"
          value={online ? 'Online' : 'Oculta'}
          highlight={!online}
          href="/configuracion/local"
        />
      </div>

      {/* Checklist de setup (solo si falta algo) */}
      {faltantes.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Para terminar de configurar la tienda
            </div>
            <ul className="space-y-2">
              {checklist.map((c) => (
                <li key={c.label}>
                  <Link
                    to={c.href}
                    className="flex items-center gap-2 text-sm hover:underline"
                  >
                    {c.ok ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />
                    ) : (
                      <div className="h-4 w-4 rounded-full border-2 border-amber-500 shrink-0" />
                    )}
                    <span className={c.ok ? 'text-muted-foreground line-through' : ''}>{c.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Accesos rápidos */}
      <div>
        <div className="mb-2 text-sm font-medium text-muted-foreground">Gestión</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {accesos.map((a) => (
            <Link key={a.label} to={a.href}>
              <Card className="transition-colors hover:bg-accent">
                <CardContent className="p-4 flex items-center gap-3">
                  <a.icon className="h-5 w-5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {a.label}
                      {a.badge ? (
                        <span className="rounded-full bg-red-500 px-1.5 text-xs font-semibold text-white">
                          {a.badge}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">{a.desc}</div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function Metric({
  label, value, sub, highlight, href,
}: { label: string; value: string; sub?: string; highlight?: boolean; href: string }) {
  return (
    <Link to={href}>
      <Card className={`transition-colors hover:bg-accent ${highlight ? 'border-amber-500/50' : ''}`}>
        <CardContent className="p-3">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className={`mt-1 text-lg font-semibold ${highlight ? 'text-amber-500' : ''}`}>{value}</div>
          {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
        </CardContent>
      </Card>
    </Link>
  );
}
