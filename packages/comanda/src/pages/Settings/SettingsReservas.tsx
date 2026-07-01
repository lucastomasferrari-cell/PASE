import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CalendarCheck, Globe, Loader2, Users, Clock, MessageSquare, Shield } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocalActivo } from '@/lib/localActivo';
import { getLocalSettings, updateLocalSettings } from '@/services/localSettingsService';
import type { ComandaLocalSettings, HorarioReserva } from '@/types/database';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';

const DIAS = [
  { dia: 1, label: 'Lunes' },
  { dia: 2, label: 'Martes' },
  { dia: 3, label: 'Miércoles' },
  { dia: 4, label: 'Jueves' },
  { dia: 5, label: 'Viernes' },
  { dia: 6, label: 'Sábado' },
  { dia: 0, label: 'Domingo' },
];

interface FormState {
  activas: boolean;
  requiere_confirmacion: boolean;
  telefono_obligatorio: boolean;
  capacidad_max: string;
  anticipacion_min_hs: string;
  anticipacion_max_dias: string;
  duracion_estimada_min: string;
  notas_visibles: string;
  permite_combinar: boolean;
  pacing_max: string;
  horarios: { dia: number; activo: boolean; abre: string; cierra: string }[];
}

function settingsToForm(s: ComandaLocalSettings): FormState {
  const horarioMap = new Map((s.reservas_horarios ?? []).map((h) => [h.dia, h]));
  return {
    activas: s.reservas_activas ?? false,
    requiere_confirmacion: s.reservas_requiere_confirmacion ?? false,
    telefono_obligatorio: s.reservas_telefono_obligatorio ?? true,
    capacidad_max: s.reservas_capacidad_max != null ? String(s.reservas_capacidad_max) : '',
    anticipacion_min_hs: String(s.reservas_anticipacion_min_hs ?? 2),
    anticipacion_max_dias: String(s.reservas_anticipacion_max_dias ?? 30),
    duracion_estimada_min: String(s.reservas_duracion_estimada_min ?? 90),
    notas_visibles: s.reservas_notas_visibles_cliente ?? '',
    permite_combinar: s.reservas_permite_combinar ?? true,
    pacing_max: s.reservas_pacing_max_por_franja != null ? String(s.reservas_pacing_max_por_franja) : '',
    horarios: DIAS.map(({ dia }) => {
      const h = horarioMap.get(dia);
      return {
        dia,
        activo: !!h,
        abre: h?.abre ?? '19:00',
        cierra: h?.cierra ?? '23:00',
      };
    }),
  };
}

export function SettingsReservas() {
  const { user } = useAuth();
  const [localId] = useLocalActivo(user);
  const [settings, setSettings] = useState<ComandaLocalSettings | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    if (localId === null) return;
    setLoading(true);
    const { data } = await getLocalSettings(localId);
    setSettings(data);
    setForm(data ? settingsToForm(data) : null);
    setLoading(false);
  }, [localId]);

  useEffect(() => { void reload(); }, [reload]);

  async function guardar() {
    if (!settings || !form) return;
    setSaving(true);
    const horarios: HorarioReserva[] = form.horarios
      .filter((h) => h.activo)
      .map(({ dia, abre, cierra }) => ({ dia, abre, cierra }));
    const { error } = await updateLocalSettings(settings.id, {
      reservas_activas: form.activas,
      reservas_requiere_confirmacion: form.requiere_confirmacion,
      reservas_telefono_obligatorio: form.telefono_obligatorio,
      reservas_capacidad_max: form.capacidad_max ? Number(form.capacidad_max) : null,
      reservas_anticipacion_min_hs: Number(form.anticipacion_min_hs) || 2,
      reservas_anticipacion_max_dias: Number(form.anticipacion_max_dias) || 30,
      reservas_duracion_estimada_min: Number(form.duracion_estimada_min) || 90,
      reservas_notas_visibles_cliente: form.notas_visibles.trim() || null,
      reservas_permite_combinar: form.permite_combinar,
      reservas_pacing_max_por_franja: form.pacing_max ? Number(form.pacing_max) : null,
      reservas_horarios: horarios,
    });
    setSaving(false);
    if (error) toast.error('Error al guardar: ' + error);
    else toast.success('Configuración guardada');
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!form || !settings) {
    return (
      <div className="py-16 text-center text-muted-foreground">
        No se encontró configuración para este local.
      </div>
    );
  }

  function setF(patch: Partial<FormState>) {
    setForm((prev) => prev ? { ...prev, ...patch } : prev);
  }

  function setHorario(dia: number, patch: Partial<{ activo: boolean; abre: string; cierra: string }>) {
    setForm((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        horarios: prev.horarios.map((h) => h.dia === dia ? { ...h, ...patch } : h),
      };
    });
  }

  // La página pública de reservas vive en la app MESA (mesa-orpin.vercel.app/:slug),
  // NO en el dominio de COMANDA ni bajo /reservar. Antes se armaba mal
  // (`${origin}/reservar/${slug}`) → link roto para el cliente.
  const publicUrl = settings.slug
    ? `https://mesa-orpin.vercel.app/${settings.slug}`
    : null;

  return (
    <div className="space-y-6 max-w-2xl">

      {/* Toggle principal */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4 text-primary" />
            Reservas online
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">Aceptar reservas por internet</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Cuando está activo, los clientes pueden reservar desde la tienda online.
              </p>
            </div>
            <Switch
              checked={form.activas}
              onCheckedChange={(v) => setF({ activas: v })}
            />
          </div>

          {publicUrl && (
            <div className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
              <CalendarCheck className="h-3.5 w-3.5 shrink-0" />
              <span>Formulario público:</span>
              <a
                href={publicUrl}
                target="_blank"
                rel="noopener"
                className="text-primary hover:underline break-all"
              >
                {publicUrl}
              </a>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Confirmación y teléfono */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4 text-primary" />
            Flujo de confirmación
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">Requiere confirmación manual</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Si está activo, las reservas entran en estado "Pendiente" hasta que vos las confirmás.
                Si está apagado, se confirman automáticamente.
              </p>
            </div>
            <Switch
              checked={form.requiere_confirmacion}
              onCheckedChange={(v) => setF({ requiere_confirmacion: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">Teléfono obligatorio</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                El cliente debe ingresar su número para poder reservar.
              </p>
            </div>
            <Switch
              checked={form.telefono_obligatorio}
              onCheckedChange={(v) => setF({ telefono_obligatorio: v })}
            />
          </div>
        </CardContent>
      </Card>

      {/* Capacidad y tiempos */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" />
            Capacidad y tiempos
          </CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Capacidad simultánea (personas)</Label>
            <Input
              type="number"
              min={1}
              max={500}
              value={form.capacidad_max}
              onChange={(e) => setF({ capacidad_max: e.target.value })}
              placeholder="50 (default)"
            />
            <p className="text-xs text-muted-foreground">Cuántas personas en total puede haber reservadas en el mismo horario. Vacío = 50.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Duración estimada (minutos)</Label>
            <Input
              type="number"
              min={15}
              max={480}
              value={form.duracion_estimada_min}
              onChange={(e) => setF({ duracion_estimada_min: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Cuánto tiempo ocupa una reserva al calcular disponibilidad.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Anticipación mínima (horas)</Label>
            <Input
              type="number"
              min={0}
              max={72}
              value={form.anticipacion_min_hs}
              onChange={(e) => setF({ anticipacion_min_hs: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Con cuántas horas de antelación mínima se puede reservar.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Anticipación máxima (días)</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={form.anticipacion_max_dias}
              onChange={(e) => setF({ anticipacion_max_dias: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">Hasta cuántos días en el futuro se puede reservar.</p>
          </div>
        </CardContent>
      </Card>

      {/* Horarios */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4 text-primary" />
            Horarios de reserva
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-4">
            Activá los días y franjas en que se aceptan reservas. Si no hay ningún día activo, se acepta cualquier horario.
          </p>
          <div className="space-y-2">
            {form.horarios.map((h) => {
              const diaLabel = DIAS.find((d) => d.dia === h.dia)?.label ?? '';
              return (
                <div key={h.dia} className="flex items-center gap-3 flex-wrap">
                  <div className="flex items-center gap-2 w-32 shrink-0">
                    <Switch
                      checked={h.activo}
                      onCheckedChange={(v) => setHorario(h.dia, { activo: v })}
                      id={`dia-${h.dia}`}
                    />
                    <Label htmlFor={`dia-${h.dia}`} className="text-sm cursor-pointer">{diaLabel}</Label>
                  </div>
                  {h.activo && (
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        value={h.abre}
                        onChange={(e) => setHorario(h.dia, { abre: e.target.value })}
                        className="w-28 h-8"
                      />
                      <span className="text-muted-foreground text-sm">a</span>
                      <Input
                        type="time"
                        value={h.cierra}
                        onChange={(e) => setHorario(h.dia, { cierra: e.target.value })}
                        className="w-28 h-8"
                      />
                    </div>
                  )}
                  {!h.activo && (
                    <span className="text-xs text-muted-foreground/60 italic">cerrado</span>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Motor / asignación de mesas */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" />
            Asignación de mesas
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground -mt-1">
            Las reservas se asignan automáticamente a una mesa real del salón según
            la capacidad. (Las mesas se cargan en Configuración → Mesas.)
          </p>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-sm">Combinar mesas</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Si un grupo no entra en una sola mesa, junta dos (ej. dos mesas de 4 para un grupo de 6).
              </p>
            </div>
            <Switch
              checked={form.permite_combinar}
              onCheckedChange={(v) => setF({ permite_combinar: v })}
            />
          </div>
          <div>
            <Label className="text-sm">Máximo de reservas por franja de 15 min (pacing)</Label>
            <Input
              type="number" min={0} className="w-28 h-8 mt-1"
              value={form.pacing_max}
              onChange={(e) => setF({ pacing_max: e.target.value })}
              placeholder="sin límite"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Limita cuántas reservas pueden empezar juntas para no saturar la cocina. Vacío = sin límite.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Nota pública */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="h-4 w-4 text-primary" />
            Mensaje para el cliente
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          <Label>Nota visible en el formulario de reserva</Label>
          <Textarea
            rows={3}
            value={form.notas_visibles}
            onChange={(e) => setF({ notas_visibles: e.target.value })}
            placeholder="Ej: Aceptamos hasta 10 personas por reserva. Para grupos más grandes escribinos por WhatsApp."
          />
          <p className="text-xs text-muted-foreground">Se muestra arriba del formulario público. Dejalo vacío si no querés mostrar nada.</p>
        </CardContent>
      </Card>

      <div className="flex justify-end pb-6">
        <Button onClick={() => void guardar()} disabled={saving} size="lg">
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
          {saving ? 'Guardando…' : 'Guardar configuración'}
        </Button>
      </div>
    </div>
  );
}


