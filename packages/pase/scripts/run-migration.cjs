#!/usr/bin/env node
// Runner genérico de migraciones. Lee POSTGRES_URL_NON_POOLING de
// packages/pase/.env.local (git-ignoreado) y aplica el .sql que le pases.
//
// Uso:
//   node packages/pase/scripts/run-migration.cjs <ruta-al-.sql>
//   node packages/pase/scripts/run-migration.cjs packages/pase/supabase/migrations/202606302100_anular_remito_pagado_revierte_caja.sql
//
// Corre el archivo entero dentro de una transacción: si algo falla, rollback.
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env.local');
const file = process.argv[2];

if (!file) {
  console.error('Falta la ruta del .sql.\nUso: node packages/pase/scripts/run-migration.cjs <archivo.sql>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`No existe el archivo: ${file}`);
  process.exit(1);
}

const env = fs.readFileSync(ENV_PATH, 'utf8');
const m = env.match(/^POSTGRES_URL_NON_POOLING\s*=\s*"?([^"\n]+)"?/m);
if (!m) {
  console.error(
    'Falta POSTGRES_URL_NON_POOLING en packages/pase/.env.local\n' +
    'Pegá la connection string directa de Supabase (Project Settings > Database).'
  );
  process.exit(1);
}
const url = m[1].trim();
const sql = fs.readFileSync(file, 'utf8');

const c = new Client({ connectionString: url });
(async () => {
  await c.connect();
  console.log(`Aplicando ${path.basename(file)} ...`);
  try {
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('COMMIT');
    console.log('OK — migración aplicada.');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ERROR — rollback. Detalle:', e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
})();
