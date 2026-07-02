// Configuración de reservas — sección del admin de MESA.
// Unifica en MESA lo que antes vivía en COMANDA → Config → Reservas:
// on/off, horarios por día, capacidad, anticipación, duración, teléfono
// obligatorio, confirmación manual, combinar mesas, pacing y nota pública.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Save, Clock, Loader2, Users, Globe, MessageSquare } from 'lucide-react';
import { db } from '@/lib/supabase';

const DIAS: { dia: number; label: string }[] = [
  { dia: 1, label: 'Lunes' }, { dia: 2, label: 'Martes' }, { dia: 3, label: 'Miércoles' },
  { dia: 4, label: 'Jueves' }, { dia: 5, label: 'Viernes' }, { dia: 6, label: 'Sábado' },
  { dia: 0, label: 'Domingo' },
];

// Los horarios son los del NEGOCIO (columnas horario_dom..sab, formato
// "HH:MM – HH:MM" o null=cerrado). Es el único origen: la página pública los
// muestra y el motor de reservas los deriva (trigger sync_reservas_horarios).
const HCOL: Record<number, string> = {
  0: 'horario_dom', 1: 'horario_lun', 2: 'horario_mar', 3: 'horario_mie',
  4: 'horario_jue', 5: 'horario_vie', 6: 'horario_sab',
};
function parseHorario(txt: string | null | undefined): { activo: boolean; abre: string; cierra: string } {
  const parts = txt ? txt.split(/\s*[–-]\s*/) : [];
  if (parts.length >= 2 && parts[0] && parts[1]) return { activo: true, abre: parts[0].trim(), cierra: parts[1].trim() };
  return { activo: false, abre: '20:00', cierra: '00:00' };
}
interface Form {
  activas: boolean;
  requiere_confirmacion: boolean;
  telefono_obligatorio: boolean;
  permite_combinar: boolean;
  capacidad_max: string;
  anticipacion_min_hs: string;
  anticipacion_max_dias: string;
  duracion_estimada_min: string;
  pacing_max: string;
  notas_visibles: string;
  horarios: { dia: number; activo: boolean; abre: string; cierra: string }[];
}

export function AdminReservasConfig({ settingsId }: { settingsId: number }) {
  const [form, setForm] = useState<Form | null>(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data } = await db().from('comanda_local_settings').select('*').eq('id', settingsId).maybeSingle();
    const s = (data ?? {}) as Record<string, unknown>;
    setForm({
      activas: Boolean(s.reservas_activas),
      requiere_confirmacion: Boolean(s.reservas_requiere_confirmacion),
      telefono_obligatorio: s.reservas_telefono_obligatorio == null ? true : Boolean(s.reservas_telefono_obligatorio),
      permite_combinar: s.reservas_permite_combinar == null ? true : Boolean(s.reservas_permite_combinar),
      capacidad_max: s.reservas_capacidad_max != null ? String(s.reservas_capacidad_max) : '',
      anticipacion_min_hs: String(s.reservas_anticipacion_min_hs ?? 2),
      anticipacion_max_dias: String(s.reservas_anticipacion_max_dias ?? 30),
      duracion_estimada_min: String(s.reservas_duracion_estimada_min ?? 90),
      pacing_max: s.reservas_pacing_max_por_franja != null ? String(s.reservas_pacing_max_por_franja) : '',
      notas_visibles: (s.reservas_notas_visibles_cliente as string | null) ?? '',
      horarios: DIAS.map(({ dia }) => {
        const p = parseHorario(s[HCOL[dia]!] as string | null);
        return { dia, activo: p.activo, abre: p.abre, cierra: p.cierra };
      }),
    });
    setCargando(false);
  }, [settingsId]);

  useEffect(() => { void cargar(); }, [cargar]);

  async function guardar() {
    if (!form) return;
    setGuardando(true);
    try {
      // Escribimos las columnas de negocio horario_* (única fuente); el trigger
      // deriva reservas_horarios para el motor. Así la página pública y las
      // reservas quedan siempre en sync con lo que se edita acá.
      const horariosCols: Record<string, string | null> = {};
      for (const h of form.horarios) horariosCols[HCOL[h.dia]!] = h.activo ? `${h.abre} – ${h.cierra}` : null;
      const { error } = await db().from('comanda_local_settings').update({
        reservas_activas: form.activas,
        reservas_requiere_confirmacion: form.requiere_confirmacion,
        reservas_telefono_obligatorio: form.telefono_obligatorio,
        reservas_permite_combinar: form.permite_combinar,
        reservas_capacidad_max: form.capacidad_max ? Number(form.capacidad_max) : null,
        reservas_anticipacion_min_hs: Number(form.anticipacion_min_hs) || 2,
        reservas_anticipacion_max_dias: Number(form.anticipacion_max_dias) || 30,
        reservas_duracion_estimada_min: Number(form.duracion_estimada_min) || 90,
        reservas_pacing_max_por_franja: form.pacing_max ? Number(form.pacing_max) : null,
        reservas_notas_visibles_cliente: form.notas_visibles.trim() || null,
        ...horariosCols,
        updated_at: new Date().toISOString(),
      }).eq('id', settingsId);
      if (error) { toast.error('No se pudo guardar: ' + error.message); return; }
      toast.success('Configuración guardada');
    } finally { setGuardando(false); }
  }

  function set(patch: Partial<Form>) { setForm((f) => f ? { ...f, ...patch } : f); }
  function setHorario(dia: number, patch: Partial<{ activo: boolean; abre: string; cierra: string }>) {
    setForm((f) => f ? { ...f, horarios: f.horarios.map((h) => h.dia === dia ? { ...h, ...patch } : h) } : f);
  }

  if (cargando || !form) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-ink-muted" /></div>;
  }

  const input = 'w-full rounded-lg border border-ink/15 px-3 py-2 text-sm';

  return (
    <div className="mt-6 max-w-3xl space-y-6 pb-10">
      {/* Reservas online */}
      <Card icon={<Globe className="h-4 w-4 text-brand-500" />} title="Reservas online">
        <Row label="Aceptar reservas por internet" desc="Prende/apaga la página pública de reservas de este local.">
          <Toggle checked={form.activas} onChange={(v) => set({ activas: v })} />
        </Row>
        <Row label="Requiere confirmación manual" desc="Las reservas entran como 'pendiente' hasta que las confirmás vos.">
          <Toggle checked={form.requiere_confirmacion} onChange={(v) => set({ requiere_confirmacion: v })} />
        </Row>
        <Row label="Teléfono obligatorio" desc="Le pide el teléfono al cliente al reservar.">
          <Toggle checked={form.telefono_obligatorio} onChange={(v) => set({ telefono_obligatorio: v })} />
        </Row>
      </Card>

      {/* Cupo y tiempos */}
      <Card icon={<Users className="h-4 w-4 text-brand-500" />} title="Cupo y tiempos">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Capacidad simultánea (cubiertos)"><input type="number" min={0} className={input} value={form.capacidad_max} placeholder="ej. 40" onChange={(e) => set({ capacidad_max: e.target.value })} /></Field>
          <Field label="Duración estimada por reserva (min)"><input type="number" min={30} className={input} value={form.duracion_estimada_min} onChange={(e) => set({ duracion_estimada_min: e.target.value })} /></Field>
          <Field label="Anticipación mínima (horas)"><input type="number" min={0} className={input} value={form.anticipacion_min_hs} onChange={(e) => set({ anticipacion_min_hs: e.target.value })} /></Field>
          <Field label="Anticipación máxima (días)"><input type="number" min={1} className={input} value={form.anticipacion_max_dias} onChange={(e) => set({ anticipacion_max_dias: e.target.value })} /></Field>
        </div>
      </Card>

      {/* Asignación de mesas */}
      <Card icon={<Users className="h-4 w-4 text-brand-500" />} title="Asignación de mesas">
        <p className="text-xs text-ink-muted -mt-1">Las reservas se asignan a una mesa real según la capacidad (las mesas se cargan en la sección Mapa de mesas).</p>
        <Row label="Combinar mesas" desc="Si un grupo no entra en una mesa, junta dos (ej. dos de 4 para un grupo de 6).">
          <Toggle checked={form.permite_combinar} onChange={(v) => set({ permite_combinar: v })} />
        </Row>
        <Field label="Máx. reservas por franja de 15 min (pacing)">
          <input type="number" min={0} className="w-32 rounded-lg border border-ink/15 px-3 py-2 text-sm" value={form.pacing_max} placeholder="sin límite" onChange={(e) => set({ pacing_max: e.target.value })} />
          <p className="text-xs text-ink-muted mt-1">Limita cuántas reservas arrancan juntas para no saturar la cocina. Vacío = sin límite.</p>
        </Field>
      </Card>

      {/* Horarios */}
      <Card icon={<Clock className="h-4 w-4 text-brand-500" />} title="Horarios de atención">
        <p className="text-xs text-ink-muted -mt-1">Los días y franjas en que abre el local. Es lo que se muestra en la página pública y lo que habilita las reservas online (un solo lugar para editarlo).</p>
        <div className="space-y-2">
          {form.horarios.map((h) => (
            <div key={h.dia} className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-2 w-32 shrink-0 cursor-pointer">
                <Toggle checked={h.activo} onChange={(v) => setHorario(h.dia, { activo: v })} />
                <span className="text-sm">{DIAS.find((d) => d.dia === h.dia)?.label}</span>
              </label>
              {h.activo ? (
                <div className="flex items-center gap-2">
                  <input type="time" value={h.abre} onChange={(e) => setHorario(h.dia, { abre: e.target.value })} className="w-28 rounded-lg border border-ink/15 px-2 py-1.5 text-sm" />
                  <span className="text-ink-muted text-sm">a</span>
                  <input type="time" value={h.cierra} onChange={(e) => setHorario(h.dia, { cierra: e.target.value })} className="w-28 rounded-lg border border-ink/15 px-2 py-1.5 text-sm" />
                </div>
              ) : <span className="text-xs text-ink-muted/60 italic">cerrado</span>}
            </div>
          ))}
        </div>
      </Card>

      {/* Nota pública */}
      <Card icon={<MessageSquare className="h-4 w-4 text-brand-500" />} title="Mensaje para el cliente">
        <Field label="Nota visible en el formulario de reserva">
          <textarea rows={3} className={input} value={form.notas_visibles} placeholder="Ej: Aceptamos hasta 10 personas por reserva. Para grupos más grandes, escribinos." onChange={(e) => set({ notas_visibles: e.target.value })} />
        </Field>
      </Card>

      <div className="flex justify-end">
        <button onClick={() => void guardar()} disabled={guardando}
                className="rounded-lg bg-brand-500 hover:bg-brand-600 text-white px-6 py-2.5 text-sm font-medium disabled:opacity-60 inline-flex items-center gap-2">
          {guardando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Guardar configuración
        </button>
      </div>
    </div>
  );
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white border border-ink/5 shadow-card p-5 space-y-4">
      <p className="font-medium flex items-center gap-2">{icon}{title}</p>
      {children}
    </div>
  );
}
function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div><p className="text-sm font-medium">{label}</p>{desc && <p className="text-xs text-ink-muted mt-0.5">{desc}</p>}</div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><label className="text-xs font-medium text-ink-soft">{label}</label>{children}</div>;
}
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
            className={`w-10 h-6 rounded-full transition-colors relative shrink-0 ${checked ? 'bg-brand-500' : 'bg-ink/20'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
    </button>
  );
}
