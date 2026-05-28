import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { fmt_d } from "@pase/shared/utils";
import BackupsAdmin from "./BackupsAdmin";
import { InfoTooltip } from "../components/ui";
import { useToast } from "../hooks/useToast";
import { ToastComponent } from "../components/Toast";
import type { Tenant, Usuario } from "../types";

// URL del Admin Console (deploy Vercel separado). Mover la creación de
// tenants allá fue decisión Lucas 2026-05-20: el Admin Console ya tiene
// gestión completa (CRUD + billing + métricas) y dejar la pantalla
// duplicada confunde. Esta pantalla en PASE queda solo lectura + acción
// de "ver como" + tab Backups.
const ADMIN_CONSOLE_URL =
  (import.meta.env.VITE_ADMIN_CONSOLE_URL as string | undefined)
  || "https://admin.pase.local";

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
  const [flash] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tenants");
  const { toast, showError } = useToast();

  const load = async () => {
    setLoading(true);
    // Fix auditoría 2026-05-21 ALTO-6: antes hacía N+1 (1 SELECT tenants +
    // 2 COUNTs por cada tenant en Promise.all). Ahora 1 RPC con LEFT JOIN.
    const { data: rows, error: rpcErr } = await db.rpc("fn_tenants_con_counts");
    if (rpcErr) {
      console.error("Error cargando tenants:", rpcErr);
      setLoading(false);
      return;
    }
    const enriched: TenantWithCounts[] = ((rows || []) as Array<TenantWithCounts & { num_locales: number; num_usuarios: number }>).map(r => ({
      ...r,
      num_locales: Number(r.num_locales) || 0,
      num_usuarios: Number(r.num_usuarios) || 0,
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
    if (error) { showError("Error: " + error.message); return; }
    load();
  };

  return (
    <div>
      <div className="ph-row">
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <div className="ph-title">Tenants</div>
          <InfoTooltip>
            Gestión de empresas-clientes del sistema. Acceso restringido a usuarios con rol <strong>superadmin</strong>.
          </InfoTooltip>
        </div>
        {tab === "tenants" && (
          <a
            href={`${ADMIN_CONSOLE_URL}/tenants`}
            target="_blank"
            rel="noreferrer"
            className="btn btn-acc"
            title="La creación de tenants se hace ahora desde Admin Console"
          >
            Crear tenant ↗
          </a>
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
      {toast && <ToastComponent toast={toast} />}
    </div>
  );
}
