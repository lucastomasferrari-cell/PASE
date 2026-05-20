// Endpoint para crear un tenant nuevo end-to-end.
//
// Flow:
//   1. Valida JWT del caller (Authorization: Bearer <token>).
//   2. Verifica que el caller es superadmin via lookup en `usuarios`
//      (rol='superadmin').
//   3. Crea el auth.user via `db.auth.admin.createUser({email, password,
//      email_confirm: true})`. Esto genera el UID.
//   4. Llama RPC `crear_tenant_v2(..., p_auth_id=auth_user.id)` que crea
//      atómicamente tenant + usuario + local + tenant_admins + audit.
//   5. Si la RPC falla, hace rollback: `auth.admin.deleteUser(auth_user.id)`.
//
// Usa SUPABASE_SERVICE_KEY (bypassa RLS — la validación de superadmin se
// hace explícitamente arriba, no por RLS).
//
// NOTA: este endpoint hace lo que la RPC vieja `crear_tenant` intentaba
// hacer pero no podía (porque desde DB no se puede crear auth.users —
// requiere admin API). Es el patrón canónico para onboarding multi-tenant.
//
// Errores devueltos:
//   400 — campos faltantes / inválidos.
//   401 — JWT inválido o expirado.
//   403 — caller no es superadmin.
//   409 — slug o email duplicado.
//   500 — error inesperado (auth.admin falló, RPC falló, etc.).

export default async function handler(req, res) {
  // CORS: el admin-console vive en otro dominio (deploy Vercel separado) y
  // necesita poder llamar este endpoint. La auth se hace por JWT en
  // Authorization header — no usamos cookies — así que es seguro aceptar
  // cualquier origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }

    // ─── 1. Validar JWT del caller ──────────────────────────────────────
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: 'NO_TOKEN' });
    }
    const token = authHeader.slice(7);

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: authUser, error: getUserErr } = await db.auth.getUser(token);
    if (getUserErr || !authUser?.user?.id) {
      return res.status(401).json({ ok: false, error: 'TOKEN_INVALID' });
    }
    const callerAuthId = authUser.user.id;

    // ─── 2. Verificar que el caller es superadmin ───────────────────────
    const { data: callerRow, error: callerErr } = await db.from('usuarios')
      .select('id, rol, activo')
      .eq('auth_id', callerAuthId)
      .single();
    if (callerErr || !callerRow) {
      return res.status(403).json({ ok: false, error: 'CALLER_NOT_FOUND' });
    }
    if (!callerRow.activo) {
      return res.status(403).json({ ok: false, error: 'CALLER_INACTIVE' });
    }
    if (callerRow.rol !== 'superadmin') {
      return res.status(403).json({ ok: false, error: 'NOT_SUPERADMIN' });
    }

    // ─── 3. Validar payload ─────────────────────────────────────────────
    const {
      nombre, slug, plan, dueno_email, dueno_nombre, dueno_password,
      local_nombre, local_direccion, trial_dias,
    } = req.body || {};

    if (!nombre || !slug || !dueno_email || !dueno_nombre || !dueno_password || !local_nombre) {
      return res.status(400).json({ ok: false, error: 'MISSING_FIELDS' });
    }
    if (typeof dueno_password !== 'string' || dueno_password.length < 8) {
      return res.status(400).json({ ok: false, error: 'PASSWORD_TOO_SHORT' });
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({ ok: false, error: 'SLUG_INVALID_FORMAT' });
    }

    // El email para Supabase Auth: si no contiene @, le agregamos @pase.local
    // (mismo patrón que Login.tsx para mantener consistencia).
    const authEmail = dueno_email.includes('@') ? dueno_email : dueno_email + '@pase.local';

    // ─── 4. Crear auth.user ─────────────────────────────────────────────
    const { data: newAuth, error: createAuthErr } = await db.auth.admin.createUser({
      email: authEmail,
      password: dueno_password,
      email_confirm: true,  // skip confirmation email
      user_metadata: { nombre: dueno_nombre, rol: 'dueno' },
    });
    if (createAuthErr || !newAuth?.user?.id) {
      const msg = createAuthErr?.message || 'AUTH_CREATE_FAILED';
      // Probable: email ya existe en auth.users (algún tenant anterior lo usó).
      if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exists')) {
        return res.status(409).json({ ok: false, error: 'EMAIL_ALREADY_IN_AUTH', detail: msg });
      }
      return res.status(500).json({ ok: false, error: msg });
    }
    const newAuthId = newAuth.user.id;

    // ─── 5. Llamar RPC crear_tenant_v2 con el auth_id ───────────────────
    const { data: rpcData, error: rpcErr } = await db.rpc('crear_tenant_v2', {
      p_nombre: nombre,
      p_slug: slug,
      p_plan: plan || 'trial',
      p_dueno_email: dueno_email,
      p_dueno_nombre: dueno_nombre,
      p_auth_id: newAuthId,
      p_local_nombre: local_nombre,
      p_local_direccion: local_direccion || null,
      p_trial_dias: trial_dias || 14,
    });

    if (rpcErr) {
      // Rollback: borrar el auth.user que creamos.
      try {
        await db.auth.admin.deleteUser(newAuthId);
      } catch (rollbackErr) {
        // Log pero no falla la response — el error original es más importante.
        console.error('[crear-tenant] Rollback auth.user falló:', rollbackErr?.message);
      }

      const msg = rpcErr.message || 'RPC_FAILED';
      if (msg.includes('SLUG_DUPLICATED')) {
        return res.status(409).json({ ok: false, error: 'SLUG_DUPLICATED' });
      }
      if (msg.includes('EMAIL_DUPLICATED')) {
        return res.status(409).json({ ok: false, error: 'EMAIL_DUPLICATED' });
      }
      if (msg.includes('AUTH_ID_DUPLICATED')) {
        return res.status(500).json({ ok: false, error: 'AUTH_ID_DUPLICATED' });
      }
      return res.status(500).json({ ok: false, error: msg });
    }

    return res.status(200).json({ ok: true, ...rpcData });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
}
