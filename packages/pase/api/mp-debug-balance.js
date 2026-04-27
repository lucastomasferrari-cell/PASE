// TEMP DEBUG ENDPOINT, borrar cuando termine task 0.11.
//
// Prueba 3 endpoints alternativos para obtener el balance de la cuenta MP
// y reporta status + body de cada uno. NO modifica BD, NO hace fallback,
// solo lista para que Lucas vea qué devuelve cada API.
//
// El endpoint actual (api.mercadolibre.com/users/{id}/mercadopago_account/balance)
// devuelve 403 forbidden — hay que descubrir si:
//   - el endpoint fue deprecado.
//   - el token del local no tiene el scope adecuado.
//   - hay otro path moderno en api.mercadopago.com.
//
// SECURITY: admin-only. Lee Authorization: Bearer <jwt> del header,
// valida con auth.getUser() (firma vía Supabase), y chequea que el
// usuario sea dueno/admin en public.usuarios.
//
// Cómo dispararlo desde el browser logueado (DevTools console):
//   const { data: { session } } = await db.auth.getSession();
//   const r = await fetch('/api/mp-debug-balance', {
//     headers: { Authorization: 'Bearer ' + session.access_token }
//   });
//   console.log(JSON.stringify(await r.json(), null, 2));
//
// Cómo dispararlo desde curl:
//   curl -H "Authorization: Bearer <JWT>" \
//     https://pase-yndx.vercel.app/api/mp-debug-balance

import { createMpTokenGetter } from './_mp-token.js';

const ENDPOINTS_TO_TRY = [
  // (1) Endpoint actual usado por _mp-balance.js — el que da 403.
  {
    name: 'ml_users_id_mercadopago_balance',
    url: (id) => `https://api.mercadolibre.com/users/${encodeURIComponent(id)}/mercadopago_account/balance`,
    desc: 'host ML, path histórico de cuenta MP/ML',
  },
  // (2) Alternativo en host MP.
  {
    name: 'mp_v1_account_balance',
    url: () => `https://api.mercadopago.com/v1/account/balance`,
    desc: 'host MP, path moderno sin user id',
  },
  // (3) Confirma si el token es válido + a veces trae info de balance embebida.
  {
    name: 'ml_users_me',
    url: () => `https://api.mercadolibre.com/users/me`,
    desc: 'sanity check de token + endpoint canónico de user info',
  },
];

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing SUPABASE env vars' });
    }

    // ── Auth admin-only ────────────────────────────────────────────────
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return res.status(401).json({ ok: false, error: 'missing_authorization_header' });

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data: userData, error: authErr } = await db.auth.getUser(jwt);
    if (authErr || !userData?.user?.id) {
      return res.status(401).json({ ok: false, error: 'invalid_jwt', detail: authErr?.message });
    }
    const authId = userData.user.id;

    const { data: perfil, error: perfilErr } = await db
      .from('usuarios')
      .select('id, email, rol, activo')
      .eq('auth_id', authId)
      .maybeSingle();
    if (perfilErr) return res.status(500).json({ ok: false, error: 'profile_lookup_failed', detail: perfilErr.message });
    if (!perfil) return res.status(403).json({ ok: false, error: 'no_profile_found_for_jwt' });
    if (!perfil.activo) return res.status(403).json({ ok: false, error: 'usuario_inactivo' });
    if (!['dueno', 'admin'].includes(perfil.rol)) {
      return res.status(403).json({ ok: false, error: 'admin_only', rol_actual: perfil.rol });
    }

    // ── Cargar credenciales activas ────────────────────────────────────
    const { data: creds, error: credsError } = await db
      .from('mp_credenciales')
      .select('id, local_id, locales(nombre)')
      .eq('activo', true);

    if (credsError) return res.status(500).json({ ok: false, error: credsError.message });
    if (!creds || creds.length === 0) {
      return res.status(200).json({ ok: true, message: 'Sin credenciales configuradas', credentials: [] });
    }

    const getMpToken = createMpTokenGetter(db);
    const startedAt = new Date().toISOString();

    const credentials = [];
    for (const cred of creds) {
      const credResult = {
        local_id: cred.local_id,
        local_name: cred.locales?.nombre || null,
        account_id: null,
        token_valid: null,
        endpoints: [],
        error: null,
      };

      try {
        const token = await getMpToken(cred.id);

        // Resolver account_id vía /users/me. Si /users/me falla, no hay
        // forma de armar la URL del endpoint (1) — pero aún así probamos
        // los otros 2 que no requieren id en path.
        let accountId = null;
        try {
          const meRes = await fetch('https://api.mercadolibre.com/users/me', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (meRes.ok) {
            const me = await meRes.json();
            accountId = me?.id != null ? String(me.id) : null;
          }
        } catch {} // noop, ya lo probaremos abajo
        credResult.account_id = accountId;

        // Probar los 3 endpoints en serie, capturar status + body raw
        // (primeros 500 chars). Independientes entre sí — si uno falla
        // seguimos con el siguiente.
        for (const ep of ENDPOINTS_TO_TRY) {
          const urlNeedsId = ep.name === 'ml_users_id_mercadopago_balance';
          if (urlNeedsId && !accountId) {
            credResult.endpoints.push({
              name: ep.name,
              desc: ep.desc,
              url: '(skipped: no accountId)',
              status: null,
              body: null,
              error: 'accountId no resuelto, /users/me probablemente falló',
            });
            continue;
          }
          const url = ep.url(accountId);
          try {
            const resp = await fetch(url, {
              headers: { Authorization: `Bearer ${token}` },
            });
            const body = (await resp.text()).slice(0, 500);
            credResult.endpoints.push({
              name: ep.name,
              desc: ep.desc,
              url,
              status: resp.status,
              ok: resp.ok,
              body,
            });
            // Si /users/me devolvió 200, marcar token como válido.
            if (ep.name === 'ml_users_me' && resp.ok) {
              credResult.token_valid = true;
            } else if (ep.name === 'ml_users_me' && !resp.ok) {
              credResult.token_valid = false;
            }
          } catch (e) {
            credResult.endpoints.push({
              name: ep.name,
              desc: ep.desc,
              url,
              status: null,
              body: null,
              error: `fetch_error: ${e?.message || String(e)}`,
            });
          }
        }
      } catch (e) {
        credResult.error = `exception: ${e?.message || String(e)}`;
      }

      credentials.push(credResult);
    }

    return res.status(200).json({
      ok: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      caller: { auth_id: authId, email: perfil.email, rol: perfil.rol },
      credentials,
    });
  } catch (err) {
    console.error('mp-debug-balance: unhandled error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
