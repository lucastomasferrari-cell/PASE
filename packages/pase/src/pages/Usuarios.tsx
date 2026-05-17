import { useState, useEffect, useRef } from "react";
import { db } from "../lib/supabase";
import { ROLES, MODULOS, PERMISOS_EXTRAS } from "../lib/auth";
import { useRealtimeTable } from "../lib/useRealtimeTable";
import { CUENTAS } from "../lib/constants";
import { PageHeader } from "../components/ui";
import type { Usuario, Local } from "../types";

interface UsuariosProps {
  user: Usuario;
  locales: Local[];
}

type ModalState = null | "new" | Usuario;

async function sha256(text: string) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default function Usuarios({ user, locales }: UsuariosProps) {
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null); // null | "new" | user object (edit)
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [showPw, setShowPw] = useState(false);

  // cuentas_all === true → user ve TODAS las cuentas (saldos y operar).
  // false → personalizado: cuentas_visibles para SALDOS, cuentas_operables
  // para CARGAR PAGOS. Son listas independientes desde el editor.
  // Sin "rol" explícito en el form — usamos `esDueno` boolean. El sistema
  // guarda rol="dueno" o rol="encargado" según ese toggle. Decisión Lucas
  // 2026-05-17: eliminar la noción de roles intermedios (admin/cajero/compras).
  // Cada user con permisos personalizados, o "dueño" con acceso total.
  const emptyForm = { nombre:"", email:"", password:"", activo:true, esDueno:false, modulos:[] as string[], locales_ids:[] as number[], cuentas_all:true, cuentas_visibles:[] as string[], cuentas_operables:[] as string[] };
  const [form, setForm] = useState(emptyForm);

  const load = async () => {
    setLoading(true);
    const [{ data: users }, { data: allPerms }, { data: allLocs }] = await Promise.all([
      db.from("usuarios").select("*").order("nombre"),
      db.from("usuario_permisos").select("usuario_id, modulo_slug"),
      db.from("usuario_locales").select("usuario_id, local_id"),
    ]);
    const enriched: Usuario[] = (users || []).map((u: Usuario) => ({
      ...u,
      _permisos: (allPerms || []).filter((p: { usuario_id: number }) => p.usuario_id === u.id).map((p: { modulo_slug: string }) => p.modulo_slug),
      _locales: (allLocs || []).filter((l: { usuario_id: number }) => l.usuario_id === u.id).map((l: { local_id: number }) => Number(l.local_id)),
    }));
    setUsuarios(enriched);
    setLoading(false);
  };
  // Patrón fetch-on-mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []);

  // Sprint Realtime: cambios remotos en usuarios o usuario_permisos del
  // mismo tenant disparan reload. Si otro admin agrega permisos a un
  // user, se ve sin F5.
  useRealtimeTable({ table: 'usuarios', onChange: () => load() });
  useRealtimeTable({ table: 'usuario_permisos', onChange: () => load() });
  useRealtimeTable({ table: 'usuario_locales', onChange: () => load() });

  const abrirNuevo = () => { setForm(emptyForm); setModal("new"); setErr(""); setShowPw(false); };

  const abrirEditar = async (u: Usuario) => {
    // Cargar locales frescos del usuario desde DB
    const { data: userLocs } = await db.from("usuario_locales").select("local_id").eq("usuario_id", u.id);
    const lids = (userLocs || []).map((l: { local_id: number }) => Number(l.local_id));
    // Fallback al campo viejo si no hay rows en usuario_locales
    const finalLocs = lids.length > 0 ? lids : (u.locales || []).map(Number);

    // esDueno: true si el rol guardado es 'dueno' o 'admin' o 'superadmin'.
    // Los 3 comparten el short-circuit "ve todo" en tienePermiso(). Para el
    // user, "Dueño/Admin" es una sola categoría — UI unificada.
    const esDueno = u.rol === "dueno" || u.rol === "admin" || u.rol === "superadmin";
    setForm({
      nombre: u.nombre, email: u.email, password: "",
      activo: u.activo !== false,
      esDueno,
      modulos: u._permisos || [],
      locales_ids: finalLocs,
      cuentas_all: (u.cuentas_visibles === null || u.cuentas_visibles === undefined)
                && (u.cuentas_operables === null || u.cuentas_operables === undefined),
      cuentas_visibles: Array.isArray(u.cuentas_visibles) ? u.cuentas_visibles : [],
      cuentas_operables: Array.isArray(u.cuentas_operables)
        ? u.cuentas_operables
        : (Array.isArray(u.cuentas_visibles) ? u.cuentas_visibles : []),
    });
    setModal(u); setErr(""); setShowPw(false);
  };

  const toggleModulo = (slug: string) => {
    setForm(f => ({ ...f, modulos: f.modulos.includes(slug) ? f.modulos.filter(m => m !== slug) : [...f.modulos, slug] }));
  };
  const toggleLocal = (lid: number) => {
    const numId = Number(lid);
    setForm(f => ({ ...f, locales_ids: f.locales_ids.includes(numId) ? f.locales_ids.filter(l => l !== numId) : [...f.locales_ids, numId] }));
  };
  const toggleCuenta = (c: string) => {
    setForm(f => ({ ...f, cuentas_visibles: f.cuentas_visibles.includes(c) ? f.cuentas_visibles.filter(x => x !== c) : [...f.cuentas_visibles, c] }));
  };
  const toggleCuentaOperable = (c: string) => {
    setForm(f => ({ ...f, cuentas_operables: f.cuentas_operables.includes(c) ? f.cuentas_operables.filter(x => x !== c) : [...f.cuentas_operables, c] }));
  };

  const guardando = useRef(false);
  const guardar = async () => {
    if (!form.nombre || !form.email) return;
    if (modal === "new" && !form.password) return;
    if (guardando.current) return;
    guardando.current = true;
    setSaving(true); setErr("");
    try {
      let userId: number | null = null;
      // tenant_id de la fila usuario_locales/usuario_permisos a insertar.
      // Las RLS _mt requieren tenant_id = auth_tenant_id() (o superadmin),
      // así que hay que pasarlo explícito en el payload.
      let targetTenantId: string | null = null;

      if (modal === "new") {
        // Decisión Lucas 2026-05-17: el rol se deriva del toggle "esDueno".
        // dueno = acceso total, encargado = matriz custom. Eliminados los
        // roles intermedios (admin/compras/cajero) de la UI.
        const rolNuevo = form.esDueno ? "dueno" : "encargado";
        const r = await fetch("/api/auth-admin", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action:"create", nombre:form.nombre, usuario:form.email, password:form.password, rol:rolNuevo, locales:form.locales_ids }),
        });
        const d = await r.json();
        if (!d.ok) { setErr(d.error || "Error creando usuario"); setSaving(false); return; }
        const { data: newU } = await db.from("usuarios").select("id, tenant_id").eq("email", form.email).single();
        userId = newU?.id ?? null;
        targetTenantId = newU?.tenant_id ?? user.tenant_id;
        if (userId) await db.from("usuarios").update({ activo:form.activo }).eq("id", userId);
      } else if (modal !== null) {
        userId = modal.id;
        targetTenantId = modal.tenant_id ?? user.tenant_id;
        // Si está editando su propio user, NO tocar locales ni activo —
        // solo permitir cambios de nombre y password. Esto previene que el
        // user logueado se deje sin acceso por error.
        const isEditingSelf = modal.id === user.id;
        const updatePayload: Record<string, unknown> = { nombre: form.nombre };
        if (!isEditingSelf) {
          updatePayload.activo = form.activo;
          updatePayload.locales = form.locales_ids;
          // Persistir el rol según el toggle. Si era superadmin, NO degradar
          // (cross-tenant es estructural — solo Lucas/Anthropic lo usa).
          if (modal.rol !== "superadmin") {
            updatePayload.rol = form.esDueno ? "dueno" : "encargado";
          }
        }
        await db.from("usuarios").update(updatePayload).eq("id", userId);
        if (form.password) {
          // Actualizar hash SHA-256 en tabla usuarios (usado por login fallback)
          const hash = await sha256(form.password);
          console.log("[Usuarios] UPDATE password:", { userId, hashPreview: hash.slice(0, 16) + "...", authId: modal.auth_id || "NULL" });
          const { error: pwErr } = await db.from("usuarios").update({ password: hash }).eq("id", userId);
          if (pwErr) console.error("[Usuarios] UPDATE password falló:", pwErr.message);
          else console.log("[Usuarios] UPDATE password OK para userId:", userId);
          // También actualizar en Supabase Auth si el usuario está migrado
          if (modal.auth_id) {
            try {
              const r = await fetch("/api/auth-admin", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action:"change_password", authId:modal.auth_id, password:form.password }),
              });
              const d = await r.json();
              if (!d.ok) {
                // No bloquear el guardado — la contraseña ya se actualizó en la tabla
                console.warn("Supabase Auth change_password falló:", d.error);
                setErr("Contraseña actualizada en sistema local pero falló en Supabase Auth — el usuario puede seguir usando la contraseña anterior vía Auth");
              }
            } catch (authErr) {
              console.warn("Error llamando auth-admin:", authErr instanceof Error ? authErr.message : String(authErr));
              setErr("Contraseña actualizada localmente. Error de red al sincronizar con Supabase Auth.");
            }
          }
          // auth_id null: no hay user en Supabase Auth, solo funciona SHA-256
        }
      }

      if (!userId) { setErr("No se pudo obtener el ID del usuario"); setSaving(false); return; }

      // SI ES EL PROPIO USER LOGUEADO: skip TODO lo que sea permisos/locales/cuentas.
      // El UI ya tiene los inputs disabled pero el backend reafirma la regla
      // por defense-in-depth (si alguien manipula el DOM o el form state).
      const editingSelf = modal !== "new" && modal !== null && modal.id === user.id;

      if (!editingSelf) {
        // Save permisos (delete + re-insert)
        // Dueño/admin/superadmin tienen todos implícitos, no necesitan rows.
        // 2026-05-17: usamos form.esDueno (no el rol viejo del modal).
        const userRol = form.esDueno ? "dueno" : "encargado";
        const { error: delPermErr } = await db.from("usuario_permisos").delete().eq("usuario_id", userId);
        if (delPermErr) {
          console.error("Error borrando permisos previos:", delPermErr.message);
          setErr("Error borrando permisos previos: " + delPermErr.message);
          setSaving(false);
          return;
        }
        if (userRol !== "dueno" && form.modulos.length) {
          const { error: permErr } = await db.from("usuario_permisos").insert(
            form.modulos.map(slug => ({ usuario_id: userId as number, modulo_slug: slug, tenant_id: targetTenantId }))
          );
          // Bug crítico fixeado 2026-05-14: antes este error se logueaba y se
          // tragaba silenciosamente. Resultado: si RLS bloquea el INSERT (caso
          // user no-dueño antes del fix de migration 202605141500), el DELETE
          // previo ya borró todo y el user editado quedaba con 0 permisos.
          // Ahora paramos el flow y reportamos. Por defense-in-depth dejamos
          // este check aunque la RLS ya está alineada.
          if (permErr) {
            console.error("Error guardando permisos:", permErr.message);
            setErr("Error guardando permisos: " + permErr.message + " (Los permisos quedaron en blanco. Re-editar y reintentar.)");
            setSaving(false);
            return;
          }
        }

        // Save locales en usuario_locales (delete + re-insert)
        await db.from("usuario_locales").delete().eq("usuario_id", userId);
        if (form.locales_ids.length > 0) {
          const rows = form.locales_ids.map(lid => ({
            usuario_id: userId as number,
            local_id: Number(lid),
            tenant_id: targetTenantId,
          }));
          const { error: locErr } = await db.from("usuario_locales").insert(rows);
          if (locErr) {
            console.error("Error guardando locales:", locErr.message);
            setErr("Error guardando locales: " + locErr.message);
            setSaving(false);
            return;
          }
        }

        // Actualizar también campo viejo usuarios.locales para backward compat
        await db.from("usuarios").update({ locales: form.locales_ids }).eq("id", userId);

        // Cuentas: null = todas; array = personalizado. cuentas_visibles
        // controla saldos visibles; cuentas_operables controla los dropdowns
        // de pago (Compras, Remitos, RRHH, Caja, Gastos).
        const visiblesPayload = form.cuentas_all ? null : form.cuentas_visibles;
        const operablesPayload = form.cuentas_all ? null : form.cuentas_operables;
        await db.from("usuarios").update({
          cuentas_visibles: visiblesPayload,
          cuentas_operables: operablesPayload,
        }).eq("id", userId);
      }

      setModal(null); load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setSaving(false);
    guardando.current = false;
  };

  const toggleActivo = async (u: Usuario) => {
    // No permitir auto-desactivarse (queda sin acceso y solo otro admin/dueño
    // puede revertirlo).
    if (u.id === user.id) {
      alert("No podés cambiar tu propio estado. Pedile a otro dueño o admin que lo haga.");
      return;
    }
    await db.from("usuarios").update({ activo: u.activo === false }).eq("id", u.id);
    load();
  };

  const rc = (rol: string) => ROLES[rol]?.color || "#666";

  // Devuelve la lista de locales del usuario como array de nombres (para
  // renderizar como pills compactos en lugar de string concatenado, que en
  // mobile rompía cada local en 2 líneas — bug 2026-05-14).
  const getUserLocaleNamesArray = (u: Usuario): string[] => {
    const ids = (u._locales?.length ? u._locales : (u.locales || [])).map(Number);
    if (!ids.length) return [];
    return ids.map((lid: number) => locales.find((l: Local) => l.id === lid)?.nombre).filter(Boolean) as string[];
  };

  return (
    <div>
      <PageHeader
        title="Usuarios"
        info={<>
          Creá usuarios del equipo y asignales exactamente los permisos que querés que tengan. Sin roles predefinidos — vos decidís qué puede hacer cada uno (módulos, cuentas, sucursales).<br /><br />
          La única excepción es el toggle <strong>"Dueño/Admin"</strong> que da acceso total (atajo para cuando un usuario debe ver todo).
        </>}
        actions={<button className="btn btn-acc" onClick={abrirNuevo}>+ Nuevo usuario</button>}
      />

      <div className="panel">
        {loading ? <div className="loading">Cargando...</div> : (
          <div style={{overflowX:"auto"}}>
          <table>
            <thead><tr>
              <th>Nombre</th>
              <th>Sucursales</th>
              <th>Acceso</th>
              <th style={{ width: 90 }}>Estado</th>
              <th style={{ width: 60 }}></th>
            </tr></thead>
            <tbody>{usuarios.map(u => {
              const esDueno = u.rol === "dueno" || u.rol === "admin" || u.rol === "superadmin";
              const nombres = esDueno ? null : getUserLocaleNamesArray(u);
              const cantPermisos = (u._permisos || []).length;
              return (
                <tr key={u.id} style={{ opacity: u.activo === false ? 0.5 : 1 }}>
                  <td style={{ padding: "12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: "50%",
                        background: "var(--pase-celeste-100)",
                        border: "0.5px solid var(--pase-celeste-300)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: "var(--pase-celeste)", fontSize: "var(--pase-fs-sm)", fontWeight: 500,
                        flexShrink: 0,
                      }}>
                        {(u.nombre || "?")[0]!.toUpperCase()}
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 500, color: "var(--pase-text)", fontSize: "var(--pase-fs-base)" }}>
                          {u.nombre}
                        </div>
                        <div style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-xs)", letterSpacing: 0 }}>
                          {u.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={{ color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)" }}>
                    {esDueno
                      ? <span style={{ color: "var(--pase-text-muted)" }}>Todas</span>
                      : !nombres || nombres.length === 0
                        ? <span style={{ color: "var(--pase-text-muted)", fontStyle: "italic" }}>—</span>
                        : <span>{nombres.join(", ")}</span>
                    }
                  </td>
                  <td style={{ fontSize: "var(--pase-fs-sm)" }}>
                    {esDueno ? (
                      <span style={{ color: "var(--pase-celeste)", fontWeight: 500 }}>Dueño/Admin</span>
                    ) : cantPermisos === 0 ? (
                      <span style={{ color: "var(--pase-text-muted)", fontStyle: "italic" }}>Sin permisos</span>
                    ) : (
                      <span style={{ color: "var(--pase-text-muted)" }}>{cantPermisos} módulos</span>
                    )}
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => toggleActivo(u)}
                      title={`Click para ${u.activo !== false ? "desactivar" : "activar"}`}
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 6,
                        background: "transparent", border: "none", cursor: "pointer",
                        padding: "4px 0",
                        color: u.activo !== false ? "var(--pase-celeste)" : "var(--pase-text-muted)",
                        fontFamily: "var(--pase-font)",
                        fontSize: "var(--pase-fs-sm)",
                        fontWeight: 500,
                      }}
                    >
                      <span style={{
                        width: 7, height: 7, borderRadius: "50%",
                        background: u.activo !== false ? "var(--pase-celeste)" : "var(--pase-text-muted)",
                        flexShrink: 0,
                      }} />
                      {u.activo !== false ? "Activo" : "Inactivo"}
                    </button>
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => abrirEditar(u)} style={{ fontSize: "var(--pase-fs-sm)" }}>
                      Editar
                    </button>
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
          </div>
        )}
      </div>

      {modal && (
        <div className="overlay" onClick={() => setModal(null)}>
          <div className="modal" style={{ width:780 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: "50%",
                  background: "var(--pase-celeste-100)",
                  border: "0.5px solid var(--pase-celeste-300)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "var(--pase-fs-md)", fontWeight: 500,
                  color: "var(--pase-celeste)", flexShrink: 0,
                }}>
                  {form.nombre ? form.nombre[0]!.toUpperCase() : "+"}
                </div>
                <div>
                  <div className="modal-title" style={{ marginBottom: 0 }}>
                    {modal === "new" ? "Nuevo usuario" : form.nombre || "Editar usuario"}
                  </div>
                  {modal !== "new" && form.email && (
                    <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: 2 }}>
                      {form.email}
                    </div>
                  )}
                </div>
              </div>
              <button className="close-btn" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              {err && <div className="alert alert-danger">{err}</div>}

              {/* ─── Datos básicos ────────────────────────────────────── */}
              <SectionTitle>Datos básicos</SectionTitle>
              <div className="form2">
                <div className="field"><label>Nombre completo</label>
                  <input value={form.nombre} onChange={e => setForm({ ...form, nombre:e.target.value })} /></div>
                <div className="field"><label>Email / Usuario</label>
                  <input value={form.email} onChange={e => setForm({ ...form, email:e.target.value })}
                    disabled={modal !== "new"} placeholder="nombre (se agrega @pase.local)" /></div>
              </div>

              <div className="form2">
                <div className="field"><label>{modal === "new" ? "Contraseña *" : "Nueva contraseña (opcional)"}</label>
                  <div style={{ position:"relative" }}>
                    <input type={showPw ? "text" : "password"} autoComplete="new-password"
                      value={form.password} onChange={e => setForm({ ...form, password:e.target.value })}
                      placeholder={modal === "new" ? "Obligatorio" : "Dejar vacío para no cambiar"}
                      style={{ paddingRight: 36 }}
                    />
                    <button type="button" onClick={() => setShowPw(!showPw)}
                      style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:"var(--pase-text-muted)", cursor:"pointer", fontSize:14 }}>
                      {showPw ? "🙈" : "👁"}
                    </button>
                  </div>
                </div>
                <div className="field"><label>Estado{modal !== "new" && modal !== null && modal.id === user.id && <span style={{ color: "var(--pase-text-muted)", marginLeft: 6, fontSize: "var(--pase-fs-xs)" }}>(bloqueado: edición propia)</span>}</label>
                  <select value={form.activo ? "1" : "0"}
                    disabled={modal !== "new" && modal !== null && modal.id === user.id}
                    onChange={e => setForm({ ...form, activo:e.target.value === "1" })}>
                    <option value="1">Activo</option><option value="0">Inactivo</option>
                  </select></div>
              </div>

              {/* Módulos */}
              {(() => {
                const isDueno = form.esDueno;
                // isSelf: el user logueado está editando su propia row. Bloqueamos
                // edición de permisos/módulos/permisos-avanzados para evitar
                // que se deje sin acceso por error (bug reportado 2026-05-13:
                // Lucas se editó a sí mismo, el form arrancó con módulos vacíos
                // — su rol los recibía implícitos del ROLES dict — y al guardar
                // se persistió un usuario_permisos vacío que sobreescribió los
                // implícitos del rol).
                const isSelf = modal !== "new" && modal !== null && modal.id === user.id;
                const lockPermisos = isDueno || isSelf;
                // Hardening 2026-05-14: solo dueño/admin/superadmin pueden
                // grantear el permiso 'usuarios' (defense-in-depth con el
                // trigger SQL _check_grant_permiso_usuarios). Otros permisos
                // sí los puede otorgar cualquiera con permiso 'usuarios'.
                const currentUserPuedeGrantUsuarios = user.rol === "dueno" || user.rol === "admin" || user.rol === "superadmin";
                return (<>
                  {isSelf && (
                    <div className="alert" style={{ marginTop: 12, marginBottom: 16, fontSize: "var(--pase-fs-sm)", lineHeight: 1.5 }}>
                      Estás editando tu propio usuario. Por seguridad no podés modificar tus módulos, permisos, cuentas, locales ni el estado. Pedile a otro dueño/admin que los ajuste. Sí podés cambiar nombre o contraseña.
                    </div>
                  )}

                  {/* ─── Nivel de acceso ───────────────────────────────── */}
                  <SectionTitle locked={isSelf}>Nivel de acceso</SectionTitle>
                  <label
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 12,
                      padding: "14px 16px", borderRadius: 10,
                      border: `0.5px solid ${form.esDueno ? "var(--pase-celeste-300)" : "var(--pase-border-strong)"}`,
                      background: form.esDueno ? "var(--pase-celeste-100)" : "var(--pase-bg)",
                      cursor: isSelf ? "default" : "pointer",
                      opacity: isSelf ? 0.6 : 1,
                      marginBottom: 4,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={form.esDueno}
                      disabled={isSelf || !currentUserPuedeGrantUsuarios}
                      onChange={e => setForm(f => ({ ...f, esDueno: e.target.checked }))}
                      style={{ accentColor: "var(--pase-celeste)", width: 18, height: 18, marginTop: 2, flexShrink: 0 }}
                    />
                    <div>
                      <div style={{ fontSize: "var(--pase-fs-base)", fontWeight: 500, color: "var(--pase-text)" }}>
                        Dueño / Admin <span style={{ color: "var(--pase-text-muted)", fontWeight: 400, fontSize: "var(--pase-fs-sm)" }}>· acceso total</span>
                      </div>
                      <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text-muted)", marginTop: 4, lineHeight: 1.5 }}>
                        Ve todos los módulos, todas las cuentas, todas las sucursales. Puede crear y editar usuarios.<br />
                        Si NO está marcado, abajo elegís manualmente los módulos y permisos que querés que tenga.
                        {!currentUserPuedeGrantUsuarios && (
                          <><br /><span style={{ color: "#D97706", fontStyle: "italic" }}>Solo un dueño/admin existente puede otorgar este nivel.</span></>
                        )}
                      </div>
                    </div>
                  </label>

                  {/* ─── Módulos ───────────────────────────────────────── */}
                  <SectionTitle locked={isSelf || form.esDueno}>
                    Módulos habilitados {form.esDueno && <span style={{ textTransform: "none", letterSpacing: 0, fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", fontWeight: 400, marginLeft: 6 }}>(todos por ser dueño/admin)</span>}
                  </SectionTitle>
                  <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(180px, 1fr))", gap:8, marginBottom: 20 }}>
                    {MODULOS.map(m => {
                      const checked = isDueno || form.modulos.includes(m.slug);
                      const blockedSelfGrant = m.slug === "usuarios" && !currentUserPuedeGrantUsuarios;
                      const finalLocked = lockPermisos || blockedSelfGrant;
                      return (
                        <PermisoCheck
                          key={m.slug}
                          checked={checked}
                          disabled={finalLocked}
                          onChange={() => !finalLocked && toggleModulo(m.slug)}
                          label={`${m.icon} ${m.label}`}
                          title={blockedSelfGrant ? "Solo dueño/admin puede otorgar este permiso" : undefined}
                        />
                      );
                    })}
                  </div>

                  {/* ─── Permisos avanzados ────────────────────────────── */}
                  <SectionTitle locked={isSelf}>Permisos avanzados</SectionTitle>
                  <div style={{ display:"flex", flexDirection:"column", gap:6, marginBottom: 20 }}>
                    {PERMISOS_EXTRAS.map(p => {
                      const checked = isDueno || form.modulos.includes(p.slug);
                      return (
                        <PermisoCheck
                          key={p.slug}
                          checked={checked}
                          disabled={lockPermisos}
                          onChange={() => !lockPermisos && toggleModulo(p.slug)}
                          label={p.label}
                          description={p.descripcion}
                        />
                      );
                    })}
                  </div>

                  {/* ─── Cuentas de Tesorería ──────────────────────────── */}
                  {!isDueno && (
                    <>
                      <SectionTitle locked={isSelf}>Cuentas de Tesorería</SectionTitle>
                      <div style={{ display:"flex", gap:8, marginBottom: 12 }}>
                        <label style={{ flex: 1, display:"flex", alignItems:"center", gap:8, padding:"10px 12px", border: `0.5px solid ${form.cuentas_all ? "var(--pase-celeste)" : "var(--pase-border)"}`, borderRadius: 8, cursor: isSelf ? "default" : "pointer", background: form.cuentas_all ? "var(--pase-celeste-100)" : "transparent", opacity: isSelf ? 0.6 : 1 }}>
                          <input type="radio" name="cuentas_scope" checked={form.cuentas_all} disabled={isSelf} onChange={() => !isSelf && setForm(f => ({ ...f, cuentas_all: true }))} style={{ accentColor:"var(--pase-celeste)" }} />
                          <div>
                            <div style={{ fontSize: "var(--pase-fs-base)", fontWeight: 500, color: "var(--pase-text)" }}>Todas las cuentas</div>
                            <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>Acceso total a Tesorería</div>
                          </div>
                        </label>
                        <label style={{ flex: 1, display:"flex", alignItems:"center", gap:8, padding:"10px 12px", border: `0.5px solid ${!form.cuentas_all ? "var(--pase-celeste)" : "var(--pase-border)"}`, borderRadius: 8, cursor: isSelf ? "default" : "pointer", background: !form.cuentas_all ? "var(--pase-celeste-100)" : "transparent", opacity: isSelf ? 0.6 : 1 }}>
                          <input type="radio" name="cuentas_scope" checked={!form.cuentas_all} disabled={isSelf} onChange={() => !isSelf && setForm(f => ({ ...f, cuentas_all: false }))} style={{ accentColor:"var(--pase-celeste)" }} />
                          <div>
                            <div style={{ fontSize: "var(--pase-fs-base)", fontWeight: 500, color: "var(--pase-text)" }}>Personalizado</div>
                            <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)" }}>Elegí cuentas exactas</div>
                          </div>
                        </label>
                      </div>
                      {!form.cuentas_all && (
                        <>
                          <SubTitle>
                            Cuentas para ver saldo
                            <Hint> · el usuario verá las cards de saldo consolidado de estas cuentas</Hint>
                          </SubTitle>
                          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom: 14 }}>
                            {CUENTAS.map(c => (
                              <PermisoChip key={`vs-${c}`} checked={form.cuentas_visibles.includes(c)} disabled={isSelf} onChange={() => !isSelf && toggleCuenta(c)} label={c} />
                            ))}
                          </div>
                          <SubTitle>
                            Cuentas para operar
                            <Hint> · cargar pagos/gastos/transferencias/adelantos contra estas cuentas</Hint>
                          </SubTitle>
                          <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom: 4 }}>
                            {CUENTAS.map(c => (
                              <PermisoChip key={`op-${c}`} checked={form.cuentas_operables.includes(c)} disabled={isSelf} onChange={() => !isSelf && toggleCuentaOperable(c)} label={c} />
                            ))}
                          </div>
                          {form.cuentas_visibles.length === 0 && form.cuentas_operables.length === 0 && !isSelf && (
                            <div className="alert alert-warn" style={{ marginTop:10 }}>Sin cuentas marcadas, el usuario no podrá usar Tesorería</div>
                          )}
                        </>
                      )}
                    </>
                  )}

                  {/* ─── Sucursales ────────────────────────────────────── */}
                  {!isDueno && (
                    <div style={{ marginTop: 20 }}>
                      <SectionTitle locked={isSelf}>Sucursales asignadas</SectionTitle>
                      {locales.length === 0 ? (
                        <div style={{ padding: 16, textAlign: "center", color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-sm)", border: "0.5px dashed var(--pase-border)", borderRadius: 8 }}>
                          No hay sucursales cargadas todavía
                        </div>
                      ) : (
                        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                          {locales.map(l => (
                            <PermisoChip key={l.id} checked={form.locales_ids.includes(Number(l.id))} disabled={isSelf} onChange={() => !isSelf && toggleLocal(Number(l.id))} label={l.nombre} />
                          ))}
                        </div>
                      )}
                      {form.locales_ids.length === 0 && !isSelf && locales.length > 0 && (
                        <div className="alert alert-warn" style={{ marginTop:10 }}>Sin sucursales asignadas no podrá cargar novedades en Equipo</div>
                      )}
                    </div>
                  )}
                </>);
              })()}
            </div>
            <div className="modal-ft">
              <button className="btn btn-sec" onClick={() => setModal(null)}>Cancelar</button>
              <button className="btn btn-acc" onClick={guardar} disabled={saving}>{saving ? "Guardando..." : "Guardar"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Componentes auxiliares del modal Editar Usuario ────────────────────
// Diseñados 2026-05-17 para reemplazar los checkboxes nativos + vars legacy
// (--s2/--s3/--acc) por un look unificado con tokens PASE.

function SectionTitle({ children, locked }: { children: React.ReactNode; locked?: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "baseline", justifyContent: "space-between",
      fontSize: "var(--pase-fs-xs)", fontWeight: 500,
      color: "var(--pase-text-muted)",
      textTransform: "uppercase", letterSpacing: "var(--pase-ls-overline)",
      marginBottom: 10, marginTop: 18,
      paddingBottom: 6, borderBottom: "0.5px solid var(--pase-border)",
    }}>
      <span>{children}</span>
      {locked && <span style={{ textTransform: "none", letterSpacing: 0, fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", fontWeight: 400 }}>🔒 edición propia</span>}
    </div>
  );
}

function SubTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: "var(--pase-fs-sm)", color: "var(--pase-text)", fontWeight: 500, marginTop: 12, marginBottom: 6 }}>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span style={{ fontWeight: 400, color: "var(--pase-text-muted)", fontSize: "var(--pase-fs-xs)" }}>{children}</span>;
}

// Card-style checkbox para módulos y permisos.
interface PermisoCheckProps {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: React.ReactNode;
  description?: string;
  title?: string;
}

function PermisoCheck({ checked, disabled, onChange, label, description, title }: PermisoCheckProps) {
  return (
    <label
      title={title}
      style={{
        display: "flex", alignItems: description ? "flex-start" : "center", gap: 10,
        padding: "9px 11px", borderRadius: 8,
        border: `0.5px solid ${checked ? "var(--pase-celeste-300)" : "var(--pase-border)"}`,
        background: checked ? "var(--pase-celeste-100)" : "transparent",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        transition: "all 0.12s",
        fontSize: "var(--pase-fs-base)",
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        style={{ accentColor: "var(--pase-celeste)", marginTop: description ? 2 : 0, width: 15, height: 15, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "var(--pase-text)", fontWeight: 500 }}>{label}</div>
        {description && (
          <div style={{ fontSize: "var(--pase-fs-xs)", color: "var(--pase-text-muted)", marginTop: 3, lineHeight: 1.45 }}>{description}</div>
        )}
      </div>
    </label>
  );
}

// Chip estilo pill para cuentas y sucursales.
interface PermisoChipProps {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: React.ReactNode;
}

function PermisoChip({ checked, disabled, onChange, label }: PermisoChipProps) {
  return (
    <label
      style={{
        display: "inline-flex", alignItems: "center", gap: 7,
        padding: "7px 12px", borderRadius: 999,
        border: `0.5px solid ${checked ? "var(--pase-celeste-300)" : "var(--pase-border-strong)"}`,
        background: checked ? "var(--pase-celeste-100)" : "var(--pase-bg)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        transition: "all 0.12s",
        fontSize: "var(--pase-fs-sm)",
        color: checked ? "var(--pase-text)" : "var(--pase-text-muted)",
        fontWeight: 500,
      }}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} style={{ accentColor: "var(--pase-celeste)", width: 14, height: 14 }} />
      {label}
    </label>
  );
}