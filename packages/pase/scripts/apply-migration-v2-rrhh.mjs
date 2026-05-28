// Aplica la migration ADITIVA del Spec #1 RRHH a la DB compartida.
// Solo CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN — no rompe lo existente.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const env = Object.fromEntries(
  readFileSync(resolve('.env.local.tmp'), 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => {
      const [k, ...rest] = l.split('=');
      return [k, rest.join('=').replace(/^"|"$/g, '')];
    })
);

const sql = readFileSync(resolve('supabase/migrations/202605282000_v2_rrhh_eventos_calendars.sql'), 'utf8');

const client = new pg.Client({ connectionString: env.POSTGRES_URL_NON_POOLING });
await client.connect();

try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log('✅ Migration aplicada en transacción única.');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('❌ ROLLBACK:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
