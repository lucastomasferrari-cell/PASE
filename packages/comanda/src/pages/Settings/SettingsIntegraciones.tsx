// SettingsIntegraciones — hub central de credenciales del tenant.
//
// Listado de providers (WhatsApp, Email, Stripe, etc.) con su estado actual.
// Por cada provider: card con info, formulario para pegar credentials, botones
// para guardar / probar conexión / desconectar. Cuando un provider queda en
// estado "conectado", todo el ecosistema empieza a usar esas credenciales:
//   - WhatsApp → confirmaciones de reserva (MESA), emails del marketplace
//   - Email → recibos del marketplace, campañas Habitué
//   - Stripe → billing recurrente Admin Console
//   - Meta Ads → métricas Pauta Habitué
//   - Google Maps → reseñas Calidad Habitué

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, AlertCircle, XCircle, Trash2, RefreshCw, ChevronDown, ChevronRight, Plug, Loader2 } from 'lucide-react';
import {
  PROVIDERS, listIntegraciones, guardarCredencial, borrarCredencial, probarCredencial,
  type IntegracionRow, type ProviderDef, type ProviderId,
} from '@/lib/integracionesService';

export function SettingsIntegraciones() {
  const [integraciones, setIntegraciones] = useState<IntegracionRow[]>([]);
  const [cargando, setCargando] = useState(true);
  const [abierto, setAbierto] = useState<ProviderId | null>(null);

  const reload = useCallback(async () => {
    setCargando(true);
    const { data, error } = await listIntegraciones();
    if (error) toast.error(error);
    setIntegraciones(data);
    setCargando(false);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const integMap = new Map<ProviderId, IntegracionRow>();
  for (const i of integraciones) integMap.set(i.provider, i);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Integraciones</h1>
        <p className="text-sm text-ink-muted mt-1">
          Conectá los servicios externos para activar las features automáticas. Pegá las credenciales y todo el ecosistema empieza a usarlas.
        </p>
      </header>

      {cargando ? (
        <div className="py-16 text-center text-ink-muted text-sm inline-flex items-center justify-center gap-2 w-full">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando integraciones…
        </div>
      ) : (
        <div className="space-y-3">
          {PROVIDERS.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              integracion={integMap.get(p.id) ?? null}
              isOpen={abierto === p.id}
              onToggle={() => setAbierto((curr) => curr === p.id ? null : p.id)}
              onSaved={() => void reload()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderCard({
  provider, integracion, isOpen, onToggle, onSaved,
}: {
  provider: ProviderDef;
  integracion: IntegracionRow | null;
  isOpen: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const estado = integracion?.estado ?? 'desconectado';
  const EstadoIcon = estado === 'conectado' ? CheckCircle2
    : estado === 'error' ? XCircle
    : estado === 'probando' ? RefreshCw : Plug;
  const estadoColor = estado === 'conectado' ? 'text-emerald-600'
    : estado === 'error' ? 'text-red-600' : 'text-ink-muted';

  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card overflow-hidden">
      <button onClick={onToggle} className="w-full p-4 flex items-center gap-3 hover:bg-ink/5 transition">
        <div className="text-2xl">{provider.emoji}</div>
        <div className="flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink">{provider.nombre}</span>
            <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-ink/5 text-ink-soft">{provider.categoria}</span>
          </div>
          <div className="text-xs text-ink-muted mt-0.5 line-clamp-1">{provider.desbloquea}</div>
        </div>
        <div className={`flex items-center gap-1.5 text-xs font-medium ${estadoColor}`}>
          <EstadoIcon className={`h-4 w-4 ${estado === 'probando' ? 'animate-spin' : ''}`} />
          {estado === 'conectado' ? 'Conectado' : estado === 'error' ? 'Error' : estado === 'probando' ? 'Probando…' : 'No conectado'}
        </div>
        {isOpen ? <ChevronDown className="h-4 w-4 text-ink-soft" /> : <ChevronRight className="h-4 w-4 text-ink-soft" />}
      </button>

      {isOpen && (
        <ProviderForm
          provider={provider}
          integracion={integracion}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

function ProviderForm({
  provider, integracion, onSaved,
}: {
  provider: ProviderDef;
  integracion: IntegracionRow | null;
  onSaved: () => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of provider.campos) init[f.key] = '';
    return init;
  });
  const [notas, setNotas] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [probando, setProbando] = useState(false);

  async function guardar() {
    // Solo enviar campos no vacíos. Si el user dejó un campo blank, queremos
    // PRESERVAR el valor previo (no pisar con string vacío).
    const config: Record<string, string> = {};
    for (const f of provider.campos) {
      const v = vals[f.key]?.trim();
      if (v) config[f.key] = v;
    }
    if (Object.keys(config).length === 0 && !notas) {
      toast.error('No hay nada para guardar.');
      return;
    }
    setGuardando(true);
    const { error } = await guardarCredencial(provider.id, config, notas || undefined);
    setGuardando(false);
    if (error) { toast.error(error); return; }
    toast.success('Guardado. Probá la conexión.');
    setVals(() => {
      const cleared: Record<string, string> = {};
      for (const f of provider.campos) cleared[f.key] = '';
      return cleared;
    });
    onSaved();
  }

  async function probar() {
    setProbando(true);
    const { ok, error } = await probarCredencial(provider.id);
    setProbando(false);
    if (ok) toast.success('Conexión OK');
    else toast.error(error || 'Conexión falló');
    onSaved();
  }

  async function desconectar() {
    if (!confirm(`¿Desconectar ${provider.nombre}? Las features que dependen de esta credencial dejan de funcionar.`)) return;
    const { error } = await borrarCredencial(provider.id);
    if (error) { toast.error(error); return; }
    toast.success('Desconectado');
    onSaved();
  }

  return (
    <div className="border-t border-ink/5 p-4 space-y-4 bg-ink/[0.02]">
      <p className="text-sm text-ink-muted">{provider.desbloquea}</p>

      <div className="text-xs bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3">
        <span className="font-medium">¿Cómo conseguir las credenciales?</span><br />
        {provider.comoConseguir}
      </div>

      <div className="space-y-3">
        {provider.campos.map((f) => {
          const yaTiene = integracion?.config_keys?.includes(f.key);
          const preview = integracion?.config_preview?.[f.key] as string | undefined;
          return (
            <div key={f.key} className="space-y-1.5">
              <label className="text-xs font-medium text-ink-soft">
                {f.label}
                {yaTiene && <span className="ml-2 text-emerald-600 font-normal">✓ guardada ({preview})</span>}
              </label>
              <input
                type={f.type}
                value={vals[f.key] || ''}
                onChange={(e) => setVals((curr) => ({ ...curr, [f.key]: e.target.value }))}
                placeholder={yaTiene ? 'Dejar vacío para no cambiar' : f.placeholder}
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm font-mono"
              />
              {f.help && <p className="text-[11px] text-ink-muted">{f.help}</p>}
            </div>
          );
        })}

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-ink-soft">Notas (opcional)</label>
          <input
            value={notas}
            onChange={(e) => setNotas(e.target.value)}
            placeholder='Ej: "Cuenta de Anto", "Token regenerado el 15-jul"'
            className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm"
          />
        </div>
      </div>

      {integracion?.estado === 'error' && integracion.ultimo_error && (
        <div className="text-xs bg-red-50 border border-red-200 text-red-900 rounded-lg p-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Última prueba falló:</span> {integracion.ultimo_error}
          </div>
        </div>
      )}

      <div className="flex gap-2 flex-wrap pt-1">
        <button onClick={guardar} disabled={guardando}
                className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-3.5 py-2 text-sm font-medium disabled:opacity-50">
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
        {integracion && (
          <button onClick={probar} disabled={probando}
                  className="rounded-lg border border-ink/15 hover:bg-ink/5 px-3.5 py-2 text-sm font-medium inline-flex items-center gap-1.5 disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${probando ? 'animate-spin' : ''}`} />
            {probando ? 'Probando…' : 'Probar conexión'}
          </button>
        )}
        {integracion && (
          <button onClick={desconectar}
                  className="ml-auto rounded-lg border border-red-200 hover:bg-red-50 text-red-700 px-3 py-2 text-sm font-medium inline-flex items-center gap-1.5">
            <Trash2 className="h-3.5 w-3.5" /> Desconectar
          </button>
        )}
      </div>
    </div>
  );
}
