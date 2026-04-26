// One-shot: crea usuario dueno@pase.local en Supabase Auth
// y linkea con la tabla usuarios. Llamar una sola vez.
export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'Missing env vars' });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 1. Leer usuario dueno de la tabla
    const { data: dueno, error: dErr } = await db
      .from('usuarios')
      .select('*')
      .eq('email', 'dueno')
      .single();

    if (dErr || !dueno) {
      return res.status(404).json({ ok: false, error: 'Usuario dueno no encontrado', detail: dErr });
    }

    // 2. Verificar si ya tiene auth_id
    if (dueno.auth_id) {
      return res.status(200).json({ ok: true, message: 'Ya migrado', auth_id: dueno.auth_id });
    }

    // 3. Crear usuario en Supabase Auth
    const { data: authUser, error: authErr } = await db.auth.admin.createUser({
      email: 'dueno@pase.local',
      password: dueno.password, // usa la password actual (dueno123)
      email_confirm: true, // marcar como confirmado
      user_metadata: { nombre: dueno.nombre, rol: dueno.rol },
    });

    if (authErr) {
      return res.status(500).json({ ok: false, error: 'Error creando auth user', detail: authErr.message });
    }

    // 4. Agregar columna auth_id si no existe
    // Intentar update directo — si la columna no existe, dará error
    // y habrá que correr la migración manualmente en Supabase SQL Editor:
    // ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS auth_id uuid;

    // 5. Actualizar tabla usuarios con auth_id
    const { error: updErr } = await db
      .from('usuarios')
      .update({ auth_id: authUser.user.id })
      .eq('id', dueno.id);

    if (updErr) {
      return res.status(500).json({
        ok: false,
        error: 'Auth user creado pero no se pudo linkear',
        auth_id: authUser.user.id,
        detail: updErr.message,
      });
    }

    return res.status(200).json({
      ok: true,
      message: 'Usuario dueno migrado a Supabase Auth',
      auth_id: authUser.user.id,
      email: 'dueno@pase.local',
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
