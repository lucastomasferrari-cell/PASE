// TenantsFeaturesMatriz.tsx (admin-console) — vista matricial tenants×features.
// Accesible desde sidebar como página separada (/tenants/features).

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import { Loader2, Grid3x3 } from 'lucide-react';
import {
  FEATURES,
  CATEGORIAS_ORDEN,
  tenantTieneFeature,
  type FeatureCategoria,
} from '@/lib/features';
import { invalidateTenantFeaturesCache } from '@/lib/useTenantFeatures';

interface TenantRow {
  id: string;
  nombre: string;
  slug: string;
}

interface MatrixRow {
  tenant_id: string;
  tenant_nombre: string;
  feature_slug: string | null;
  habilitado: boolean | null;
}

export function TenantsFeaturesMatriz() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Record<string, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [filtroCat, setFiltroCat] = useState<FeatureCategoria | 'todas'>('todas');
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    void (async () => {
      setLoading(true);
      const { data: ts } = await db
        .from('tenants').select('id, nombre, slug').eq('activo', true).order('nombre');
      if (cancelado) return;
      setTenants((ts as TenantRow[] | null) ?? []);

      const { data: matrix, error: e } = await db.rpc('fn_get_features_matrix');
      if (cancelado) return;
      if (e) { setError(e.message); setLoading(false); return; }
      const map: Record<string, Record<string, boolean>> = {};
      for (const row of (matrix as MatrixRow[] | null) ?? []) {
        if (!map[row.tenant_id]) map[row.tenant_id] = {};
        if (row.feature_slug && row.habilitado != null) {
          map[row.tenant_id]![row.feature_slug] = row.habilitado;
        }
      }
      setOverrides(map);
      setLoading(false);
    })();
    return () => { cancelado = true; };
  }, []);

  const featuresVisibles = useMemo(() => {
    if (filtroCat === 'todas') return FEATURES;
    return FEATURES.filter((f) => f.categoria === filtroCat);
  }, [filtroCat]);

  const toggle = async (tenantId: string, slug: string) => {
    const key = `${tenantId}:${slug}`;
    const actual = tenantTieneFeature(slug, overrides[tenantId]);
    const nuevo = !actual;
    setSaving(key); setError(null);
    setOverrides((curr) => ({
      ...curr,
      [tenantId]: { ...(curr[tenantId] || {}), [slug]: nuevo },
    }));
    const { error: e } = await db.rpc('fn_set_tenant_feature', {
      p_tenant_id: tenantId, p_slug: slug, p_habilitado: nuevo,
    });
    setSaving(null);
    if (e) {
      setOverrides((curr) => ({
        ...curr,
        [tenantId]: { ...(curr[tenantId] || {}), [slug]: actual },
      }));
      setError(`Error: ${e.message}`);
      return;
    }
    invalidateTenantFeaturesCache(tenantId);
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-admin-text flex items-center gap-2">
          <Grid3x3 className="w-5 h-5 text-admin-accent" />
          Funciones (matriz)
        </h1>
        <p className="text-xs text-admin-muted mt-1">
          Vista comparativa tenants × funciones. Click en una celda para activar/desactivar.
        </p>
      </header>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-admin-muted">Categoría:</span>
        <button
          onClick={() => setFiltroCat('todas')}
          className={cn(
            'px-2.5 py-1 rounded text-xs border',
            filtroCat === 'todas'
              ? 'bg-admin-accent text-admin-bg border-admin-accent'
              : 'border-admin-border text-admin-muted hover:text-admin-text',
          )}
        >
          Todas ({FEATURES.length})
        </button>
        {CATEGORIAS_ORDEN.map((cat) => {
          const n = FEATURES.filter((f) => f.categoria === cat).length;
          if (n === 0) return null;
          return (
            <button
              key={cat}
              onClick={() => setFiltroCat(cat)}
              className={cn(
                'px-2.5 py-1 rounded text-xs border',
                filtroCat === cat
                  ? 'bg-admin-accent text-admin-bg border-admin-accent'
                  : 'border-admin-border text-admin-muted hover:text-admin-text',
              )}
            >
              {cat} ({n})
            </button>
          );
        })}
      </div>

      {error && <div className="rounded border border-admin-danger/30 bg-admin-danger/10 text-admin-danger px-3 py-2 text-sm">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-admin-muted text-sm gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando matriz…
        </div>
      ) : (
        <div className="rounded border border-admin-border bg-admin-surface overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-admin-bg">
              <tr>
                <th className="text-left px-3 py-2 sticky left-0 bg-admin-bg border-r border-admin-border min-w-[220px] font-medium text-admin-muted text-xs uppercase tracking-wider">
                  Función
                </th>
                {tenants.map((t) => (
                  <th key={t.id} className="text-center px-2 py-2 min-w-[100px] font-medium">
                    <button
                      onClick={() => navigate(`/tenants/${t.id}/features`)}
                      className="text-xs text-admin-accent hover:underline"
                      title="Ver detalle"
                    >
                      {t.nombre}
                    </button>
                    <div className="text-[10px] text-admin-muted font-mono mt-0.5">{t.slug}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {featuresVisibles.map((f, idx) => (
                <tr key={f.slug} className={cn(idx > 0 && 'border-t border-admin-border/50')}>
                  <td className="px-3 py-2.5 sticky left-0 bg-admin-surface border-r border-admin-border">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-admin-text">{f.label}</span>
                      {f.beta && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-admin-accent/15 text-admin-accent font-semibold">
                          BETA
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-admin-muted font-mono mt-0.5">
                      {f.slug} · def {f.default_habilitado ? 'ON' : 'OFF'}
                    </div>
                  </td>
                  {tenants.map((t) => {
                    const habilitado = tenantTieneFeature(f.slug, overrides[t.id]);
                    const hasOverride = overrides[t.id]?.[f.slug] !== undefined;
                    const key = `${t.id}:${f.slug}`;
                    const esBusy = saving === key;
                    return (
                      <td key={t.id} className="text-center px-2 py-2">
                        <button
                          onClick={() => void toggle(t.id, f.slug)}
                          disabled={esBusy}
                          title={hasOverride
                            ? `Override: ${habilitado ? 'ON' : 'OFF'}`
                            : `Default: ${habilitado ? 'ON' : 'OFF'}`}
                          className={cn(
                            'relative w-9 h-5 rounded-full transition-colors',
                            habilitado ? 'bg-admin-success' : 'bg-admin-border',
                            hasOverride && 'ring-1 ring-admin-accent ring-offset-1 ring-offset-admin-surface',
                            esBusy ? 'cursor-wait opacity-50' : 'cursor-pointer',
                          )}
                        >
                          <span className={cn(
                            'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all',
                            habilitado ? 'left-[18px]' : 'left-0.5',
                          )} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-admin-muted leading-relaxed">
        Click en una celda para invertir el estado. Ring celeste = override
        explícito (no es el default del catálogo). Click en el nombre del
        tenant para ir al detalle individual.
      </p>
    </div>
  );
}
