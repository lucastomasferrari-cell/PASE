// useTenantFeatures.ts — hook para leer feature flags del tenant actual.
//
// Cachea en sessionStorage durante 5 min (similar a useCategorias). El
// re-fetch automático ocurre al cambiar de tenant (override de superadmin)
// o cuando el cache vence.
//
// Uso típico:
// ```tsx
// const { features, loading } = useTenantFeatures();
// if (loading) return <Loader/>;
// if (!tenantTieneFeature("modulo.mensajeria", features)) {
//   return <NoTenesAccesoAEstaFeature/>;
// }
// ```
//
// Para una sola feature sin React state, usar `tenantTieneFeature` directo
// con el cache estático (ej. en sidebar-nav).

import { useEffect, useState, useCallback } from "react";
import { db } from "./supabase";

const CACHE_KEY_PREFIX = "pase_tenant_features__";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

interface CachedEntry {
  features: Record<string, boolean>;
  cachedAt: number;
}

function readCache(tenantId: string): Record<string, boolean> | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY_PREFIX + tenantId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedEntry;
    if (Date.now() - parsed.cachedAt > CACHE_TTL_MS) return null;
    return parsed.features;
  } catch {
    return null;
  }
}

function writeCache(tenantId: string, features: Record<string, boolean>) {
  try {
    sessionStorage.setItem(
      CACHE_KEY_PREFIX + tenantId,
      JSON.stringify({ features, cachedAt: Date.now() }),
    );
  } catch {
    /* sessionStorage puede fallar en modo privado — no crítico */
  }
}

/** Borra el cache de un tenant específico — usar después de un cambio en superadmin. */
export function invalidateTenantFeaturesCache(tenantId: string) {
  try {
    sessionStorage.removeItem(CACHE_KEY_PREFIX + tenantId);
  } catch {
    /* idem */
  }
}

/**
 * Hook principal — devuelve { features: { slug: bool }, loading, error, reload }.
 *
 * Si tenantId es null/undefined, devuelve features={} y loading=false (no fetch).
 */
export function useTenantFeatures(tenantId: string | null | undefined): {
  features: Record<string, boolean>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<boolean>(!!tenantId);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) {
      setFeatures({});
      setLoading(false);
      return;
    }
    // Cache hit
    const cached = readCache(tenantId);
    if (cached) {
      setFeatures(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    // SELECT directo a tenant_features. La RLS permite leer las propias
    // (auth_tenant_id() === tenant_id), y superadmin también.
    // eslint-disable-next-line pase-local/require-apply-local-scope -- tabla por tenant
    const { data, error: e } = await db
      .from("tenant_features")
      .select("feature_slug, habilitado")
      .eq("tenant_id", tenantId);
    if (e) {
      setError(e.message);
      setLoading(false);
      return;
    }
    const map: Record<string, boolean> = {};
    for (const row of (data as Array<{ feature_slug: string; habilitado: boolean }> | null) ?? []) {
      map[row.feature_slug] = row.habilitado;
    }
    writeCache(tenantId, map);
    setFeatures(map);
    setLoading(false);
  }, [tenantId]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  return { features, loading, error, reload: load };
}
