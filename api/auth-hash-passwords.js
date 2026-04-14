// One-shot: hashea los passwords en texto plano de la tabla usuarios.
// Agrega columna password_hash, hashea cada password, y limpia password.
// Llamar una sola vez después de aplicar la migración RLS.
import { createHash } from 'crypto';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
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

    // Leer todos los usuarios
    const { data: usuarios, error } = await db.from('usuarios').select('id, email, password');
    if (error) return res.status(500).json({ ok: false, error: error.message });

    const results = [];

    for (const u of usuarios) {
      // Si password ya es un hash (64 chars hex) o '***', skip
      if (!u.password || u.password === '***' || u.password.length === 64) {
        results.push({ id: u.id, email: u.email, status: 'already_hashed' });
        continue;
      }

      const hash = sha256(u.password);
      const { error: updErr } = await db
        .from('usuarios')
        .update({ password: hash })
        .eq('id', u.id);

      if (updErr) {
        results.push({ id: u.id, email: u.email, status: 'error', error: updErr.message });
      } else {
        results.push({ id: u.id, email: u.email, status: 'hashed' });
      }
    }

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
