import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { fmt_d } from "../lib/utils";
import OnboardingTenant from "./OnboardingTenant";
import BackupsAdmin from "./BackupsAdmin";
import type { Tenant, Usuario } from "../types";

interface TenantsProps {
  user: Usuario;
}

interface TenantWithCounts extends Tenant {
  num_locales: number;
  num_usuarios: number;
}

const TENANT_OVERRIDE_KEY = "pase_tenant_override__superadmin_only";

type Tab = "tenants" | "backups";

export default function Tenants({ user }: TenantsProps) {
  const [tenants, setTenants] = useState<TenantWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tenants");

  const load = async () => {
    setLoading(true);
    const { data: ts, error: tsErr } = await db.from("tenants").select("*").order("created_at", { ascending: false });
    if (tsErr) {
      console.error("Error cargando tenants:", tsErr);
      setLoading(false);
      return;
    }
    const list = (ts || []) as Tenant[];

    // Counts: locales y usuarios por tenant. RLS deja al superadmin ver todos.
    const enriched: TenantWithCounts[] = await Promise.all(list.map(async (t) => {
      const [{ count: locCount }, { count: usrCount }] = await Promise.all([
        db.from("locales").select("*", { count: "exact", head: true }).eq("tenant_id", t.id),
        db.from("usuarios").select("*", { count: "exact", head: true }).eq("tenant_id", t.id),
      ]);
      return { ...t, num_locales: locCount || 0, num_usuarios: usrCount || 0 };
    }));
    setTenants(enriched);
    setLoading(false);
  };

  // El useEffect debe declararse antes de cualquier early return — React
  // requiere mismo orden de hooks en cada render. La gate de superadmin se
  // mueve adentro del effect para preservar el comportamiento (no fetchear
  // tenants si el user no es superadmin).
  // Patrón fetch-on-mount. No agregar load/user a deps (re-fetch infinito).
  useEffect(() => {
    if (user.rol !== "superadmin") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Solo superadmin puede ver esta pantalla.
  if (user.rol !== "superadmin") {
    return <div className="empty">Acceso denegado: solo superadmin.</div>;
  }

  const verComo = (tenant: Tenant) => {
    sessionStorage.setItem(TENANT_OVERRIDE_KEY, tenant.id);
    window.location.reload();
  };

  const toggleActivo = async (t: Tenant) => {
    if (!confirm(`${t.activo ? "Desactivar" : "Activar"} tenant "${t.nombre}"?`)) return;
    const { error } = await db.from("tenants").update({ activo: !t.activo }).eq("id", t.id);
    if (error) { alert("Error: " + error.message); return; }
    load();
  };

  const onTenantCreated = (slug: string) => {
    setWizardOpen(false);
    setFlash(`Tenant "${slug}" creado correctamente.`);
    setTimeout(() => setFlash(null), 5000);
    load();
  };

  return (
    <div>
      <div className="ph-row">
        <div>
          <div className="ph-title">Tenants</div>
          <div className="ph-sub">Gestión de empresas-clientes (solo superadmin)</div>
        </div>
        {tab === "tenants" && (
          <button className="btn btn-acc" onClick={() => setWizardOpen(true)}>+ Nuevo tenant</button>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, borderBottom: "1px solid var(--bd)" }}>
        <button
          className={"btn " + (tab === "tenants" ? "btn-acc" : "btn-ghost")}
          onClick={() => setTab("tenants")}
          style={{ borderRadius: 0, borderBottom: tab === "tenants" ? "2px solid var(--acc)" : "2px solid transparent" }}
        >
          Tenants ({tenants.length})
        </button>
        <button
          className={"btn " + (tab === "backups" ? "btn-acc" : "btn-ghost")}
          onClick={() => setTab("backups")}
          style={{ borderRadius: 0, borderBottom: tab === "backups" ? "2px solid var(--acc)" : "2px solid transparent" }}
        >
          Backups
        </button>
      </div>

      {flash && tab === "tenants" && <div className="alert alert-success" style={{ marginBottom: 16 }}>{flash}</div>}

      {tab === "tenants" && (
        <div className="panel">
          {loading ? <div className="loading">Cargando...</div> : tenants.length === 0 ? (
            <div className="empty">No hay tenants. Creá el primero.</div>
          ) : (
            <table>
              <thead><tr>
                <th>Nombre</th><th>Slug</th><th>Plan</th><th>Activo</th>
                <th style={{textAlign:"right"}}>Locales</th>
                <th style={{textAlign:"right"}}>Usuarios</th>
                <th>Creado</th>
                <th>Trial vence</th>
                <th></th>
              </tr></thead>
              <tbody>{tenants.map(t => (
                <tr key={t.id} style={{ opacity: t.activo ? 1 : 0.4 }}>
                  <td style={{ fontWeight: 500 }}>{t.nombre}</td>
                  <td className="mono" style={{ color: "var(--muted2)" }}>{t.slug}</td>
                  <td><span className="badge b-muted">{t.plan || "—"}</span></td>
                  <td><span className={`badge ${t.activo ? "b-success" : "b-muted"}`}>{t.activo ? "Activo" : "Inactivo"}</span></td>
                  <td style={{ textAlign: "right" }} className="num">{t.num_locales}</td>
                  <td style={{ textAlign: "right" }} className="num">{t.num_usuarios}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{fmt_d(t.created_at?.slice(0,10))}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{t.trial_ends_at ? fmt_d(t.trial_ends_at.slice(0,10)) : "—"}</td>
                  <td><div style={{ display: "flex", gap: 4 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => verComo(t)}>Ver como</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => toggleActivo(t)}>
                      {t.activo ? "Desactivar" : "Activar"}
                    </button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}

      {tab === "backups" && <BackupsAdmin tenants={tenants} />}

      {wizardOpen && (
        <OnboardingTenant onClose={() => setWizardOpen(false)} onCreated={onTenantCreated} />
      )}
    </div>
  );
}
