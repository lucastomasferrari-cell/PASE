// Integraciones — hub para conectar las APIs externas (WhatsApp Business, email,
// Meta/Google Ads, Search Console, Instagram). Todo está diseñado y cableado;
// "Conectar" queda pendiente del código de integración (OAuth/API key).

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Check, Plug, ChevronRight } from 'lucide-react';
import { INTEGRACIONES, listEstados, type EstadoIntegracion, type IntegracionDef } from '@/lib/integraciones';

const CATS: IntegracionDef['categoria'][] = ['Mensajería', 'Publicidad', 'SEO'];

export function Integraciones() {
  const [estados, setEstados] = useState<Record<string, EstadoIntegracion>>({});
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    void (async () => {
      const { estados } = await listEstados();
      setEstados(estados);
      setCargando(false);
    })();
  }, []);

  function conectar(def: IntegracionDef) {
    toast('Integración pendiente', { description: `Para conectar ${def.nombre}: ${def.comoConectar}` });
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <p className="text-sm text-ink-muted">
        Conectá tus herramientas para automatizar campañas y traer las métricas reales. Está todo listo — falta enchufar cada API.
      </p>

      {CATS.map((cat) => (
        <div key={cat}>
          <p className="text-xs uppercase tracking-wide text-ink-muted mb-2">{cat}</p>
          <div className="space-y-2">
            {INTEGRACIONES.filter((i) => i.categoria === cat).map((def) => {
              const estado = estados[def.id] ?? 'desconectado';
              const conectado = estado === 'conectado';
              return (
                <div key={def.id} className="rounded-2xl bg-white border border-ink/5 shadow-card p-4">
                  <div className="flex items-start gap-3">
                    <span className="text-2xl shrink-0">{def.emoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{def.nombre}</span>
                        {conectado ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 inline-flex items-center gap-1"><Check className="h-3 w-3" />Conectado</span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">No conectado</span>
                        )}
                      </div>
                      <p className="text-xs text-ink-soft mt-1">{def.descripcion}</p>
                      <p className="text-xs text-brand-700 mt-1.5">🔓 {def.desbloquea}</p>
                    </div>
                    {!conectado && (
                      <button onClick={() => conectar(def)}
                              className="shrink-0 rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3 py-1.5 text-sm font-medium inline-flex items-center gap-1">
                        <Plug className="h-3.5 w-3.5" /> Conectar
                      </button>
                    )}
                  </div>
                  <details className="mt-2 group">
                    <summary className="text-xs text-ink-muted cursor-pointer inline-flex items-center gap-1 list-none">
                      <ChevronRight className="h-3 w-3 group-open:rotate-90 transition-transform" /> Cómo se conecta
                    </summary>
                    <p className="text-xs text-ink-muted mt-1.5 pl-4">{def.comoConectar}</p>
                  </details>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {!cargando && (
        <p className="text-[11px] text-ink-muted">
          La conexión real (OAuth / API keys) se guarda en la tabla <span className="font-mono">integraciones</span> (migración 202606250600). Mientras tanto, WhatsApp y email funcionan en modo manual desde las campañas.
        </p>
      )}
    </div>
  );
}
