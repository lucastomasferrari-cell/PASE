// ─────────────────────────────────────────────────────────────────────────
// UsuariosComanda — Gestión de usuarios POS de COMANDA desde PASE.
//
// Sprint COMANDA Autónomo Fase 2 (Lucas 24-may): pantalla para que el dueño/
// admin del tenant cree, edite, active/desactive usuarios del POS y les
// asigne permisos específicos del catálogo `comanda_permisos_catalogo`.
//
// Auth compartido: si el email ya existe como usuario PASE, se reusa el
// auth_id. El mismo email/password loguea en ambos sistemas con perfiles
// y permisos separados.
//
// Acceso: solo dueno/admin/superadmin (chequeado por RLS de
// comanda_usuarios + por route guard en App.tsx).
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useState, useMemo } from "react";
import { db } from "../lib/supabase";
import { PageHeader, EmptyState } from "../components/ui";
import type { Usuario, Local } from "../types/auth";

interface ComandaUsuario {
  id: string;
  auth_id: string | null;
  tenant_id: string;
  nombre: string;
  email: string;
  rol_pos: "mozo" | "cajero" | "manager" | "admin";
  locales: number[] | null;
  pin_pos: string | null;
  activo: boolean;
  created_at: string;
  updated_at: string;
}

interface PermisoCatalogo {
  slug: string;
  descripcion: string;
  categoria: string;
  orden: number;
}

type RolPos = ComandaUsuario["rol_pos"];

const ROL_LABEL: Record<RolPos, string> = {
  mozo: "Mozo (solo agregar items)",
  cajero: "Cajero (cobrar + conteo)",
  manager: "Manager (anular + descuentos + mesas)",
  admin: "Admin POS (acceso total)",
};

interface Props {
  user: Usuario | null;
  locales?: Local[];
}

export default function UsuariosComanda({ user, locales = [] }: Props) {
  const [list, setList] = useState<ComandaUsuario[]>([]);
  const [catalogo, setCatalogo] = useState<PermisoCatalogo[]>([]);
  const [permisosPorUsuario, setPermisosPorUsuario] = useState<Map<string, Set<string>>>(new Map());
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ComandaUsuario | "nuevo" | null>(null);

  const esDuenoAdmin = user?.rol === "dueno" || user?.rol === "admin" || user?.rol === "superadmin";

  async function load() {
    setLoading(true);
    const [{ data: users }, { data: cat }, { data: perms }] = await Promise.all([
      db.from("comanda_usuarios").select("*").order("rol_pos").order("nombre"),
      db.from("comanda_permisos_catalogo").select("*").order("categoria").order("orden"),
      db.from("comanda_usuario_permisos").select("comanda_usuario_id, modulo_slug"),
    ]);
    setList((users || []) as ComandaUsuario[]);
    setCatalogo((cat || []) as PermisoCatalogo[]);
    const map = new Map<string, Set<string>>();
    (perms || []).forEach((p) => {
      const k = (p as { comanda_usuario_id: string }).comanda_usuario_id;
      const s = (p as { modulo_slug: string }).modulo_slug;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k)!.add(s);
    });
    setPermisosPorUsuario(map);
    setLoading(false);
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);

  if (!esDuenoAdmin) {
    return (
      <div>
        <PageHeader title="Usuarios COMANDA" subtitle="acceso restringido" />
        <EmptyState icon="🔒" title="Sin permisos" description="Solo dueños y administradores pueden gestionar usuarios POS." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Usuarios COMANDA"
        subtitle={`${list.length} usuarios POS · ${list.filter(u => u.activo).length} activos`}
        info={<>Gestión de cuentas del POS. Comparten email/password con PASE (auth único) pero los permisos y el perfil son separados. Un mismo email puede tener cuenta PASE + cuenta COMANDA, ambas o solo una.</>}
        actions={
          <button className="btn btn-acc" onClick={() => setModal("nuevo")}>+ Crear usuario POS</button>
        }
      />

      {loading ? <div className="loading">Cargando…</div> : list.length === 0 ? (
        <EmptyState icon="👥" title="Sin usuarios COMANDA"
          description="Creá el primer usuario POS clickeando '+ Crear usuario POS'." />
      ) : (
        <div className="panel">
          <table>
            <thead><tr>
              <th>Nombre</th><th>Email</th><th>Rol POS</th><th>Locales</th>
              <th style={{ textAlign: "center" }}># Permisos</th><th>Estado</th><th></th>
            </tr></thead>
            <tbody>
              {list.map(u => {
                const nPerms = permisosPorUsuario.get(u.id)?.size ?? 0;
                const localesNombres = u.locales == null
                  ? "Todos"
                  : u.locales.map(lid => locales.find(l => l.id === lid)?.nombre ?? `#${lid}`).join(", ");
                return (
                  <tr key={u.id} style={{ opacity: u.activo ? 1 : 0.5 }}>
                    <td>{u.nombre}</td>
                    <td style={{ fontSize: 11, color: "var(--muted2)" }}>{u.email}</td>
                    <td><span className="badge b-muted">{u.rol_pos}</span></td>
                    <td style={{ fontSize: 11 }}>{localesNombres}</td>
                    <td style={{ textAlign: "center" }}>{u.rol_pos === "admin" ? "—" : nPerms}</td>
                    <td>
                      <span className={`badge ${u.activo ? "b-success" : "b-muted"}`}>
                        {u.activo ? "Activo" : "Inactivo"}
                      </span>
                    </td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => setModal(u)}>Editar</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <UsuarioComandaModal
          modo={modal === "nuevo" ? "nuevo" : "editar"}
          usuario={modal === "nuevo" ? null : modal}
          permisosActuales={modal === "nuevo" ? new Set() : (permisosPorUsuario.get(modal.id) ?? new Set())}
          catalogo={catalogo}
          locales={locales}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Modal crear/editar ────────────────────────────────────────────────
interface ModalProps {
  modo: "nuevo" | "editar";
  usuario: ComandaUsuario | null;
  permisosActuales: Set<string>;
  catalogo: PermisoCatalogo[];
  locales: Local[];
  onClose: () => void;
  onSaved: () => void;
}

function UsuarioComandaModal({ modo, usuario, permisosActuales, catalogo, locales, onClose, onSaved }: ModalProps) {
  const [nombre, setNombre] = useState(usuario?.nombre ?? "");
  const [email, setEmail] = useState(usuario?.email ?? "");
  const [password, setPassword] = useState("");
  const [rolPos, setRolPos] = useState<RolPos>(usuario?.rol_pos ?? "cajero");
  const [localesSel, setLocalesSel] = useState<number[] | null>(usuario?.locales ?? null);
  const [pinPos, setPinPos] = useState(usuario?.pin_pos ?? "");
  const [activo, setActivo] = useState(usuario?.activo ?? true);
  const [permisosSel, setPermisosSel] = useState<Set<string>>(new Set(permisosActuales));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const categorias = useMemo(() => {
    const map = new Map<string, PermisoCatalogo[]>();
    catalogo.forEach(p => {
      if (!map.has(p.categoria)) map.set(p.categoria, []);
      map.get(p.categoria)!.push(p);
    });
    return Array.from(map.entries());
  }, [catalogo]);

  function toggle(slug: string) {
    const next = new Set(permisosSel);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    setPermisosSel(next);
  }

  async function guardar() {
    setSaving(true); setErr(null);
    try {
      if (modo === "nuevo") {
        const { data: sess } = await db.auth.getSession();
        const token = sess?.session?.access_token;
        const resp = await fetch("/api/auth-admin", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            action: "create_comanda",
            nombre, email, password,
            rol_pos: rolPos,
            locales: localesSel,
            pin_pos: pinPos || null,
            permisos: Array.from(permisosSel),
          }),
        });
        const json = await resp.json();
        if (!resp.ok || !json.ok) throw new Error(json.error || "create_failed");
      } else if (usuario) {
        // UPDATE comanda_usuario via cliente (RLS lo deja a dueno/admin)
        const { error: uErr } = await db.from("comanda_usuarios").update({
          nombre, rol_pos: rolPos, locales: localesSel,
          pin_pos: pinPos || null, activo,
        }).eq("id", usuario.id);
        if (uErr) throw new Error(uErr.message);

        // Sincronizar permisos: borrar todos los del usuario + reinsertar los seleccionados
        await db.from("comanda_usuario_permisos").delete().eq("comanda_usuario_id", usuario.id);
        if (rolPos !== "admin" && permisosSel.size > 0) {
          const rows = Array.from(permisosSel).map(slug => ({
            comanda_usuario_id: usuario.id,
            tenant_id: usuario.tenant_id,
            modulo_slug: slug,
          }));
          const { error: pErr } = await db.from("comanda_usuario_permisos").insert(rows);
          if (pErr) throw new Error(pErr.message);
        }
      }
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const adminBypass = rolPos === "admin";

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 640, maxWidth: "92vw" }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <div className="modal-title">{modo === "nuevo" ? "Crear usuario COMANDA" : `Editar — ${usuario?.nombre}`}</div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          {err && <div className="alert alert-error" style={{ marginBottom: 12 }}>❌ {err}</div>}

          <div className="form2">
            <div className="field">
              <label>Nombre</label>
              <input value={nombre} onChange={e => setNombre(e.target.value)} />
            </div>
            <div className="field">
              <label>Email {modo === "editar" && "(read-only)"}</label>
              <input value={email} onChange={e => setEmail(e.target.value)} disabled={modo === "editar"} placeholder="caro@neko.local" />
            </div>
          </div>

          {modo === "nuevo" && (
            <div className="field">
              <label>Password inicial (solo si el email no existe ya en PASE)</label>
              <input type="text" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Si el email ya tiene cuenta PASE, dejá vacío — se reusa su password" />
              <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4 }}>
                El user va a usar este password para loguear EN COMANDA y EN PASE (auth compartido).
              </div>
            </div>
          )}

          <div className="form2">
            <div className="field">
              <label>Rol POS</label>
              <select value={rolPos} onChange={e => setRolPos(e.target.value as RolPos)}>
                {(["mozo","cajero","manager","admin"] as RolPos[]).map(r => (
                  <option key={r} value={r}>{ROL_LABEL[r]}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>PIN POS (opcional, 4-6 dígitos)</label>
              <input value={pinPos} onChange={e => setPinPos(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="1234" inputMode="numeric" />
            </div>
          </div>

          <div className="field">
            <label>Locales asignados</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={localesSel === null}
                  onChange={e => setLocalesSel(e.target.checked ? null : [])} />
                Todos los locales
              </label>
              {localesSel !== null && locales.map(l => (
                <label key={l.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <input type="checkbox" checked={localesSel.includes(l.id)}
                    onChange={e => {
                      const next = new Set(localesSel);
                      if (e.target.checked) next.add(l.id); else next.delete(l.id);
                      setLocalesSel(Array.from(next));
                    }} />
                  {l.nombre}
                </label>
              ))}
            </div>
          </div>

          {modo === "editar" && (
            <div className="field">
              <label>Estado</label>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={activo} onChange={e => setActivo(e.target.checked)} />
                Usuario activo
              </label>
            </div>
          )}

          <div className="field">
            <label>Permisos POS</label>
            {adminBypass ? (
              <div style={{ fontSize: 11, color: "var(--muted2)", padding: "10px 12px", background: "var(--s2)", borderRadius: 6 }}>
                💡 El rol "Admin POS" tiene <strong>acceso total</strong> a todas las features de COMANDA. No se asignan permisos individuales.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {categorias.map(([cat, perms]) => (
                  <div key={cat}>
                    <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)", marginBottom: 4 }}>{cat}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {perms.map(p => (
                        <label key={p.slug} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, cursor: "pointer" }}>
                          <input type="checkbox" checked={permisosSel.has(p.slug)} onChange={() => toggle(p.slug)} />
                          <span>{p.descripcion}</span>
                          <code style={{ fontSize: 9, color: "var(--muted2)", marginLeft: "auto" }}>{p.slug}</code>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="modal-ft">
          <button className="btn btn-sec" onClick={onClose} disabled={saving}>Cancelar</button>
          <button className="btn btn-acc" onClick={guardar} disabled={saving || !nombre.trim() || !email.trim()}>
            {saving ? "Guardando..." : modo === "nuevo" ? "Crear" : "Guardar cambios"}
          </button>
        </div>
      </div>
    </div>
  );
}
