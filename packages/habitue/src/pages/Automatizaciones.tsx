// Automatizaciones — flows lifecycle (recuperá perdidos, cumpleaños, bienvenida,
// premio a recurrentes). Se definen y activan acá; la ejecución en horario es una
// edge function/cron que se enchufa al conectar WhatsApp/email (integración).

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Zap, Power, Trash2, Plus, ArrowRight } from 'lucide-react';
import {
  listAutomatizaciones, crearAutomatizacion, toggleAutomatizacion, eliminarAutomatizacion,
  PLANTILLAS_FLOW, type Automatizacion,
} from '@/lib/automatizacionesService';

interface Props { tenantId: string; }

const TRIGGER_LABEL: Record<string, string> = {
  sin_pedir_dias: 'No pide hace X días',
  cumpleanos: 'Es su cumpleaños',
  primera_compra: 'Hizo su primera compra',
  recurrente: 'Es recurrente',
  post_visita: 'Después de una visita',
};
const ACCION_LABEL: Record<string, string> = {
  enviar_campana: 'Enviar mensaje',
  dar_cupon: 'Dar cupón',
};

function describir(a: Automatizacion): string {
  const t = a.trigger_tipo === 'sin_pedir_dias' ? `No pide hace ${(a.trigger_params as { dias?: number }).dias ?? 60} días` : TRIGGER_LABEL[a.trigger_tipo];
  const canal = (a.accion_params as { canal?: string }).canal;
  const acc = a.accion_tipo === 'enviar_campana' ? `Enviar ${canal ?? 'mensaje'}` : ACCION_LABEL[a.accion_tipo];
  return `${t} → ${acc}`;
}

export function Automatizaciones({ tenantId }: Props) {
  const [flows, setFlows] = useState<Automatizacion[]>([]);
  const [sinTabla, setSinTabla] = useState(false);
  const [cargando, setCargando] = useState(true);

  const reload = useCallback(async () => {
    setCargando(true);
    const { data, sinTabla, error } = await listAutomatizaciones();
    if (error) toast.error(error);
    setFlows(data); setSinTabla(sinTabla);
    setCargando(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  async function agregarPlantilla(p: typeof PLANTILLAS_FLOW[number]) {
    const { error } = await crearAutomatizacion(tenantId, { ...p.input, activa: false });
    if (error) { toast.error(error); return; }
    toast.success(`"${p.nombre}" agregada (apagada — activala cuando quieras)`);
    void reload();
  }
  async function toggle(a: Automatizacion) {
    setFlows((prev) => prev.map((x) => x.id === a.id ? { ...x, activa: !x.activa } : x));
    const { error } = await toggleAutomatizacion(a.id, !a.activa);
    if (error) { toast.error(error); void reload(); }
    else if (!a.activa) toast.success('Activada — correrá automáticamente cuando esté conectado WhatsApp/email');
  }
  async function borrar(a: Automatizacion) {
    setFlows((prev) => prev.filter((x) => x.id !== a.id));
    const { error } = await eliminarAutomatizacion(a.id);
    if (error) { toast.error(error); void reload(); }
  }

  return (
    <div className="space-y-5 max-w-3xl">
      <p className="text-sm text-ink-muted">
        Flows que corren solos: cuando pasa algo (un cliente se pierde, cumple años, compra por primera vez), se dispara una acción.
      </p>

      {sinTabla && (
        <div className="rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm p-3">
          Las automatizaciones necesitan aplicar la migración <span className="font-mono text-xs">202606250600</span> (en tus pendientes). Igual podés ver las plantillas.
        </div>
      )}

      {/* Plantillas */}
      <div>
        <p className="text-xs normal-case tracking-wide text-ink-muted mb-2">Plantillas listas</p>
        <div className="grid sm:grid-cols-2 gap-3">
          {PLANTILLAS_FLOW.map((p) => (
            <div key={p.nombre} className="rounded-2xl bg-white border border-ink/5 shadow-card p-4">
              <div className="flex items-start justify-between gap-2">
                <span className="text-2xl">{p.emoji}</span>
                <button onClick={() => void agregarPlantilla(p)} disabled={sinTabla}
                        className="text-xs rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-2.5 py-1.5 font-medium inline-flex items-center gap-1 disabled:opacity-50">
                  <Plus className="h-3.5 w-3.5" /> Agregar
                </button>
              </div>
              <div className="font-medium mt-2">{p.nombre}</div>
              <p className="text-xs text-ink-muted mt-0.5">{p.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Activas */}
      <div>
        <p className="text-xs normal-case tracking-wide text-ink-muted mb-2 inline-flex items-center gap-1"><Zap className="h-3.5 w-3.5" /> Tus automatizaciones</p>
        {cargando ? (
          <div className="py-10 text-center text-ink-muted">Cargando…</div>
        ) : flows.length === 0 ? (
          <div className="rounded-2xl bg-white border border-ink/5 shadow-card py-12 text-center">
            <p className="font-medium">Todavía no tenés automatizaciones</p>
            <p className="text-sm text-ink-muted mt-1">Agregá una plantilla de arriba para empezar.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {flows.map((a) => (
              <div key={a.id} className={`rounded-2xl bg-white border shadow-card p-4 flex items-center gap-3 flex-wrap ${a.activa ? 'border-emerald-200' : 'border-ink/5'}`}>
                <div className="flex-1 min-w-[180px]">
                  <div className="font-medium">{a.nombre}</div>
                  <div className="text-xs text-ink-soft inline-flex items-center gap-1 mt-0.5">
                    {describir(a)} <ArrowRight className="h-3 w-3 hidden" />
                  </div>
                  <div className="text-[11px] text-ink-muted mt-0.5">{a.disparos} disparos{a.ultima_corrida_at ? ` · última ${new Date(a.ultima_corrida_at).toLocaleDateString('es-AR')}` : ''}</div>
                </div>
                <button onClick={() => void toggle(a)}
                        className={`text-xs px-3 py-1.5 rounded-lg border inline-flex items-center gap-1.5 font-medium ${a.activa ? 'bg-emerald-500 text-white border-transparent' : 'bg-white border-ink/15 text-ink-soft'}`}>
                  <Power className="h-3.5 w-3.5" /> {a.activa ? 'Activa' : 'Apagada'}
                </button>
                <button onClick={() => void borrar(a)} className="p-2 rounded-lg border border-ink/15 text-ink-soft hover:bg-ink/5"><Trash2 className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[11px] text-ink-muted">
        Cuando una automatización está activa, corre sola en horario (eso lo enciende la integración de WhatsApp/email + un cron). Hasta entonces quedan definidas y listas.
      </p>
    </div>
  );
}
