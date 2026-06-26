// TenantBilling — pantalla del superadmin para ver/cambiar billing de un tenant.
//
// Flujo:
//   1. Lucas elige un tenant.
//   2. Ve la suscripción actual (plan, estado, próximo cobro, fechas trial).
//   3. Si está en trial o pending_payment, puede:
//      - Activar suscripción → abre Stripe Checkout para que el dueño pague.
//      - Marcar como activo manualmente (workaround mientras no haya Stripe).
//   4. Si está activa: ver Stripe customer/subscription IDs, link al Dashboard.
//
// Requiere: credencial Stripe configurada en el hub de integraciones (settings).

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { db } from '@/lib/supabase';
import { CreditCard, ExternalLink, Loader2, RefreshCw, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/cn';

interface Plan {
  id: string;
  nombre: string;
  precio_mensual_ars: number;
  max_locales: number | null;
  max_usuarios: number | null;
}

interface Subscription {
  id: number;
  tenant_id: string;
  plan_id: string;
  estado: string;
  billing_cycle: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  next_billing_at: string | null;
  gateway_provider: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  precio_actual_ars: number | null;
}

interface TenantInfo {
  id: string;
  nombre: string;
  slug: string;
}

const PASE_API_BASE = (import.meta.env.VITE_PASE_API_BASE as string | undefined) || 'https://pase-yndx.vercel.app';

export function TenantBilling() {
  const { id: tenantId } = useParams<{ id: string }>();
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [creandoCheckout, setCreandoCheckout] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setLoading(true);
    const [t, s, p] = await Promise.all([
      db.from('tenants').select('id, nombre, slug').eq('id', tenantId).single(),
      db.from('tenant_subscriptions').select('*').eq('tenant_id', tenantId).maybeSingle(),
      db.from('billing_plans').select('id, nombre, precio_mensual_ars, max_locales, max_usuarios').eq('activo', true).order('orden'),
    ]);
    setTenant((t.data as TenantInfo) ?? null);
    setSub((s.data as Subscription) ?? null);
    setPlans((p.data as Plan[]) ?? []);
    setLoading(false);
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  async function iniciarCheckout(planId: string) {
    setCreandoCheckout(planId);
    try {
      const { data } = await db.auth.getSession();
      const token = data.session?.access_token;
      const r = await fetch(`${PASE_API_BASE}/api/auth-admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'stripe-checkout', plan_id: planId }),
      });
      const d = await r.json();
      if (!d.ok) { alert('Error: ' + (d.error || 'desconocido')); return; }
      if (d.url) window.open(d.url, '_blank', 'noopener');
    } finally {
      setCreandoCheckout(null);
    }
  }

  if (loading) return <div className="p-6 text-admin-muted text-sm inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Cargando…</div>;
  if (!tenant) return <div className="p-6 text-admin-muted">Tenant no encontrado.</div>;

  const planActual = plans.find((p) => p.id === sub?.plan_id);
  const estadoClr = sub?.estado === 'active' ? 'text-admin-success'
    : sub?.estado === 'trial' ? 'text-admin-accent'
    : sub?.estado === 'past_due' || sub?.estado === 'trial_expired' ? 'text-admin-warn'
    : sub?.estado === 'suspended' || sub?.estado === 'cancelled' ? 'text-admin-danger'
    : 'text-admin-muted';

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-admin-text">Facturación — {tenant.nombre}</h1>
          <p className="text-sm text-admin-muted">{tenant.slug}</p>
        </div>
        <button onClick={() => void load()} className="px-3 py-1.5 rounded border border-admin-border text-sm hover:bg-admin-border/40 inline-flex items-center gap-1.5">
          <RefreshCw className="h-3.5 w-3.5" /> Recargar
        </button>
      </header>

      {/* Estado actual */}
      <div className="rounded border border-admin-border bg-admin-surface p-5">
        <h2 className="font-medium text-admin-text mb-3 flex items-center gap-2">
          <CreditCard className="h-4 w-4" /> Suscripción actual
        </h2>
        {!sub ? (
          <p className="text-sm text-admin-muted">Sin suscripción registrada. Elegí un plan abajo para crearla.</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div><span className="text-admin-muted">Plan:</span> {planActual?.nombre ?? sub.plan_id}</div>
            <div><span className="text-admin-muted">Estado:</span> <span className={cn('font-medium', estadoClr)}>{sub.estado}</span></div>
            <div><span className="text-admin-muted">Ciclo:</span> {sub.billing_cycle}</div>
            <div><span className="text-admin-muted">Precio:</span> ${sub.precio_actual_ars ?? planActual?.precio_mensual_ars ?? 0}</div>
            {sub.trial_ends_at && <div><span className="text-admin-muted">Trial vence:</span> {new Date(sub.trial_ends_at).toLocaleDateString('es-AR')}</div>}
            {sub.current_period_end && <div><span className="text-admin-muted">Período actual hasta:</span> {new Date(sub.current_period_end).toLocaleDateString('es-AR')}</div>}
            {sub.gateway_provider && <div><span className="text-admin-muted">Gateway:</span> {sub.gateway_provider}</div>}
            {sub.stripe_customer_id && (
              <div className="col-span-2 text-xs text-admin-muted font-mono">
                Stripe: <a href={`https://dashboard.stripe.com/customers/${sub.stripe_customer_id}`} target="_blank" rel="noopener" className="text-admin-accent inline-flex items-center gap-1">
                  {sub.stripe_customer_id} <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Cambiar plan */}
      <div className="rounded border border-admin-border bg-admin-surface p-5">
        <h2 className="font-medium text-admin-text mb-3">{sub ? 'Cambiar plan' : 'Elegir plan'}</h2>
        <p className="text-xs text-admin-muted mb-4">
          Al activar un plan, el dueño del tenant recibe el link de Stripe Checkout para pagar.
          Requiere que el tenant tenga Stripe configurado en Settings → Integraciones.
        </p>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {plans.map((p) => (
            <div key={p.id} className={cn(
              'rounded border p-4 flex flex-col gap-2',
              sub?.plan_id === p.id ? 'border-admin-accent bg-admin-accent/5' : 'border-admin-border'
            )}>
              <div className="flex items-baseline justify-between">
                <span className="font-medium text-admin-text">{p.nombre}</span>
                {sub?.plan_id === p.id && <span className="text-[10px] uppercase text-admin-accent">Actual</span>}
              </div>
              <div className="text-2xl font-semibold tabular-nums">${p.precio_mensual_ars.toLocaleString('es-AR')}<span className="text-xs text-admin-muted font-normal">/mes</span></div>
              <div className="text-xs text-admin-muted">
                {p.max_locales ? `Hasta ${p.max_locales} locales` : 'Locales ilimitados'} ·{' '}
                {p.max_usuarios ? `${p.max_usuarios} usuarios` : 'Usuarios ilimitados'}
              </div>
              <button
                onClick={() => void iniciarCheckout(p.id)}
                disabled={creandoCheckout !== null}
                className="mt-2 px-3 py-1.5 rounded text-xs bg-admin-accent text-white hover:opacity-90 disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
              >
                {creandoCheckout === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                {sub?.plan_id === p.id ? 'Renovar / cambiar' : 'Activar'}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded border border-admin-warn/30 bg-admin-warn/10 p-4 text-xs text-admin-text flex items-start gap-2">
        <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-admin-warn" />
        <div>
          <span className="font-medium">Setup Stripe necesario:</span> el tenant tiene que cargar su Secret Key y Webhook Secret en
          COMANDA → Configuración → Integraciones → Stripe antes de poder activar suscripciones.
          El webhook tiene que apuntar a <code className="font-mono">pase-yndx.vercel.app/api/auth-admin?action=stripe-webhook</code>.
        </div>
      </div>
    </div>
  );
}
