// Configuración de reservas — sección del admin de MESA.
// Unifica en MESA lo que antes vivía en COMANDA → Config → Reservas:
// on/off, horarios por día, capacidad, anticipación, duración, teléfono
// obligatorio, confirmación manual, pacing y nota pública.
// (Combinar mesas y los límites por sector ahora viven en la sección Mesas.)

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Save, Clock, Loader2, Users, Globe, MessageSquare, Mail, FileText } from 'lucide-react';
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
interface MailTpl { titulo: string; subtitulo: string }
interface Form {
  activas: boolean;
  requiere_confirmacion: boolean;
  telefono_obligatorio: boolean;
  email_obligatorio: boolean;
  capacidad_max: string;
  anticipacion_min_hs: string;
  anticipacion_max_dias: string;
  duracion_estimada_min: string;
  slot_min: string;
  pacing_max: string;
  notas_visibles: string;
  horarios: { dia: number; activo: boolean; abre: string; cierra: string }[];
  notif_confirmacion: boolean;
  notif_recordatorio: boolean;
  notif_resena: boolean;
  notif_hora: string;
  tpl_confirmacion: MailTpl;
  tpl_recordatorio: MailTpl;
  tpl_resena: MailTpl;
}

export function AdminReservasConfig({ settingsId }: { settingsId: number }) {
  const [form, setForm] = useState<Form | null>(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  // Cubiertos reservables reales (suma de la capacidad de las mesas reservables).
  // Si el local tiene mesas, la capacidad se deriva de ahí y el campo plano
  // "Capacidad simultánea" no aplica (el motor asigna mesa real, no cupo global).
  const [cubiertos, setCubiertos] = useState<number | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data } = await db().from('comanda_local_settings').select('*').eq('id', settingsId).maybeSingle();
    const s = (data ?? {}) as Record<string, unknown>;

    // Cubiertos reservables del local (para saber si mostrar el cupo plano).
    const localId = s.local_id as number | undefined;
    if (localId) {
      const { data: mesas } = await db().from('mesas')
        .select('capacidad, reservable').eq('local_id', localId).is('deleted_at', null);
      const tot = (mesas ?? [])
        .filter((m) => (m as { reservable?: boolean }).reservable)
        .reduce((a, m) => a + (Number((m as { capacidad?: number }).capacidad) || 0), 0);
      setCubiertos(tot);
    } else {
      setCubiertos(null);
    }
    setForm({
      activas: Boolean(s.reservas_activas),
      requiere_confirmacion: Boolean(s.reservas_requiere_confirmacion),
      telefono_obligatorio: s.reservas_telefono_obligatorio == null ? true : Boolean(s.reservas_telefono_obligatorio),
      email_obligatorio: Boolean(s.reservas_email_obligatorio),
      capacidad_max: s.reservas_capacidad_max != null ? String(s.reservas_capacidad_max) : '',
      anticipacion_min_hs: String(s.reservas_anticipacion_min_hs ?? 2),
      anticipacion_max_dias: String(s.reservas_anticipacion_max_dias ?? 30),
      duracion_estimada_min: String(s.reservas_duracion_estimada_min ?? 90),
      slot_min: String(s.reservas_slot_min ?? 30),
      pacing_max: s.reservas_pacing_max_por_franja != null ? String(s.reservas_pacing_max_por_franja) : '',
      notas_visibles: (s.reservas_notas_visibles_cliente as string | null) ?? '',
      horarios: DIAS.map(({ dia }) => {
        const p = parseHorario(s[HCOL[dia]!] as string | null);
        return { dia, activo: p.activo, abre: p.abre, cierra: p.cierra };
      }),
      notif_confirmacion: s.reservas_notif_confirmacion == null ? true : Boolean(s.reservas_notif_confirmacion),
      notif_recordatorio: s.reservas_notif_recordatorio == null ? true : Boolean(s.reservas_notif_recordatorio),
      notif_resena: s.reservas_notif_resena == null ? true : Boolean(s.reservas_notif_resena),
      notif_hora: String(s.reservas_notif_hora ?? 11),
      tpl_confirmacion: { titulo: (s.reservas_tpl_confirmacion_titulo as string) ?? '', subtitulo: (s.reservas_tpl_confirmacion_subtitulo as string) ?? '' },
      tpl_recordatorio: { titulo: (s.reservas_tpl_recordatorio_titulo as string) ?? '', subtitulo: (s.reservas_tpl_recordatorio_subtitulo as string) ?? '' },
      tpl_resena: { titulo: (s.reservas_tpl_resena_titulo as string) ?? '', subtitulo: (s.reservas_tpl_resena_subtitulo as string) ?? '' },
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
        reservas_email_obligatorio: form.email_obligatorio,
        reservas_capacidad_max: form.capacidad_max ? Number(form.capacidad_max) : null,
        reservas_anticipacion_min_hs: Number(form.anticipacion_min_hs) || 2,
        reservas_anticipacion_max_dias: Number(form.anticipacion_max_dias) || 30,
        reservas_duracion_estimada_min: Number(form.duracion_estimada_min) || 90,
        reservas_slot_min: Number(form.slot_min) || 30,
        reservas_pacing_max_por_franja: form.pacing_max ? Number(form.pacing_max) : null,
        reservas_notas_visibles_cliente: form.notas_visibles.trim() || null,
        reservas_notif_confirmacion: form.notif_confirmacion,
        reservas_notif_recordatorio: form.notif_recordatorio,
        reservas_notif_resena: form.notif_resena,
        reservas_notif_hora: Math.min(23, Math.max(0, Number(form.notif_hora) || 11)),
        reservas_tpl_confirmacion_titulo: form.tpl_confirmacion.titulo.trim() || null,
        reservas_tpl_confirmacion_subtitulo: form.tpl_confirmacion.subtitulo.trim() || null,
        reservas_tpl_recordatorio_titulo: form.tpl_recordatorio.titulo.trim() || null,
        reservas_tpl_recordatorio_subtitulo: form.tpl_recordatorio.subtitulo.trim() || null,
        reservas_tpl_resena_titulo: form.tpl_resena.titulo.trim() || null,
        reservas_tpl_resena_subtitulo: form.tpl_resena.subtitulo.trim() || null,
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
  function setTpl(key: 'tpl_confirmacion' | 'tpl_recordatorio' | 'tpl_resena', patch: Partial<MailTpl>) {
    setForm((f) => f ? { ...f, [key]: { ...f[key], ...patch } } : f);
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
        <Row label="Email obligatorio" desc="Pide el email al reservar (necesario para mandar la confirmación y el recordatorio).">
          <Toggle checked={form.email_obligatorio} onChange={(v) => set({ email_obligatorio: v })} />
        </Row>
      </Card>

      {/* Cupo y tiempos */}
      <Card icon={<Users className="h-4 w-4 text-brand-500" />} title="Cupo y tiempos">
        <div className="grid sm:grid-cols-2 gap-4">
          {cubiertos && cubiertos > 0 ? (
            <Field label="Capacidad simultánea (cubiertos)">
              <div className={`${input} bg-ink/5 text-ink-soft flex items-center`}>{cubiertos} cubiertos — se calcula de tus mesas</div>
              <p className="text-xs text-ink-muted mt-1">Sale de tus mesas reservables (Mapa de mesas). No hace falta configurarla acá.</p>
            </Field>
          ) : (
            <Field label="Capacidad simultánea (cubiertos)">
              <input type="number" min={0} className={input} value={form.capacidad_max} placeholder="ej. 40" onChange={(e) => set({ capacidad_max: e.target.value })} />
              <p className="text-xs text-ink-muted mt-1">Se usa solo si todavía no cargaste mesas. Si cargás mesas, la capacidad se calcula sola.</p>
            </Field>
          )}
          <Field label="Duración estimada por reserva (min)"><input type="number" min={30} className={input} value={form.duracion_estimada_min} onChange={(e) => set({ duracion_estimada_min: e.target.value })} /></Field>
          <Field label="Anticipación mínima (horas)"><input type="number" min={0} className={input} value={form.anticipacion_min_hs} onChange={(e) => set({ anticipacion_min_hs: e.target.value })} /></Field>
          <Field label="Anticipación máxima (días)"><input type="number" min={1} className={input} value={form.anticipacion_max_dias} onChange={(e) => set({ anticipacion_max_dias: e.target.value })} /></Field>
          <Field label="Intervalo entre turnos (min)">
            <input type="number" min={5} step={5} className={input} value={form.slot_min} onChange={(e) => set({ slot_min: e.target.value })} />
            <p className="text-xs text-ink-muted mt-1">Cada cuánto se ofrece un turno. Ej: 120 = turnos de 2h (20:00, 22:00); 30 = cada media hora.</p>
          </Field>
        </div>
      </Card>

      {/* Asignación de mesas */}
      <Card icon={<Users className="h-4 w-4 text-brand-500" />} title="Asignación de mesas">
        <p className="text-xs text-ink-muted -mt-1">Las reservas se asignan a una mesa real según la capacidad. Combinar mesas y los límites por sector se configuran en la sección Mesas.</p>
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

      {/* Notificaciones por email */}
      <Card icon={<Mail className="h-4 w-4 text-brand-500" />} title="Mails automáticos al cliente">
        <p className="text-xs text-ink-muted -mt-1">Requiere email obligatorio para que lleguen. El recordatorio y la reseña salen a la hora que elijas.</p>
        <Row label="Confirmación al reservar" desc="Apenas hace la reserva.">
          <Toggle checked={form.notif_confirmacion} onChange={(v) => set({ notif_confirmacion: v })} />
        </Row>
        <Row label="Recordatorio el día de la reserva" desc="Le recordamos que hoy tiene reserva.">
          <Toggle checked={form.notif_recordatorio} onChange={(v) => set({ notif_recordatorio: v })} />
        </Row>
        <Row label="Pedido de reseña al día siguiente" desc="Le pedimos que puntúe su experiencia.">
          <Toggle checked={form.notif_resena} onChange={(v) => set({ notif_resena: v })} />
        </Row>
        <Field label="Hora de envío (recordatorio y reseña)">
          <select value={form.notif_hora} onChange={(e) => set({ notif_hora: e.target.value })} className="w-40 rounded-lg border border-ink/15 px-3 py-2 text-sm">
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={String(h)}>{String(h).padStart(2, '0')}:00</option>)}
          </select>
        </Field>
      </Card>

      {/* Personalizar textos de mails */}
      <Card icon={<FileText className="h-4 w-4 text-brand-500" />} title="Personalizar textos de mails">
        <p className="text-xs text-ink-muted -mt-1">
          Dejá vacío para usar el texto por defecto. Podés usar variables: <code className="bg-ink/5 px-1 rounded text-[11px]">{'{{nombre}}'}</code> <code className="bg-ink/5 px-1 rounded text-[11px]">{'{{local}}'}</code> <code className="bg-ink/5 px-1 rounded text-[11px]">{'{{fecha}}'}</code> <code className="bg-ink/5 px-1 rounded text-[11px]">{'{{hora}}'}</code> <code className="bg-ink/5 px-1 rounded text-[11px]">{'{{personas}}'}</code>
        </p>

        <div className="space-y-4 pt-2">
          <MailTplEditor
            label="Mail de confirmación"
            defaultTitulo="¡Hola {{nombre}}!"
            defaultSubtitulo="Tu reserva quedó confirmada."
            tpl={form.tpl_confirmacion}
            onChange={(p) => setTpl('tpl_confirmacion', p)}
          />
          <MailTplEditor
            label="Mail recordatorio"
            defaultTitulo="¡Hola {{nombre}}!"
            defaultSubtitulo="Te recordamos tu reserva de hoy a las {{hora}} en {{local}} para {{personas}} personas. ¡Te esperamos!"
            tpl={form.tpl_recordatorio}
            onChange={(p) => setTpl('tpl_recordatorio', p)}
          />
          <MailTplEditor
            label="Mail de reseña"
            defaultTitulo="¡Gracias por venir, {{nombre}}!"
            defaultSubtitulo="¿Nos dejás una reseña de tu visita a {{local}}? Te toma 10 segundos y nos ayuda un montón."
            tpl={form.tpl_resena}
            onChange={(p) => setTpl('tpl_resena', p)}
          />
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
function MailTplEditor({ label, defaultTitulo, defaultSubtitulo, tpl, onChange }: {
  label: string; defaultTitulo: string; defaultSubtitulo: string;
  tpl: MailTpl; onChange: (p: Partial<MailTpl>) => void;
}) {
  return (
    <div className="rounded-xl border border-ink/10 p-4 space-y-3">
      <p className="text-sm font-medium">{label}</p>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-ink-soft">Título</label>
        <input type="text" value={tpl.titulo} placeholder={defaultTitulo}
               onChange={(e) => onChange({ titulo: e.target.value })}
               className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-ink-soft">Subtítulo / mensaje</label>
        <textarea rows={2} value={tpl.subtitulo} placeholder={defaultSubtitulo}
                  onChange={(e) => onChange({ subtitulo: e.target.value })}
                  className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
      </div>
    </div>
  );
}
