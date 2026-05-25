// useTenantFeatures.ts — hook para leer feature flags del tenant (admin-console).
//
// Adaptado del de PASE para usar el cliente `db` del admin-console y
// soportar el caso superadmin (que no tiene tenant_id propio sino que ve
// features de otros tenants).

import { useEffect, useState, useCallback } from 'react';
import { db } from '@/lib/supabase';

const CACHE_KEY_PREFIX = 'admin_tenant_features__';
const CACHE_TTL_MS = 5 * 60 * 1000;

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
    /* sessionStorage puede fallar en modo privado */
  }
}

export function invalidateTenantFeaturesCache(tenantId: string) {
  try {
    sessionStorage.removeItem(CACHE_KEY_PREFIX + tenantId);
  } catch { /* idem */ }
}

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
    const cached = readCache(tenantId);
    if (cached) {
      setFeatures(cached);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: e } = await db
      .from('tenant_features')
      .select('feature_slug, habilitado')
      .eq('tenant_id', tenantId);
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
