// Endpoint para crear usuarios y cambiar contraseñas via Supabase Auth admin API.
// Solo accesible desde el frontend cuando el usuario tiene rol=dueno.
//
// Multi-tenant (TASK 0.15):
// - El endpoint corre con service_role (bypassa RLS), así que NO tiene auth
//   context del caller automático.
// - El payload puede incluir `tenant_id` explícito (frontend de superadmin
//   lo va a pasar en etapas futuras).
// - Si no viene tenant_id en el payload, se asume tenant Neko como default
//   (defensive, mantiene compat con frontend pre-multitenant).
async function resolveTenantId(db, payloadTenantId) {
  if (payloadTenantId) return payloadTenantId;
  const { data } = await db.from('tenants').select('id').eq('slug', 'neko').single();
  return data?.id || null;
}

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { action, nombre, usuario, password, rol, locales: userLocales, userId, authId, tenant_id: payloadTenantId } = req.body || {};

    if (action === 'create') {
      if (!nombre || !usuario || !password) {
        return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
      }

      // 1. Intentar crear en Supabase Auth (no bloquea si falla)
      let authId = null;
      try {
        const authEmail = usuario.includes('@') ? usuario : usuario + '@pase.local';
        const { data: authUser, error: authErr } = await db.auth.admin.createUser({
          email: authEmail,
          password,
          email_confirm: true,
          user_metadata: { nombre, rol: rol || 'encargado' },
        });
        if (authErr) {
          console.warn('[auth-admin] Supabase Auth falló (continuando sin auth):', authErr.message);
        } else {
          authId = authUser.user.id;
        }
      } catch (authCatchErr) {
        console.warn('[auth-admin] Supabase Auth exception (continuando sin auth):', authCatchErr.message);
      }

      // 2. Hash SHA-256 de la contraseña
      const { createHash } = await import('crypto');
      const hashPassword = createHash('sha256').update(password).digest('hex');

      // 3. INSERT en tabla usuarios (sin campo id, SERIAL auto-incremental)
      // tenant_id resolved del payload o default a Neko.
      const tenantId = await resolveTenantId(db, payloadTenantId);
      const userRow = {
        nombre,
        email: usuario,
        password: hashPassword,
        rol: rol || 'encargado',
        activo: true,
        locales: userLocales || [],
        auth_id: authId,
      };
      // Solo poner tenant_id si NO es superadmin. Superadmin debe quedar
      // con tenant_id NULL (CHECK usuarios_tenant_check lo respalda).
      if ((rol || 'encargado') !== 'superadmin') {
        userRow.tenant_id = tenantId;
      }
      const { error: insertErr } = await db.from('usuarios').insert([userRow]);

      if (insertErr) {
        return res.status(500).json({ ok: false, error: insertErr.message });
      }

      return res.status(200).json({ ok: true, auth_id: authId });

    } else if (action === 'change_password') {
      // Cambiar contraseña en Supabase Auth
      if (!authId || !password) {
        console.error('[auth-admin] change_password: faltan campos', { authId: !!authId, password: !!password });
        return res.status(400).json({ ok: false, error: 'Faltan authId o password' });
      }

      console.log('[auth-admin] change_password para authId:', authId);
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
