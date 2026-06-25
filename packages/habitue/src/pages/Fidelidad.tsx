// Fidelidad — administra el programa de puntos por local (activar, cuánto se
// acumula y cuánto vale el punto) y muestra el ranking de comensales por puntos.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Award, Power, Trophy } from 'lucide-react';
import { listConfigFidelidad, updateFidelidad, listTopPuntos, type FidelidadConfig, type ClientePuntos } from '@/lib/fidelidadService';

function nombre(c: ClientePuntos) {
  return [c.nombre, c.apellido].filter(Boolean).join(' ').trim() || c.telefono || 'Sin nombre';
}

export function Fidelidad() {
  const [configs, setConfigs] = useState<FidelidadConfig[]>([]);
  const [top, setTop] = useState<ClientePuntos[]>([]);
  const [cargando, setCargando] = useState(true);

  const reload = useCallback(async () => {
    setCargando(true);
    const [c, t] = await Promise.all([listConfigFidelidad(), listTopPuntos(50)]);
    if (c.error) toast.error(c.error);
    setConfigs(c.data);
    setTop(t.data);
    setCargando(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function guardar(cfg: FidelidadConfig, patch: { activa?: boolean; puntos_por_peso?: number; pesos_por_punto?: number }) {
    setConfigs((prev) => prev.map((x) => x.settings_id === cfg.settings_id ? { ...x, ...patch } : x));
    const { error } = await updateFidelidad(cfg.settings_id, patch);
    if (error) { toast.error(error); void reload(); }
    else toast.success('Guardado');
  }

  if (cargando) return <div className="py-16 text-center text-ink-muted">Cargando…</div>;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <p className="text-sm text-ink-muted mb-3">
          Configurá los puntos por local. Se acumulan solos al cobrar en COMANDA y el cliente los canjea en la tienda online.
        </p>
        <div className="space-y-2">
          {configs.map((cfg) => (
            <ConfigCard key={cfg.settings_id} cfg={cfg} onGuardar={(p) => void guardar(cfg, p)} />
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium mb-2 inline-flex items-center gap-1.5"><Trophy className="h-4 w-4 text-brand-500" /> Ranking de puntos</p>
        {top.length === 0 ? (
          <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-10 text-center text-sm text-ink-muted">
            Todavía nadie acumuló puntos. Activá el programa arriba.
          </div>
        ) : (
          <div className="rounded-2xl bg-white border border-ink/5 shadow-card divide-y divide-ink/5">
            {top.map((c, i) => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-6 text-center text-sm font-semibold text-ink-muted">{i + 1}</span>
                <span className="flex-1 text-sm font-medium truncate">{nombre(c)}</span>
                <span className="text-sm font-semibold text-brand-700 inline-flex items-center gap-1">
                  <Award className="h-4 w-4" />{Math.round(c.puntos_disponibles)} pts
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConfigCard({ cfg, onGuardar }: { cfg: FidelidadConfig; onGuardar: (p: { activa?: boolean; puntos_por_peso?: number; pesos_por_punto?: number }) => void }) {
  // UI amigable: "1 punto cada $X gastados" (X = 1/puntos_por_peso) y
  // "1 punto = $Y al canjear" (Y = pesos_por_punto).
  const [pesosParaUnPunto, setPesosParaUnPunto] = useState(String(Math.round(cfg.puntos_por_peso > 0 ? 1 / cfg.puntos_por_peso : 100)));
  const [valorPunto, setValorPunto] = useState(String(cfg.pesos_por_punto));

  function guardarRatios() {
    const x = Number(pesosParaUnPunto);
    const y = Number(valorPunto);
    if (!x || x <= 0 || !y || y <= 0) { toast.error('Poné valores válidos'); return; }
    onGuardar({ puntos_por_peso: 1 / x, pesos_por_punto: y });
  }

  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <span className="font-medium">{cfg.nombre}</span>
        <button onClick={() => onGuardar({ activa: !cfg.activa })}
                className={`text-xs px-3 py-1.5 rounded-lg border inline-flex items-center gap-1.5 font-medium ${
                  cfg.activa ? 'bg-emerald-500 text-white border-transparent' : 'bg-white border-ink/15 text-ink-soft'
                }`}>
          <Power className="h-3.5 w-3.5" /> {cfg.activa ? 'Activo' : 'Inactivo'}
        </button>
      </div>
      {cfg.activa && (
        <div className="grid sm:grid-cols-3 gap-3 items-end">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">1 punto cada… ($ gastados)</label>
            <input type="number" min={1} value={pesosParaUnPunto} onChange={(e) => setPesosParaUnPunto(e.target.value)}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink-soft">1 punto vale ($ al canjear)</label>
            <input type="number" min={1} value={valorPunto} onChange={(e) => setValorPunto(e.target.value)}
                   className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
          </div>
          <button onClick={guardarRatios}
                  className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white py-2 text-sm font-medium">Guardar</button>
        </div>
      )}
    </div>
  );
}
