import { useState, useEffect, useRef } from "react";
import { db } from "../lib/supabase";
import { ROLES, MODULOS, PERMISOS_EXTRAS } from "../lib/auth";
import { useRealtimeTable } from "../lib/useRealtimeTable";
import { CUENTAS } from "../lib/constants";
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
  const emptyForm = { nombre:"", email:"", password:"", activo:true, modulos:[] as string[], locales_ids:[] as number[], cuentas_all:true, cuentas_visibles:[] as string[], cuentas_operables:[] as string[] };
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

    setForm({
      nombre: u.nombre, email: u.email, password: "",
      activo: u.activo !== false,
      modulos: u._permisos || [],
      locales_ids: finalLocs,
      // cuentas_all reflejaba "ambas listas son NULL". Si visibles es NULL,
      // operables también lo es por convención. Si una de las dos es array,
      // pasamos a modo personalizado.
      cuentas_all: (u.cuentas_visibles === null || u.cuentas_visibles === undefined)
                && (u.cuentas_operables === null || u.cuentas_operables === undefined),
      cuentas_visibles: Array.isArray(u.cuentas_visibles) ? u.cuentas_visibles : [],
      // Fallback: si la migration aún no corrió y cuentas_operables viene
      // undefined, mostrarmos lo mismo que cuentas_visibles para que la UI
      // refleje el estado real (al guardar se persiste explícitamente).
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
        const r = await fetch("/api/auth-admin", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action:"create", nombre:form.nombre, usuario:form.email, password:form.password, rol:"encargado", locales:form.locales_ids }),
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
        // Dueno tiene todos implícitos, no necesita rows. Otros roles sí.
        const userRol = modal === "new" || modal === null ? "encargado" : (modal.rol || "encargado");
        await db.from("usuario_permisos").delete().eq("usuario_id", userId);
        if (userRol !== "dueno" && form.modulos.length) {
          const { error: permErr } = await db.from("usuario_permisos").insert(
            form.modulos.map(slug => ({ usuario_id: userId as number, modulo_slug: slug, tenant_id: targetTenantId }))
          );
          if (permErr) console.error("Error guardando permisos:", permErr.message);
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

  // Mostrar locales para un usuario: primero _locales (nuevo), fallback a locales (viejo)
  const getUserLocaleNames = (u: Usuario) => {
    const ids = (u._locales?.length ? u._locales : (u.locales || [])).map(Number);
    if (!ids.length) return "—";
    return ids.map((lid: number) => locales.find((l: Local) => l.id === lid)?.nombre).filter(Boolean).join(", ") || "—";
  };

  return (
    <div>
      <div className="ph-row">
        <div><div className="ph-title">Usuarios</div></div>
        <button className="btn btn-acc" onClick={abrirNuevo}>+ Nuevo usuario</button>
      </div>

      <div className="panel">
        {loading ? <div className="loading">Cargando...</div> : (
          <div style={{overflowX:"auto"}}>
          <table><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Locales</th><th>Módulos</th><th>Activo</th><th></th></tr></thead>
          <tbody>{usuarios.map(u => (
            <tr key={u.id} style={{ opacity: u.activo === false ? 0.4 : 1 }}>
              <td style={{ fontWeight: 500 }}>{u.nombre}</td>
              <td className="mono" style={{ color:"var(--muted2)", fontSize:11 }}>{u.email}</td>
              <td><span className="badge" style={{ background:rc(u.rol)+"22", color:rc(u.rol) }}>{ROLES[u.rol]?.label || u.rol}</span></td>
              <td style={{ fontSize:10 }}>
                {u.rol === "dueno" ? <span style={{ color:"var(--muted)" }}>Todos</span> : getUserLocaleNames(u)}
              </td>
              <td style={{ fontSize:10 }}>
                {u.rol === "dueno" ? <span style={{ color:"var(--muted)" }}>Todos</span> :
                 (u._permisos || []).length ? <span>{u._permisos!.length} módulos</span> : "—"}
              </td>
              <td>
                <span className={`badge ${u.activo !== false ? "b-success" : "b-muted"}`}
                  style={{ cursor:"pointer" }} onClick={() => toggleActivo(u)}>
                  {u.activo !== false ? "Activo" : "Inactivo"}
                </span>
              </td>
              <td><button className="btn btn-ghost btn-sm" onClick={() => abrirEditar(u)}>Editar</button></td>
            </tr>
          ))}</tbody></table>
          </div>
        )}
      </div>

      {modal && (
        <div className="overlay" onClick={() => setModal(null)}>
          <div className="modal" style={{ width:700 }} onClick={e => e.stopPropagation()}>
            <div className="modal-hd">
              <div className="modal-title">{modal === "new" ? "Nuevo Usuario" : "Editar Usuario"}</div>
              <button className="close-btn" onClick={() => setModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              {err && <div className="alert alert-danger">{err}</div>}

              <div className="form2">
                <div className="field"><label>Nombre completo</label>
                  <input value={form.nombre} onChange={e => setForm({ ...form, nombre:e.target.value })} /></div>
                <div className="field"><label>Email / Usuario</label>
                  <input value={form.email} onChange={e => setForm({ ...form, email:e.target.value })}
                    disabled={modal !== "new"} placeholder="nombre (se agrega @pase.local)" /></div>
              </div>

              <div className="field"><label>{modal === "new" ? "Contraseña *" : "Nueva contraseña (dejar vacío para no cambiar)"}</label>
                <div style={{ position:"relative" }}>
                  <input type={showPw ? "text" : "password"} autoComplete="new-password"
                    value={form.password} onChange={e => setForm({ ...form, password:e.target.value })}
                    placeholder={modal === "new" ? "Obligatorio" : "Opcional"} />
                  <button type="button" onClick={() => setShowPw(!showPw)}
                    style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:"var(--muted2)", cursor:"pointer", fontSize:14 }}>
                    {showPw ? "🙈" : "👁"}
                  </button>
                </div>
              </div>

              <div className="field"><label>Estado{modal !== "new" && modal !== null && modal.id === user.id && <span style={{ color: "var(--pase-text-muted)", textTransform: "none", letterSpacing: 0, marginLeft: 6, fontSize: 10 }}>(bloqueado: edición propia)</span>}</label>
                <select value={form.activo ? "1" : "0"}
                  disabled={modal !== "new" && modal !== null && modal.id === user.id}
                  onChange={e => setForm({ ...form, activo:e.target.value === "1" })}>
                  <option value="1">Activo</option><option value="0">Inactivo</option>
                </select></div>

              {/* Módulos */}
              {(() => {
                const modalRol = modal === "new" || modal === null ? "encargado" : (modal.rol || "encargado");
                const isDueno = modalRol === "dueno";
                // isSelf: el user logueado está editando su propia row. Bloqueamos
                // edición de permisos/módulos/permisos-avanzados para evitar
                // que se deje sin acceso por error (bug reportado 2026-05-13:
                // Lucas se editó a sí mismo, el form arrancó con módulos vacíos
                // — su rol los recibía implícitos del ROLES dict — y al guardar
                // se persistió un usuario_permisos vacío que sobreescribió los
                // implícitos del rol).
                const isSelf = modal !== "new" && modal !== null && modal.id === user.id;
                const lockPermisos = isDueno || isSelf;
                return (<>
                  {isSelf && (
                    <div className="alert" style={{ marginTop: 12, marginBottom: 4, fontSize: 11.5, lineHeight: 1.5 }}>
                      Estás editando tu propio usuario. Por seguridad, no podés modificar tus módulos, permisos avanzados, cuentas, locales ni el estado activo. Pedile a otro dueño o admin que los ajuste si hace falta. Sí podés cambiar nombre o contraseña.
                    </div>
                  )}
                  <div style={{ marginTop:16, marginBottom:16 }}>
                    <label style={{ display:"block", fontSize:9, letterSpacing:"1.5px", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
                      Módulos habilitados {isSelf && <span style={{ color: "var(--pase-text-muted)", textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>(bloqueado: edición propia)</span>}
                    </label>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:4 }}>
                      {MODULOS.map(m => {
                        const checked = isDueno || form.modulos.includes(m.slug);
                        return (
                          <label key={m.slug} style={{ display:"flex", alignItems:"center", gap:6, fontSize:11,
                            color: lockPermisos ? "var(--muted)" : checked ? "var(--txt)" : "var(--muted2)",
                            cursor: lockPermisos ? "default" : "pointer", padding:"4px 6px",
                            background: checked ? "var(--s3)" : "transparent", borderRadius:"var(--r)",
                            opacity: lockPermisos ? 0.6 : 1 }}>
                            <input type="checkbox" checked={checked} disabled={lockPermisos}
                              onChange={() => !lockPermisos && toggleModulo(m.slug)} style={{ accentColor:"var(--acc)" }} />
                            <span>{m.icon}</span> {m.label}
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Permisos avanzados — flags granulares dentro de pantallas
                      ya habilitadas. No aparecen como módulos en sidebar. */}
                  <div style={{ marginTop:16, marginBottom:16 }}>
                    <label style={{ display:"block", fontSize:9, letterSpacing:"1.5px", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
                      Permisos avanzados {isSelf && <span style={{ color: "var(--pase-text-muted)", textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>(bloqueado: edición propia)</span>}
                    </label>
                    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                      {PERMISOS_EXTRAS.map(p => {
                        const checked = isDueno || form.modulos.includes(p.slug);
                        return (
                          <label key={p.slug} style={{ display:"flex", alignItems:"flex-start", gap:8, fontSize:11,
                            color: lockPermisos ? "var(--muted)" : checked ? "var(--txt)" : "var(--muted2)",
                            cursor: lockPermisos ? "default" : "pointer", padding:"6px 8px",
                            background: checked ? "var(--s3)" : "transparent", borderRadius:"var(--r)",
                            opacity: lockPermisos ? 0.6 : 1 }}>
                            <input type="checkbox" checked={checked} disabled={lockPermisos}
                              onChange={() => !lockPermisos && toggleModulo(p.slug)} style={{ accentColor:"var(--acc)", marginTop:2 }} />
                            <div>
                              <div style={{ fontWeight:500 }}>{p.label}</div>
                              <div style={{ fontSize:10, color:"var(--muted)", marginTop:2 }}>{p.descripcion}</div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Cuentas de Tesorería — visible para no-dueno.
                      Dos listas independientes: ver saldo vs operar. */}
                  {!isDueno && (
                    <div style={{ marginTop:16 }}>
                      <label style={{ display:"block", fontSize:9, letterSpacing:"1.5px", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
                        Cuentas de Tesorería {isSelf && <span style={{ color: "var(--pase-text-muted)", textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>(bloqueado: edición propia)</span>}
                      </label>
                      <div style={{ display:"flex", gap:16, marginBottom:8 }}>
                        <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:11, cursor: isSelf ? "default" : "pointer", opacity: isSelf ? 0.6 : 1 }}>
                          <input type="radio" name="cuentas_scope" checked={form.cuentas_all} disabled={isSelf}
                            onChange={() => !isSelf && setForm(f => ({ ...f, cuentas_all: true }))} style={{ accentColor:"var(--acc)" }} />
                          Todas las cuentas
                        </label>
                        <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:11, cursor: isSelf ? "default" : "pointer", opacity: isSelf ? 0.6 : 1 }}>
                          <input type="radio" name="cuentas_scope" checked={!form.cuentas_all} disabled={isSelf}
                            onChange={() => !isSelf && setForm(f => ({ ...f, cuentas_all: false }))} style={{ accentColor:"var(--acc)" }} />
                          Personalizado
                        </label>
                      </div>
                      {!form.cuentas_all && (
                        <>
                          <div style={{ fontSize:10, color:"var(--muted2)", marginBottom:6, marginTop:8 }}>
                            <strong style={{ color:"var(--txt)" }}>Cuentas para ver saldo</strong> — el usuario verá las cards con el saldo consolidado de estas cuentas.
                          </div>
                          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                            {CUENTAS.map(c => {
                              const checked = form.cuentas_visibles.includes(c);
                              return (
                                <label key={`vs-${c}`} style={{ display:"flex", alignItems:"center", gap:6, fontSize:11,
                                  color: checked ? "var(--txt)" : "var(--muted2)", cursor: isSelf ? "default" : "pointer",
                                  padding:"6px 10px", background: checked ? "var(--s3)" : "var(--s2)",
                                  borderRadius:"var(--r)", border:`1px solid ${checked ? "var(--acc)" : "var(--bd)"}`,
                                  opacity: isSelf ? 0.6 : 1 }}>
                                  <input type="checkbox" checked={checked} disabled={isSelf}
                                    onChange={() => !isSelf && toggleCuenta(c)} style={{ accentColor:"var(--acc)" }} />
                                  {c}
                                </label>
                              );
                            })}
                          </div>
                          <div style={{ fontSize:10, color:"var(--muted2)", marginTop:14, marginBottom:6 }}>
                            <strong style={{ color:"var(--txt)" }}>Cuentas para operar</strong> — el usuario podrá cargar pagos, gastos, transferencias y adelantos contra estas cuentas. Puede operar sin ver el saldo consolidado.
                          </div>
                          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                            {CUENTAS.map(c => {
                              const checked = form.cuentas_operables.includes(c);
                              return (
                                <label key={`op-${c}`} style={{ display:"flex", alignItems:"center", gap:6, fontSize:11,
                                  color: checked ? "var(--txt)" : "var(--muted2)", cursor: isSelf ? "default" : "pointer",
                                  padding:"6px 10px", background: checked ? "var(--s3)" : "var(--s2)",
                                  borderRadius:"var(--r)", border:`1px solid ${checked ? "var(--acc)" : "var(--bd)"}`,
                                  opacity: isSelf ? 0.6 : 1 }}>
                                  <input type="checkbox" checked={checked} disabled={isSelf}
                                    onChange={() => !isSelf && toggleCuentaOperable(c)} style={{ accentColor:"var(--acc)" }} />
                                  {c}
                                </label>
                              );
                            })}
                          </div>
                          {form.cuentas_visibles.length === 0 && form.cuentas_operables.length === 0 && !isSelf && (
                            <div className="alert alert-warn" style={{ marginTop:8 }}>Sin cuentas marcadas (ni saldo ni operar), el usuario no podrá usar Tesorería</div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Locales — visible para admin y encargado */}
                  {!isDueno && (
                    <div style={{ marginTop:16 }}>
                      <label style={{ display:"block", fontSize:9, letterSpacing:"1.5px", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
                        Sucursales asignadas {isSelf && <span style={{ color: "var(--pase-text-muted)", textTransform: "none", letterSpacing: 0, marginLeft: 6 }}>(bloqueado: edición propia)</span>}
                      </label>
                      {locales.length === 0 ? <div className="empty" style={{padding:16}}>No hay sucursales cargadas en el sistema</div> : (
                        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                          {locales.map(l => {
                            const checked = form.locales_ids.includes(Number(l.id));
                            return (
                              <label key={l.id} style={{ display:"flex", alignItems:"center", gap:6, fontSize:11,
                                color: checked ? "var(--txt)" : "var(--muted2)", cursor: isSelf ? "default" : "pointer",
                                padding:"6px 10px", background: checked ? "var(--s3)" : "var(--s2)",
                                borderRadius:"var(--r)", border:`1px solid ${checked ? "var(--acc)" : "var(--bd)"}`,
                                opacity: isSelf ? 0.6 : 1 }}>
                                <input type="checkbox" checked={checked} disabled={isSelf}
                                  onChange={() => !isSelf && toggleLocal(Number(l.id))} style={{ accentColor:"var(--acc)" }} />
                                {l.nombre}
                              </label>
                            );
                          })}
                        </div>
                      )}
                      {form.locales_ids.length === 0 && !isSelf && (
                        <div className="alert alert-warn" style={{ marginTop:8 }}>Sin sucursales asignadas no podrá cargar novedades en Equipo</div>
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