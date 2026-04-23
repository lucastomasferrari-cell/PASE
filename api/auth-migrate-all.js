// Migra TODOS los usuarios activos sin auth_id a Supabase Auth.
// Protegido con header x-admin-secret === process.env.ADMIN_MIGRATION_SECRET.
// Devuelve las passwords temporales en la response (distribución fuera de banda).
//
// Uso:
//   curl -X POST https://pase-yndx.vercel.app/api/auth-migrate-all \
//     -H "x-admin-secret: <secret>"
import { randomBytes } from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY' });
    }
    if (!process.env.ADMIN_MIGRATION_SECRET) {
      return res.status(500).json({ ok: false, error: 'Missing ADMIN_MIGRATION_SECRET' });
    }

    const provided = req.headers['x-admin-secret'];
    if (provided !== process.env.ADMIN_MIGRATION_SECRET) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: usuarios, error: listErr } = await db
      .from('usuarios')
      .select('id, email, nombre, rol')
      .is('auth_id', null)
      .eq('activo', true);

    if (listErr) {
      return res.status(500).json({ ok: false, error: 'Error leyendo usuarios', detail: listErr.message });
    }

    const migrated = [];
    const errors = [];

    for (const u of usuarios || []) {
      if (!u.email || !u.email.trim()) {
        errors.push({ id: u.id, nombre: u.nombre, status: 'email_vacio' });
        continue;
      }

      const emailUsado = u.email.includes('@') ? u.email : u.email + '@pase.local';
      const passwordTemporal = randomBytes(16).toString('hex'); // 32 chars hex

      const { data: authUser, error: authErr } = await db.auth.admin.createUser({
        email: emailUsado,
        password: passwordTemporal,
        email_confirm: true,
        user_metadata: { nombre: u.nombre, rol: u.rol },
      });

      if (authErr) {
        errors.push({ id: u.id, email_usado: emailUsado, status: 'auth_create_fail', error: authErr.message });
        continue;
      }

      const { error: updErr } = await db
        .from('usuarios')
        .update({ auth_id: authUser.user.id, password_temporal: true })
        .eq('id', u.id);

      if (updErr) {
        errors.push({
          id: u.id,
          email_usado: emailUsado,
          status: 'auth_ok_link_fail',
          auth_id: authUser.user.id,
          error: updErr.message,
        });
        continue;
      }

      migrated.push({
        id: u.id,
        email_usado: emailUsado,
        password_temporal: passwordTemporal,
        status: 'ok',
      });
    }

    return res.status(200).json({
      ok: true,
      summary: {
        total: (usuarios || []).length,
        ok: migrated.length,
        fail: errors.length,
      },
      migrated,
      errors,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
