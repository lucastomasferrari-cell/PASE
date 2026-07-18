import { useEffect, useState, useCallback } from 'react';
import { db } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import {
  TrendingUp, TrendingDown, Users, Building2, DollarSign,
  AlertTriangle, Activity, Loader2,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────
// Métricas globales del Admin Console
//
// Fuente principal: vista `v_admin_metricas_tenants` que arma:
//   - facturado mes actual / mes pasado / crecimiento %
//   - estado de sub (active / trial / past_due / etc)
//   - cantidad locales + usuarios por tenant
//
// Añadimos:
//   - MRR (Monthly Recurring Revenue) — qué nos pagan los tenants en planes
//   - Tasa de trial→paid conversion (quién pasó de trial a active)
//   - Tickets de soporte abiertos por tenant (señal de salud)
//   - Top tenants por facturación (qué cliente factura más)
//   - Tenants en riesgo (sub en past_due, suspended, trial_expired)
// ─────────────────────────────────────────────────────────────────────────

interface MetricaRow {
  tenant_id: string;
  tenant_nombre: string;
  slug: string;
  activo: boolean;
  plan_id: string | null;
  plan_nombre: string | null;
  precio_mensual_ars: number | null;
  sub_estado: string | null;
  trial_ends_at: string | null;
  next_billing_at: string | null;
  tenant_creado_at: string;
  ventas_mes_actual: number;
  facturado_mes_actual: number;
  facturado_mes_pasado: number;
  crecimiento_pct: number | null;
  locales_count: number;
  usuarios_count: number;
}

interface TicketsPorTenant {
  tenant_id: string;
  abiertos: number;
  totales: number;
}

const fmtMoney = (n: number | null | undefined) => {
  if (typeof n !== 'number') return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'k';
  return '$' + n.toFixed(0);
};

const fmtMoneyExact = (n: number | null | undefined) =>
  typeof n === 'number'
    ? '$' + n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : '—';

const fmtPct = (n: number | null | undefined) =>
  typeof n === 'number' ? (n >= 0 ? '+' : '') + n.toFixed(1) + '%' : '—';

export function Metricas() {
  const [data, setData] = useState<MetricaRow[]>([]);
  const [tickets, setTickets] = useState<TicketsPorTenant[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: m, error: mErr }, { data: t, error: tErr }] = await Promise.all([
      db.from('v_admin_metricas_tenants').select('*'),
      db.from('tickets_soporte')
        .select('tenant_id, estado')
        .neq('estado', 'cerrado'),
    ]);
    if (mErr) console.error('Metricas:', mErr);
    if (tErr) console.error('Tickets:', tErr);
    setData((m || []) as MetricaRow[]);

    // Agregamos tickets por tenant
    const counts = new Map<string, { abiertos: number; totales: number }>();
    for (const row of (t || []) as { tenant_id: string; estado: string }[]) {
      const c = counts.get(row.tenant_id) || { abiertos: 0, totales: 0 };
      c.totales++;
      if (row.estado === 'abierto') c.abiertos++;
      counts.set(row.tenant_id, c);
    }
    setTickets(
      Array.from(counts.entries()).map(([tenant_id, v]) => ({ tenant_id, ...v })),
    );

    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ─── Agregaciones globales ────────────────────────────────────────────
  const totalTenants = data.length;
  const tenantsActivos = data.filter(d => d.activo).length;
  const tenantsTrial = data.filter(d => d.sub_estado === 'trial').length;
  const tenantsPagando = data.filter(d => d.sub_estado === 'active').length;
  // tenantsEnRiesgo (incluyendo cancelled) — usado en KPI count si lo agregamos
  // después. Por ahora la lista "en riesgo de churn" excluye cancelled
  // (ese ya churneó). Mantenemos el calc por si se necesita.

  // MRR = suma de precios mensuales de subs activas
  const mrr = data
    .filter(d => d.sub_estado === 'active')
    .reduce((s, d) => s + (Number(d.precio_mensual_ars) || 0), 0);
  // Annual Run Rate proyectado
  const arr = mrr * 12;

  // GMV global (lo que facturan TUS clientes a sus propios clientes este mes)
  const gmvMes = data.reduce((s, d) => s + (Number(d.facturado_mes_actual) || 0), 0);
  const gmvMesPasado = data.reduce((s, d) => s + (Number(d.facturado_mes_pasado) || 0), 0);
  const gmvCrecimiento = gmvMesPasado > 0 ? ((gmvMes - gmvMesPasado) / gmvMesPasado) * 100 : null;

  // Locales / usuarios totales en la plataforma
  const localesTotal = data.reduce((s, d) => s + Number(d.locales_count || 0), 0);
  const usuariosTotal = data.reduce((s, d) => s + Number(d.usuarios_count || 0), 0);

  // Top 5 tenants por facturación
  const topFacturacion = [...data]
    .sort((a, b) => Number(b.facturado_mes_actual || 0) - Number(a.facturado_mes_actual || 0))
    .slice(0, 5);

  // Tenants en riesgo
  const enRiesgo = data.filter(d =>
    ['past_due', 'suspended', 'trial_expired'].includes(d.sub_estado || ''),
  );

  // Trials que vencen pronto (próximos 7 días)
  const trialsPorVencer = data
    .filter(d => d.sub_estado === 'trial' && d.trial_ends_at)
    .filter(d => {
      const dias = (new Date(d.trial_ends_at!).getTime() - Date.now()) / 86_400_000;
      return dias <= 7;
    })
    .sort((a, b) => (a.trial_ends_at || '').localeCompare(b.trial_ends_at || ''));

  // Ticket map por tenant
  const ticketsMap = new Map(tickets.map(t => [t.tenant_id, t]));

  return (
    <div className="space-y-8">
      <SectionHeader label="05 / Métricas" />

      {loading ? (
        <div className="flex items-center justify-center py-12 text-admin-muted mono text-xs uppercase tracking-widest gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando métricas…
        </div>
      ) : (
        <>
          {/* ─── Banner riesgo si hay tenants en problema ─── */}
          {enRiesgo.length > 0 && (
            <div className="rounded border border-admin-danger/30 bg-admin-danger/10 p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-admin-danger shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-admin-danger">
                    {enRiesgo.length} tenant{enRiesgo.length > 1 ? 's' : ''} con riesgo de churn
                  </div>
                  <div className="text-xs text-admin-text mt-1">
                    Suspendidos, trials vencidos o con pago atrasado. Ver lista al final.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ─── KPIs principales del SaaS ─── */}
          <section className="space-y-4">
            <SectionHeader label="Ingresos del SaaS" icon={<DollarSign className="w-3.5 h-3.5" />} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiBig
                label="MRR"
                value={fmtMoney(mrr)}
                exact={fmtMoneyExact(mrr)}
                hint="Ingresos recurrentes mensuales (subs activas)"
                tone="success"
              />
              <KpiBig
                label="ARR"
                value={fmtMoney(arr)}
                exact={fmtMoneyExact(arr)}
                hint="Annual Run Rate (MRR × 12)"
                tone="success"
              />
              <KpiBig
                label="Clientes pagando"
                value={String(tenantsPagando)}
                hint={`de ${totalTenants} totales`}
                tone={tenantsPagando > 0 ? 'success' : 'muted'}
              />
              <KpiBig
                label="En trial"
                value={String(tenantsTrial)}
                hint={trialsPorVencer.length > 0 ? `${trialsPorVencer.length} vence(n) en 7d` : 'ninguno por vencer'}
                tone={trialsPorVencer.length > 0 ? 'warn' : 'default'}
              />
            </div>
          </section>

          {/* ─── Métricas de la plataforma (GMV) ─── */}
          <section className="space-y-4">
            <SectionHeader label="Uso de la plataforma" icon={<Activity className="w-3.5 h-3.5" />} />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <KpiBig
                label="GMV mes actual"
                value={fmtMoney(gmvMes)}
                exact={fmtMoneyExact(gmvMes)}
                hint="Lo que tus clientes facturan a través de PASE"
                tone="default"
              />
              <KpiBig
                label="vs mes pasado"
                value={fmtPct(gmvCrecimiento)}
                hint={fmtMoney(gmvMesPasado) + ' el mes anterior'}
                tone={gmvCrecimiento === null ? 'muted' : gmvCrecimiento >= 0 ? 'success' : 'danger'}
                icon={gmvCrecimiento === null ? null : gmvCrecimiento >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
              />
              <KpiBig
                label="Locales totales"
                value={String(localesTotal)}
                hint={`${tenantsActivos} tenants activos`}
                icon={<Building2 className="w-4 h-4 text-admin-accent" />}
              />
              <KpiBig
                label="Usuarios totales"
                value={String(usuariosTotal)}
                hint="Cuentas activas creadas"
                icon={<Users className="w-4 h-4 text-admin-accent" />}
              />
            </div>
          </section>

          {/* ─── Top facturación + Trials por vencer ─── */}
          <div className="grid md:grid-cols-2 gap-4">
            <Card title="Top 5 clientes por facturación (mes actual)">
              {topFacturacion.length === 0 ? (
                <Empty>Sin datos de facturación este mes.</Empty>
              ) : (
                <ul>
                  {topFacturacion.map((d, idx) => (
                    <li key={d.tenant_id} className="flex items-center justify-between py-2 px-3 text-sm border-b border-admin-border last:border-0 hover:bg-admin-accent/[0.03] transition-colors">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-admin-muted text-xs mono tabular-nums w-4">{idx + 1}.</span>
                        <span className="text-admin-text font-medium truncate">{d.tenant_nombre}</span>
                        <span className="text-[10px] text-admin-muted mono shrink-0">({d.locales_count}L · {d.plan_nombre})</span>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-admin-text mono tabular-nums">{fmtMoney(d.facturado_mes_actual)}</div>
                        {d.crecimiento_pct !== null && (
                          <div className={cn('text-[10px] mono tabular-nums', d.crecimiento_pct >= 0 ? 'text-admin-success' : 'text-admin-danger')}>
                            {fmtPct(d.crecimiento_pct)}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title={`Trials por vencer (próximos 7 días) — ${trialsPorVencer.length}`}>
              {trialsPorVencer.length === 0 ? (
                <Empty>No hay trials por vencer esta semana.</Empty>
              ) : (
                <ul>
                  {trialsPorVencer.map(d => {
                    const dias = Math.ceil((new Date(d.trial_ends_at!).getTime() - Date.now()) / 86_400_000);
                    return (
                      <li key={d.tenant_id} className="flex items-center justify-between py-2 px-3 text-sm border-b border-admin-border last:border-0 hover:bg-admin-accent/[0.03] transition-colors">
                        <div className="min-w-0">
                          <div className="text-admin-text font-medium truncate">{d.tenant_nombre}</div>
                          <div className="text-[10px] text-admin-muted mono">{d.slug}</div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className={cn('text-xs mono tabular-nums', dias <= 2 ? 'text-admin-danger' : 'text-admin-warn')}>
                            {dias}d
                          </div>
                          <div className="text-[10px] text-admin-muted mono tabular-nums">{d.trial_ends_at?.slice(0, 10)}</div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>

          {/* ─── Tenants en riesgo + Soporte abierto ─── */}
          <div className="grid md:grid-cols-2 gap-4">
            <Card title={`Clientes en riesgo de churn — ${enRiesgo.length}`}>
              {enRiesgo.length === 0 ? (
                <Empty>Ningún cliente en riesgo.</Empty>
              ) : (
                <ul>
                  {enRiesgo.map(d => (
                    <li key={d.tenant_id} className="flex items-center justify-between py-2 px-3 text-sm border-b border-admin-border last:border-0 hover:bg-admin-accent/[0.03] transition-colors">
                      <div className="min-w-0">
                        <div className="text-admin-text font-medium truncate">{d.tenant_nombre}</div>
                        <div className="text-[10px] text-admin-muted mono">{d.plan_nombre} · {d.locales_count}L · {d.usuarios_count}U</div>
                      </div>
                      <span className={cn(
                        'mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0',
                        d.sub_estado === 'suspended' ? 'bg-admin-danger/10 text-admin-danger border-admin-danger/30' :
                        d.sub_estado === 'trial_expired' ? 'bg-admin-danger/10 text-admin-danger border-admin-danger/30' :
                        'bg-admin-warn/10 text-admin-warn border-admin-warn/30',
                      )}>
                        {d.sub_estado?.replace('_', ' ')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Soporte abierto por cliente">
              {tickets.length === 0 ? (
                <Empty>No hay tickets abiertos.</Empty>
              ) : (
                <ul>
                  {tickets
                    .sort((a, b) => b.abiertos - a.abiertos)
                    .map(t => {
                      const tenant = data.find(d => d.tenant_id === t.tenant_id);
                      return (
                        <li key={t.tenant_id} className="flex items-center justify-between py-2 px-3 text-sm border-b border-admin-border last:border-0 hover:bg-admin-accent/[0.03] transition-colors">
                          <div className="text-admin-text truncate">{tenant?.tenant_nombre || t.tenant_id.slice(0, 8)}</div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-xs text-admin-warn mono tabular-nums">{t.abiertos} abiertos</span>
                            <span className="text-[10px] text-admin-muted mono tabular-nums">/ {t.totales} total</span>
                          </div>
                        </li>
                      );
                    })}
                </ul>
              )}
            </Card>
          </div>

          {/* ─── Tabla completa de tenants ─── */}
          <Card title={`Todos los clientes (${data.length})`} flush>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-admin-bg border-b border-admin-border">
                  <tr className="text-left">
                    <th className="px-3 py-2 label-sys">Cliente</th>
                    <th className="px-3 py-2 label-sys">Estado</th>
                    <th className="px-3 py-2 label-sys text-right">Locales</th>
                    <th className="px-3 py-2 label-sys text-right">Usuarios</th>
                    <th className="px-3 py-2 label-sys text-right">Mes actual</th>
                    <th className="px-3 py-2 label-sys text-right">vs prev</th>
                    <th className="px-3 py-2 label-sys text-right">Tickets</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data]
                    .sort((a, b) => Number(b.facturado_mes_actual || 0) - Number(a.facturado_mes_actual || 0))
                    .map(d => {
                      const tk = ticketsMap.get(d.tenant_id);
                      return (
                        <tr key={d.tenant_id} className={cn('border-b border-admin-border last:border-0 hover:bg-admin-accent/[0.03] transition-colors', !d.activo && 'opacity-50')}>
                          <td className="px-3 py-2">
                            <div className="text-admin-text font-medium">{d.tenant_nombre}</div>
                            <div className="text-[10px] text-admin-muted mono">{d.plan_nombre}</div>
                          </td>
                          <td className="px-3 py-2">
                            <span className="mono text-[10px] uppercase tracking-wider text-admin-muted">
                              {d.sub_estado?.replace('_', ' ') || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right mono tabular-nums text-admin-text">{d.locales_count}</td>
                          <td className="px-3 py-2 text-right mono tabular-nums text-admin-text">{d.usuarios_count}</td>
                          <td className="px-3 py-2 text-right mono tabular-nums text-admin-text">{fmtMoney(d.facturado_mes_actual)}</td>
                          <td className={cn('px-3 py-2 text-right mono tabular-nums text-xs', d.crecimiento_pct === null ? 'text-admin-muted' : d.crecimiento_pct >= 0 ? 'text-admin-success' : 'text-admin-danger')}>
                            {fmtPct(d.crecimiento_pct)}
                          </td>
                          <td className="px-3 py-2 text-right text-xs">
                            {tk ? (
                              <span className={cn('mono tabular-nums', tk.abiertos > 0 ? 'text-admin-warn' : 'text-admin-muted')}>
                                {tk.abiertos}/{tk.totales}
                              </span>
                            ) : (
                              <span className="text-admin-muted mono tabular-nums">0/0</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// ─── Componentes auxiliares ──────────────────────────────────────────────

// Cabecera de sección cocina.os: título mono celeste + hairline degradado.
function SectionHeader({ label, icon, right }: { label: string; icon?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="mono text-[11px] font-semibold text-admin-accent tracking-[0.3em] uppercase whitespace-nowrap flex items-center gap-2">
        {icon}{label}
      </h2>
      <div className="h-px flex-1 bg-gradient-to-r from-admin-border-strong to-transparent" />
      {right}
    </div>
  );
}

function KpiBig({ label, value, exact, hint, tone, icon }: {
  label: string;
  value: string;
  exact?: string;
  hint?: string;
  tone?: 'default' | 'success' | 'warn' | 'danger' | 'muted';
  icon?: React.ReactNode;
}) {
  const toneCls = {
    default: 'text-admin-text',
    success: 'text-admin-success',
    warn:    'text-admin-warn',
    danger:  'text-admin-danger',
    muted:   'text-admin-muted',
  }[tone || 'default'];
  return (
    <div className="rounded border border-admin-border bg-admin-surface p-4">
      <div className="flex items-center justify-between">
        <div className="label-sys">{label}</div>
        {icon}
      </div>
      <div className={cn('mono tabular-nums text-2xl mt-1', toneCls)} title={exact}>{value}</div>
      {hint && <div className="mono text-[10px] text-admin-muted mt-1">{hint}</div>}
    </div>
  );
}

function Card({ title, children, flush }: { title: string; children: React.ReactNode; flush?: boolean }) {
  return (
    <div className="rounded border border-admin-border bg-admin-surface overflow-hidden">
      <div className="px-4 py-2.5 border-b border-admin-border">
        <span className="label-sys">{title}</span>
      </div>
      <div className={flush ? '' : 'p-2'}>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-6 text-center text-admin-muted mono text-xs uppercase tracking-widest">{children}</div>
  );
}
