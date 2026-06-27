// automatizacionesService — flows lifecycle (estilo Klaviyo/Square Automations).
// Tabla automatizaciones (migración 202606250600). Graceful si no está aplicada.
// La EJECUCIÓN (correr los flows en horario) es una edge function/cron futura =
// la "integración" que queda por enchufar; acá se definen y activan.

import { db } from './supabase';

export type TriggerTipo = 'sin_pedir_dias' | 'cumpleanos' | 'primera_compra' | 'recurrente' | 'post_visita';
export type AccionTipo = 'enviar_campana' | 'dar_cupon';

export interface Automatizacion {
  id: number;
  nombre: string;
  trigger_tipo: TriggerTipo;
  trigger_params: Record<string, unknown>;
  accion_tipo: AccionTipo;
  accion_params: Record<string, unknown>;
  activa: boolean;
  disparos: number;
  ultima_corrida_at: string | null;
}

export interface AutomatizacionInput {
  nombre: string;
  trigger_tipo: TriggerTipo;
  trigger_params: Record<string, unknown>;
  accion_tipo: AccionTipo;
  accion_params: Record<string, unknown>;
  activa?: boolean;
}

function faltaTabla(msg: string) {
  return /relation .*automatizaciones.* does not exist/i.test(msg) || /could not find the table/i.test(msg);
}

export async function listAutomatizaciones(): Promise<{ data: Automatizacion[]; sinTabla: boolean; error: string | null }> {
  const { data, error } = await db()
    .from('automatizaciones')
    .select('id, nombre, trigger_tipo, trigger_params, accion_tipo, accion_params, activa, disparos, ultima_corrida_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) {
    if (faltaTabla(error.message)) return { data: [], sinTabla: true, error: null };
    return { data: [], sinTabla: false, error: error.message };
  }
  return { data: (data ?? []) as Automatizacion[], sinTabla: false, error: null };
}

export async function crearAutomatizacion(tenantId: string, input: AutomatizacionInput): Promise<{ error: string | null }> {
  const { error } = await db().from('automatizaciones').insert({
    tenant_id: tenantId,
    nombre: input.nombre,
    trigger_tipo: input.trigger_tipo,
    trigger_params: input.trigger_params,
    accion_tipo: input.accion_tipo,
    accion_params: input.accion_params,
    activa: input.activa ?? false,
  });
  if (error && faltaTabla(error.message)) {
    return { error: 'Las automatizaciones necesitan la migración 202606250600 (pendiente).' };
  }
  return { error: error?.message ?? null };
}

export async function toggleAutomatizacion(id: number, activa: boolean): Promise<{ error: string | null }> {
  const { error } = await db().from('automatizaciones').update({ activa }).eq('id', id);
  return { error: error?.message ?? null };
}

export async function eliminarAutomatizacion(id: number): Promise<{ error: string | null }> {
  const { error } = await db().from('automatizaciones').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  return { error: error?.message ?? null };
}

// Plantillas pre-armadas (las que usan los grandes).
export const PLANTILLAS_FLOW: { nombre: string; emoji: string; desc: string; input: AutomatizacionInput }[] = [
  {
    nombre: 'Recuperá perdidos', emoji: '', desc: 'Cuando un cliente no pide hace 60 días, mandale un WhatsApp con descuento.',
    input: { nombre: 'Recuperá perdidos', trigger_tipo: 'sin_pedir_dias', trigger_params: { dias: 60 }, accion_tipo: 'enviar_campana', accion_params: { canal: 'whatsapp', mensaje: 'Hola {nombre}! Hace rato no te vemos. Te dejamos un beneficio para que vuelvas 🍽️' } },
  },
  {
    nombre: 'Saludo de cumpleaños', emoji: '', desc: 'El día del cumple, saludá y regalá un beneficio.',
    input: { nombre: 'Saludo de cumpleaños', trigger_tipo: 'cumpleanos', trigger_params: {}, accion_tipo: 'enviar_campana', accion_params: { canal: 'whatsapp', mensaje: '¡Feliz cumple {nombre}! 🎉 Te esperamos con un regalo para festejar.' } },
  },
  {
    nombre: 'Bienvenida', emoji: '', desc: 'Tras la primera compra, agradecé e invitá a volver.',
    input: { nombre: 'Bienvenida', trigger_tipo: 'primera_compra', trigger_params: {}, accion_tipo: 'enviar_campana', accion_params: { canal: 'whatsapp', mensaje: 'Gracias por tu primera visita, {nombre}! 🙌 Para la próxima, un beneficio para vos.' } },
  },
  {
    nombre: 'Premio a recurrentes', emoji: '', desc: 'A los que ya son habitués, un mimo para fidelizar.',
    input: { nombre: 'Premio a recurrentes', trigger_tipo: 'recurrente', trigger_params: { min_pedidos: 5 }, accion_tipo: 'dar_cupon', accion_params: { mensaje: 'Gracias por elegirnos siempre 💛' } },
  },
  {
    nombre: 'Pedí reseñas', emoji: '', desc: 'Después de una visita/pedido, pedile una reseña en Google.',
    input: { nombre: 'Pedí reseñas', trigger_tipo: 'post_visita', trigger_params: { horas: 3 }, accion_tipo: 'enviar_campana', accion_params: { canal: 'whatsapp', mensaje: 'Hola {nombre}! Gracias por tu visita 🙌 ¿Nos dejás una reseña? Nos ayuda muchísimo.' } },
  },
];
