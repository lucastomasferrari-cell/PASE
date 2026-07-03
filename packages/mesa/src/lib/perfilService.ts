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
    email_obligatorio?: boolean;
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

// error=true → problema de red/backend (mostrar "reintentá"); data=null sin
// error → el local no existe. Antes ambos casos se veían como "no existe".
export async function getPerfil(slug: string): Promise<{ data: PerfilLocalData | null; error: boolean }> {
  const { data, error } = await db().rpc('fn_get_perfil_publico_local', { p_local_slug: slug });
  if (error) return { data: null, error: true };
  return { data: (data as PerfilLocalData | null) ?? null, error: false };
}

// ─── Reservas ──────────────────────────────────────────────────────────────

export interface SlotDisponibilidad { hora: string; disponible: boolean; restantes: number }

// Disponibilidad por horario para un día (para los chips del widget).
export async function getSlotsDisponibilidad(
  slug: string, fecha: string, personas: number, zona?: string | null,
): Promise<SlotDisponibilidad[]> {
  const { data, error } = await db().rpc('fn_slots_disponibilidad_publico', {
    p_local_slug: slug, p_fecha: fecha, p_personas: personas, p_zona: zona ?? null,
  });
  if (error || !Array.isArray(data)) return [];
  return (data as SlotDisponibilidad[]).map((s) => ({
    hora: s.hora, disponible: Boolean(s.disponible), restantes: Number(s.restantes ?? 0),
  }));
}

// Sectores (Barra/Salón/Terraza/Privado) que el local ofrece para reservar.
export async function getZonasReservables(slug: string): Promise<string[]> {
  const { data, error } = await db().rpc('fn_zonas_reservables_publico', { p_local_slug: slug });
  if (error || !Array.isArray(data)) return [];
  return (data as Array<{ zona: string }>).map((r) => r.zona).filter(Boolean);
}

export async function crearReservaPublica(args: {
  slug: string; nombre: string; telefono: string; email?: string;
  fechaHora: string; personas: number; notas?: string; zona?: string | null;
}): Promise<{ ok: boolean; estado?: string; id?: number; cancelToken?: string; error?: string }> {
  // El alta pública ya no llama a la RPC directo (se le revocó anon): pega a
  // /api/reservar, que corre con service_role y aplica rate limit por IP antes
  // de crear la reserva. El endpoint está rebotado por vercel.json al proyecto
  // PASE (en dev local no hay rewrite, probar en deploy).
  try {
    const res = await fetch('/api/reservar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: args.slug,
        nombre: args.nombre,
        telefono: args.telefono,
        email: args.email ?? null,
        fechaHora: args.fechaHora,
        personas: args.personas,
        notas: args.notas ?? null,
        zona: args.zona ?? null,
        // Incluye teléfono: antes era slug-nombre-fechaHora → dos personas
        // distintas con el mismo nombre y horario colisionaban (la 2ª "heredaba"
        // la reserva de la 1ª). Con el teléfono, mismo cliente que re-envía =
        // idempotente; clientes distintos = reservas separadas.
        idempotencyKey: `mesa-${args.slug}-${args.nombre}-${args.telefono}-${args.fechaHora}`,
      }),
    });
    const json = await res.json() as {
      ok: boolean; estado?: string; id?: number; cancelToken?: string; error?: string;
    };
    if (!json.ok) return { ok: false, error: json.error };
    return {
      ok: true,
      estado: json.estado ?? 'pendiente',
      id: json.id,
      // El alta devuelve el cancel_token → armamos el link sin volver a consultar
      // por teléfono (antes fn_reserva_token_por_tel, ahora sin acceso anónimo).
      cancelToken: json.cancelToken ?? undefined,
    };
  } catch {
    return { ok: false, error: 'No se pudo conectar' };
  }
}

// Dispara la confirmación automática al cliente (email vía Resend; WA cuando
// esté la plantilla Meta). Fire-and-forget: si falla, no rompe la reserva.
export async function notificarConfirmacionReserva(reservaId: number): Promise<void> {
  try {
    await fetch('/api/reserva-notificar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservaId }),
    });
  } catch { /* best-effort */ }
}

export interface ReservaResumen {
  cliente_nombre: string; fecha_hora: string; personas: number;
  estado: string; local_nombre: string; cancelable: boolean;
}
// Resumen de la reserva para la página de cancelación (id + token).
export async function getReservaResumen(reservaId: number, token: string): Promise<ReservaResumen | null> {
  const { data, error } = await db().rpc('fn_reserva_publica_token', {
    p_reserva_id: reservaId, p_token: token,
  });
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return (row as ReservaResumen) ?? null;
}

// Cancelar con el token del link (sin teléfono). true = cancelada.
export async function cancelarReservaPorToken(
  reservaId: number, token: string, motivo?: string,
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await db().rpc('fn_cancelar_reserva_token', {
    p_reserva_id: reservaId, p_token: token, p_motivo: motivo ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: data === true };
}

// Cancelación por el propio cliente (verifica por teléfono). true = cancelada.
// Ya no llama a la RPC directo (se le revocó anon): pega a /api/reserva-accion,
// que corre con service_role y aplica rate limit por IP antes de cancelar. El
// endpoint está rebotado por vercel.json al proyecto PASE (en dev local no hay
// rewrite, probar en deploy).
export async function cancelarReservaPublica(
  reservaId: number, telefono: string, motivo?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/reserva-accion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accion: 'cancelar',
        reservaId,
        telefono: telefono.trim(),
        motivo: motivo ?? null,
      }),
    });
    const json = await res.json() as { ok: boolean; error?: string };
    // El endpoint pasa el mensaje de la RPC tal cual → lo propagamos.
    if (json.ok === false && json.error) return { ok: false, error: json.error };
    return { ok: json.ok === true };
  } catch {
    return { ok: false, error: 'No se pudo conectar' };
  }
}

// Reseña del cliente para una reserva que asistió (verifica por teléfono).
// Ya no llama a la RPC directo (se le revocó anon): pega a /api/reserva-accion,
// que corre con service_role y aplica rate limit por IP antes de guardar la
// reseña. Rebotado por vercel.json al proyecto PASE (en dev local no hay
// rewrite, probar en deploy).
export async function crearReviewReserva(args: {
  reservaId: number; telefono: string; rating: number; comentario?: string;
  email?: string; estrellasComida?: number; estrellasPresentacion?: number;
}): Promise<{ ok: boolean; yaExistia?: boolean; error?: string }> {
  try {
    const res = await fetch('/api/reserva-accion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accion: 'review',
        reservaId: args.reservaId,
        telefono: args.telefono.trim(),
        rating: args.rating,
        comentario: args.comentario ?? null,
        email: args.email ?? null,
        estrellasComida: args.estrellasComida ?? null,
        estrellasPresentacion: args.estrellasPresentacion ?? null,
      }),
    });
    const json = await res.json() as { ok: boolean; yaExistia?: boolean; error?: string };
    if (json.ok === false) return { ok: false, error: json.error };
    return { ok: true, yaExistia: Boolean(json.yaExistia) };
  } catch {
    return { ok: false, error: 'No se pudo conectar' };
  }
}

// Dispara el mail de reseña post-visita (lo llama el admin al finalizar la
// reserva). Fire-and-forget; el endpoint valida estado + idempotencia.
export async function notificarResenaReserva(reservaId: number): Promise<void> {
  try {
    await fetch('/api/reserva-notificar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservaId, tipo: 'resena' }),
    });
  } catch { /* best-effort */ }
}

// Crear reseña con el token del link (sin teléfono).
export async function crearReviewPorToken(args: {
  reservaId: number; token: string; rating: number; comentario?: string;
  estrellasComida?: number; estrellasPresentacion?: number;
}): Promise<{ ok: boolean; yaExistia?: boolean; error?: string }> {
  const { data, error } = await db().rpc('fn_crear_review_token', {
    p_reserva_id: args.reservaId, p_token: args.token, p_rating: args.rating,
    p_comentario: args.comentario ?? null,
    p_estrellas_comida: args.estrellasComida ?? null,
    p_estrellas_presentacion: args.estrellasPresentacion ?? null,
  });
  if (error) return { ok: false, error: error.message };
  const rr = data as { ya_existia?: boolean };
  return { ok: true, yaExistia: Boolean(rr?.ya_existia) };
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
