// One-off: firmas COMPLETAS (con DEFAULT) de las funciones internas.
const fs = require('fs');
const lines = fs.readFileSync('.env.local.tmp', 'utf8').split('\n');
const url = lines.find((l) => l.startsWith('POSTGRES_URL_NON_POOLING='))
  ?.split('=').slice(1).join('=').replace(/^"|"$/g, '');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const r = await c.query(`
    SELECT p.proname, pg_get_function_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'fn_anular_item_comanda', 'fn_cortesia_item_comanda',
      'fn_modificar_precio_item_comanda', 'fn_anular_venta_comanda',
      'fn_transferir_mesa_comanda', 'fn_unir_mesas_comanda', 'fn_partir_cuenta_comanda'
    )
    ORDER BY p.proname;
  `);
  for (const row of r.rows) console.log(row.proname + '\n   (' + row.args + ')');
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
