// Endpoint temporal para correr migrations contra Supabase desde local.
// Autenticación: header x-admin-secret = ADMIN_MIGRATION_SECRET (env var en
// Vercel encriptada, no accesible localmente). Lee POSTGRES_URL_NON_POOLING
// (también encriptada) en runtime y abre una conexión directa con `pg`.
//
// Uso: POST /api/admin-run-sql { sql: "..." } con header x-admin-secret.
// CLEANUP: este endpoint y la dep `pg` se eliminan en C6 del refactor C.
import pg from "pg";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }
  const secret = req.headers["x-admin-secret"];
  if (!secret || secret !== process.env.ADMIN_MIGRATION_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const sql = req.body?.sql;
  if (!sql || typeof sql !== "string") {
    res.status(400).json({ error: "missing_sql" });
    return;
  }
  const url = process.env.POSTGRES_URL_NON_POOLING;
  if (!url) {
    res.status(500).json({ error: "missing_db_url" });
    return;
  }
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    const result = await client.query(sql);
    const rows = Array.isArray(result) ? result.map(r => ({ rowCount: r.rowCount, rows: r.rows })) : { rowCount: result.rowCount, rows: result.rows };
    res.status(200).json({ ok: true, result: rows });
  } catch (err) {
    res.status(500).json({ error: "sql_error", message: err.message });
  } finally {
    try { await client.end(); } catch {}
  }
}
