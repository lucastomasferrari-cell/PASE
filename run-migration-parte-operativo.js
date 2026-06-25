// Script one-off para aplicar la migración de partes_operativos.
// Correr así (desde la raíz del repo):
//   POSTGRES_URL_NON_POOLING="postgres://..." node run-migration-parte-operativo.js
//
// Para obtener la URL: Vercel → Settings → Environment Variables →
// POSTGRES_URL_NON_POOLING (desmarcar "Sensitive" si no aparece, o copiar desde el panel).

import { readFileSync } from 'fs';
import { Client } from 'pg';

const url = process.env.POSTGRES_URL_NON_POOLING;
if (!url) {
  console.error('ERROR: falta env var POSTGRES_URL_NON_POOLING');
  process.exit(1);
}

const sql = readFileSync(
  'packages/pase/supabase/migrations/202606241200_parte_operativo.sql',
  'utf8',
);

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(sql);
  await client.query('COMMIT');
  console.log('✅ Migración aplicada: tabla partes_operativos creada');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('❌ Error al aplicar la migración:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
