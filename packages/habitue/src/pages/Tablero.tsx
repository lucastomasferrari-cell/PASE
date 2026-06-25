// Tablero — KPIs de marketing del local, calculados desde nuestros datos
// (clientes): base, retención, recompra, LTV, ticket promedio, perdidos, etc.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Users, UserPlus, Repeat, TrendingUp, AlertTriangle, DoorOpen, Heart, Megaphone } from 'lucide-react';
import { getKpis, type Kpis } from '@/lib/kpisService';

function money(n: number) {
  return n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
}
function pct(n: number) { return `${Math.round(n * 100)}%`; }

export function Tablero() {
  const [k, setK] = useState<Kpis | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    void (async () => {
      const { data, error } = await getKpis();
      if (error) toast.error('No se pudieron calcular los KPIs: ' + error);
      setK(data);
      setCargando(false);
    })();
  }, []);

  if (cargando) return <div className="py-16 text-center text-ink-muted">Calculando KPIs…</div>;
  if (!k) return <div className="py-16 text-center text-ink-muted">Sin datos.</div>;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Base */}
      <Seccion titulo="Tu base de comensales">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card icon={<Users />} label="Comensales" valor={String(k.total)} sub={k.topeado ? '(tope 8000)' : undefined} />
          <Card icon={<UserPlus />} label="Nuevos (30 días)" valor={String(k.nuevos30)} tono="emerald" />
          <Card icon={<Megaphone />} label="Aceptan promos" valor={String(k.aceptanMarketing)} />
          <Card icon={<Heart />} label="Recurrentes (5+)" valor={String(k.recurrentes)} tono="emerald" />
        </div>
      </Seccion>

      {/* Plata */}
      <Seccion titulo="Valor">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card icon={<TrendingUp />} label="LTV promedio" valor={money(k.ltv)} sub="gasto por cliente" />
          <Card icon={<TrendingUp />} label="Ticket promedio" valor={money(k.ticketProm)} />
          <Card icon={<Repeat />} label="Tasa de recompra" valor={pct(k.tasaRecompra)} tono={k.tasaRecompra >= 0.3 ? 'emerald' : 'amber'} sub={`${k.recompra} con 2+ pedidos`} />
          <Card icon={<TrendingUp />} label="Gasto total base" valor={money(k.gastoTotal)} />
        </div>
      </Seccion>

      {/* Retención / riesgo */}
      <Seccion titulo="Retención">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card icon={<DoorOpen />} label="Perdidos (60d+)" valor={String(k.perdidos)} tono={k.perdidos > 0 ? 'red' : 'normal'} />
          <Card icon={<AlertTriangle />} label="En riesgo (30-60d)" valor={String(k.riesgo)} tono={k.riesgo > 0 ? 'amber' : 'normal'} />
          <Card icon={<Users />} label="Con pedidos" valor={String(k.conPedidos)} />
          <Card icon={<Repeat />} label="Una sola compra" valor={String(Math.max(0, k.conPedidos - k.recompra))} sub='objetivo "comprá de nuevo"' />
        </div>
      </Seccion>

      <p className="text-xs text-ink-muted">
        Los KPIs salen de los pedidos de COMANDA/tienda (se reflejan en cada cliente). Para accionar sobre cada grupo, andá a <span className="font-medium">Segmentos y campañas</span>.
      </p>
    </div>
  );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-ink-muted mb-2">{titulo}</p>
      {children}
    </div>
  );
}

function Card({ icon, label, valor, sub, tono = 'normal' }: { icon: React.ReactNode; label: string; valor: string; sub?: string; tono?: 'normal' | 'emerald' | 'amber' | 'red' }) {
  const c = tono === 'emerald' ? 'text-emerald-600' : tono === 'amber' ? 'text-amber-600' : tono === 'red' ? 'text-red-600' : 'text-brand-600';
  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4">
      <div className={`inline-flex items-center justify-center w-9 h-9 rounded-xl bg-brand-50 ${c} mb-2 [&_svg]:h-5 [&_svg]:w-5`}>{icon}</div>
      <div className={`text-2xl font-semibold ${tono === 'normal' ? 'text-ink' : c}`}>{valor}</div>
      <div className="text-xs text-ink-muted">{label}</div>
      {sub && <div className="text-[11px] text-ink-muted mt-0.5">{sub}</div>}
    </div>
  );
}
