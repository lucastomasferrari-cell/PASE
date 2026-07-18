// IGConfigDrawer — edita la configuración del bot (system prompt, max_tokens,
// rate-limits, modelo).
//
// Look "Cocina.OS Command Center" (17-jul-2026): modal dark — overlay negro,
// panel navy, labels mono uppercase, pills outline. Solo presentación.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { X, Bot, Save } from 'lucide-react';
import { getConfig, updateConfig, type IGConfig } from '@/lib/igService';

const MODELOS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-8'];

export function IGConfigDrawer({ cuentaId, onClose }: { cuentaId: number; onClose: () => void }) {
  const [cfg, setCfg] = useState<IGConfig | null>(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data, error } = await getConfig(cuentaId);
      if (error) toast.error(error);
      setCfg(data);
      setCargando(false);
    })();
  }, [cuentaId]);

  async function guardar() {
    if (!cfg) return;
    setGuardando(true);
    const { error } = await updateConfig(cfg.id, cfg);
    setGuardando(false);
    if (error) { toast.error(error); return; }
    toast.success('Config guardada');
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-end sm:items-center justify-center p-0 sm:p-6" onClick={onClose}>
      <div className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto bg-carbon-800 border border-carbon-600 rounded-t-2xl sm:rounded shadow-card overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-carbon-600 flex items-center justify-between">
          <h3 className="mono text-xs font-bold uppercase tracking-widest text-dim-50 inline-flex items-center gap-2">
            <Bot className="h-4 w-4 text-brand-400" /> BOT_CONFIGURATION
          </h3>
          <button onClick={onClose} aria-label="Cerrar" className="text-dim-300 hover:text-dim-50 transition-colors"><X className="h-5 w-5" /></button>
        </div>

        {cargando ? (
          <p className="py-10 text-center text-dim-300 mono text-[10px] uppercase tracking-widest">Cargando…</p>
        ) : !cfg ? (
          <p className="py-10 text-center text-dim-300 mono text-[10px] uppercase tracking-widest">No se pudo cargar la configuración.</p>
        ) : (
          <div className="p-6 space-y-6">
            <label className="flex items-center justify-between gap-3 p-3 rounded border border-carbon-600">
              <div>
                <div className="mono text-[10px] uppercase tracking-widest text-dim-50">Bot activo</div>
                <div className="text-[11px] text-dim-300 mt-1">Si está apagado, ningún DM se contesta automáticamente.</div>
              </div>
              <input type="checkbox" checked={cfg.activo} onChange={(e) => setCfg({ ...cfg, activo: e.target.checked })} className="h-5 w-5 accent-brand-400 shrink-0" />
            </label>

            <div className="space-y-2">
              <label className="mono text-[10px] uppercase tracking-widest text-dim-300 block">Modelo</label>
              <select value={cfg.modelo ?? MODELOS[1]} onChange={(e) => setCfg({ ...cfg, modelo: e.target.value })}
                      className="w-full mono text-sm text-dim-50 py-2">
                {MODELOS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <p className="text-[11px] text-dim-300">Haiku = barato/rápido · Sonnet = balanceado · Opus = más potente.</p>
            </div>

            <div className="space-y-2">
              <label className="mono text-[10px] uppercase tracking-widest text-dim-300 block">System prompt (cómo se comporta el bot)</label>
              <textarea rows={6} value={cfg.system_prompt ?? ''} onChange={(e) => setCfg({ ...cfg, system_prompt: e.target.value })}
                        className="mono text-xs w-full bg-black/20 border border-carbon-600 rounded p-3 text-dim-50 focus:border-brand-400" placeholder="Sos el asistente de @nekosushi.ar…" />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <label className="mono text-[10px] uppercase tracking-widest text-dim-300 block">Máx. tokens respuesta</label>
                <input type="number" min={100} max={2048} value={cfg.max_tokens ?? 800}
                       onChange={(e) => setCfg({ ...cfg, max_tokens: Math.min(2048, Math.max(100, Number(e.target.value))) })}
                       className="w-full mono text-sm text-dim-50 py-2" />
              </div>
              <div className="space-y-2">
                <label className="mono text-[10px] uppercase tracking-widest text-dim-300 block">Rate limit (msgs)</label>
                <input type="number" min={1} value={cfg.rate_limit_msgs ?? 30}
                       onChange={(e) => setCfg({ ...cfg, rate_limit_msgs: Number(e.target.value) })}
                       className="w-full mono text-sm text-dim-50 py-2" />
              </div>
              <div className="space-y-2">
                <label className="mono text-[10px] uppercase tracking-widest text-dim-300 block">Por (minutos)</label>
                <input type="number" min={1} value={cfg.rate_limit_minutos ?? 5}
                       onChange={(e) => setCfg({ ...cfg, rate_limit_minutos: Number(e.target.value) })}
                       className="w-full mono text-sm text-dim-50 py-2" />
              </div>
            </div>
            <p className="text-[11px] text-dim-300">El rate-limit previene cost-runaway: si un cliente excede los msgs por minuto se ignora.</p>

            <div className="flex gap-2 pt-1">
              <button onClick={onClose} className="mono text-[10px] flex-1 py-3 rounded border border-slate-700 text-dim-300 hover:text-dim-50 uppercase tracking-widest transition-colors">Cancelar</button>
              <button onClick={() => void guardar()} disabled={guardando}
                      className="mono text-[10px] flex-1 py-3 rounded border border-brand-400/40 bg-brand-400/5 text-brand-400 hover:bg-brand-400/10 uppercase tracking-widest inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-50">
                <Save className="h-4 w-4" /> {guardando ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
