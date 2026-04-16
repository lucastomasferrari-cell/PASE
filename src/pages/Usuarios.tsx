import { useState, useEffect, useRef } from "react";
import { db } from "../lib/supabase";
import { ROLES, MODULOS } from "../lib/auth";

async function sha256(text: string) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default function Usuarios({ user, locales }) {
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | "new" | user object (edit)
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [showPw, setShowPw] = useState(false);

  const emptyForm = { nombre:"", email:"", password:"", activo:true, modulos:[] as string[], locales_ids:[] as number[] };
  const [form, setForm] = useState(emptyForm);

  const load = async () => {
    setLoading(true);
    const [{ data: users }, { data: allPerms }, { data: allLocs }] = await Promise.all([
      db.from("usuarios").select("*").order("nombre"),
      db.from("usuario_permisos").select("usuario_id, modulo_slug"),
      db.from("usuario_locales").select("usuario_id, local_id"),
    ]);
    const enriched = (users || []).map(u => ({
      ...u,
      _permisos: (allPerms || []).filter(p => p.usuario_id === u.id).map(p => p.modulo_slug),
      _locales: (allLocs || []).filter(l => l.usuario_id === u.id).map(l => Number(l.local_id)),
    }));
    setUsuarios(enriched);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const abrirNuevo = () => { setForm(emptyForm); setModal("new"); setErr(""); setShowPw(false); };

  const abrirEditar = async (u) => {
    // Cargar locales frescos del usuario desde DB
    const { data: userLocs } = await db.from("usuario_locales").select("local_id").eq("usuario_id", u.id);
    const lids = (userLocs || []).map(l => Number(l.local_id));
    // Fallback al campo viejo si no hay rows en usuario_locales
    const finalLocs = lids.length > 0 ? lids : (u.locales || []).map(Number);

    setForm({
      nombre: u.nombre, email: u.email, password: "",
      activo: u.activo !== false,
      modulos: u._permisos || [],
      locales_ids: finalLocs,
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

  const guardando = useRef(false);
  const guardar = async () => {
    if (!form.nombre || !form.email) return;
    if (modal === "new" && !form.password) return;
    if (guardando.current) return;
    guardando.current = true;
    setSaving(true); setErr("");
    try {
      let userId: number | null = null;

      if (modal === "new") {
        const r = await fetch("/api/auth-admin", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action:"create", nombre:form.nombre, usuario:form.email, password:form.password, rol:"encargado", locales:form.locales_ids }),
        });
        const d = await r.json();
        if (!d.ok) { setErr(d.error || "Error creando usuario"); setSaving(false); return; }
        const { data: newU } = await db.from("usuarios").select("id").eq("email", form.email).single();
        userId = newU?.id ?? null;
        if (userId) await db.from("usuarios").update({ activo:form.activo }).eq("id", userId);
      } else {
        userId = modal.id;
        await db.from("usuarios").update({ nombre:form.nombre, activo:form.activo, locales:form.locales_ids }).eq("id", userId);
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
            } catch (authErr: any) {
              console.warn("Error llamando auth-admin:", authErr.message);
              setErr("Contraseña actualizada localmente. Error de red al sincronizar con Supabase Auth.");
            }
          }
          // auth_id null: no hay user en Supabase Auth, solo funciona SHA-256
        }
      }

      if (!userId) { setErr("No se pudo obtener el ID del usuario"); setSaving(false); return; }

      // Save permisos (delete + re-insert)
      // Dueno tiene todos implícitos, no necesita rows. Otros roles sí.
      const userRol = modal === "new" ? "encargado" : (modal.rol || "encargado");
      await db.from("usuario_permisos").delete().eq("usuario_id", userId);
      if (userRol !== "dueno" && form.modulos.length) {
        const { error: permErr } = await db.from("usuario_permisos").insert(
          form.modulos.map(slug => ({ usuario_id: userId as number, modulo_slug: slug }))
        );
        if (permErr) console.error("Error guardando permisos:", permErr.message);
      }

      // Save locales en usuario_locales (delete + re-insert)
      await db.from("usuario_locales").delete().eq("usuario_id", userId);
      if (form.locales_ids.length > 0) {
        const rows = form.locales_ids.map(lid => ({
          usuario_id: userId as number,
          local_id: Number(lid),
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

      setModal(null); load();
    } catch (e: any) { setErr(e.message); }
    setSaving(false);
    guardando.current = false;
  };

  const toggleActivo = async (u) => {
    await db.from("usuarios").update({ activo: u.activo === false }).eq("id", u.id);
    load();
  };

  const rc = (rol) => ROLES[rol]?.color || "#666";

  // Mostrar locales para un usuario: primero _locales (nuevo), fallback a locales (viejo)
  const getUserLocaleNames = (u) => {
    const ids = (u._locales?.length ? u._locales : (u.locales || [])).map(Number);
    if (!ids.length) return "—";
    return ids.map(lid => locales.find(l => l.id === lid)?.nombre).filter(Boolean).join(", ") || "—";
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
                 (u._permisos || []).length ? <span>{u._permisos.length} módulos</span> : "—"}
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

              <div className="field"><label>Estado</label>
                <select value={form.activo ? "1" : "0"} onChange={e => setForm({ ...form, activo:e.target.value === "1" })}>
                  <option value="1">Activo</option><option value="0">Inactivo</option>
                </select></div>

              {/* Módulos */}
              {(() => {
                const modalRol = modal === "new" ? "encargado" : (modal.rol || "encargado");
                const isDueno = modalRol === "dueno";
                return (<>
                  <div style={{ marginTop:16, marginBottom:16 }}>
                    <label style={{ display:"block", fontSize:9, letterSpacing:"1.5px", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
                      Módulos habilitados
                    </label>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:4 }}>
                      {MODULOS.map(m => {
                        const checked = isDueno || form.modulos.includes(m.slug);
                        return (
                          <label key={m.slug} style={{ display:"flex", alignItems:"center", gap:6, fontSize:11,
                            color: isDueno ? "var(--muted)" : checked ? "var(--txt)" : "var(--muted2)",
                            cursor: isDueno ? "default" : "pointer", padding:"4px 6px",
                            background: checked ? "var(--s3)" : "transparent", borderRadius:"var(--r)" }}>
                            <input type="checkbox" checked={checked} disabled={isDueno}
                              onChange={() => !isDueno && toggleModulo(m.slug)} style={{ accentColor:"var(--acc)" }} />
                            <span>{m.icon}</span> {m.label}
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Locales — visible para admin y encargado */}
                  {!isDueno && (
                    <div style={{ marginTop:16 }}>
                      <label style={{ display:"block", fontSize:9, letterSpacing:"1.5px", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
                        Locales asignados
                      </label>
                      {locales.length === 0 ? <div className="empty" style={{padding:16}}>No hay locales cargados en el sistema</div> : (
                        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                          {locales.map(l => {
                            const checked = form.locales_ids.includes(Number(l.id));
                            return (
                              <label key={l.id} style={{ display:"flex", alignItems:"center", gap:6, fontSize:11,
                                color: checked ? "var(--txt)" : "var(--muted2)", cursor:"pointer",
                                padding:"6px 10px", background: checked ? "var(--s3)" : "var(--s2)",
                                borderRadius:"var(--r)", border:`1px solid ${checked ? "var(--acc)" : "var(--bd)"}` }}>
                                <input type="checkbox" checked={checked} onChange={() => toggleLocal(Number(l.id))} style={{ accentColor:"var(--acc)" }} />
                                {l.nombre}
                              </label>
                            );
                          })}
                        </div>
                      )}
                      {form.locales_ids.length === 0 && (
                        <div className="alert alert-warn" style={{ marginTop:8 }}>Sin locales asignados no podrá cargar novedades en RRHH</div>
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
