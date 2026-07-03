// Acciones públicas sobre una reserva por TELÉFONO (cancelar / reseñar) con
// rate limiting por IP. Mismo patrón que /api/reservar.
//
// El widget público (perfilService.cancelarReservaPublica y crearReviewReserva)
// ya no llama a las RPCs fn_cancelar_reserva_publica / fn_crear_review_reserva
// directo (se les revocó anon): pega acá. Este endpoint corre con
// SUPABASE_SERVICE_KEY, hashea la IP del request y aplica un tope por IP
// (fn_rate_limit_hit) ANTES de ejecutar la acción. Las RPCs ya validan por
// teléfono; esto suma una capa contra bots que rotan datos.
//
// Las acciones POR TOKEN (fn_cancelar_reserva_token / fn_crear_review_token)
// NO pasan por acá: usan un UUID secreto del link y siguen siendo anon.
//
// No se almacena ni loguea la IP en crudo: sólo su hash sha256 (con salt).
//
// Requiere en Vercel pase-yndx: SUPABASE_URL, SUPABASE_SERVICE_KEY (ya están).
// Opcional RATE_LIMIT_SALT (salt del hash de IP).

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(200).json({ ok: false, error: 'Backend sin configurar' });

  try {
    const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    // IP del cliente: x-real-ip primero, luego el 1er valor de x-forwarded-for,
    // fallback al socket. Nunca se guarda/loguea en crudo — sólo el hash.
    const fwd = req.headers['x-forwarded-for'];
    const ip = req.headers['x-real-ip']
      || (fwd ? String(fwd).split(',')[0].trim() : null)
      || req.socket?.remoteAddress
      || 'unknown';
    const ipHash = createHash('sha256').update(ip + (process.env.RATE_LIMIT_SALT || 'mesa-reservas')).digest('hex');

    // Tope: 10 acciones cada 10 min por IP. false = pasó el límite.
    const { data: allowed } = await db.rpc('fn_rate_limit_hit', {
      p_bucket: 'reserva_accion', p_ip_hash: ipHash, p_max: 10, p_window_secs: 600,
    });
    if (allowed === false) return res.status(429).json({ ok: false, error: 'DEMASIADO_RAPIDO' });

    const b = req.body || {};
    const accion = b.accion;

    if (accion === 'cancelar') {
      if (!b.reservaId || !b.telefono) {
        return res.status(400).json({ ok: false, error: 'DATOS_INCOMPLETOS' });
      }
      const { data, error } = await db.rpc('fn_cancelar_reserva_publica', {
        p_reserva_id: b.reservaId, p_telefono: String(b.telefono).trim(), p_motivo: b.motivo ?? null,
      });
      // La RPC levanta códigos: pasamos el mensaje tal cual (el cliente traduce).
      if (error) return res.status(200).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: data === true });
    }

    if (accion === 'review') {
      if (!b.reservaId || !b.telefono || !b.rating) {
        return res.status(400).json({ ok: false, error: 'DATOS_INCOMPLETOS' });
      }
      const { data, error } = await db.rpc('fn_crear_review_reserva', {
        p_reserva_id: b.reservaId, p_telefono: String(b.telefono).trim(), p_rating: b.rating,
        p_comentario: b.comentario ?? null, p_email: b.email ?? null,
        p_estrellas_comida: b.estrellasComida ?? null,
        p_estrellas_presentacion: b.estrellasPresentacion ?? null,
      });
      if (error) return res.status(200).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, yaExistia: Boolean(data?.ya_existia) });
    }

    return res.status(400).json({ ok: false, error: 'ACCION_INVALIDA' });
  } catch {
    return res.status(200).json({ ok: false, error: 'ERROR_INTERNO' });
  }
}
