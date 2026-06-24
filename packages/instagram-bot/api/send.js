// Endpoint para enviar mensajes desde PASE como humano.
//
// Flow:
//   POST /api/send
//   Headers: Authorization: Bearer <supabase_jwt>
//   Body: { conversacion_id: number, texto: string }
//
//   1. Valida JWT del usuario contra Supabase Auth.
//   2. Verifica que el usuario sea dueño/admin del tenant que posee la conversación.
//   3. Lee config del tenant (page_access_token).
//   4. Envía mensaje via Instagram Graph API.
//   5. Guarda en ig_mensajes con origen='humano' + usuario_id.
//
// CORS abierto para que PASE pueda llamarlo desde el browser.

// AUDIT F7A#4: usar helper centralizado _lib/db.js.
import { db } from './_lib/db.js';
import { enviarMensaje } from './_lib/meta.js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    // ─── 1. Validar JWT del caller ──────────────────────────────────────
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: 'NO_TOKEN' });
    }
    const token = authHeader.slice(7);

    const { data: authUser, error: authErr } = await db.auth.getUser(token);
    if (authErr || !authUser?.user?.id) {
      return res.status(401).json({ ok: false, error: 'TOKEN_INVALID' });
    }
    const authId = authUser.user.id;

    // ─── 2. Buscar usuario interno + verificar permisos ─────────────────
    const { data: usuario } = await db.from('usuarios')
      .select('id, rol, tenant_id, activo, nombre')
      .eq('auth_id', authId)
      .single();

    if (!usuario) return res.status(403).json({ ok: false, error: 'USER_NOT_FOUND' });
    if (!usuario.activo) return res.status(403).json({ ok: false, error: 'USER_INACTIVE' });

    // Solo dueño/admin/superadmin pueden enviar mensajes manuales
    if (!['dueno', 'admin', 'superadmin'].includes(usuario.rol)) {
      return res.status(403).json({ ok: false, error: 'NOT_AUTHORIZED' });
    }

    // ─── 3. Validar body ────────────────────────────────────────────────
    const { conversacion_id, texto } = req.body || {};
    if (!conversacion_id || typeof conversacion_id !== 'number') {
      return res.status(400).json({ ok: false, error: 'MISSING_CONVERSACION_ID' });
    }
    if (!texto || typeof texto !== 'string' || texto.trim().length === 0) {
      return res.status(400).json({ ok: false, error: 'MISSING_TEXTO' });
    }
    if (texto.length > 1000) {
      return res.status(400).json({ ok: false, error: 'TEXTO_TOO_LONG' });
    }

    // ─── 4. Cargar conversación + cliente + config ──────────────────────
    const { data: conv } = await db.from('ig_conversaciones')
      .select('id, tenant_id, cliente_id, estado, ig_config_id')
      .eq('id', conversacion_id)
      .single();

    if (!conv) return res.status(404).json({ ok: false, error: 'CONVERSACION_NOT_FOUND' });

    // Verificar que el usuario sea del mismo tenant
    if (conv.tenant_id !== usuario.tenant_id && usuario.rol !== 'superadmin') {
      return res.status(403).json({ ok: false, error: 'CROSS_TENANT' });
    }

    const { data: cliente } = await db.from('ig_clientes')
      .select('igsid, bloqueado')
      .eq('id', conv.cliente_id)
      .single();

    if (!cliente) return res.status(404).json({ ok: false, error: 'CLIENTE_NOT_FOUND' });
    if (cliente.bloqueado) return res.status(403).json({ ok: false, error: 'CLIENTE_BLOQUEADO' });

    // Obtener ig_account_id de la cuenta dueña de esta conversación para usar
    // el token correcto cuando el tenant tiene múltiples cuentas IG.
    let igAccountId = null;
    if (conv.ig_config_id) {
      const { data: igCfg } = await db.from('ig_config')
        .select('ig_account_id')
        .eq('id', conv.ig_config_id)
        .single();
      igAccountId = igCfg?.ig_account_id ?? null;
    }

    // AUDIT F2D #27: token leído vía RPC encrypted (no más TEXT plano).
    const { data: tokenIG, error: tokErr } = await db.rpc('get_ig_token', {
      p_tenant_id: conv.tenant_id,
      p_ig_account_id: igAccountId,
    });
    if (tokErr || !tokenIG) {
      return res.status(500).json({ ok: false, error: 'IG_CONFIG_NO_TOKEN', detail: tokErr?.message });
    }

    // ─── 5. Enviar via Graph API ────────────────────────────────────────
    const envio = await enviarMensaje({
      pageAccessToken: tokenIG,
      igsid: cliente.igsid,
      texto: texto.trim(),
    });

    if (!envio.ok) {
      // Loguear evento de error
      await db.from('ig_eventos').insert({
        tenant_id: conv.tenant_id,
        conversacion_id: conv.id,
        tipo: 'error',
        error_message: `Send manual fallo: ${envio.error}`,
      });
      return res.status(502).json({ ok: false, error: 'SEND_FAILED', detail: envio.error });
    }

    // ─── 6. Guardar mensaje out con origen='humano' ─────────────────────
    await db.from('ig_mensajes').insert({
      conversacion_id: conv.id,
      tenant_id: conv.tenant_id,
      direccion: 'out',
      origen: 'humano',
      usuario_id: usuario.id,
      tipo: 'texto',
      texto: texto.trim(),
      ig_mid: envio.message_id,
    });

    // Loguear evento
    await db.from('ig_eventos').insert({
      tenant_id: conv.tenant_id,
      conversacion_id: conv.id,
      tipo: 'message_sent',
      payload: { origen: 'humano', usuario: usuario.nombre, message_id: envio.message_id },
    });

    return res.status(200).json({ ok: true, message_id: envio.message_id });
  } catch (e) {
    console.error('[send] error:', e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}
