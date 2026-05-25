// TenantsFeaturesMatriz.tsx — vista matricial (tenants × features) para
// comparar rápido qué tiene activado cada cliente.
//
// Renderizada como tab dentro de /tenants (no es ruta independiente).
// Solo superadmin.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../lib/supabase";
import {
  FEATURES,
  CATEGORIAS_ORDEN,
  tenantTieneFeature,
  type FeatureCategoria,
} from "../lib/features";
import { invalidateTenantFeaturesCache } from "../lib/useTenantFeatures";

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

export default function TenantsFeaturesMatriz() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  // Map tenantId → (Map slug → habilitado).
  const [overrides, setOverrides] = useState<Record<string, Record<string, boolean>>>({});
  const [loading, setLoading] = useState(true);
  const [filtroCat, setFiltroCat] = useState<FeatureCategoria | "todas">("todas");
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    void (async () => {
      setLoading(true);
      const { data: ts } = await db
        .from("tenants")
        .select("id, nombre, slug")
        .eq("activo", true)
        .order("nombre");
      if (cancelado) return;
      setTenants((ts as TenantRow[] | null) ?? []);

      const { data: matrix, error: e } = await db.rpc("fn_get_features_matrix");
      if (cancelado) return;
      if (e) {
        setError(e.message);
        setLoading(false);
        return;
      }
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
    if (filtroCat === "todas") return FEATURES;
    return FEATURES.filter((f) => f.categoria === filtroCat);
  }, [filtroCat]);

  const toggle = async (tenantId: string, slug: string) => {
    const key = `${tenantId}:${slug}`;
    const actual = tenantTieneFeature(slug, overrides[tenantId]);
    const nuevo = !actual;
    setSaving(key);
    setError(null);

    // Optimista
    setOverrides((curr) => ({
      ...curr,
      [tenantId]: { ...(curr[tenantId] || {}), [slug]: nuevo },
    }));

    const { error: e } = await db.rpc("fn_set_tenant_feature", {
      p_tenant_id: tenantId,
      p_slug: slug,
      p_habilitado: nuevo,
    });
    setSaving(null);
    if (e) {
      // Rollback
      setOverrides((curr) => ({
        ...curr,
        [tenantId]: { ...(curr[tenantId] || {}), [slug]: actual },
      }));
      setError(`Error: ${e.message}`);
      return;
    }
    invalidateTenantFeaturesCache(tenantId);
  };

  if (loading) {
    return <div style={{ padding: 16, color: "var(--pase-text-muted)" }}>Cargando matriz…</div>;
  }

  return (
    <div>
      {/* Filtros */}
      <div style={{
        display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
        marginBottom: 14, fontSize: 13,
      }}>
        <span style={{ color: "var(--pase-text-muted)" }}>Categoría:</span>
        <button
          className={"btn btn-sm " + (filtroCat === "todas" ? "btn-acc" : "btn-ghost")}
          onClick={() => setFiltroCat("todas")}
        >
          Todas ({FEATURES.length})
        </button>
        {CATEGORIAS_ORDEN.map((cat) => {
          const n = FEATURES.filter((f) => f.categoria === cat).length;
          if (n === 0) return null;
          return (
            <button
              key={cat}
              className={"btn btn-sm " + (filtroCat === cat ? "btn-acc" : "btn-ghost")}
              onClick={() => setFiltroCat(cat)}
            >
              {cat} ({n})
            </button>
          );
        })}
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Matriz — scroll horizontal en mobile */}
      <div style={{ overflowX: "auto", borderRadius: 10, border: "0.5px solid var(--pase-border)" }}>
        <table style={{
          width: "100%", borderCollapse: "collapse", fontSize: 13,
          background: "var(--pase-bg-elev)",
        }}>
          <thead>
            <tr style={{ background: "rgba(117,170,219,0.05)" }}>
              <th style={{
                textAlign: "left", padding: "10px 14px",
                position: "sticky", left: 0, background: "var(--pase-bg-elev)",
                borderRight: "0.5px solid var(--pase-border)",
                minWidth: 220, fontWeight: 600,
              }}>Función</th>
              {tenants.map((t) => (
                <th key={t.id} style={{
                  textAlign: "center", padding: "10px 8px", minWidth: 100,
                  fontWeight: 500,
                }}>
                  <button
                    onClick={() => navigate(`/tenants/${t.id}/features`)}
                    style={{
                      background: "none", border: "none", color: "var(--pase-celeste)",
                      cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 500,
                    }}
                    title="Ver detalle"
                  >
                    {t.nombre}
                  </button>
                  <div style={{ fontSize: 10, color: "var(--pase-text-muted)" }}>{t.slug}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {featuresVisibles.map((f, idx) => (
              <tr key={f.slug} style={{
                borderTop: idx > 0 ? "0.5px solid var(--pase-border)" : "none",
              }}>
                <td style={{
                  padding: "10px 14px", position: "sticky", left: 0,
                  background: "var(--pase-bg-elev)",
                  borderRight: "0.5px solid var(--pase-border)",
                }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontWeight: 500, color: "var(--pase-text)" }}>{f.label}</span>
                    {f.beta && (
                      <span style={{
                        fontSize: 9, padding: "1px 5px", borderRadius: 3,
                        background: "rgba(168,137,58,0.15)", color: "#A8893A",
                        fontWeight: 600,
                      }}>BETA</span>
                    )}
                  </div>
                  <div style={{
                    fontSize: 11, color: "var(--pase-text-muted)",
                    fontFamily: "monospace", marginTop: 2,
                  }}>
                    {f.slug} · def {f.default_habilitado ? "ON" : "OFF"}
                  </div>
                </td>
                {tenants.map((t) => {
                  const habilitado = tenantTieneFeature(f.slug, overrides[t.id]);
                  const hasOverride = overrides[t.id]?.[f.slug] !== undefined;
                  const key = `${t.id}:${f.slug}`;
                  const esBusy = saving === key;
                  return (
                    <td key={t.id} style={{ textAlign: "center", padding: "8px" }}>
                      <button
                        onClick={() => void toggle(t.id, f.slug)}
                        disabled={esBusy}
                        title={hasOverride
                          ? `Override: ${habilitado ? "ON" : "OFF"}. Click para invertir.`
                          : `Default del catálogo: ${habilitado ? "ON" : "OFF"}. Click para forzar override.`
                        }
                        style={{
                          width: 36, height: 20, borderRadius: 999,
                          background: habilitado ? "#2BB673" : "rgba(147,168,194,0.25)",
                          border: hasOverride
                            ? "1.5px solid var(--pase-celeste)"
                            : "none",
                          cursor: esBusy ? "wait" : "pointer",
                          position: "relative", padding: 0,
                          opacity: esBusy ? 0.5 : 1,
                          transition: "background 0.2s",
                        }}
                      >
                        <span style={{
                          position: "absolute",
                          top: 1, left: habilitado ? 16 : 2,
                          width: 16, height: 16, borderRadius: "50%",
                          background: "white",
                          transition: "left 0.2s",
                          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                        }}/>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{
        fontSize: 11, color: "var(--pase-text-muted)", marginTop: 12,
        lineHeight: 1.5,
      }}>
        Click en una celda para invertir el estado. Borde celeste = override
        explícito (no es el default). Click en el nombre del tenant para ir
        al detalle por tenant con la lista completa.
      </p>
    </div>
  );
}
