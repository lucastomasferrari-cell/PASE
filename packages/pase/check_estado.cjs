// One-off: estado actual de los wrappers en prod (¿qué versión quedó viva?).
const fs = require('fs');
const lines = fs.readFileSync('.env.local.tmp', 'utf8').split('\n');
const url = lines.find((l) => l.startsWith('POSTGRES_URL_NON_POOLING='))
  ?.split('=').slice(1).join('=').replace(/^"|"$/g, '');
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  // 1. ¿anular_item tiene el cuerpo CRIT-9 (IDEMPOTENCY_UUID_REUSE)?
  const r1 = await c.query(`
    SELECT p.proname, (p.prosrc LIKE '%IDEMPOTENCY_UUID_REUSE%') AS crit9
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN
      ('fn_anular_item_comanda_offline','fn_cortesia_item_comanda_offline','fn_modificar_precio_item_comanda_offline');
  `);
  console.log('CRIT-9 presente:', JSON.stringify(r1.rows));
  // 2. firmas de los mesa-ops (¿tienen p_manager_id?)
  const r2 = await c.query(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN
      ('fn_transferir_mesa_comanda_offline','fn_unir_mesas_comanda_offline','fn_partir_cuenta_comanda_offline');
  `);
  for (const row of r2.rows) console.log(row.proname, '→', row.args.includes('p_manager_id') ? 'CON manager' : 'SIN manager');
  // 3. overloads duplicados
  const r3 = await c.query(`
    SELECT p.proname, COUNT(*) AS n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE '%_comanda_offline'
    GROUP BY p.proname HAVING COUNT(*) > 1;
  `);
  console.log('overloads dup:', JSON.stringify(r3.rows));
  // 4. ¿anon puede ejecutar alguno?
  const r4 = await c.query(`
    SELECT COUNT(*) AS abiertas
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE '%_comanda_offline'
      AND has_function_privilege('anon', p.oid, 'EXECUTE');
  `);
  console.log('wrappers ejecutables por anon:', r4.rows[0].abiertas);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
