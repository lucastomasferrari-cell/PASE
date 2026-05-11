import { useState } from "react";
import { db } from "../lib/supabase";

interface OnboardingTenantProps {
  onClose: () => void;
  onCreated: (slug: string) => void;
}

interface FormPaso1 { nombre: string; slug: string; plan: string; trial_dias: number }
interface FormPaso2 { dueno_email: string; dueno_nombre: string; dueno_password: string; password_confirm: string }
interface FormPaso3 { local_nombre: string; local_direccion: string }

export default function OnboardingTenant({ onClose, onCreated }: OnboardingTenantProps) {
  const [paso, setPaso] = useState(1);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");

  const [paso1, setPaso1] = useState<FormPaso1>({ nombre: "", slug: "", plan: "trial", trial_dias: 14 });
  const [paso2, setPaso2] = useState<FormPaso2>({ dueno_email: "", dueno_nombre: "", dueno_password: "", password_confirm: "" });
  const [paso3, setPaso3] = useState<FormPaso3>({ local_nombre: "", local_direccion: "" });

  const slugFromNombre = (nombre: string) =>
    nombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const validarPaso1 = () => {
    if (!paso1.nombre.trim()) return "Falta nombre del tenant.";
    if (!paso1.slug.trim()) return "Falta slug.";
    if (!/^[a-z0-9-]+$/.test(paso1.slug)) return "Slug solo puede tener letras minúsculas, números y guiones.";
    return null;
  };
  const validarPaso2 = () => {
    if (!paso2.dueno_email.trim()) return "Falta email del dueño.";
    if (!paso2.dueno_nombre.trim()) return "Falta nombre del dueño.";
    if (paso2.dueno_password.length < 8) return "Password debe tener al menos 8 caracteres.";
    if (paso2.dueno_password !== paso2.password_confirm) return "Los passwords no coinciden.";
    return null;
  };
  const validarPaso3 = () => {
    if (!paso3.local_nombre.trim()) return "Falta nombre del primer local.";
    return null;
  };

  const next = () => {
    setErr("");
    let v: string | null = null;
    if (paso === 1) v = validarPaso1();
    else if (paso === 2) v = validarPaso2();
    else if (paso === 3) v = validarPaso3();
    if (v) { setErr(v); return; }
    setPaso(paso + 1);
  };
  const back = () => { setErr(""); setPaso(paso - 1); };

  const crear = async () => {
    if (creating) return;
    setCreating(true);
    setErr("");
    try {
      // Endpoint serverless que: valida superadmin → crea auth.user →
      // llama RPC crear_tenant_v2 con el auth_id → rollback si falla.
      // Sustituye la RPC vieja `crear_tenant` que crasheaba por
      // `digest(text, unknown) does not exist` y además guardaba password
      // en `usuarios.password` legacy (Supabase Auth ya no lo usa).
      const { data: { session } } = await db.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setErr("Sesión expirada. Volvé a loguear como superadmin.");
        return;
      }

      const resp = await fetch("/api/crear-tenant", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          nombre: paso1.nombre.trim(),
          slug: paso1.slug.trim(),
          plan: paso1.plan,
          dueno_email: paso2.dueno_email.trim(),
          dueno_nombre: paso2.dueno_nombre.trim(),
          dueno_password: paso2.dueno_password,
          local_nombre: paso3.local_nombre.trim(),
          local_direccion: paso3.local_direccion.trim() || null,
          trial_dias: paso1.trial_dias,
        }),
      });

      const data = await resp.json().catch(() => ({ ok: false, error: "RESPUESTA_INVALIDA" }));

      if (!resp.ok || !data?.ok) {
        const code = data?.error || "";
        if (code === "NOT_SUPERADMIN" || code === "CALLER_NOT_FOUND" || code === "CALLER_INACTIVE") {
          setErr("No tenés permisos para crear tenants (debe ser superadmin).");
        } else if (code === "NO_TOKEN" || code === "TOKEN_INVALID") {
          setErr("Sesión expirada. Volvé a loguear.");
        } else if (code === "SLUG_DUPLICATED") {
          setErr("El slug ya existe. Elegí otro.");
        } else if (code === "EMAIL_DUPLICATED" || code === "EMAIL_ALREADY_IN_AUTH") {
          setErr("El email del dueño ya está en uso. Elegí otro.");
        } else if (code === "PASSWORD_TOO_SHORT") {
          setErr("Password debe tener al menos 8 caracteres.");
        } else if (code === "SLUG_INVALID_FORMAT") {
          setErr("Slug solo puede tener letras minúsculas, números y guiones.");
        } else if (code === "MISSING_FIELDS") {
          setErr("Faltan campos obligatorios.");
        } else {
          setErr("Error: " + (code || `HTTP ${resp.status}`));
        }
        return;
      }
       
      console.log("[onboarding] Tenant creado:", data);
      onCreated(paso1.slug);
    } catch (e) {
      setErr("Error inesperado: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 600 }} onClick={e => e.stopPropagation()}>
        <div className="modal-hd">
          <div>
            <div className="modal-title">Crear nuevo tenant</div>
            <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 2 }}>Paso {paso} de 4</div>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {err && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{err}</div>}

          {paso === 1 && (<>
            <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 12 }}>
              Datos básicos del tenant (la empresa-cliente).
            </div>
            <div className="field"><label>Nombre del tenant *</label>
              <input value={paso1.nombre}
                onChange={e => setPaso1({ ...paso1, nombre: e.target.value, slug: paso1.slug || slugFromNombre(e.target.value) })}
                placeholder="Ej: Cliente A SA" />
            </div>
            <div className="field"><label>Slug *</label>
              <input value={paso1.slug}
                onChange={e => setPaso1({ ...paso1, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })}
                placeholder="cliente-a" />
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
                Identificador único, solo minúsculas/números/guiones. Se autocompleta del nombre.
              </div>
            </div>
            <div className="form2">
              <div className="field"><label>Plan</label>
                <select value={paso1.plan} onChange={e => setPaso1({ ...paso1, plan: e.target.value })}>
                  <option value="trial">Trial</option>
                  <option value="basic">Basic</option>
                  <option value="pro">Pro</option>
                </select>
              </div>
              {paso1.plan === "trial" && (
                <div className="field"><label>Días de trial</label>
                  <input type="number" value={paso1.trial_dias}
                    onChange={e => setPaso1({ ...paso1, trial_dias: parseInt(e.target.value) || 14 })} />
                </div>
              )}
            </div>
          </>)}

          {paso === 2 && (<>
            <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 12 }}>
              Primer usuario dueño del tenant. Forzado a cambiar el password al primer login.
            </div>
            <div className="form2">
              <div className="field"><label>Nombre completo *</label>
                <input value={paso2.dueno_nombre} onChange={e => setPaso2({ ...paso2, dueno_nombre: e.target.value })} placeholder="Juan Pérez" />
              </div>
              <div className="field"><label>Email / Usuario *</label>
                <input value={paso2.dueno_email} onChange={e => setPaso2({ ...paso2, dueno_email: e.target.value })} placeholder="juan@cliente.com" />
              </div>
            </div>
            <div className="form2">
              <div className="field"><label>Password temporal *</label>
                <input type="password" value={paso2.dueno_password}
                  onChange={e => setPaso2({ ...paso2, dueno_password: e.target.value })}
                  placeholder="mínimo 8 caracteres" autoComplete="new-password" />
              </div>
              <div className="field"><label>Confirmar password *</label>
                <input type="password" value={paso2.password_confirm}
                  onChange={e => setPaso2({ ...paso2, password_confirm: e.target.value })}
                  autoComplete="new-password" />
              </div>
            </div>
          </>)}

          {paso === 3 && (<>
            <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 12 }}>
              Primer local del tenant. Se pueden agregar más locales después desde Configuración.
            </div>
            <div className="field"><label>Nombre del local *</label>
              <input value={paso3.local_nombre} onChange={e => setPaso3({ ...paso3, local_nombre: e.target.value })} placeholder="Local Centro" />
            </div>
            <div className="field"><label>Dirección (opcional)</label>
              <input value={paso3.local_direccion} onChange={e => setPaso3({ ...paso3, local_direccion: e.target.value })} placeholder="Av. Siempre Viva 742" />
            </div>
          </>)}

          {paso === 4 && (<>
            <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 16 }}>
              Revisá los datos antes de crear. Esta acción es atómica: si algo falla, no se crea nada.
            </div>
            <div style={{ background: "var(--s2)", padding: 16, borderRadius: "var(--r)", marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Tenant</div>
              <div><strong>{paso1.nombre}</strong> · slug: <span className="mono">{paso1.slug}</span></div>
              <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 4 }}>
                Plan: {paso1.plan}{paso1.plan === "trial" ? ` (${paso1.trial_dias} días)` : ""}
              </div>
            </div>
            <div style={{ background: "var(--s2)", padding: 16, borderRadius: "var(--r)", marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Primer dueño</div>
              <div><strong>{paso2.dueno_nombre}</strong></div>
              <div style={{ fontSize: 11, color: "var(--muted2)" }}>{paso2.dueno_email} · password temporal (forzado a cambiar)</div>
            </div>
            <div style={{ background: "var(--s2)", padding: 16, borderRadius: "var(--r)" }}>
              <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Primer local</div>
              <div><strong>{paso3.local_nombre}</strong></div>
              {paso3.local_direccion && <div style={{ fontSize: 11, color: "var(--muted2)" }}>{paso3.local_direccion}</div>}
            </div>
          </>)}
        </div>

        <div className="modal-ft">
          <button className="btn btn-sec" onClick={paso === 1 ? onClose : back} disabled={creating}>
            {paso === 1 ? "Cancelar" : "← Atrás"}
          </button>
          {paso < 4 ? (
            <button className="btn btn-acc" onClick={next}>Siguiente →</button>
          ) : (
            <button className="btn btn-acc" onClick={crear} disabled={creating}>
              {creating ? "Creando..." : "✓ Crear tenant"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
