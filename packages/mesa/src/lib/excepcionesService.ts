// Días especiales / excepciones de reservas por FECHA (tabla reservas_excepciones,
// migración 202607142000). Una excepción gana sobre el horario semanal: permite
// abrir un día que normalmente cierra, o cerrar uno que abre — sin tocar el
// horario semanal. El motor (fn_check_disponibilidad_reserva + slots) ya la
// consulta; acá solo la leemos/escribimos desde el admin.

import { db } from '@/lib/supabase';

export interface EstadoDiaReservas {
  excepcion: { cerrado: boolean; abre: string | null; cierra: string | null } | null;
  normalAbierto: boolean;
  normalAbre: string | null;   // 'HH:MM'
  normalCierra: string | null;
}

function hhmm(t: string | null | undefined): string | null {
  return t ? String(t).slice(0, 5) : null;
}

// La migración 202607142000 puede no estar aplicada todavía (la UI deploya
// antes). Si la tabla no existe, degradamos con gracia: sin excepción.
function faltaTabla(msg: string): boolean {
  return /relation .*reservas_excepciones.* does not exist/i.test(msg) || /could not find the table/i.test(msg);
}

// dow: 0=Dom .. 6=Sáb (igual que Date.getDay() y EXTRACT(DOW)).
export async function getEstadoDia(
  localId: number, fechaISO: string, dow: number,
): Promise<{ data: EstadoDiaReservas | null; error: string | null }> {
  const [exc, cls] = await Promise.all([
    db().from('reservas_excepciones').select('cerrado, abre, cierra')
      .eq('local_id', localId).eq('fecha', fechaISO).maybeSingle(),
    db().from('comanda_local_settings').select('reservas_horarios')
      .eq('local_id', localId).maybeSingle(),
  ]);
  if (exc.error && !faltaTabla(exc.error.message)) return { data: null, error: exc.error.message };
  if (cls.error) return { data: null, error: cls.error.message };

  const horarios = Array.isArray((cls.data as { reservas_horarios?: unknown } | null)?.reservas_horarios)
    ? ((cls.data as { reservas_horarios: { dia: number; abre: string; cierra: string }[] }).reservas_horarios)
    : [];
  const hoy = horarios.find((h) => Number(h.dia) === dow);
  const e = (exc.error ? null : exc.data) as { cerrado: boolean; abre: string | null; cierra: string | null } | null;

  return {
    data: {
      excepcion: e ? { cerrado: e.cerrado, abre: hhmm(e.abre), cierra: hhmm(e.cierra) } : null,
      normalAbierto: !!hoy,
      normalAbre: hoy ? hhmm(hoy.abre) : null,
      normalCierra: hoy ? hhmm(hoy.cierra) : null,
    },
    error: null,
  };
}

export async function setExcepcion(
  localId: number, fechaISO: string, cerrado: boolean, abre?: string | null, cierra?: string | null,
): Promise<{ error: string | null }> {
  const { error } = await db().from('reservas_excepciones').upsert({
    local_id: localId,
    fecha: fechaISO,
    cerrado,
    abre: cerrado ? null : (abre ?? null),
    cierra: cerrado ? null : (cierra ?? null),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'local_id,fecha' });
  return { error: error?.message ?? null };
}

export async function borrarExcepcion(
  localId: number, fechaISO: string,
): Promise<{ error: string | null }> {
  const { error } = await db().from('reservas_excepciones').delete()
    .eq('local_id', localId).eq('fecha', fechaISO);
  return { error: error?.message ?? null };
}
