// Cupones / Descuentos — Habitué. Crea códigos de descuento (porcentaje o monto)
// que se canjean en la tienda online / WhatsApp. Voucher = cupón de 1 solo uso.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, X, Ticket, Power, Trash2, Copy } from 'lucide-react';
import { listCupones, crearCupon, toggleCupon, eliminarCupon, type Cupon, type CanalCupon } from '@/lib/cuponesService';

interface Props { tenantId: string; }

function valorTxt(c: Cupon) {
  return c.tipo === 'porcentaje' ? `${c.valor}%` : `$${c.valor.toLocaleString('es-AR')}`;
}

export function Cupones({ tenantId }: Props) {
  const [cupones, setCupones] = useState<Cupon[]>([]);
  const [cargando, setCargando] = useState(true);
  const [creando, setCreando] = useState(false);

  const reload = useCallback(async () => {
    setCargando(true);
    const { data, error } = await listCupones();
    if (error) toast.error('No se pudieron cargar los cupones: ' + error);
    setCupones(data);
    setCargando(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function toggle(c: Cupon) {
    setCupones((prev) => prev.map((x) => x.id === c.id ? { ...x, activo: !x.activo } : x));
    const { error } = await toggleCupon(c.id, !c.activo);
    if (error) { toast.error(error); void reload(); }
  }

  async function borrar(c: Cupon) {
    if (!window.confirm(`¿Borrar el cupón ${c.code}?`)) return;
    setCupones((prev) => prev.filter((x) => x.id !== c.id));
    const { error } = await eliminarCupon(c.id);
    if (error) { toast.error(error); void reload(); }
    else toast.success('Cupón borrado');
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-ink-muted">Descuentos que se canjean en la tienda online / WhatsApp. Un voucher es un cupón de 1 solo uso.</p>
        <button onClick={() => setCreando(true)}
                className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3.5 py-2 text-sm font-medium inline-flex items-center gap-1.5 shrink-0">
          <Plus className="h-4 w-4" /> Nuevo cupón
        </button>
      </div>

      {cargando ? (
        <div className="py-16 text-center text-ink-muted">Cargando…</div>
      ) : cupones.length === 0 ? (
        <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-16 text-center">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-50 text-brand-500 mb-3"><Ticket className="h-7 w-7" /></div>
          <p className="font-medium">Todavía no hay cupones</p>
          <p className="text-sm text-ink-muted mt-1">Creá uno para tus campañas o para la tienda online.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {cupones.map((c) => (
            <div key={c.id} className={`rounded-2xl bg-white border shadow-card p-4 flex items-center gap-3 flex-wrap ${c.activo ? 'border-ink/5' : 'border-ink/5 opacity-60'}`}>
              <div className="w-12 h-12 rounded-xl bg-brand-50 text-brand-700 grid place-items-center font-medium shrink-0">{valorTxt(c)}</div>
              <div className="flex-1 min-w-[160px]">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{c.code}</span>
                  <button onClick={() => void navigator.clipboard.writeText(c.code).then(() => toast.success('Código copiado'))}
                          className="text-ink-muted hover:text-ink" title="Copiar código"><Copy className="h-3.5 w-3.5" /></button>
                  {!c.activo && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">Pausado</span>}
                </div>
                {c.descripcion && <div className="text-xs text-ink-soft">{c.descripcion}</div>}
                <div className="text-[11px] text-ink-muted mt-0.5">
                  {c.usos_actuales} uso{c.usos_actuales !== 1 ? 's' : ''}{c.max_usos ? ` / ${c.max_usos}` : ''}
                  {c.solo_primera_compra ? ' · 1ª compra' : ''}
                  {c.fecha_hasta ? ` · vence ${new Date(c.fecha_hasta).toLocaleDateString('es-AR')}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button onClick={() => void toggle(c)} title={c.activo ? 'Pausar' : 'Activar'}
                        className={`p-2 rounded-lg border ${c.activo ? 'border-amber-200 text-amber-700 hover:bg-amber-50' : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}>
                  <Power className="h-4 w-4" />
                </button>
                <button onClick={() => void borrar(c)} className="p-2 rounded-lg border border-ink/15 text-ink-soft hover:bg-ink/5" title="Borrar"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creando && (
        <FormCupon
          onClose={() => setCreando(false)}
          onSave={async (input) => {
            const { error } = await crearCupon(tenantId, input);
            if (error) { toast.error(error); return; }
            toast.success('Cupón creado');
            setCreando(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function FormCupon({ onClose, onSave }: {
  onClose: () => void;
  onSave: (input: { code: string; descripcion?: string; tipo: 'porcentaje' | 'monto_fijo'; valor: number; fechaHasta?: string; maxUsos?: number; soloPrimeraCompra?: boolean; canales: CanalCupon[] }) => void;
}) {
  const [code, setCode] = useState('');
  const [descripcion, setDescripcion] = useState('');
  const [tipo, setTipo] = useState<'porcentaje' | 'monto_fijo'>('porcentaje');
  const [valor, setValor] = useState(10);
  const [fechaHasta, setFechaHasta] = useState('');
  const [maxUsos, setMaxUsos] = useState('');
  const [soloPrimera, setSoloPrimera] = useState(false);
  const [voucher, setVoucher] = useState(false);
  const [canalTienda, setCanalTienda] = useState(true);
  const [canalWa, setCanalWa] = useState(true);
  const [guardando, setGuardando] = useState(false);

  async function submit() {
    if (!code.trim()) { toast.error('Falta el código'); return; }
    if (valor <= 0) { toast.error('El valor debe ser mayor a 0'); return; }
    const canales: CanalCupon[] = [];
    if (canalTienda) canales.push('tienda_online');
    if (canalWa) canales.push('whatsapp');
    setGuardando(true);
    await onSave({
      code: code.trim(), descripcion: descripcion.trim() || undefined, tipo, valor,
      fechaHasta: fechaHasta || undefined,
      maxUsos: voucher ? 1 : (maxUsos ? Number(maxUsos) : undefined),
      soloPrimeraCompra: soloPrimera, canales,
    });
    setGuardando(false);
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-medium">Nuevo cupón</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Código *</label>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus placeholder="VOLVE20"
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm font-mono" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Descripción</label>
          <input value={descripcion} onChange={(e) => setDescripcion(e.target.value)} placeholder="20% para clientes que vuelven"
                 className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Tipo</label>
            <select value={tipo} onChange={(e) => setTipo(e.target.value as 'porcentaje' | 'monto_fijo')}
                    className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm bg-white">
              <option value="porcentaje">Porcentaje %</option>
              <option value="monto_fijo">Monto fijo $</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Valor</label>
            <input type="number" min={1} value={valor} onChange={(e) => setValor(Number(e.target.value))}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Vence (opcional)</label>
            <input type="date" value={fechaHasta} onChange={(e) => setFechaHasta(e.target.value)}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">Máx. usos</label>
            <input type="number" min={1} value={voucher ? 1 : maxUsos} disabled={voucher} onChange={(e) => setMaxUsos(e.target.value)}
                   placeholder="ilimitado" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm disabled:bg-ink/5" />
          </div>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={voucher} onChange={(e) => setVoucher(e.target.checked)} className="h-4 w-4" />
            Voucher (1 solo uso)
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={soloPrimera} onChange={(e) => setSoloPrimera(e.target.checked)} className="h-4 w-4" />
            Solo primera compra
          </label>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Dónde se puede usar</label>
          <div className="flex gap-3">
            <label className="flex items-center gap-1.5 text-sm text-ink-soft">
              <input type="checkbox" checked={canalTienda} onChange={(e) => setCanalTienda(e.target.checked)} className="h-4 w-4" /> Tienda online
            </label>
            <label className="flex items-center gap-1.5 text-sm text-ink-soft">
              <input type="checkbox" checked={canalWa} onChange={(e) => setCanalWa(e.target.checked)} className="h-4 w-4" /> WhatsApp
            </label>
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
          <button onClick={() => void submit()} disabled={guardando}
                  className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60">
            {guardando ? 'Creando…' : 'Crear cupón'}
          </button>
        </div>
      </div>
    </div>
  );
}
