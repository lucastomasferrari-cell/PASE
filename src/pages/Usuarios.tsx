import { useState, useEffect } from "react";
import { db } from "../lib/supabase";
import { ROLES, MODULOS } from "../lib/auth";

export default function Usuarios({ user, locales }) {
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | "new" | user object (edit)
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [showPw, setShowPw] = useState(false);

  const emptyForm = { nombre:"", email:"", password:"", rol:"encargado", activo:true, modulos:[] as string[], locales_ids:[] as number[] };
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
      rol: u.rol || "encargado", activo: u.activo !== false,
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

  const guardar = async () => {
    if (!form.nombre || !form.email) return;
    if (modal === "new" && !form.password) return;
    setSaving(true); setErr("");
    try {
      let userId: number | null = null;

      if (modal === "new") {
        const r = await fetch("/api/auth-admin", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action:"create", nombre:form.nombre, usuario:form.email, password:form.password, rol:form.rol, locales:form.locales_ids }),
        });
        const d = await r.json();
        if (!d.ok) { setErr(d.error || "Error creando usuario"); setSaving(false); return; }
        const { data: newU } = await db.from("usuarios").select("id").eq("email", form.email).single();
        userId = newU?.id ?? null;
        if (userId) await db.from("usuarios").update({ activo:form.activo, rol:form.rol }).eq("id", userId);
      } else {
        userId = modal.id;
        await db.from("usuarios").update({ nombre:form.nombre, rol:form.rol, activo:form.activo, locales:form.locales_ids }).eq("id", userId);
        if (form.password && modal.auth_id) {
          const r = await fetch("/api/auth-admin", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action:"change_password", authId:modal.auth_id, password:form.password }),
          });
          const d = await r.json();
          if (!d.ok) { setErr(d.error); setSaving(false); return; }
        }
      }

      if (!userId) { setErr("No se pudo obtener el ID del usuario"); setSaving(false); return; }

      // Save permisos (delete + re-insert)
      if (form.rol !== "dueno") {
        await db.from("usuario_permisos").delete().eq("usuario_id", userId);
        if (form.modulos.length) {
          const { error: permErr } = await db.from("usuario_permisos").insert(
            form.modulos.map(slug => ({ usuario_id: userId as number, modulo_slug: slug }))
          );
          if (permErr) console.error("Error guardando permisos:", permErr.message);
        }
      } else {
        // Dueno: limpiar permisos individuales (tiene todos implícitos)
        await db.from("usuario_permisos").delete().eq("usuario_id", userId);
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
        <div><div className="ph-title">Usuarios</div><div className="ph-sub">Gestión de accesos, permisos y locales</div></div>
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

              <div className="form2">
                <div className="field"><label>Rol</label>
                  <select value={form.rol} onChange={e => setForm({ ...form, rol:e.target.value })}>
                    <option value="dueno">Dueño</option><option value="admin">Admin</option><option value="encargado">Encargado</option>
                  </select></div>
                <div className="field"><label>Estado</label>
                  <select value={form.activo ? "1" : "0"} onChange={e => setForm({ ...form, activo:e.target.value === "1" })}>
                    <option value="1">Activo</option><option value="0">Inactivo</option>
                  </select></div>
              </div>

              {/* Módulos */}
              <div style={{ marginTop:16, marginBottom:16 }}>
                <label style={{ display:"block", fontSize:9, letterSpacing:"1.5px", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
                  Módulos habilitados
                </label>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:4 }}>
                  {MODULOS.map(m => {
                    const checked = form.rol === "dueno" || form.modulos.includes(m.slug);
                    const disabled = form.rol === "dueno";
                    return (
                      <label key={m.slug} style={{ display:"flex", alignItems:"center", gap:6, fontSize:11,
                        color: disabled ? "var(--muted)" : checked ? "var(--txt)" : "var(--muted2)",
                        cursor: disabled ? "default" : "pointer", padding:"4px 6px",
                        background: checked ? "var(--s3)" : "transparent", borderRadius:"var(--r)" }}>
                        <input type="checkbox" checked={checked} disabled={disabled}
                          onChange={() => !disabled && toggleModulo(m.slug)} style={{ accentColor:"var(--acc)" }} />
                        <span>{m.icon}</span> {m.label}
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Locales — visible para admin y encargado */}
              {form.rol !== "dueno" && (
                <div style={{ marginTop:16 }}>
                  <label style={{ display:"block", fontSize:9, letterSpacing:"1.5px", textTransform:"uppercase", color:"var(--muted)", marginBottom:8 }}>
                    Locales asignados {form.rol === "encargado" && "(obligatorio para encargados)"}
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
                  {form.rol === "encargado" && form.locales_ids.length === 0 && (
                    <div className="alert alert-warn" style={{ marginTop:8 }}>Sin locales asignados no podrá cargar novedades en RRHH</div>
                  )}
                </div>
              )}
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
