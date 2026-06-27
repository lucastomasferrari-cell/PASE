// Pauta — medición de inversión publicitaria (Meta/Google/IG). Registro manual
// + KPIs: invertido total, invertido últimos 30d, y CAC (costo por cliente
// nuevo) = invertido 30d / clientes nuevos 30d. La integración con las APIs de
// Meta/Google Ads es un paso aparte.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, X, Megaphone, Trash2, TrendingUp, UserPlus, DollarSign } from 'lucide-react';
import { listInversiones, crearInversion, eliminarInversion, type Inversion } from '@/lib/pautaService';
import { getKpis } from '@/lib/kpisService';

interface Props { tenantId: string; }

function money(n: number) { return n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }); }
function fechaCorta(iso: string) { return new Date(iso + 'T00:00:00').toLocaleDateString('es-AR', { day: '2-digit', month: 'short' }); }
const PLATAFORMAS = ['Meta (FB/IG)', 'Google Ads', 'Instagram', 'TikTok', 'Otro'];

export function Pauta({ tenantId }: Props) {
  const [inv, setInv] = useState<Inversion[]>([]);
  const [sinTabla, setSinTabla] = useState(false);
  const [nuevos30, setNuevos30] = useState<number | null>(null);
  const [cargando, setCargando] = useState(true);
  const [creando, setCreando] = useState(false);

  const reload = useCallback(async () => {
    setCargando(true);
    const [i, k] = await Promise.all([listInversiones(), getKpis()]);
    if (i.error) toast.error(i.error);
    setInv(i.data); setSinTabla(!!i.sinTabla);
    setNuevos30(k.data?.nuevos30 ?? null);
    setCargando(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function borrar(id: number) {
    setInv((prev) => prev.filter((x) => x.id !== id));
    const { error } = await eliminarInversion(id);
    if (error) { toast.error(error); void reload(); }
  }

  const hace30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const total = inv.reduce((s, x) => s + Number(x.monto), 0);
  const total30 = inv.filter((x) => new Date(x.fecha + 'T00:00:00').getTime() >= hace30).reduce((s, x) => s + Number(x.monto), 0);
  const cac = nuevos30 && nuevos30 > 0 ? total30 / nuevos30 : null;

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-ink-muted">Registrá lo que invertís en pauta para medir cuánto te cuesta traer un cliente nuevo (CAC).</p>
        <button onClick={() => setCreando(true)} disabled={sinTabla}
                className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3.5 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50 shrink-0">
          <Plus className="h-4 w-4" /> Registrar gasto
        </button>
      </div>

      {sinTabla && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm p-3">
          Para usar la medición de pauta hay que aplicar la migración <span className="font-mono text-xs">202606250500_marketing_inversiones.sql</span>. (Lo dejé en tus pendientes.)
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card icon={<DollarSign />} label="Invertido (total)" valor={money(total)} />
        <Card icon={<TrendingUp />} label="Invertido (30 días)" valor={money(total30)} />
        <Card icon={<UserPlus />} label="Nuevos (30 días)" valor={nuevos30 == null ? '—' : String(nuevos30)} />
        <Card icon={<Megaphone />} label="CAC (costo x cliente)" valor={cac == null ? '—' : money(cac)} tono={cac != null ? 'brand' : 'normal'} />
      </div>

      {/* Lista */}
      {cargando ? (
        <div className="py-12 text-center text-ink-muted">Cargando…</div>
      ) : inv.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-14 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-50 text-brand-500 mb-3"><Megaphone className="h-7 w-7" /></div>
          <p className="font-medium">Sin gastos de pauta cargados</p>
          <p className="text-sm text-ink-muted mt-1">Registrá lo que invertís en Meta/Google y medí tu CAC.</p>
        </div>
      ) : (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card divide-y divide-ink/5">
          {inv.map((x) => (
            <div key={x.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="text-center min-w-[44px]">
                <div className="text-xs font-medium text-ink">{fechaCorta(x.fecha)}</div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{x.plataforma}{x.campania ? ` · ${x.campania}` : ''}</div>
                <div className="text-[11px] text-ink-muted">
                  {x.alcance ? `${x.alcance.toLocaleString('es-AR')} alcance` : ''}
                  {x.clicks ? ` · ${x.clicks} clicks${x.clicks > 0 ? ` · ${money(Number(x.monto) / x.clicks)}/click` : ''}` : ''}
                </div>
              </div>
              <div className="text-sm font-medium text-ink">{money(Number(x.monto))}</div>
              <button onClick={() => void borrar(x.id)} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft" title="Borrar"><Trash2 className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-ink-muted">
        Próximo paso: conectar las APIs de Meta Ads / Google Ads para traer el gasto y las métricas (alcance, clicks, conversiones) automáticamente, y SEO/posicionamiento con Search Console.
      </p>

      {creando && (
        <FormInversion
          onClose={() => setCreando(false)}
          onSave={async (input) => {
            const { error } = await crearInversion(tenantId, input);
            if (error) { toast.error(error); return; }
            toast.success('Gasto registrado');
            setCreando(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function Card({ icon, label, valor, tono = 'normal' }: { icon: React.ReactNode; label: string; valor: string; tono?: 'normal' | 'brand' }) {
  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4">
      <div className={`inline-flex items-center justify-center w-9 h-9 rounded-xl bg-brand-50 text-brand-600 mb-2 [&_svg]:h-5 [&_svg]:w-5`}>{icon}</div>
      <div className={`text-xl font-medium ${tono === 'brand' ? 'text-brand-700' : 'text-ink'}`}>{valor}</div>
      <div className="text-xs text-ink-muted">{label}</div>
    </div>
  );
}

function FormInversion({ onClose, onSave }: {
  onClose: () => void;
  onSave: (input: { fecha: string; plataforma: string; campania?: string; monto: number; alcance?: number; clicks?: number; notas?: string }) => void;
}) {
  const [fecha, setFecha] = useState(() => new Date().toISOString().slice(0, 10));
  const [plataforma, setPlataforma] = useState(PLATAFORMAS[0]!);
  const [campania, setCampania] = useState('');
  const [monto, setMonto] = useState('');
  const [alcance, setAlcance] = useState('');
  const [clicks, setClicks] = useState('');
  const [guardando, setGuardando] = useState(false);

  async function submit() {
    const m = Number(monto);
    if (!m || m <= 0) { toast.error('Poné un monto válido'); return; }
    setGuardando(true);
    await onSave({
      fecha, plataforma, campania: campania.trim() || undefined, monto: m,
      alcance: alcance ? Number(alcance) : undefined, clicks: clicks ? Number(clicks) : undefined,
    });
    setGuardando(false);
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-medium">Registrar gasto de pauta</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Fecha</label>
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Plataforma</label>
            <select value={plataforma} onChange={(e) => setPlataforma(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm bg-white">
              {PLATAFORMAS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Campaña (opcional)</label>
          <input value={campania} onChange={(e) => setCampania(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" placeholder="Promo invierno" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Monto $ *</label>
            <input type="number" min={1} value={monto} onChange={(e) => setMonto(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Alcance</label>
            <input type="number" min={0} value={alcance} onChange={(e) => setAlcance(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Clicks</label>
            <input type="number" min={0} value={clicks} onChange={(e) => setClicks(e.target.value)} className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
          <button onClick={() => void submit()} disabled={guardando}
                  className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Guardando…' : 'Registrar'}
          </button>
        </div>
      </div>
    </div>
  );
}
