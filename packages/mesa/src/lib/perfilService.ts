// perfilService — todo lo que consume la página pública /:slug.
// Una llamada agregadora (fn_get_perfil_publico_local) + las acciones:
// reservar, inscribirse a un evento (→ MP), comprar giftcard (→ MP).
// El checkout MP vive en /api/tienda-mp (rebotado por vercel.json al
// proyecto PASE — en dev local no hay rewrite, probar en deploy).

import { db } from './supabase';

// ─── Tipos del perfil ──────────────────────────────────────────────────────

export interface PerfilLocalData {
  local: {
    nombre: string;
    slug: string;
    direccion: string | null;
    telefono: string | null;
    instagram: string | null;
    web: string | null;
    descripcion: string | null;
    fotos: string[];
    horarios: Record<'lun' | 'mar' | 'mie' | 'jue' | 'vie' | 'sab' | 'dom', string | null>;
  };
  reservas: {
    activas: boolean;
    anticipacion_min_hs: number | null;
    anticipacion_max_dias: number | null;
    telefono_obligatorio: boolean;
  };
  hay_mesa_ahora: boolean | null;
  populares: Array<{ nombre: string; foto_url: string | null; precio: number; vendidos: number }>;
  reviews: {
    resumen: { promedio: number | null; total: number | null } | null;
    ultimas: Array<{ autor: string; rating: number; comentario: string | null; fecha: string }>;
  };
  eventos: Array<{
    id: number; titulo: string; descripcion: string | null; foto_url: string | null;
    fecha_inicio: string; precio_por_persona: number; cupos_disponibles: number;
  }>;
  giftcards: Array<{
    id: number; nombre: string; descripcion: string | null; foto_url: string | null; precio: number;
  }>;
  hermanos: Array<{ slug: string; nombre: string; direccion: string | null }>;
}

export async function getPerfil(slug: string): Promise<PerfilLocalData | null> {
  const { data, error } = await db().rpc('fn_get_perfil_publico_local', { p_local_slug: slug });
  if (error || !data) return null;
  return data as PerfilLocalData;
}

// ─── Reservas ──────────────────────────────────────────────────────────────

export async function checkDisponibilidad(slug: string, fechaHora: string, personas: number): Promise<{ disponible: boolean; motivo: string | null }> {
  const { data, error } = await db().rpc('fn_check_disponibilidad_reserva', {
    p_local_slug: slug, p_fecha_hora: fechaHora, p_personas: personas,
  });
  if (error) return { disponible: false, motivo: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  return { disponible: Boolean(row?.disponible), motivo: (row?.motivo as string) ?? null };
}

export async function crearReservaPublica(args: {
  slug: string; nombre: string; telefono: string; email?: string;
  fechaHora: string; personas: number; notas?: string;
}): Promise<{ ok: boolean; estado?: string; error?: string }> {
  const { data, error } = await db().rpc('fn_crear_reserva_publica', {
    p_local_slug: args.slug,
    p_cliente_nombre: args.nombre,
    p_cliente_telefono: args.telefono,
    p_cliente_email: args.email ?? null,
    p_fecha_hora: args.fechaHora,
    p_personas: args.personas,
    p_notas: args.notas ?? null,
    // Incluye teléfono: antes era slug-nombre-fechaHora → dos personas
    // distintas con el mismo nombre y horario colisionaban (la 2ª "heredaba"
    // la reserva de la 1ª). Con el teléfono, mismo cliente que re-envía =
    // idempotente; clientes distintos = reservas separadas.
    p_idempotency_key: `mesa-${args.slug}-${args.nombre}-${args.telefono}-${args.fechaHora}`,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : data;
  return { ok: true, estado: (row?.estado as string) ?? 'pendiente' };
}

// ─── Eventos: inscripción + checkout MP ────────────────────────────────────

export async function inscribirEventoYPagar(args: {
  slug: string; eventoId: number; nombre: string; telefono?: string;
  email: string; cantidad: number;
}): Promise<{ initPoint?: string; error?: string }> {
  const { data, error } = await db().rpc('fn_inscribir_evento_publico', {
    p_local_slug: args.slug, p_evento_id: args.eventoId,
    p_nombre: args.nombre, p_telefono: args.telefono ?? null,
    p_email: args.email, p_cantidad: args.cantidad,
    p_idempotency_key: `mesa-ev-${args.eventoId}-${args.email}-${args.cantidad}`,
  });
  if (error) return { error: error.message };
  const insc = data as { inscripcion_id: number };
  const back = `${window.location.origin}/r/confirmacion/evento/${insc.inscripcion_id}`;
  const r = await fetch('/api/tienda-mp?action=evento-preference', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: insc.inscripcion_id, back_url_success: back }),
  });
  if (!r.ok) return { error: 'No se pudo iniciar el pago. Probá de nuevo.' };
  const pref = await r.json() as { init_point?: string };
  if (!pref.init_point) return { error: 'MercadoPago no devolvió el checkout.' };
  return { initPoint: pref.init_point };
}

// ─── Giftcards: compra + checkout MP ───────────────────────────────────────

export async function comprarGiftcardYPagar(args: {
  slug: string; giftcardId: number; compradorNombre: string; compradorEmail: string;
  compradorTelefono?: string; paraNombre?: string; mensaje?: string;
}): Promise<{ initPoint?: string; error?: string }> {
  const { data, error } = await db().rpc('fn_comprar_giftcard_publica', {
    p_local_slug: args.slug, p_giftcard_id: args.giftcardId,
    p_comprador_nombre: args.compradorNombre, p_comprador_email: args.compradorEmail,
    p_comprador_telefono: args.compradorTelefono ?? null,
    p_para_nombre: args.paraNombre ?? null, p_mensaje: args.mensaje ?? null,
    p_idempotency_key: `mesa-gc-${args.giftcardId}-${args.compradorEmail}`,
  });
  if (error) return { error: error.message };
  const compra = data as { compra_id: number };
  const back = `${window.location.origin}/r/confirmacion/gift/${compra.compra_id}`;
  const r = await fetch('/api/tienda-mp?action=giftcard-preference', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: compra.compra_id, back_url_success: back }),
  });
  if (!r.ok) return { error: 'No se pudo iniciar el pago. Probá de nuevo.' };
  const pref = await r.json() as { init_point?: string };
  if (!pref.init_point) return { error: 'MercadoPago no devolvió el checkout.' };
  return { initPoint: pref.init_point };
}

// ─── Confirmación post-pago ────────────────────────────────────────────────

export interface EstadoPago {
  estado: string;
  titulo: string;
  monto: number;
  cantidad?: number;
  fecha?: string;
  codigo?: string | null;
  para?: string | null;
}

export async function getEstadoPago(tipo: 'evento' | 'gift', id: number): Promise<EstadoPago | null> {
  const { data, error } = await db().rpc('fn_estado_pago_publico', { p_tipo: tipo, p_id: id });
  if (error || !data) return null;
  return data as EstadoPago;
}
