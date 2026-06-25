// Aplicar migration 202606240010_mesa_waitlist.sql
import { readFileSync } from 'fs';
import pg from 'pg';
const { Client } = pg;

const url = process.env.POSTGRES_URL_NON_POOLING;
if (!url) { console.error('Falta POSTGRES_URL_NON_POOLING'); process.exit(1); }

const sql = readFileSync('packages/pase/supabase/migrations/202606240010_mesa_waitlist.sql', 'utf8');
const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log('✅ Migration aplicada OK');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('❌ Error:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
