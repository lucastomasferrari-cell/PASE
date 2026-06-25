// One-off: reconciliar prod — re-aplicar 202606111200 (restaura cuerpos
// CRIT-9 pisados por el apply intermedio) y aplicar 202606111300 (mesa-ops).
const fs = require('fs');
const lines = fs.readFileSync('.env.local.tmp', 'utf8').split('\n');
const url = lines.find((l) => l.startsWith('POSTGRES_URL_NON_POOLING='))
  ?.split('=').slice(1).join('=').replace(/^"|"$/g, '');
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('BEGIN');
  try {
    const sql1200 = fs.readFileSync('supabase/migrations/202606111200_fix_wrappers_offline_inner_names.sql', 'utf8');
    await c.query(sql1200);
    console.log('1200 re-aplicada (CRIT-9 restaurado)');

    const sql1300 = fs.readFileSync('supabase/migrations/202606111300_fix_wrappers_mesa_ops_args.sql', 'utf8');
    await c.query(sql1300);
    console.log('1300 aplicada (mesa-ops)');

    // Verificación final integral
    const crit9 = await c.query(`
      SELECT COUNT(*) AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.prosrc LIKE '%IDEMPOTENCY_UUID_REUSE%'
        AND p.proname IN ('fn_anular_item_comanda_offline','fn_cortesia_item_comanda_offline','fn_modificar_precio_item_comanda_offline');
    `);
    if (crit9.rows[0].n !== '3') throw new Error('CRIT-9 no quedó en los 3 wrappers: ' + crit9.rows[0].n);
    console.log('CRIT-9 verificado en los 3 wrappers de item');

    await c.query('COMMIT');
    console.log('\nRECONCILIACION COMPLETA ✅');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLBACK:', e.message);
    process.exit(1);
  } finally {
    await c.end();
  }
})();
