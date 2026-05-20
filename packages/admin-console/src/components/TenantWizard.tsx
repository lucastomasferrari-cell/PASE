import { useState } from 'react';
import { db } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import { X, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

interface Props {
  apiBase: string;       // URL del backend de PASE (donde vive crear-tenant.js)
  onClose: () => void;
  onCreated: (slug: string) => void;
}

interface Paso1 { nombre: string; slug: string; plan: string; trial_dias: number }
interface Paso2 { dueno_email: string; dueno_nombre: string; dueno_password: string; password_confirm: string }
interface Paso3 { local_nombre: string; local_direccion: string }

const PLANES = ['trial', 'basic', 'pro', 'enterprise'] as const;

const slugFromNombre = (nombre: string) =>
  nombre.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function TenantWizard({ apiBase, onClose, onCreated }: Props) {
  const [paso, setPaso] = useState(1);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  const [p1, setP1] = useState<Paso1>({ nombre: '', slug: '', plan: 'trial', trial_dias: 14 });
  const [p2, setP2] = useState<Paso2>({ dueno_email: '', dueno_nombre: '', dueno_password: '', password_confirm: '' });
  const [p3, setP3] = useState<Paso3>({ local_nombre: '', local_direccion: '' });

  const validar = (): string | null => {
    if (paso === 1) {
      if (!p1.nombre.trim()) return 'Falta nombre del tenant.';
      if (!p1.slug.trim()) return 'Falta slug.';
      if (!/^[a-z0-9-]+$/.test(p1.slug)) return 'Slug solo puede tener minúsculas, números y guiones.';
    } else if (paso === 2) {
      if (!p2.dueno_email.trim()) return 'Falta email del dueño.';
      if (!p2.dueno_nombre.trim()) return 'Falta nombre del dueño.';
      if (p2.dueno_password.length < 8) return 'Password debe tener al menos 8 caracteres.';
      if (p2.dueno_password !== p2.password_confirm) return 'Los passwords no coinciden.';
    } else if (paso === 3) {
      if (!p3.local_nombre.trim()) return 'Falta nombre del primer local.';
    }
    return null;
  };

  const next = () => {
    setErr('');
    const v = validar();
    if (v) { setErr(v); return; }
    setPaso(paso + 1);
  };
  const back = () => { setErr(''); setPaso(paso - 1); };

  const crear = async () => {
    if (creating) return;
    setCreating(true);
    setErr('');
    try {
      const { data: { session } } = await db.auth.getSession();
      const token = session?.access_token;
      if (!token) { setErr('Sesión expirada. Volvé a loguear.'); return; }

      const resp = await fetch(`${apiBase}/api/crear-tenant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          nombre: p1.nombre.trim(),
          slug: p1.slug.trim(),
          plan: p1.plan,
          dueno_email: p2.dueno_email.trim(),
          dueno_nombre: p2.dueno_nombre.trim(),
          dueno_password: p2.dueno_password,
          local_nombre: p3.local_nombre.trim(),
          local_direccion: p3.local_direccion.trim() || null,
          trial_dias: p1.trial_dias,
        }),
      });

      const data = await resp.json().catch(() => ({ ok: false, error: 'RESPUESTA_INVALIDA' }));

      if (!resp.ok || !data?.ok) {
        const code = data?.error || '';
        const mapping: Record<string, string> = {
          NOT_SUPERADMIN: 'No tenés permisos para crear tenants.',
          CALLER_NOT_FOUND: 'Tu usuario no aparece en la tabla usuarios.',
          CALLER_INACTIVE: 'Tu usuario está inactivo.',
          NO_TOKEN: 'Sesión expirada. Volvé a loguear.',
          TOKEN_INVALID: 'Sesión expirada. Volvé a loguear.',
          SLUG_DUPLICATED: 'El slug ya existe. Elegí otro.',
          EMAIL_DUPLICATED: 'El email del dueño ya está en uso.',
          EMAIL_ALREADY_IN_AUTH: 'El email del dueño ya está en uso.',
          PASSWORD_TOO_SHORT: 'Password debe tener al menos 8 caracteres.',
          SLUG_INVALID_FORMAT: 'Slug inválido (solo minúsculas/números/guiones).',
          MISSING_FIELDS: 'Faltan campos obligatorios.',
        };
        setErr(mapping[code] || `Error: ${code || `HTTP ${resp.status}`}`);
        return;
      }

      onCreated(p1.slug);
    } catch (e) {
      setErr('Error inesperado: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-admin-bg/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-admin-surface border border-admin-border rounded-lg max-w-2xl w-full max-h-[90vh] overflow-auto shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-admin-border">
          <div>
            <h2 className="text-base font-semibold text-admin-text">Crear nuevo tenant</h2>
            <p className="text-xs text-admin-muted mt-0.5">Paso {paso} de 4</p>
          </div>
          <button onClick={onClose} className="text-admin-muted hover:text-admin-text">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="px-5 pt-3">
          <div className="flex gap-1">
            {[1, 2, 3, 4].map(n => (
              <div
                key={n}
                className={cn(
                  'h-1 flex-1 rounded',
                  n <= paso ? 'bg-admin-accent' : 'bg-admin-border',
                )}
              />
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          {err && (
            <div className="rounded border border-admin-danger/30 bg-admin-danger/10 text-admin-danger px-3 py-2 text-sm">
              {err}
            </div>
          )}

          {paso === 1 && (
            <>
              <p className="text-xs text-admin-muted">Datos básicos del tenant (la empresa-cliente).</p>
              <Field label="Nombre del tenant *">
                <input
                  value={p1.nombre}
                  onChange={e => setP1({ ...p1, nombre: e.target.value, slug: p1.slug || slugFromNombre(e.target.value) })}
                  placeholder="Ej: Cliente A SA"
                  className={inputCls}
                />
              </Field>
              <Field label="Slug *" hint="Identificador único, solo minúsculas/números/guiones.">
                <input
                  value={p1.slug}
                  onChange={e => setP1({ ...p1, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
                  placeholder="cliente-a"
                  className={cn(inputCls, 'font-mono')}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Plan">
                  <select value={p1.plan} onChange={e => setP1({ ...p1, plan: e.target.value })} className={inputCls}>
                    {PLANES.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                  </select>
                </Field>
                {p1.plan === 'trial' && (
                  <Field label="Días de trial">
                    <input
                      type="number"
                      value={p1.trial_dias}
                      onChange={e => setP1({ ...p1, trial_dias: parseInt(e.target.value) || 14 })}
                      className={inputCls}
                    />
                  </Field>
                )}
              </div>
            </>
          )}

          {paso === 2 && (
            <>
              <p className="text-xs text-admin-muted">
                Primer usuario dueño del tenant. Forzado a cambiar el password en su primer login.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nombre completo *">
                  <input value={p2.dueno_nombre} onChange={e => setP2({ ...p2, dueno_nombre: e.target.value })} placeholder="Juan Pérez" className={inputCls} />
                </Field>
                <Field label="Email / Usuario *">
                  <input value={p2.dueno_email} onChange={e => setP2({ ...p2, dueno_email: e.target.value })} placeholder="juan@cliente.com" className={inputCls} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Password temporal *">
                  <input
                    type="password"
                    value={p2.dueno_password}
                    onChange={e => setP2({ ...p2, dueno_password: e.target.value })}
                    placeholder="mínimo 8 caracteres"
                    autoComplete="new-password"
                    className={inputCls}
                  />
                </Field>
                <Field label="Confirmar *">
                  <input
                    type="password"
                    value={p2.password_confirm}
                    onChange={e => setP2({ ...p2, password_confirm: e.target.value })}
                    autoComplete="new-password"
                    className={inputCls}
                  />
                </Field>
              </div>
            </>
          )}

          {paso === 3 && (
            <>
              <p className="text-xs text-admin-muted">
                Primer local del tenant. Más locales se agregan desde Configuración después.
              </p>
              <Field label="Nombre del local *">
                <input value={p3.local_nombre} onChange={e => setP3({ ...p3, local_nombre: e.target.value })} placeholder="Local Centro" className={inputCls} />
              </Field>
              <Field label="Dirección (opcional)">
                <input value={p3.local_direccion} onChange={e => setP3({ ...p3, local_direccion: e.target.value })} placeholder="Av. Siempre Viva 742" className={inputCls} />
              </Field>
            </>
          )}

          {paso === 4 && (
            <>
              <p className="text-xs text-admin-muted">
                Revisá los datos antes de crear. Esta acción es atómica — si algo falla, no se crea nada.
              </p>
              <SummaryCard label="Tenant">
                <div className="text-admin-text font-medium">{p1.nombre}</div>
                <div className="text-xs text-admin-muted mt-0.5 font-mono">{p1.slug}</div>
                <div className="text-xs text-admin-muted mt-1">
                  Plan: {p1.plan}{p1.plan === 'trial' ? ` (${p1.trial_dias} días)` : ''}
                </div>
              </SummaryCard>
              <SummaryCard label="Primer dueño">
                <div className="text-admin-text font-medium">{p2.dueno_nombre}</div>
                <div className="text-xs text-admin-muted mt-0.5">{p2.dueno_email}</div>
                <div className="text-xs text-admin-muted">Password temporal — forzado a cambiar al primer login</div>
              </SummaryCard>
              <SummaryCard label="Primer local">
                <div className="text-admin-text font-medium">{p3.local_nombre}</div>
                {p3.local_direccion && <div className="text-xs text-admin-muted mt-0.5">{p3.local_direccion}</div>}
              </SummaryCard>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-admin-border flex justify-between gap-2">
          <button
            onClick={paso === 1 ? onClose : back}
            disabled={creating}
            className="flex items-center gap-1 px-3 py-2 rounded text-sm text-admin-muted hover:text-admin-text hover:bg-admin-border/40 disabled:opacity-50"
          >
            {paso === 1 ? 'Cancelar' : (<><ChevronLeft className="w-4 h-4" /> Atrás</>)}
          </button>
          {paso < 4 ? (
            <button
              onClick={next}
              className="flex items-center gap-1 px-3 py-2 rounded text-sm bg-admin-accent text-admin-bg hover:bg-admin-accent/90"
            >
              Siguiente <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={crear}
              disabled={creating}
              className="flex items-center gap-1.5 px-3 py-2 rounded text-sm bg-admin-success text-admin-bg hover:bg-admin-success/90 disabled:opacity-50"
            >
              {creating ? (<><Loader2 className="w-4 h-4 animate-spin" /> Creando…</>) : 'Crear tenant'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const inputCls = 'w-full px-3 py-2 rounded border border-admin-border bg-admin-bg text-sm text-admin-text placeholder-admin-muted focus:outline-none focus:border-admin-accent';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-admin-muted">{label}</label>
      {children}
      {hint && <div className="text-[10px] text-admin-muted">{hint}</div>}
    </div>
  );
}

function SummaryCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-admin-border bg-admin-bg p-3">
      <div className="text-[10px] uppercase tracking-wider text-admin-muted mb-1">{label}</div>
      {children}
    </div>
  );
}
