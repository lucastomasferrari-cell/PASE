// Endpoint TEMPORAL para ejecutar SQL arbitrario (DDL incluído) contra la DB.
// Se elimina en el commit posterior una vez aplicada la migration.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!process.env.ADMIN_MIGRATION_SECRET) return res.status(500).json({ ok: false, error: 'Missing ADMIN_MIGRATION_SECRET' });
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_MIGRATION_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!process.env.POSTGRES_URL_NON_POOLING) return res.status(500).json({ ok: false, error: 'Missing POSTGRES_URL_NON_POOLING' });

  const { sql, params } = req.body || {};
  if (!sql || typeof sql !== 'string') return res.status(400).json({ ok: false, error: 'Body: { sql: text, params?: any[] }' });

  const { Client } = await import('pg');
  const client = new Client({
    connectionString: process.env.POSTGRES_URL_NON_POOLING,
    ssl: { rejectUnauthorized: false },
  });
  try { await client.connect(); }
  catch (err) { return res.status(500).json({ ok: false, error: 'Connect failed: ' + err.message }); }

  try {
    await client.query('BEGIN');
    const result = await client.query(sql, Array.isArray(params) ? params : undefined);
    await client.query('COMMIT');
    const payload = Array.isArray(result)
      ? result.map(r => ({ command: r.command, rowCount: r.rowCount, rows: r.rows }))
      : { command: result.command, rowCount: result.rowCount, rows: result.rows };
    return res.status(200).json({ ok: true, result: payload });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({
      ok: false, error: err.message, code: err.code,
      position: err.position, detail: err.detail, hint: err.hint,
    });
  } finally {
    await client.end().catch(() => {});
  }
}
