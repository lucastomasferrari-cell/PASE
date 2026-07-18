// TenantFeaturesDetalle.tsx (admin-console) — prender/apagar funciones
// de un tenant específico. Acceso desde /tenants → "Funciones" en la fila.

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { db } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import { ArrowLeft, Loader2 } from 'lucide-react';
import {
  FEATURES,
  CATEGORIAS_ORDEN,
  featuresPorCategoria,
  tenantTieneFeature,
  type FeatureDef,
} from '@/lib/features';
import { invalidateTenantFeaturesCache } from '@/lib/useTenantFeatures';

interface TenantBasico {
  id: string;
  nombre: string;
  slug: string;
  plan: string | null;
  activo: boolean;
}

export function TenantFeaturesDetalle() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const [tenant, setTenant] = useState<TenantBasico | null>(null);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    let cancelado = false;
    void (async () => {
      setLoading(true);
      const { data: t, error: e1 } = await db
        .from('tenants')
        .select('id, nombre, slug, plan, activo')
        .eq('id', tenantId)
        .single();
      if (cancelado) return;
      if (e1 || !t) {
        setError(e1?.message || 'Tenant no encontrado');
        setLoading(false);
        return;
      }
      setTenant(t as TenantBasico);
      const { data: rows, error: e2 } = await db
        .from('tenant_features')
        .select('feature_slug, habilitado')
        .eq('tenant_id', tenantId);
      if (cancelado) return;
      if (e2) {
        setError(e2.message);
      } else {
        const map: Record<string, boolean> = {};
        for (const r of (rows as Array<{ feature_slug: string; habilitado: boolean }> | null) ?? []) {
          map[r.feature_slug] = r.habilitado;
        }
        setOverrides(map);
      }
      setLoading(false);
    })();
    return () => { cancelado = true; };
  }, [tenantId]);

  const toggle = async (feature: FeatureDef) => {
    if (!tenantId) return;
    const actual = tenantTieneFeature(feature.slug, overrides);
    const nuevo = !actual;
    setSaving(feature.slug);
    setError(null); setInfo(null);
    setOverrides((curr) => ({ ...curr, [feature.slug]: nuevo }));
    const { error: e } = await db.rpc('fn_set_tenant_feature', {
      p_tenant_id: tenantId, p_slug: feature.slug, p_habilitado: nuevo,
    });
    setSaving(null);
    if (e) {
      setOverrides((curr) => ({ ...curr, [feature.slug]: actual }));
      setError(`No se pudo guardar "${feature.label}": ${e.message}`);
      return;
    }
    invalidateTenantFeaturesCache(tenantId);
  };

  const resetear = async () => {
    if (!tenantId || !tenant) return;
    if (!confirm(`Resetear TODAS las funciones de "${tenant.nombre}" a los defaults del catálogo? Borra todos los overrides.`)) return;
    setError(null); setInfo(null);
    const { error: e } = await db.rpc('fn_reset_tenant_features', { p_tenant_id: tenantId });
    if (e) { setError('Error al resetear: ' + e.message); return; }
    setOverrides({});
    invalidateTenantFeaturesCache(tenantId);
    setInfo('Reseteado. Ahora el tenant ve los defaults del catálogo.');
  };

  const bulkSet = async (habilitado: boolean) => {
    if (!tenantId || !tenant) return;
    const accion = habilitado ? 'Activar' : 'Desactivar';
    if (!confirm(`${accion} TODAS las funciones para "${tenant.nombre}"?`)) return;
    setError(null); setInfo(null);
    const payload = FEATURES.map((f) => ({ slug: f.slug, habilitado }));
    const { error: e } = await db.rpc('fn_set_tenant_features_bulk', {
      p_tenant_id: tenantId, p_features: payload,
    });
    if (e) { setError('Error: ' + e.message); return; }
    const map: Record<string, boolean> = {};
    for (const f of FEATURES) map[f.slug] = habilitado;
    setOverrides(map);
    invalidateTenantFeaturesCache(tenantId);
    setInfo(`Todas las funciones ${habilitado ? 'activadas' : 'desactivadas'}.`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-admin-muted mono text-xs uppercase tracking-widest gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Cargando funciones…
      </div>
    );
  }

  if (error && !tenant) {
    return (
      <div className="space-y-3">
        <button
          onClick={() => navigate('/tenants')}
          className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-widest text-admin-muted hover:text-admin-accent transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Volver a Tenants
        </button>
        <div className="rounded border border-admin-danger/20 bg-admin-danger/10 text-admin-danger px-3 py-2 text-sm">
          {error}
        </div>
      </div>
    );
  }

  const porCat = featuresPorCategoria();
  const activas = FEATURES.filter((f) => tenantTieneFeature(f.slug, overrides)).length;

  return (
    <div className="space-y-4">
      <div>
        <button
          onClick={() => navigate('/tenants')}
          className="inline-flex items-center gap-1.5 mono text-[10px] uppercase tracking-widest text-admin-muted hover:text-admin-accent transition-colors mb-3"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Tenants
        </button>
        <div className="flex items-center gap-4">
          <h2 className="font-mono text-[11px] font-semibold text-admin-accent tracking-[0.3em] uppercase whitespace-nowrap">
            Funciones · {tenant?.nombre}
          </h2>
          <div className="h-px flex-1 bg-gradient-to-r from-admin-border-strong to-transparent" />
          <span className="mono text-[9px] text-admin-muted opacity-60 whitespace-nowrap">{tenant?.slug}</span>
        </div>
        <div className="flex gap-2 flex-wrap mt-4">
          <button onClick={resetear} className="px-3 py-1.5 rounded-[3px] mono text-[9px] uppercase tracking-widest border border-admin-border text-admin-muted hover:text-admin-text hover:bg-admin-surface-2 transition-colors">
            Resetear a default
          </button>
          <button onClick={() => bulkSet(false)} className="px-3 py-1.5 rounded-[3px] mono text-[9px] uppercase tracking-widest border border-admin-danger/40 text-admin-danger hover:bg-admin-danger/10 transition-colors">
            Desactivar todo
          </button>
          <button onClick={() => bulkSet(true)} className="px-3 py-1.5 rounded-[3px] mono text-[9px] uppercase tracking-widest border border-admin-accent/30 bg-admin-accent/10 text-admin-accent hover:bg-admin-accent/20 transition-colors">
            Activar todo
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-admin-muted bg-admin-surface border border-admin-border rounded px-3 py-2">
        <span className="inline-flex items-center gap-1.5">
          <span className={tenant?.activo ? 'status-active' : 'status-inactive'} />
          Estado tenant:{' '}
          <span className={cn(tenant?.activo ? 'text-admin-success' : 'text-admin-muted', 'font-medium')}>
            {tenant?.activo ? 'Activo' : 'Inactivo'}
          </span>
          {' · '}Plan: <span className="text-admin-text">{tenant?.plan || '—'}</span>
        </span>
        <span className="font-mono">
          <strong className="text-admin-text">{activas}</strong> de {FEATURES.length} funciones activas
        </span>
      </div>

      {error && <div className="rounded border border-admin-danger/20 bg-admin-danger/10 text-admin-danger px-3 py-2 text-sm">{error}</div>}
      {info && <div className="rounded border border-admin-success/20 bg-admin-success/10 text-admin-success px-3 py-2 text-sm">{info}</div>}

      {CATEGORIAS_ORDEN.map((cat) => {
        const feats = porCat[cat];
        if (!feats || feats.length === 0) return null;
        return (
          <section key={cat}>
            <div className="flex items-center gap-3 mb-2">
              <h3 className="label-sys whitespace-nowrap">{cat}</h3>
              <div className="h-px flex-1 bg-gradient-to-r from-admin-border to-transparent" />
            </div>
            <div className="rounded border border-admin-border bg-admin-surface overflow-hidden">
              {feats.map((f, idx) => {
                const habilitado = tenantTieneFeature(f.slug, overrides);
                const esBusy = saving === f.slug;
                const hasOverride = f.slug in overrides;
                return (
                  <div
                    key={f.slug}
                    className={cn(
                      'flex gap-3 items-start px-4 py-4',
                      idx > 0 && 'border-t border-admin-border',
                      esBusy && 'opacity-50',
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-base font-semibold text-admin-text">{f.label}</span>
                        {f.beta && (
                          <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-admin-accent/10 text-admin-accent border border-admin-accent/20 uppercase tracking-wider">
                            BETA
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-admin-muted mt-1 leading-snug">{f.descripcion}</p>
                      <p className="text-[9px] text-admin-muted mt-1 font-mono opacity-70">
                        {f.slug} · default: {f.default_habilitado ? 'ON' : 'OFF'}
                        {hasOverride && ' · override activo'}
                      </p>
                    </div>
                    <button
                      onClick={() => void toggle(f)}
                      disabled={esBusy}
                      title={habilitado ? 'Click para desactivar' : 'Click para activar'}
                      className={cn(
                        'relative w-11 h-6 rounded-full transition-colors flex-shrink-0',
                        habilitado ? 'bg-admin-success' : 'bg-admin-border',
                        esBusy ? 'cursor-wait' : 'cursor-pointer',
                      )}
                    >
                      <span
                        className={cn(
                          'absolute top-0.5 w-5 h-5 rounded-full bg-admin-text shadow transition-all',
                          habilitado ? 'left-[22px]' : 'left-0.5',
                        )}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
