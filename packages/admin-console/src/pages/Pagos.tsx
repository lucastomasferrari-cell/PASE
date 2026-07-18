import { useEffect, useState, useCallback } from 'react';
import { db } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import { Plus, FileText, CheckCircle2, Loader2, CreditCard, Info } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────
// Pantalla Pagos del Admin Console
//
// Modo actual: COBRO MANUAL.
// - Listamos subscriptions de todos los tenants.
// - Listamos invoices (pendientes + pagadas).
// - Lucas puede:
//     * Generar próxima invoice (RPC fn_generar_invoice_proxima).
//     * Marcar invoice como pagada manualmente (RPC fn_registrar_pago_invoice).
//
// Scaffolding gateway:
// El schema ya tiene gateway_provider/gateway_subscription_id/gateway_customer_id
// y gateway_payment_id en invoices. Cuando se conecte MP/dLocal/Stripe:
//   1. Implementar webhook handler en api/billing-webhook.js
//   2. Reemplazar marcar-pago-manual por el flujo de webhook auto
//   3. Activar trigger de cobro automático en fecha de vencimiento
//
// Argentina-friendly: MP Suscripciones es la opción canónica (acepta tarjeta
// AR, AFIP automático). dLocal cuando se expanda a otros países LATAM.
// Stripe NO procesa tarjetas argentinas — descartado salvo entrada por dLocal
// como wrapper.
// ─────────────────────────────────────────────────────────────────────────

interface SubRow {
  id: number;
  tenant_id: string;
  plan_id: string;
  estado: string;
  billing_cycle: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  next_billing_at: string | null;
  gateway_provider: string | null;
  precio_actual_ars: number | null;
  modo_cobro: string;
  // joined
  tenant_nombre?: string;
  plan_nombre?: string;
  precio_mensual_ars?: number;
}

interface InvoiceRow {
  id: number;
  tenant_id: string;
  subscription_id: number | null;
  periodo_desde: string;
  periodo_hasta: string;
  importe_ars: number;
  total_ars: number;
  estado: string;
  fecha_emision: string;
  fecha_vencimiento: string | null;
  fecha_pago: string | null;
  metodo_pago: string | null;
  tenant_nombre?: string;
}

// Chips de estado — pill relleno slate con tinte + borde semántico (cocina.os).
const SUB_ESTADO_COLORS: Record<string, string> = {
  trial:           'text-admin-accent bg-admin-accent/10 border border-admin-accent/30',
  pending_payment: 'text-admin-warn bg-admin-warn/10 border border-admin-warn/30',
  active:          'text-admin-success bg-admin-success/10 border border-admin-success/30',
  past_due:        'text-admin-warn bg-admin-warn/10 border border-admin-warn/30',
  suspended:       'text-admin-danger bg-admin-danger/10 border border-admin-danger/30',
  cancelled:       'text-admin-muted bg-slate-900/50 border border-admin-border',
  trial_expired:   'text-admin-danger bg-admin-danger/10 border border-admin-danger/30',
};

const INV_ESTADO_COLORS: Record<string, string> = {
  pendiente:    'text-admin-warn bg-admin-warn/10 border border-admin-warn/30',
  pagada:       'text-admin-success bg-admin-success/10 border border-admin-success/30',
  vencida:      'text-admin-danger bg-admin-danger/10 border border-admin-danger/30',
  anulada:      'text-admin-muted bg-slate-900/50 border border-admin-border',
  reembolsada:  'text-admin-muted bg-slate-900/50 border border-admin-border',
};

// Clase base de todo chip de estado (mono, uppercase, denso).
const CHIP_BASE = 'mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded';

const fmtMoney = (n: number | null | undefined) =>
  typeof n === 'number'
    ? '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : '—';

const fmtDate = (s: string | null | undefined) => s ? s.slice(0, 10) : '—';

type Tab = 'subs' | 'invoices' | 'gateway';

export function Pagos() {
  const [tab, setTab] = useState<Tab>('subs');
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Subscriptions con join a tenants + plan.
    const { data: subsRaw } = await db
      .from('tenant_subscriptions')
      .select(`
        id, tenant_id, plan_id, estado, billing_cycle, trial_ends_at,
        current_period_end, next_billing_at, gateway_provider,
        precio_actual_ars, modo_cobro
      `)
      .order('created_at', { ascending: false });

    // Cargamos por separado tenants + plans para evitar problemas de FK declarados.
    const [{ data: tenantsRaw }, { data: plansRaw }] = await Promise.all([
      db.from('tenants').select('id, nombre'),
      db.from('billing_plans').select('id, nombre, precio_mensual_ars'),
    ]);
    const tenantMap = new Map((tenantsRaw || []).map((t: { id: string; nombre: string }) => [t.id, t.nombre]));
    const planMap = new Map(
      (plansRaw || []).map((p: { id: string; nombre: string; precio_mensual_ars: number }) =>
        [p.id, p],
      ),
    );

    const enrichedSubs: SubRow[] = (subsRaw || []).map((s: SubRow) => ({
      ...s,
      tenant_nombre: tenantMap.get(s.tenant_id) || '?',
      plan_nombre: planMap.get(s.plan_id)?.nombre || s.plan_id,
      precio_mensual_ars: planMap.get(s.plan_id)?.precio_mensual_ars,
    }));
    setSubs(enrichedSubs);

    // Invoices
    const { data: invRaw } = await db
      .from('tenant_invoices')
      .select(`
        id, tenant_id, subscription_id, periodo_desde, periodo_hasta,
        importe_ars, total_ars, estado, fecha_emision, fecha_vencimiento,
        fecha_pago, metodo_pago
      `)
      .order('fecha_emision', { ascending: false })
      .limit(100);
    const enrichedInvs: InvoiceRow[] = (invRaw || []).map((i: InvoiceRow) => ({
      ...i,
      tenant_nombre: tenantMap.get(i.tenant_id) || '?',
    }));
    setInvoices(enrichedInvs);

    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const generarInvoice = async (sub: SubRow) => {
    if (!confirm(`¿Generar invoice del próximo período para "${sub.tenant_nombre}"?`)) return;
    setActionLoading(`gen-${sub.id}`);
    const { error } = await db.rpc('fn_generar_invoice_proxima', { p_tenant_id: sub.tenant_id });
    setActionLoading(null);
    if (error) { alert('Error: ' + error.message); return; }
    await load();
  };

  const marcarPagada = async (inv: InvoiceRow) => {
    const metodo = prompt('Método de pago (transferencia / efectivo / mercadopago / otro):', 'transferencia');
    if (!metodo) return;
    const notas = prompt('Notas opcionales:', '') || null;
    setActionLoading(`pay-${inv.id}`);
    const { error } = await db.rpc('fn_registrar_pago_invoice', {
      p_invoice_id: inv.id,
      p_metodo_pago: metodo,
      p_gateway_payment_id: null,
      p_notas: notas,
    });
    setActionLoading(null);
    if (error) { alert('Error: ' + error.message); return; }
    await load();
  };

  // Counts para tabs
  const pendingInvoices = invoices.filter(i => i.estado === 'pendiente').length;
  const subsActivos = subs.filter(s => s.estado === 'active').length;
  const subsAtraso = subs.filter(s => ['past_due', 'pending_payment'].includes(s.estado)).length;

  return (
    <div className="space-y-6">
      <SectionHeader label="04 / Pagos" />

      {/* KPIs rápidos */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Subs activas" value={subsActivos} tone="success" />
        <Kpi label="Subs con atraso" value={subsAtraso} tone={subsAtraso > 0 ? 'warn' : 'muted'} />
        <Kpi label="Invoices pendientes" value={pendingInvoices} tone={pendingInvoices > 0 ? 'warn' : 'muted'} />
        <Kpi label="Total tenants" value={subs.length} tone="default" />
      </div>

      {/* Tabs */}
      <div className="flex gap-6 border-b border-admin-border-strong">
        <TabBtn active={tab === 'subs'} onClick={() => setTab('subs')} label="Suscripciones" count={subs.length} />
        <TabBtn active={tab === 'invoices'} onClick={() => setTab('invoices')} label="Invoices" count={invoices.length} />
        <TabBtn active={tab === 'gateway'} onClick={() => setTab('gateway')} label="Gateway" />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-admin-muted mono text-xs uppercase tracking-widest gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando…
        </div>
      ) : tab === 'subs' ? (
        <SubsTable
          subs={subs}
          actionLoading={actionLoading}
          onGenerarInvoice={generarInvoice}
        />
      ) : tab === 'invoices' ? (
        <InvoicesTable
          invoices={invoices}
          actionLoading={actionLoading}
          onMarcarPagada={marcarPagada}
        />
      ) : (
        <GatewaySetup />
      )}
    </div>
  );
}

// ─── Componentes ─────────────────────────────────────────────────────────

// Cabecera de sección cocina.os: título mono celeste + hairline degradado.
function SectionHeader({ label, right }: { label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-1">
      <h2 className="mono text-[11px] font-semibold text-admin-accent tracking-[0.3em] uppercase whitespace-nowrap">
        {label}
      </h2>
      <div className="h-px flex-1 bg-gradient-to-r from-admin-border-strong to-transparent" />
      {right}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone: 'default' | 'success' | 'warn' | 'muted' }) {
  const toneCls = {
    default: 'text-admin-text',
    success: 'text-admin-success',
    warn:    'text-admin-warn',
    muted:   'text-admin-muted',
  }[tone];
  return (
    <div className="rounded border border-admin-border bg-admin-surface p-4">
      <div className="label-sys">{label}</div>
      <div className={cn('mono tabular-nums text-2xl mt-1', toneCls)}>{value}</div>
    </div>
  );
}

function TabBtn({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'mono text-[11px] tracking-[0.2em] uppercase pb-2 -mb-px border-b-2 transition-colors flex items-center gap-1.5',
        active
          ? 'font-semibold text-admin-accent border-admin-accent'
          : 'font-medium text-admin-muted border-transparent hover:text-admin-text',
      )}
    >
      {label}
      {count !== undefined && (
        <span className="mono text-[9px] bg-slate-900/50 px-1.5 py-0.5 rounded tabular-nums">{count}</span>
      )}
    </button>
  );
}

function SubsTable({ subs, actionLoading, onGenerarInvoice }: { subs: SubRow[]; actionLoading: string | null; onGenerarInvoice: (s: SubRow) => void }) {
  return (
    <div className="rounded border border-admin-border bg-admin-surface overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-admin-bg border-b border-admin-border">
          <tr className="text-left">
            <th className="px-3 py-2 label-sys">Tenant</th>
            <th className="px-3 py-2 label-sys">Plan</th>
            <th className="px-3 py-2 label-sys">Estado</th>
            <th className="px-3 py-2 label-sys text-right">Precio/mes</th>
            <th className="px-3 py-2 label-sys">Próximo cobro</th>
            <th className="px-3 py-2 label-sys">Gateway</th>
            <th className="px-3 py-2 label-sys"></th>
          </tr>
        </thead>
        <tbody>
          {subs.length === 0 && (
            <tr><td colSpan={7} className="px-3 py-8 text-center text-admin-muted mono text-xs uppercase tracking-widest">No hay suscripciones.</td></tr>
          )}
          {subs.map(s => (
            <tr key={s.id} className="border-b border-admin-border last:border-0 hover:bg-admin-accent/[0.03] transition-colors">
              <td className="px-3 py-2.5 text-admin-text font-medium">{s.tenant_nombre}</td>
              <td className="px-3 py-2.5 text-admin-text">{s.plan_nombre}</td>
              <td className="px-3 py-2.5">
                <span className={cn(CHIP_BASE, SUB_ESTADO_COLORS[s.estado] || SUB_ESTADO_COLORS.cancelled)}>
                  {s.estado.replace('_', ' ')}
                </span>
              </td>
              <td className="px-3 py-2.5 text-right text-admin-text mono tabular-nums">{fmtMoney(s.precio_mensual_ars)}</td>
              <td className="px-3 py-2.5 text-admin-muted text-xs mono tabular-nums">
                {fmtDate(s.next_billing_at || s.current_period_end || s.trial_ends_at)}
              </td>
              <td className="px-3 py-2.5 text-xs">
                {s.gateway_provider ? (
                  <span className={cn(CHIP_BASE, 'text-admin-success bg-admin-success/10 border border-admin-success/30')}>{s.gateway_provider}</span>
                ) : (
                  <span className={cn(CHIP_BASE, 'text-admin-muted bg-slate-900/50 border border-admin-border')}>manual</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-right">
                {s.estado !== 'cancelled' && s.precio_mensual_ars && s.precio_mensual_ars > 0 && (
                  <button
                    onClick={() => onGenerarInvoice(s)}
                    disabled={actionLoading === `gen-${s.id}`}
                    className="mono text-[10px] uppercase tracking-widest px-2 py-1 rounded border border-admin-accent/30 text-admin-accent hover:bg-admin-accent/10 disabled:opacity-50 flex items-center gap-1 ml-auto transition-colors"
                  >
                    {actionLoading === `gen-${s.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                    Invoice
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvoicesTable({ invoices, actionLoading, onMarcarPagada }: { invoices: InvoiceRow[]; actionLoading: string | null; onMarcarPagada: (i: InvoiceRow) => void }) {
  return (
    <div className="rounded border border-admin-border bg-admin-surface overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-admin-bg border-b border-admin-border">
          <tr className="text-left">
            <th className="px-3 py-2 label-sys">Tenant</th>
            <th className="px-3 py-2 label-sys">Período</th>
            <th className="px-3 py-2 label-sys text-right">Total</th>
            <th className="px-3 py-2 label-sys">Estado</th>
            <th className="px-3 py-2 label-sys">Vence</th>
            <th className="px-3 py-2 label-sys">Cobrada</th>
            <th className="px-3 py-2 label-sys"></th>
          </tr>
        </thead>
        <tbody>
          {invoices.length === 0 && (
            <tr><td colSpan={7} className="px-3 py-8 text-center text-admin-muted mono text-xs uppercase tracking-widest">
              No hay invoices todavía. Generá la primera desde la tab de Suscripciones.
            </td></tr>
          )}
          {invoices.map(i => (
            <tr key={i.id} className="border-b border-admin-border last:border-0 hover:bg-admin-accent/[0.03] transition-colors">
              <td className="px-3 py-2.5 text-admin-text font-medium">{i.tenant_nombre}</td>
              <td className="px-3 py-2.5 text-admin-muted text-xs mono tabular-nums">
                {fmtDate(i.periodo_desde)} → {fmtDate(i.periodo_hasta)}
              </td>
              <td className="px-3 py-2.5 text-right text-admin-text mono tabular-nums">{fmtMoney(i.total_ars)}</td>
              <td className="px-3 py-2.5">
                <span className={cn(CHIP_BASE, INV_ESTADO_COLORS[i.estado] || INV_ESTADO_COLORS.anulada)}>
                  {i.estado}
                </span>
              </td>
              <td className="px-3 py-2.5 text-admin-muted text-xs mono tabular-nums">{fmtDate(i.fecha_vencimiento)}</td>
              <td className="px-3 py-2.5 text-admin-muted text-xs">
                {i.fecha_pago ? (
                  <>
                    <div className="mono tabular-nums">{fmtDate(i.fecha_pago)}</div>
                    <div className="mono text-[9px] uppercase tracking-wider opacity-70">{i.metodo_pago}</div>
                  </>
                ) : '—'}
              </td>
              <td className="px-3 py-2.5 text-right">
                {i.estado === 'pendiente' && (
                  <button
                    onClick={() => onMarcarPagada(i)}
                    disabled={actionLoading === `pay-${i.id}`}
                    className="mono text-[10px] uppercase tracking-widest px-2 py-1 rounded border border-admin-success/30 text-admin-success hover:bg-admin-success/10 disabled:opacity-50 flex items-center gap-1 ml-auto transition-colors"
                  >
                    {actionLoading === `pay-${i.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                    Pagada
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GatewaySetup() {
  return (
    <div className="space-y-4">
      <div className="rounded border border-admin-warn/30 bg-admin-warn/10 p-4">
        <div className="flex items-start gap-2">
          <Info className="w-4 h-4 text-admin-warn shrink-0 mt-0.5" />
          <div className="text-sm text-admin-text">
            <strong className="text-admin-warn">Modo manual activado.</strong> Hoy todos los cobros se registran manualmente acá.
            Para conectar un gateway, primero registrate y después conectamos los webhooks.
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <GatewayCard
          name="MercadoPago Suscripciones"
          badge="Recomendado para AR"
          badgeTone="success"
          description="Procesa tarjetas argentinas. Genera factura AFIP automática si tenés cuenta MP empresa. API simple, webhooks bien documentados."
          steps={[
            'Registrar cuenta MP empresa (gratis)',
            'Obtener access_token de producción',
            'Crear plan en MP con tu pricing',
            'Conectar webhook a /api/billing-webhook',
          ]}
          url="https://www.mercadopago.com.ar/developers/es/docs/subscriptions/landing"
          status="disponible"
        />
        <GatewayCard
          name="dLocal"
          badge="Multi-país LATAM"
          badgeTone="default"
          description="Si vas a vender PASE en Chile/México/Colombia además de AR. Cobra ~3.5% + IVA, soporta tarjeta + transfer local + cash."
          steps={[
            'Aplicar a dLocal Direct (validación KYC)',
            'Configurar productos/planes en el dashboard',
            'Conectar webhook firmado',
          ]}
          url="https://dlocal.com/es/"
          status="planeado"
        />
        <GatewayCard
          name="Stripe"
          badge="No procesa tarjetas AR"
          badgeTone="danger"
          description="Stripe Atlas no acepta tarjetas argentinas. Solo sirve si vas a cobrar clientes fuera de AR en USD. Descartado para clientes locales."
          steps={[]}
          url="https://stripe.com/docs/billing"
          status="descartado"
        />
        <GatewayCard
          name="Cobro manual + AFIP propio"
          badge="Actual"
          badgeTone="muted"
          description="Tenants te transfieren / pagan efectivo. Vos marcás invoice como pagada y emitís factura AFIP por afuera. Cero comisión gateway."
          steps={['Ya está activo']}
          url=""
          status="activo"
        />
      </div>

      <details className="rounded border border-admin-border bg-admin-surface p-4">
        <summary className="cursor-pointer mono text-[11px] uppercase tracking-widest text-admin-accent font-semibold">
          Schema técnico ya preparado para conectar gateway
        </summary>
        <div className="mt-3 text-xs text-admin-muted space-y-2">
          <p>
            La tabla <code className="mono text-admin-accent">tenant_subscriptions</code> ya tiene los campos para
            integrar cualquier gateway sin migration adicional:
          </p>
          <ul className="ml-4 space-y-1 list-disc">
            <li><code className="mono text-admin-accent">gateway_provider</code> — &apos;mercadopago&apos; / &apos;dlocal&apos; / &apos;stripe&apos; / &apos;manual&apos;</li>
            <li><code className="mono text-admin-accent">gateway_subscription_id</code> — ID de la sub en el gateway externo</li>
            <li><code className="mono text-admin-accent">gateway_customer_id</code> — ID del cliente en el gateway</li>
            <li><code className="mono text-admin-accent">modo_cobro</code> — &apos;manual&apos; o &apos;automatico&apos;</li>
          </ul>
          <p>
            Y en <code className="mono text-admin-accent">tenant_invoices</code>:
          </p>
          <ul className="ml-4 space-y-1 list-disc">
            <li><code className="mono text-admin-accent">gateway_payment_id</code> — ID de la transacción del webhook</li>
            <li><code className="mono text-admin-accent">comprobante_numero/cae/url</code> — factura AFIP si la emite el gateway o se emite afuera</li>
          </ul>
          <p className="text-admin-text">
            Próximo paso cuando elijas gateway: crear <code className="mono text-admin-accent">api/billing-webhook.js</code> que reciba eventos
            <span className="text-admin-muted"> (payment.created / subscription.cancelled / etc.)</span> y llame las mismas RPCs
            <code className="mono text-admin-accent"> fn_registrar_pago_invoice</code> que hoy usás manualmente.
          </p>
        </div>
      </details>
    </div>
  );
}

function GatewayCard({ name, badge, badgeTone, description, steps, url, status }: {
  name: string;
  badge: string;
  badgeTone: 'success' | 'default' | 'danger' | 'muted';
  description: string;
  steps: string[];
  url: string;
  status: 'disponible' | 'planeado' | 'descartado' | 'activo';
}) {
  const badgeCls = {
    success: 'bg-admin-success/10 text-admin-success border-admin-success/30',
    default: 'bg-admin-accent/10 text-admin-accent border-admin-accent/30',
    danger:  'bg-admin-danger/10 text-admin-danger border-admin-danger/30',
    muted:   'bg-slate-900/50 text-admin-muted border-admin-border',
  }[badgeTone];
  const statusCls = {
    disponible: 'text-admin-text',
    planeado: 'text-admin-muted',
    descartado: 'text-admin-danger opacity-60',
    activo: 'text-admin-success',
  }[status];
  return (
    <div className={cn('rounded border border-admin-border bg-admin-surface p-4', status === 'descartado' && 'opacity-60')}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className={cn('flex items-center gap-2 font-medium', statusCls)}>
          <CreditCard className="w-4 h-4" />
          {name}
        </div>
        <span className={cn('mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border', badgeCls)}>
          {badge}
        </span>
      </div>
      <p className="text-xs text-admin-muted mb-3">{description}</p>
      {steps.length > 0 && (
        <ol className="text-xs text-admin-text space-y-1 ml-4 list-decimal">
          {steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 mt-3 mono text-[10px] uppercase tracking-widest text-admin-accent hover:underline"
        >
          <FileText className="w-3 h-3" /> Documentación
        </a>
      )}
    </div>
  );
}
