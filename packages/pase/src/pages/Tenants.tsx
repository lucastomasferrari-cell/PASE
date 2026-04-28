import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { fmt_d } from "../lib/utils";
import OnboardingTenant from "./OnboardingTenant";
import type { Tenant, Usuario } from "../types";

interface TenantsProps {
  user: Usuario;
}

interface TenantWithCounts extends Tenant {
  num_locales: number;
  num_usuarios: number;
}

const TENANT_OVERRIDE_KEY = "pase_tenant_override";

export default function Tenants({ user }: TenantsProps) {
  const [tenants, setTenants] = useState<TenantWithCounts[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  // Solo superadmin puede ver esta pantalla.
  if (user.rol !== "superadmin") {
    return <div className="empty">Acceso denegado: solo superadmin.</div>;
  }

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

  useEffect(() => { load(); }, []);

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
        <button className="btn btn-acc" onClick={() => setWizardOpen(true)}>+ Nuevo tenant</button>
      </div>

      {flash && <div className="alert alert-success" style={{ marginBottom: 16 }}>{flash}</div>}

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

      {wizardOpen && (
        <OnboardingTenant onClose={() => setWizardOpen(false)} onCreated={onTenantCreated} />
      )}
    </div>
  );
}
