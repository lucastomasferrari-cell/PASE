// IGConfigDrawer — edita la configuración del bot (system prompt, max_tokens,
// rate-limits, modelo). Versión resumida del modal original de PASE.

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
    <div className="fixed inset-0 z-50 bg-ink/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-card p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-xl font-medium inline-flex items-center gap-2">
            <Bot className="h-5 w-5 text-brand-500" /> Configuración del bot
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-ink/5 text-ink-soft"><X className="h-5 w-5" /></button>
        </div>

        {cargando ? (
          <p className="py-10 text-center text-ink-muted text-sm">Cargando…</p>
        ) : !cfg ? (
          <p className="py-10 text-center text-ink-muted text-sm">No se pudo cargar la configuración.</p>
        ) : (
          <>
            <label className="flex items-center justify-between gap-3 p-3 rounded-xl border border-ink/10">
              <div>
                <div className="font-medium text-sm">Bot activo</div>
                <div className="text-[11px] text-ink-muted">Si está apagado, ningún DM se contesta automáticamente.</div>
              </div>
              <input type="checkbox" checked={cfg.activo} onChange={(e) => setCfg({ ...cfg, activo: e.target.checked })} className="h-5 w-5" />
            </label>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-soft">Modelo</label>
              <select value={cfg.modelo ?? MODELOS[1]} onChange={(e) => setCfg({ ...cfg, modelo: e.target.value })}
                      className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm bg-white">
                {MODELOS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <p className="text-[11px] text-ink-muted">Haiku = barato/rápido · Sonnet = balanceado · Opus = más potente.</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink-soft">System prompt (cómo se comporta el bot)</label>
              <textarea rows={6} value={cfg.system_prompt ?? ''} onChange={(e) => setCfg({ ...cfg, system_prompt: e.target.value })}
                        className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm font-mono" placeholder="Sos el asistente de @nekosushi.ar…" />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink-soft">Máx. tokens respuesta</label>
                <input type="number" min={100} max={2048} value={cfg.max_tokens ?? 800}
                       onChange={(e) => setCfg({ ...cfg, max_tokens: Math.min(2048, Math.max(100, Number(e.target.value))) })}
                       className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink-soft">Rate limit (msgs)</label>
                <input type="number" min={1} value={cfg.rate_limit_msgs ?? 30}
                       onChange={(e) => setCfg({ ...cfg, rate_limit_msgs: Number(e.target.value) })}
                       className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-ink-soft">Por (minutos)</label>
                <input type="number" min={1} value={cfg.rate_limit_minutos ?? 5}
                       onChange={(e) => setCfg({ ...cfg, rate_limit_minutos: Number(e.target.value) })}
                       className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
              </div>
            </div>
            <p className="text-[11px] text-ink-muted">El rate-limit previene cost-runaway: si un cliente excede los msgs por minuto se ignora.</p>

            <div className="flex gap-2 pt-1">
              <button onClick={onClose} className="flex-1 rounded-lg border border-ink/15 py-2.5 text-sm font-medium hover:bg-ink/5">Cancelar</button>
              <button onClick={() => void guardar()} disabled={guardando}
                      className="flex-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2.5 text-sm font-medium disabled:opacity-60 inline-flex items-center justify-center gap-1.5">
                <Save className="h-4 w-4" /> {guardando ? 'Guardando…' : 'Guardar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
