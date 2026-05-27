import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import { Building2, Plus, Loader2, Search, ExternalLink, ToggleLeft } from 'lucide-react';
import { TenantWizard } from '@/components/TenantWizard';

// URL del backend de PASE — el endpoint /api/crear-tenant vive ahí porque ya
// tiene SUPABASE_SERVICE_KEY configurado. Acepta CORS desde cualquier origen
// (auth por JWT, no cookies).
const PASE_API_BASE = import.meta.env.VITE_PASE_API_BASE || 'https://pase-yndx.vercel.app';

interface TenantRow {
  id: string;
  nombre: string;
  slug: string;
  plan: string | null;
  activo: boolean;
  trial_ends_at: string | null;
  created_at: string;
  // Subscription joined
  sub_estado?: string | null;
  num_locales: number;
  num_usuarios: number;
}

// Mapeo estado de subscription → color del badge.
const ESTADO_COLORS: Record<string, string> = {
  trial:          'bg-admin-accent/15 text-admin-accent border-admin-accent/30',
  pending_payment:'bg-admin-warn/15 text-admin-warn border-admin-warn/30',
  active:         'bg-admin-success/15 text-admin-success border-admin-success/30',
  past_due:       'bg-admin-warn/15 text-admin-warn border-admin-warn/30',
  suspended:      'bg-admin-danger/15 text-admin-danger border-admin-danger/30',
  cancelled:      'bg-admin-border text-admin-muted border-admin-border',
  trial_expired:  'bg-admin-danger/15 text-admin-danger border-admin-danger/30',
};

const ESTADO_LABELS: Record<string, string> = {
  trial: 'Trial',
  pending_payment: 'Esperando pago',
  active: 'Activo',
  past_due: 'Atrasado',
  suspended: 'Suspendido',
  cancelled: 'Cancelado',
  trial_expired: 'Trial vencido',
};

export function Tenants() {
  const navigate = useNavigate();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // 1. Lista de tenants
    const { data: ts, error } = await db
      .from('tenants')
      .select('id, nombre, slug, plan, activo, trial_ends_at, created_at')
      .order('created_at', { ascending: false });
    if (error) { console.error(error); setLoading(false); return; }

    const list = (ts || []) as Omit<TenantRow, 'num_locales' | 'num_usuarios' | 'sub_estado'>[];

    // 2. Para cada tenant, contar locales + usuarios + buscar estado de sub.
    // Estos counts no escalan a miles, pero hoy hay <20 tenants, sirve.
    const enriched: TenantRow[] = await Promise.all(list.map(async (t) => {
      const [{ count: locCount }, { count: usrCount }, { data: subRow }] = await Promise.all([
        db.from('locales').select('*', { count: 'exact', head: true }).eq('tenant_id', t.id),
        db.from('usuarios').select('*', { count: 'exact', head: true }).eq('tenant_id', t.id),
        db.from('tenant_subscriptions').select('estado').eq('tenant_id', t.id).maybeSingle(),
      ]);
      return {
        ...t,
        num_locales: locCount || 0,
        num_usuarios: usrCount || 0,
        sub_estado: subRow?.estado ?? null,
      };
    }));
    setTenants(enriched);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // AUDIT F6B#1: verComo está deshabilitado hasta implementar el lado PASE.
  // Antes: el botón abría URL `?as=<uuid>` que PASE NUNCA leía → Lucas
  // clickeaba "Ver" y veía su propio tenant (Neko), silently broken.
  // Para implementar realmente: handler en PASE App.tsx que lea ?as, valide
  // que el caller es superadmin, escriba pase_tenant_override en sessionStorage
  // y recargue. Por ahora el botón está oculto para no engañar.
  const verComo = (t: TenantRow) => {
    alert(`Función "Ver como" deshabilitada — el handler ?as=<uuid> en PASE no está implementado todavía. Pendiente sprint dedicado. Tenant: ${t.nombre}`);
  };
  // Mantener referencia explícita para que TS/ESLint no se queje del unused var.
  // PASE_API_BASE se mantiene en uso por otros features (si los hay).
  void PASE_API_BASE;

  const toggleActivo = async (t: TenantRow) => {
    const accion = t.activo ? 'Desactivar' : 'Activar';
    if (!confirm(`¿${accion} el tenant "${t.nombre}"?`)) return;
    // AUDIT F6B: usar RPC fn_set_tenant_activo que audita el cambio
    // (antes era UPDATE directo sin rastro de quién lo cambió).
    const { error } = await db.rpc('fn_set_tenant_activo', {
      p_tenant_id: t.id,
      p_activo: !t.activo,
    });
    if (error) { alert('Error: ' + error.message); return; }
    void load();
  };

  // AUDIT F6B: UI para eliminar tenant con confirmación fuerte (typing del slug).
  // Llama a la RPC eliminar_tenant_completo que existe en DB desde hace meses
  // pero solo se usaba via script a mano. Decisión Lucas pendiente: si quiere
  // un soft-delete (set activo=false + delete diferido N días) en vez del hard.
  const eliminarTenant = async (t: TenantRow) => {
    const confirmText = prompt(
      `⚠ ELIMINAR PERMANENTEMENTE el tenant "${t.nombre}".\n\n` +
      `Esto borra: ventas, facturas, gastos, empleados, movimientos, ` +
      `mesas, items, recetas, configuración, usuarios — TODA la data del tenant.\n\n` +
      `Hay una RPC restore_tenant para deshacer pero requiere backup previo.\n\n` +
      `Para CONFIRMAR escribí exactamente: ${t.slug}`
    );
    if (confirmText !== t.slug) {
      if (confirmText !== null) alert('Slug no coincide. Cancelado.');
      return;
    }
    const { error } = await db.rpc('eliminar_tenant_completo', { p_tenant_id: t.id });
    if (error) { alert('Error: ' + error.message); return; }
    setFlash(`Tenant "${t.slug}" eliminado.`);
    setTimeout(() => setFlash(null), 5000);
    void load();
  };

  const restaurarTenant = async (t: TenantRow) => {
    if (!confirm(`Restaurar tenant "${t.nombre}" desde último backup?`)) return;
    const { error } = await db.rpc('restore_tenant', { p_tenant_id: t.id });
    if (error) { alert('Error: ' + error.message); return; }
    setFlash(`Tenant "${t.slug}" restaurado.`);
    setTimeout(() => setFlash(null), 5000);
    void load();
  };

  const onTenantCreated = (slug: string) => {
    setWizardOpen(false);
    setFlash(`Tenant "${slug}" creado correctamente.`);
    setTimeout(() => setFlash(null), 5000);
    void load();
  };

  const filtered = search.trim()
    ? tenants.filter(t =>
        t.nombre.toLowerCase().includes(search.toLowerCase()) ||
        t.slug.toLowerCase().includes(search.toLowerCase()),
      )
    : tenants;

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-admin-text flex items-center gap-2">
            <Building2 className="w-5 h-5 text-admin-accent" />
            Tenants
          </h1>
          <p className="text-xs text-admin-muted mt-1">
            Gestión de cuentas-cliente. Crear, suspender, ver como.
          </p>
        </div>
        <button
          onClick={() => setWizardOpen(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded text-sm bg-admin-accent text-admin-bg hover:bg-admin-accent/90 transition-colors"
        >
          <Plus className="w-4 h-4" /> Nuevo tenant
        </button>
      </header>

      {flash && (
        <div className="rounded border border-admin-success/30 bg-admin-success/10 text-admin-success px-3 py-2 text-sm">
          {flash}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-admin-muted" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Buscar por nombre o slug…"
            className="w-full pl-8 pr-3 py-2 rounded border border-admin-border bg-admin-surface text-sm text-admin-text placeholder-admin-muted focus:outline-none focus:border-admin-accent"
          />
        </div>
        <span className="text-xs text-admin-muted">{filtered.length} de {tenants.length}</span>
      </div>

      <div className="rounded border border-admin-border bg-admin-surface overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-admin-muted text-sm gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Cargando tenants…
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-admin-muted text-sm">
            {search ? 'No hay tenants que coincidan con la búsqueda.' : 'No hay tenants todavía. Creá el primero.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-admin-bg border-b border-admin-border">
              <tr className="text-left">
                <th className="px-3 py-2 font-medium text-admin-muted text-xs uppercase tracking-wider">Nombre</th>
                <th className="px-3 py-2 font-medium text-admin-muted text-xs uppercase tracking-wider">Plan / Estado</th>
                <th className="px-3 py-2 font-medium text-admin-muted text-xs uppercase tracking-wider text-right">Locales</th>
                <th className="px-3 py-2 font-medium text-admin-muted text-xs uppercase tracking-wider text-right">Usuarios</th>
                <th className="px-3 py-2 font-medium text-admin-muted text-xs uppercase tracking-wider">Creado</th>
                <th className="px-3 py-2 font-medium text-admin-muted text-xs uppercase tracking-wider"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id} className={cn('border-b border-admin-border/50 last:border-0', !t.activo && 'opacity-50')}>
                  <td className="px-3 py-2.5">
                    <div className="text-admin-text font-medium">{t.nombre}</div>
                    <div className="text-[11px] text-admin-muted font-mono">{t.slug}</div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="text-admin-text text-xs">{t.plan || '—'}</div>
                    {t.sub_estado && (
                      <span className={cn(
                        'inline-block mt-0.5 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border',
                        ESTADO_COLORS[t.sub_estado] || ESTADO_COLORS['cancelled'],
                      )}>
                        {ESTADO_LABELS[t.sub_estado] || t.sub_estado}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right text-admin-text font-mono">{t.num_locales}</td>
                  <td className="px-3 py-2.5 text-right text-admin-text font-mono">{t.num_usuarios}</td>
                  <td className="px-3 py-2.5 text-admin-muted text-xs font-mono">
                    {t.created_at ? t.created_at.slice(0, 10) : '—'}
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      {/* AUDIT F6B#1: botón "Ver" oculto hasta implementar el handler en PASE.
                          Antes hacía window.open(?as=uuid) pero PASE nunca lo leía. */}
                      <button
                        onClick={() => verComo(t)}
                        className="hidden px-2 py-1 rounded text-xs text-admin-muted hover:text-admin-text hover:bg-admin-border/40 flex items-center gap-1"
                        title="Pendiente: implementar handler ?as=<uuid> en PASE"
                      >
                        <ExternalLink className="w-3 h-3" /> Ver
                      </button>
                      <button
                        onClick={() => navigate(`/tenants/${t.id}/features`)}
                        className="px-2 py-1 rounded text-xs text-admin-muted hover:text-admin-text hover:bg-admin-border/40 flex items-center gap-1"
                        title="Activar/desactivar funciones del tenant"
                      >
                        <ToggleLeft className="w-3 h-3" /> Funciones
                      </button>
                      <button
                        onClick={() => toggleActivo(t)}
                        className={cn(
                          'px-2 py-1 rounded text-xs hover:bg-admin-border/40',
                          t.activo ? 'text-admin-muted hover:text-admin-warn' : 'text-admin-success',
                        )}
                      >
                        {t.activo ? 'Desactivar' : 'Activar'}
                      </button>
                      {/* AUDIT F6B: botones eliminar/restaurar (antes solo
                          accesibles vía scripts a mano). Confirmación fuerte
                          en eliminar — requiere typing del slug. */}
                      {!t.activo && (
                        <button
                          onClick={() => restaurarTenant(t)}
                          className="px-2 py-1 rounded text-xs text-admin-success hover:bg-admin-border/40"
                          title="Restaurar tenant desde backup"
                        >
                          Restaurar
                        </button>
                      )}
                      <button
                        onClick={() => eliminarTenant(t)}
                        className="px-2 py-1 rounded text-xs text-admin-danger hover:bg-admin-border/40"
                        title="Eliminar tenant PERMANENTEMENTE (requiere typing del slug)"
                      >
                        Eliminar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Wizard de creación — modal de 4 pasos como antes en PASE. */}
      {wizardOpen && (
        <TenantWizard
          apiBase={PASE_API_BASE}
          onClose={() => setWizardOpen(false)}
          onCreated={onTenantCreated}
        />
      )}
    </div>
  );
}
