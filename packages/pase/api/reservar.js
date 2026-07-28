// Alta pública de reservas (MESA) con rate limiting por IP.
//
// El widget público (perfilService.crearReservaPublica) ya no llama a la RPC
// fn_crear_reserva_publica directo (se le revocó anon): pega acá. Este endpoint
// corre con SUPABASE_SERVICE_KEY, hashea la IP del request y aplica un tope por
// IP (fn_rate_limit_hit) ANTES de crear la reserva. La RPC ya trae sus propios
// topes por teléfono/local; esto suma una capa contra bots que rotan datos.
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

    // Tope: 6 altas cada 10 min por IP. false = pasó el límite.
    const { data: allowed } = await db.rpc('fn_rate_limit_hit', {
      p_bucket: 'reserva_crear', p_ip_hash: ipHash, p_max: 6, p_window_secs: 600,
    });
    if (allowed === false) return res.status(429).json({ ok: false, error: 'DEMASIADO_RAPIDO' });

    const b = req.body || {};
    const { slug, nombre, telefono, email, fechaHora, personas, notas, zona, idempotencyKey } = b;
    if (!slug || !nombre || !fechaHora || personas == null) {
      return res.status(400).json({ ok: false, error: 'DATOS_INCOMPLETOS' });
    }
    const personasInt = parseInt(personas, 10);

    const { data, error } = await db.rpc('fn_crear_reserva_publica', {
      p_local_slug: slug, p_cliente_nombre: nombre, p_cliente_telefono: telefono ?? null,
      p_cliente_email: email ?? null, p_fecha_hora: fechaHora, p_personas: personasInt,
      p_notas: notas ?? null, p_idempotency_key: idempotencyKey ?? null, p_zona: zona ?? null,
    });
    // La RPC levanta códigos (SIN_MESA, DEMASIADO_RAPIDO, etc.): pasamos el
    // mensaje tal cual — el cliente ya los traduce.
    if (error) return res.status(200).json({ ok: false, error: error.message });

    const row = Array.isArray(data) ? data[0] : data;

    // Atribución de marketing (best-effort): guardamos de dónde vino el cliente
    // en la reserva recién creada. No tocamos la RPC — UPDATE con service_role.
    // Si falla, no rompe la reserva (ya está creada).
    if (row?.id && b.atribucion && typeof b.atribucion === 'object') {
      try {
        const a = b.atribucion;
        const clip = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : null);
        await db.from('reservas').update({
          utm_source: clip(a.utm_source),
          utm_medium: clip(a.utm_medium),
          utm_campaign: clip(a.utm_campaign),
          utm_content: clip(a.utm_content),
          utm_term: clip(a.utm_term),
          fbclid: clip(a.fbclid),
          gclid: clip(a.gclid),
          attr_referrer: clip(a.referrer),
          attr_landing: clip(a.landing),
        }).eq('id', row.id);
      } catch { /* best-effort: la reserva ya existe */ }
    }

    // ── Meta Conversions API (server-side) ────────────────────────────────
    // Le avisamos a Meta "esta persona reservó" con el mismo event_id que el
    // Pixel del cliente → dedup. Usa el Pixel + token del cliente (tenant).
    // Best-effort: si algo falla, la reserva ya está creada.
    if (row?.id && b.metaEventId) {
      try {
        const { data: cls } = await db.from('comanda_local_settings')
          .select('local_id').eq('slug', slug).is('deleted_at', null).maybeSingle();
        let mi = null;
        if (cls?.local_id != null) {
          const { data: loc } = await db.from('locales').select('tenant_id').eq('id', cls.local_id).maybeSingle();
          if (loc?.tenant_id) {
            const { data } = await db.from('marketing_integraciones')
              .select('meta_pixel_id, meta_capi_token, meta_test_event_code, meta_activa')
              .eq('tenant_id', loc.tenant_id).maybeSingle();
            mi = data;
          }
        }
        if (mi && mi.meta_activa && mi.meta_pixel_id && mi.meta_capi_token) {
          const sha = (v) => createHash('sha256').update(String(v)).digest('hex');
          const user_data = {
            client_ip_address: ip !== 'unknown' ? ip : undefined,
            client_user_agent: req.headers['user-agent'] || undefined,
            fbp: b.fbp || undefined,
            fbc: b.fbc || undefined,
          };
          if (email) user_data.em = [sha(String(email).trim().toLowerCase())];
          if (telefono) user_data.ph = [sha(String(telefono).replace(/\D/g, ''))];
          const payload = {
            data: [{
              event_name: 'Schedule',
              event_time: Math.floor(Date.now() / 1000),
              event_id: String(b.metaEventId),
              action_source: 'website',
              event_source_url: req.headers['referer'] || undefined,
              user_data,
              custom_data: { content_category: 'reserva', num_items: personasInt },
            }],
          };
          if (mi.meta_test_event_code) payload.test_event_code = mi.meta_test_event_code;
          await fetch(
            `https://graph.facebook.com/v19.0/${mi.meta_pixel_id}/events?access_token=${encodeURIComponent(mi.meta_capi_token)}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
          );
        }
      } catch { /* best-effort: no romper la reserva */ }
    }

    return res.status(200).json({
      ok: true, id: row?.id, estado: row?.estado, cancelToken: row?.cancel_token ?? null,
    });
  } catch {
    return res.status(200).json({ ok: false, error: 'ERROR_INTERNO' });
  }
}
