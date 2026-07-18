import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import { Building2, Plus, Loader2, Search, ExternalLink, ToggleLeft, CreditCard } from 'lucide-react';
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
  // Bot IG cost watch (migración 202606260100)
  ig_gasto_hoy?: number | null;
  ig_cap_diario?: number | null;
}

// Mapeo estado de subscription → color del badge.
const ESTADO_COLORS: Record<string, string> = {
  trial:          'bg-admin-accent/10 text-admin-accent border-admin-accent/20',
  pending_payment:'bg-admin-warn/10 text-admin-warn border-admin-warn/20',
  active:         'bg-admin-success/10 text-admin-success border-admin-success/20',
  past_due:       'bg-admin-warn/10 text-admin-warn border-admin-warn/20',
  suspended:      'bg-admin-danger/10 text-admin-danger border-admin-danger/20',
  cancelled:      'bg-slate-900/50 text-admin-muted border-admin-border',
  trial_expired:  'bg-admin-danger/10 text-admin-danger border-admin-danger/20',
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

    // Vista v_ig_costo_diario_tenant (migración 202606260100): un SELECT global
    // y mapeamos por tenant_id en JS. Si la vista no existe (tenants sin bot),
    // gasto_hoy_usd queda en 0.
    const { data: igCostos } = await db.from('v_ig_costo_diario_tenant')
      .select('tenant_id, gasto_hoy_usd, cap_diario_usd');
    const igMap = new Map<string, { gasto: number; cap: number }>();
    for (const r of (igCostos ?? []) as { tenant_id: string; gasto_hoy_usd: number; cap_diario_usd: number }[]) {
      igMap.set(r.tenant_id, { gasto: Number(r.gasto_hoy_usd), cap: Number(r.cap_diario_usd) });
    }

    // 2. Para cada tenant, contar locales + usuarios + buscar estado de sub.
    // Estos counts no escalan a miles, pero hoy hay <20 tenants, sirve.
    const enriched: TenantRow[] = await Promise.all(list.map(async (t) => {
      const [{ count: locCount }, { count: usrCount }, { data: subRow }] = await Promise.all([
        db.from('locales').select('*', { count: 'exact', head: true }).eq('tenant_id', t.id),
        db.from('usuarios').select('*', { count: 'exact', head: true }).eq('tenant_id', t.id),
        db.from('tenant_subscriptions').select('estado').eq('tenant_id', t.id).maybeSingle(),
      ]);
      const ig = igMap.get(t.id);
      return {
        ...t,
        num_locales: locCount || 0,
        num_usuarios: usrCount || 0,
        sub_estado: subRow?.estado ?? null,
        ig_gasto_hoy: ig?.gasto ?? null,
        ig_cap_diario: ig?.cap ?? null,
      };
    }));
    setTenants(enriched);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // F6B#1 (26-jun-2026): habilitado. PASE App.tsx ahora lee `?override_tenant=<uuid>`
  // al cargar, lo guarda en sessionStorage (key TENANT_OVERRIDE_KEY), limpia
  // la URL y aplica el override solo si el user logueado es superadmin.
  // Si no es superadmin, applyLogin lo borra solo (defense-in-depth).
  const verComo = (t: TenantRow) => {
    const url = `https://pase-yndx.vercel.app/?override_tenant=${encodeURIComponent(t.id)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
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
      `Eliminar permanentemente el tenant "${t.nombre}".\n\n` +
      `Esto borra: ventas, facturas, gastos, empleados, movimientos, ` +
      `mesas, items, recetas, configuración, usuarios — toda la data del tenant.\n\n` +
      `Hay una RPC restore_tenant para deshacer pero requiere backup previo.\n\n` +
      `Para confirmar escribí exactamente: ${t.slug}`
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
    <div>
      {/* Cabecera de sección + CTA. */}
      <div className="flex items-center gap-4 mb-6">
        <h2 className="font-mono text-[11px] font-semibold text-admin-accent tracking-[0.3em] uppercase whitespace-nowrap">
          02 / Tenants
        </h2>
        <div className="h-px flex-1 bg-gradient-to-r from-admin-border-strong to-transparent" />
        <span className="mono text-[9px] text-admin-muted tracking-widest whitespace-nowrap">
          {filtered.length} / {tenants.length}
        </span>
        <button
          onClick={() => setWizardOpen(true)}
          className="border border-admin-accent/20 text-admin-accent px-3 py-1 rounded-[3px] mono text-[9px] uppercase tracking-widest hover:bg-admin-accent/10 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
        >
          <Plus className="w-3 h-3" /> Nuevo tenant
        </button>
      </div>

      {flash && (
        <div className="rounded border border-admin-success/20 bg-admin-success/10 text-admin-success px-3 py-2 text-sm mb-6">
          {flash}
        </div>
      )}

      {/* Buscador — campo integrado slate. */}
      <div className="mb-8">
        <div className="flex items-center gap-3 px-4 py-2 bg-slate-900/50 rounded border border-admin-border focus-within:border-admin-accent/40 transition-colors">
          <Search className="w-4 h-4 text-admin-muted shrink-0" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="BUSCAR POR NOMBRE O SLUG…"
            className="flex-1 bg-transparent border-0 mono text-[10px] tracking-widest uppercase text-admin-text placeholder:text-admin-muted/70"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-admin-muted mono text-xs uppercase tracking-widest gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando tenants…
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center">
          <p className="font-medium text-admin-text">Sin resultados</p>
          <p className="text-sm text-admin-muted mt-1">
            {search ? 'Probá otra búsqueda o creá un tenant nuevo.' : 'No hay tenants todavía. Creá el primero.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col">
          {filtered.map(t => {
            const gasto = t.ig_gasto_hoy ?? 0;
            const cap = t.ig_cap_diario ?? 5;
            const pct = cap > 0 ? gasto / cap : 0;
            const igCls = pct >= 1 ? 'text-admin-danger font-medium'
              : pct >= 0.8 ? 'text-admin-warn font-medium'
              : gasto > 0 ? 'text-admin-text'
              : 'text-admin-muted';
            return (
              <div key={t.id} className={cn('system-row group px-4 py-4 flex items-center gap-4 sm:gap-6', !t.activo && 'opacity-60')}>
                <div className="icon-box w-9 h-9 rounded border border-admin-accent/20 flex items-center justify-center shrink-0">
                  <Building2 className="w-4 h-4" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-semibold text-admin-text group-hover:text-admin-accent transition-colors truncate">{t.nombre}</span>
                    <span className="font-mono text-[9px] text-admin-muted opacity-50 shrink-0">{t.slug}</span>
                  </div>
                  <div className="text-xs text-admin-muted truncate flex items-center gap-2">
                    <span>{t.plan || '—'}</span>
                    <span className="opacity-40">·</span>
                    <span className="font-mono">{t.created_at ? t.created_at.slice(0, 10) : '—'}</span>
                    {t.sub_estado && (
                      <span className={cn(
                        'font-mono text-[9px] uppercase tracking-wider px-2 py-0.5 rounded border',
                        ESTADO_COLORS[t.sub_estado] || ESTADO_COLORS['cancelled'],
                      )}>
                        {ESTADO_LABELS[t.sub_estado] || t.sub_estado}
                      </span>
                    )}
                  </div>
                </div>

                {/* Métricas — chips slate. */}
                <div className="hidden lg:flex items-center gap-2 shrink-0">
                  <span className="font-mono text-[9px] uppercase tracking-tighter bg-slate-900/50 px-2 py-0.5 rounded text-admin-muted">
                    {t.num_locales} LOC
                  </span>
                  <span className="font-mono text-[9px] uppercase tracking-tighter bg-slate-900/50 px-2 py-0.5 rounded text-admin-muted">
                    {t.num_usuarios} USR
                  </span>
                  {t.ig_cap_diario != null && (
                    <span
                      className={cn('font-mono text-[9px] bg-slate-900/50 px-2 py-0.5 rounded', igCls)}
                      title={`IG hoy — ${(pct * 100).toFixed(0)}% del cap`}
                    >
                      IG ${gasto.toFixed(2)}/${cap.toFixed(0)}
                    </span>
                  )}
                </div>

                {/* Estado activo. */}
                <div className="hidden sm:flex items-center gap-1.5 shrink-0 w-16">
                  <span className={t.activo ? 'status-active' : 'status-inactive'} />
                  <span className="mono text-[9px] text-admin-muted">{t.activo ? 'ACTIVE' : 'OFF'}</span>
                </div>

                {/* Acciones. */}
                <div className="flex items-center justify-end flex-wrap gap-1 shrink-0">
                  {/* AUDIT F6B#1: botón "Ver" oculto hasta implementar el handler en PASE.
                      Antes hacía window.open(?as=uuid) pero PASE nunca lo leía. */}
                  <button
                    onClick={() => verComo(t)}
                    className="hidden px-2 py-1 rounded-[3px] mono text-[9px] uppercase tracking-widest text-admin-muted hover:text-admin-text hover:bg-admin-surface-2 items-center gap-1"
                    title="Pendiente: implementar handler ?as=<uuid> en PASE"
                  >
                    <ExternalLink className="w-3 h-3" /> Ver
                  </button>
                  <button
                    onClick={() => navigate(`/tenants/${t.id}/features`)}
                    className="px-2 py-1 rounded-[3px] mono text-[9px] uppercase tracking-widest border border-admin-border text-admin-muted hover:text-admin-text hover:bg-admin-surface-2 inline-flex items-center gap-1 transition-colors"
                    title="Activar/desactivar funciones del tenant"
                  >
                    <ToggleLeft className="w-3 h-3" /> Funciones
                  </button>
                  <button
                    onClick={() => navigate(`/tenants/${t.id}/billing`)}
                    className="px-2 py-1 rounded-[3px] mono text-[9px] uppercase tracking-widest border border-admin-border text-admin-muted hover:text-admin-text hover:bg-admin-surface-2 inline-flex items-center gap-1 transition-colors"
                    title="Suscripción y facturación"
                  >
                    <CreditCard className="w-3 h-3" /> Billing
                  </button>
                  <button
                    onClick={() => toggleActivo(t)}
                    className={cn(
                      'px-2 py-1 rounded-[3px] mono text-[9px] uppercase tracking-widest border transition-colors',
                      t.activo
                        ? 'border-admin-border text-admin-muted hover:text-admin-warn hover:border-admin-warn/40'
                        : 'border-admin-success/40 text-admin-success hover:bg-admin-success/10',
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
                      className="px-2 py-1 rounded-[3px] mono text-[9px] uppercase tracking-widest border border-admin-success/40 text-admin-success hover:bg-admin-success/10 transition-colors"
                      title="Restaurar tenant desde backup"
                    >
                      Restaurar
                    </button>
                  )}
                  <button
                    onClick={() => eliminarTenant(t)}
                    className="px-2 py-1 rounded-[3px] mono text-[9px] uppercase tracking-widest border border-admin-danger/40 text-admin-danger hover:bg-admin-danger/10 transition-colors"
                    title="Eliminar tenant PERMANENTEMENTE (requiere typing del slug)"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
