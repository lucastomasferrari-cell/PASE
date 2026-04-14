// Endpoint para crear usuarios y cambiar contraseñas via Supabase Auth admin API.
// Solo accesible desde el frontend cuando el usuario tiene rol=dueno.
export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { action, nombre, usuario, password, rol, locales: userLocales, userId, authId } = req.body || {};

    if (action === 'create') {
      // Crear usuario en Supabase Auth + tabla usuarios
      if (!nombre || !usuario || !password || !rol) {
        return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
      }

      const authEmail = usuario.includes('@') ? usuario : usuario + '@pase.local';

      const { data: authUser, error: authErr } = await db.auth.admin.createUser({
        email: authEmail,
        password,
        email_confirm: true,
        user_metadata: { nombre, rol },
      });

      if (authErr) {
        return res.status(500).json({ ok: false, error: authErr.message });
      }

      const { error: insertErr } = await db.from('usuarios').insert([{
        nombre,
        email: usuario,
        password: '***', // no guardar en texto plano
        rol,
        locales: userLocales || [],
        auth_id: authUser.user.id,
      }]);

      if (insertErr) {
        // Rollback: borrar auth user
        await db.auth.admin.deleteUser(authUser.user.id);
        return res.status(500).json({ ok: false, error: insertErr.message });
      }

      return res.status(200).json({ ok: true, auth_id: authUser.user.id });

    } else if (action === 'change_password') {
      // Cambiar contraseña
      if (!authId || !password) {
        return res.status(400).json({ ok: false, error: 'Faltan authId o password' });
      }

      const { error: updErr } = await db.auth.admin.updateUserById(authId, {
        password,
      });

      if (updErr) {
        return res.status(500).json({ ok: false, error: updErr.message });
      }

      return res.status(200).json({ ok: true });

    } else {
      return res.status(400).json({ ok: false, error: 'action requerida: create | change_password' });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
