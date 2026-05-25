// TenantFeaturesDetalle.tsx — pantalla superadmin: prender/apagar
// funciones de un tenant específico.
//
// Acceso: desde /tenants → botón "Funciones" en cada fila.
// Solo superadmin (la pantalla de Tenants ya gatea).
//
// Layout:
//   - Header con nombre del tenant + botones "Resetear a default", "Volver".
//   - Lista de features agrupadas por categoría.
//   - Cada feature: nombre + descripción + switch on/off + badge "BETA" si aplica.
//   - Cambios se guardan al toggle (optimista) con RPC fn_set_tenant_feature.

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { db } from "../lib/supabase";
import { PageHeader } from "../components/ui";
import {
  FEATURES,
  CATEGORIAS_ORDEN,
  featuresPorCategoria,
  tenantTieneFeature,
  type FeatureDef,
} from "../lib/features";
import { invalidateTenantFeaturesCache } from "../lib/useTenantFeatures";

interface TenantBasico {
  id: string;
  nombre: string;
  slug: string;
  plan: string | null;
  activo: boolean;
}

export default function TenantFeaturesDetalle() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const [tenant, setTenant] = useState<TenantBasico | null>(null);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Cargar tenant + sus overrides actuales.
  useEffect(() => {
    if (!tenantId) return;
    let cancelado = false;
    void (async () => {
      setLoading(true);
      const { data: t, error: e1 } = await db
        .from("tenants")
        .select("id, nombre, slug, plan, activo")
        .eq("id", tenantId)
        .single();
      if (cancelado) return;
      if (e1 || !t) {
        setError(e1?.message || "Tenant no encontrado");
        setLoading(false);
        return;
      }
      setTenant(t as TenantBasico);

      const { data: rows, error: e2 } = await db
        .from("tenant_features")
        .select("feature_slug, habilitado")
        .eq("tenant_id", tenantId);
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
    return () => {
      cancelado = true;
    };
  }, [tenantId]);

  const toggle = async (feature: FeatureDef) => {
    if (!tenantId) return;
    const actual = tenantTieneFeature(feature.slug, overrides);
    const nuevo = !actual;
    setSaving(feature.slug);
    setError(null);
    setInfo(null);

    // Optimista — actualizo UI antes de la respuesta.
    setOverrides((curr) => ({ ...curr, [feature.slug]: nuevo }));

    const { error: e } = await db.rpc("fn_set_tenant_feature", {
      p_tenant_id: tenantId,
      p_slug: feature.slug,
      p_habilitado: nuevo,
    });
    setSaving(null);
    if (e) {
      // Rollback
      setOverrides((curr) => ({ ...curr, [feature.slug]: actual }));
      setError(`No se pudo guardar "${feature.label}": ${e.message}`);
      return;
    }
    // Invalidar cache del tenant para que la próxima vez que entre
    // (con override de superadmin) vea los cambios.
    invalidateTenantFeaturesCache(tenantId);
  };

  const resetear = async () => {
    if (!tenantId || !tenant) return;
    if (!confirm(`Resetear TODAS las funciones de "${tenant.nombre}" a los defaults del catálogo? Borra todos los overrides.`)) return;
    setError(null);
    setInfo(null);
    const { error: e } = await db.rpc("fn_reset_tenant_features", {
      p_tenant_id: tenantId,
    });
    if (e) {
      setError("Error al resetear: " + e.message);
      return;
    }
    setOverrides({});
    invalidateTenantFeaturesCache(tenantId);
    setInfo("Reseteado. Ahora el tenant ve los defaults del catálogo.");
  };

  const activarTodo = async () => {
    if (!tenantId || !tenant) return;
    if (!confirm(`Activar TODAS las funciones para "${tenant.nombre}"?`)) return;
    setError(null);
    setInfo(null);
    const payload = FEATURES.map((f) => ({ slug: f.slug, habilitado: true }));
    const { error: e } = await db.rpc("fn_set_tenant_features_bulk", {
      p_tenant_id: tenantId,
      p_features: payload,
    });
    if (e) {
      setError("Error: " + e.message);
      return;
    }
    const map: Record<string, boolean> = {};
    for (const f of FEATURES) map[f.slug] = true;
    setOverrides(map);
    invalidateTenantFeaturesCache(tenantId);
    setInfo("Todas las funciones activadas.");
  };

  const desactivarTodo = async () => {
    if (!tenantId || !tenant) return;
    if (!confirm(`Desactivar TODAS las funciones para "${tenant.nombre}"? El tenant no va a poder operar.`)) return;
    setError(null);
    setInfo(null);
    const payload = FEATURES.map((f) => ({ slug: f.slug, habilitado: false }));
    const { error: e } = await db.rpc("fn_set_tenant_features_bulk", {
      p_tenant_id: tenantId,
      p_features: payload,
    });
    if (e) {
      setError("Error: " + e.message);
      return;
    }
    const map: Record<string, boolean> = {};
    for (const f of FEATURES) map[f.slug] = false;
    setOverrides(map);
    invalidateTenantFeaturesCache(tenantId);
    setInfo("Todas las funciones desactivadas.");
  };

  if (loading) {
    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "var(--pase-text-muted)" }}>Cargando…</p>
      </div>
    );
  }

  if (error && !tenant) {
    return (
      <div style={{ padding: 24 }}>
        <PageHeader title="Funciones del tenant" />
        <div className="alert alert-danger">{error}</div>
        <button className="btn btn-ghost" onClick={() => navigate("/tenants")}>← Volver</button>
      </div>
    );
  }

  const porCat = featuresPorCategoria();
  const activas = FEATURES.filter((f) => tenantTieneFeature(f.slug, overrides)).length;

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: "0 auto" }}>
      <PageHeader
        title={`Funciones: ${tenant?.nombre ?? "?"}`}
        subtitle={tenant?.slug}
        info={
          <>
            Prendé o apagá las funciones que ve este tenant. Los cambios se
            guardan automáticamente. Si el tenant está usando la app en este
            momento, los cambios le aparecen al refrescar.
          </>
        }
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => navigate("/tenants")}>← Volver</button>
            <button className="btn btn-ghost" onClick={resetear}>Resetear a default</button>
            <button className="btn btn-ghost" onClick={desactivarTodo}>Desactivar todo</button>
            <button className="btn btn-acc" onClick={activarTodo}>Activar todo</button>
          </>
        }
      />

      <div style={{
        background: "var(--pase-bg-elev)",
        border: "0.5px solid var(--pase-border)",
        borderRadius: 10, padding: "10px 14px", marginBottom: 16,
        display: "flex", justifyContent: "space-between", fontSize: 13,
      }}>
        <span style={{ color: "var(--pase-text-muted)" }}>
          Estado del tenant: <span style={{
            color: tenant?.activo ? "#2BB673" : "var(--pase-text-muted)",
            fontWeight: 500,
          }}>{tenant?.activo ? "Activo" : "Inactivo"}</span>
          {" · "}Plan: <span style={{ color: "var(--pase-text)" }}>{tenant?.plan || "—"}</span>
        </span>
        <span style={{ color: "var(--pase-text-muted)" }}>
          <strong style={{ color: "var(--pase-text)" }}>{activas}</strong> de {FEATURES.length} funciones activas
        </span>
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}
      {info && <div style={{
        background: "rgba(43,182,115,0.1)", border: "1px solid rgba(43,182,115,0.3)",
        color: "#2BB673", padding: "10px 14px", borderRadius: 8, marginBottom: 12,
        fontSize: 14,
      }}>{info}</div>}

      {CATEGORIAS_ORDEN.map((cat) => {
        const feats = porCat[cat];
        if (!feats || feats.length === 0) return null;
        return (
          <div key={cat} style={{ marginBottom: 22 }}>
            <h3 style={{
              fontSize: 13, fontWeight: 600, letterSpacing: "0.05em",
              textTransform: "uppercase", color: "var(--pase-text-muted)",
              margin: "0 0 10px",
            }}>{cat}</h3>
            <div style={{
              background: "var(--pase-bg-elev)",
              border: "0.5px solid var(--pase-border)",
              borderRadius: 10, overflow: "hidden",
            }}>
              {feats.map((f, idx) => {
                const habilitado = tenantTieneFeature(f.slug, overrides);
                const esBusy = saving === f.slug;
                return (
                  <div
                    key={f.slug}
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                      padding: "14px 16px",
                      borderTop: idx > 0 ? "0.5px solid var(--pase-border)" : "none",
                      opacity: esBusy ? 0.5 : 1,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 14, fontWeight: 500, color: "var(--pase-text)" }}>
                          {f.label}
                        </span>
                        {f.beta && (
                          <span style={{
                            fontSize: 10, padding: "2px 6px", borderRadius: 4,
                            background: "rgba(168,137,58,0.15)", color: "#A8893A",
                            fontWeight: 600, letterSpacing: "0.05em",
                          }}>BETA</span>
                        )}
                      </div>
                      <p style={{
                        margin: "4px 0 0", fontSize: 12,
                        color: "var(--pase-text-muted)", lineHeight: 1.4,
                      }}>{f.descripcion}</p>
                      <p style={{
                        margin: "4px 0 0", fontSize: 11,
                        color: "var(--pase-text-muted)",
                        fontFamily: "monospace",
                      }}>
                        {f.slug} · default: {f.default_habilitado ? "ON" : "OFF"}
                        {f.slug in overrides ? " · override activo" : ""}
                      </p>
                    </div>
                    <button
                      onClick={() => void toggle(f)}
                      disabled={esBusy}
                      title={habilitado ? "Click para desactivar" : "Click para activar"}
                      style={{
                        position: "relative",
                        width: 44, height: 24, flexShrink: 0,
                        borderRadius: 999,
                        background: habilitado ? "#2BB673" : "rgba(147,168,194,0.25)",
                        border: "none", cursor: esBusy ? "wait" : "pointer",
                        transition: "background 0.2s",
                      }}
                    >
                      <span style={{
                        position: "absolute",
                        top: 2, left: habilitado ? 22 : 2,
                        width: 20, height: 20, borderRadius: "50%",
                        background: "white",
                        transition: "left 0.2s",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                      }}/>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
