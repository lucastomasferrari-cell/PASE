// Endpoint para crear usuarios y cambiar contraseñas via Supabase Auth admin API.
// Solo accesible desde el frontend cuando el usuario tiene rol=dueno/admin/superadmin.
//
// SEGURIDAD (fix auditoría 2026-05-21 CRIT-1):
//   - Requiere JWT del caller en Authorization header.
//   - Solo dueno/admin/superadmin pueden invocar.
//   - change_password: el target authId debe pertenecer al mismo tenant que el
//     caller (excepto superadmin que puede cruzar tenants).
//   - create: rol pedido NO puede ser >= al del caller. Tenant_id forzado al
//     del caller si NO es superadmin (no podés crear usuarios en otro tenant).
//
// Multi-tenant:
// - El payload puede incluir `tenant_id` explícito (solo respetado si caller
//   es superadmin).
// - Si no viene tenant_id y el caller no es superadmin, se usa el tenant del caller.
// - Mantiene fallback a Neko solo para superadmin sin tenant_id pasado.
import { checkUserAuth } from './_user-auth.js';

// Jerarquía de roles (más alto = más poder). Si un rol no está acá, se ignora.
const ROLE_RANK = {
  superadmin: 100,
  dueno: 50,
  admin: 40,
  encargado: 20,
  cajero: 10,
};

async function resolveTenantId(db, payloadTenantId, callerRow) {
  // Solo superadmin puede pasar tenant_id explícito y respetarse.
  if (callerRow.rol === 'superadmin') {
    if (payloadTenantId) return payloadTenantId;
    const { data } = await db.from('tenants').select('id').eq('slug', 'neko').single();
    return data?.id || null;
  }
  // No-superadmin: forzar al tenant del caller (defensa contra cross-tenant create).
  return callerRow.tenant_id;
}

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }

    // ─── AUTH del caller (CRIT-1 fix) ────────────────────────────────────
    const auth = await checkUserAuth(req, res);
    if (!auth) return; // checkUserAuth ya respondió 401/403/500

    // Solo roles administrativos pueden invocar este endpoint.
    if (!['superadmin', 'dueno', 'admin'].includes(auth.row.rol)) {
      return res.status(403).json({ ok: false, error: 'forbidden_role' });
    }
    const callerRank = ROLE_RANK[auth.row.rol] || 0;
    // ─────────────────────────────────────────────────────────────────────

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { action, nombre, usuario, password, rol, locales: userLocales, authId, tenant_id: payloadTenantId } = req.body || {};

    if (action === 'create') {
      if (!nombre || !usuario || !password) {
        return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
      }

      const requestedRol = rol || 'encargado';
      const requestedRank = ROLE_RANK[requestedRol] || 0;

      // No podés crear un usuario con rol >= al tuyo.
      // (superadmin=100 sí puede crear superadmin=100 — caso edge para Lucas;
      // dueno=50 NO puede crear dueno=50; admin=40 NO puede crear dueno=50.)
      if (auth.row.rol !== 'superadmin' && requestedRank >= callerRank) {
        return res.status(403).json({ ok: false, error: 'cannot_create_role_higher_or_equal' });
      }

      // 1. Intentar crear en Supabase Auth (no bloquea si falla)
      let newAuthId = null;
      try {
        const authEmail = usuario.includes('@') ? usuario : usuario + '@pase.local';
        const { data: authUser, error: authErr } = await db.auth.admin.createUser({
          email: authEmail,
          password,
          email_confirm: true,
          user_metadata: { nombre, rol: requestedRol },
        });
        if (authErr) {
          console.warn('[auth-admin] Supabase Auth falló (continuando sin auth):', authErr.message);
        } else {
          newAuthId = authUser.user.id;
        }
      } catch (authCatchErr) {
        console.warn('[auth-admin] Supabase Auth exception (continuando sin auth):', authCatchErr.message);
      }

      // 2. Hash SHA-256 de la contraseña
      const { createHash } = await import('crypto');
      const hashPassword = createHash('sha256').update(password).digest('hex');

      // 3. INSERT en tabla usuarios.
      // tenant_id forzado al del caller si NO es superadmin (defensa cross-tenant).
      const tenantId = await resolveTenantId(db, payloadTenantId, auth.row);
      const userRow = {
        nombre,
        email: usuario,
        password: hashPassword,
        rol: requestedRol,
        activo: true,
        locales: userLocales || [],
        auth_id: newAuthId,
      };
      // Solo poner tenant_id si NO es superadmin (CHECK usuarios_tenant_check).
      if (requestedRol !== 'superadmin') {
        userRow.tenant_id = tenantId;
      }
      const { error: insertErr } = await db.from('usuarios').insert([userRow]);

      if (insertErr) {
        return res.status(500).json({ ok: false, error: insertErr.message });
      }

      return res.status(200).json({ ok: true, auth_id: newAuthId });

    } else if (action === 'change_password') {
      // Cambiar contraseña en Supabase Auth
      if (!authId || !password) {
        console.error('[auth-admin] change_password: faltan campos', { authId: !!authId, password: !!password });
        return res.status(400).json({ ok: false, error: 'Faltan authId o password' });
      }

      // ─── Validar que el target pertenece al mismo tenant que el caller ───
      // (superadmin puede cruzar tenants; resto no).
      if (auth.row.rol !== 'superadmin') {
        const { data: targetRow } = await db.from('usuarios')
          .select('id, rol, tenant_id')
          .eq('auth_id', authId)
          .maybeSingle();
        if (!targetRow) {
          return res.status(404).json({ ok: false, error: 'target_user_not_found' });
        }
        if (targetRow.tenant_id !== auth.row.tenant_id) {
          return res.status(403).json({ ok: false, error: 'cross_tenant_password_change_denied' });
        }
        // No podés cambiar la contraseña de alguien con rol >= al tuyo.
        const targetRank = ROLE_RANK[targetRow.rol] || 0;
        if (targetRank >= callerRank) {
          return res.status(403).json({ ok: false, error: 'cannot_change_password_of_higher_role' });
        }
      }

      console.log('[auth-admin] change_password para authId:', authId, '(por caller:', auth.row.id, auth.row.rol + ')');
      const { error: updErr } = await db.auth.admin.updateUserById(authId, {
        password,
      });

      if (updErr) {
        console.error('[auth-admin] change_password falló:', updErr.message);
        return res.status(500).json({ ok: false, error: updErr.message });
      }

      console.log('[auth-admin] change_password OK para authId:', authId);
      return res.status(200).json({ ok: true });

    } else {
      return res.status(400).json({ ok: false, error: 'action requerida: create | change_password' });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
