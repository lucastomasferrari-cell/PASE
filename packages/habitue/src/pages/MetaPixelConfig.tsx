// MetaPixelConfig — config del Meta Pixel + Conversions API por cliente.
// Vive dentro de Integraciones. Cada tenant carga SU Pixel ID + su token de
// Conversions API. El token no se muestra (secreto): dejarlo vacío conserva el
// actual. Con "activa" prendido, la web pública dispara el Pixel y el server
// manda las conversiones (reservas) a Meta.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Target, Loader2 } from 'lucide-react';
import { getMetaIntegracion, upsertMetaIntegracion } from '@/lib/metaIntegracionService';

export function MetaPixelConfig() {
  const [cargando, setCargando] = useState(true);
  const [sinTabla, setSinTabla] = useState(false);
  const [pixelId, setPixelId] = useState('');
  const [testCode, setTestCode] = useState('');
  const [token, setToken] = useState('');
  const [activa, setActiva] = useState(false);
  const [tokenYaHabia, setTokenYaHabia] = useState(false);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data, sinTabla } = await getMetaIntegracion();
      if (sinTabla) { setSinTabla(true); setCargando(false); return; }
      if (data) {
        setPixelId(data.meta_pixel_id ?? '');
        setTestCode(data.meta_test_event_code ?? '');
        setActiva(data.meta_activa);
        // Si ya hay algo configurado, asumimos que el token también (no se puede leer).
        setTokenYaHabia(Boolean(data.meta_pixel_id));
      }
      setCargando(false);
    })();
  }, []);

  async function guardar() {
    if (activa && !pixelId.trim()) { toast.error('Para activar necesitás el Pixel ID.'); return; }
    setGuardando(true);
    const { ok, error } = await upsertMetaIntegracion({
      pixelId: pixelId.trim(), capiToken: token.trim(), testEventCode: testCode.trim(), activa,
    });
    setGuardando(false);
    if (!ok) { toast.error(error ?? 'No se pudo guardar'); return; }
    setToken('');
    setTokenYaHabia((prev) => prev || Boolean(token.trim()));
    toast.success('Configuración de Meta guardada');
  }

  if (sinTabla) {
    return (
      <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4">
        <div className="flex items-center gap-2 font-medium"><Target className="h-4 w-4 text-brand-600" /> Meta Pixel & Conversiones</div>
        <p className="text-xs text-ink-muted mt-2">Falta aplicar la migración de integraciones de marketing. Avisá para habilitarlo.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-brand-600 shrink-0" />
          <span className="font-medium">Meta Pixel &amp; Conversiones</span>
          {activa && !cargando && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">Activo</span>
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-ink-soft cursor-pointer select-none">
          <input type="checkbox" checked={activa} onChange={(e) => setActiva(e.target.checked)} className="accent-brand-600" />
          Activar
        </label>
      </div>
      <p className="text-xs text-ink-soft mt-1">
        Mide las reservas que llegan por tu pauta y hace que Meta optimice hacia gente que reserva. Los datos los sacás de tu Business Manager → Events Manager.
      </p>

      {cargando ? (
        <div className="py-6 flex justify-center"><Loader2 className="h-4 w-4 animate-spin text-ink-muted" /></div>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <label className="text-xs text-ink-muted block mb-1">Pixel ID (Dataset ID)</label>
            <input
              value={pixelId} onChange={(e) => setPixelId(e.target.value.replace(/\D/g, ''))}
              placeholder="1234567890123456" inputMode="numeric"
              className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-400"
            />
          </div>
          <div>
            <label className="text-xs text-ink-muted block mb-1">
              Access Token (Conversions API){tokenYaHabia && <span className="text-emerald-600"> · ya configurado</span>}
            </label>
            <input
              value={token} onChange={(e) => setToken(e.target.value)} type="password"
              placeholder={tokenYaHabia ? 'Dejar vacío para mantener el actual' : 'Pegá el token de Meta'}
              className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-400"
            />
            <p className="text-[11px] text-ink-muted mt-1">Se guarda cifrado del lado del servidor; no se muestra de nuevo.</p>
          </div>
          <div>
            <label className="text-xs text-ink-muted block mb-1">Código de evento de prueba (opcional)</label>
            <input
              value={testCode} onChange={(e) => setTestCode(e.target.value)}
              placeholder="TEST12345 (solo para probar en Events Manager)"
              className="w-full rounded-lg border border-ink/10 px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-400"
            />
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => void guardar()} disabled={guardando}
              className="rounded-lg bg-brand-500 hover:bg-brand-600 disabled:opacity-60 text-white px-4 py-2 text-sm font-medium inline-flex items-center gap-1.5"
            >
              {guardando && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Guardar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
