// One-off: aplicar 202606111100 en prod + verificaciones.
const fs = require('fs');
const lines = fs.readFileSync('.env.local.tmp', 'utf8').split('\n');
const url = lines.find((l) => l.startsWith('POSTGRES_URL_NON_POOLING='))
  ?.split('=').slice(1).join('=').replace(/^"|"$/g, '');
const sql = fs.readFileSync('supabase/migrations/202606111100_fix_wrappers_offline_nombres_internos.sql', 'utf8');
const { Client } = require('pg');

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('BEGIN');
  try {
    await c.query(sql);

    // Verificación 1: exactamente 1 overload por wrapper (el DROP+CREATE no
    // debe dejar versiones duplicadas que rompan PostgREST con PGRST203).
    const ov = await c.query(`
      SELECT p.proname, COUNT(*) AS n
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname LIKE '%_comanda_offline'
      GROUP BY p.proname HAVING COUNT(*) > 1;
    `);
    if (ov.rows.length > 0) throw new Error('OVERLOADS DUPLICADOS: ' + JSON.stringify(ov.rows));

    // Verificación 2: los cuerpos referencian las funciones internas REALES.
    const checks = [
      ['fn_anular_venta_comanda_offline', 'fn_anular_venta_comanda('],
      ['fn_anular_item_comanda_offline', 'fn_anular_item_comanda('],
      ['fn_cortesia_item_comanda_offline', 'fn_cortesia_item_comanda('],
      ['fn_modificar_precio_item_comanda_offline', 'fn_modificar_precio_item_comanda('],
      ['fn_transferir_mesa_comanda_offline', 'fn_transferir_mesa_comanda('],
      ['fn_unir_mesas_comanda_offline', 'fn_unir_mesas_comanda(v_origen, v_destino'],
      ['fn_partir_cuenta_comanda_offline', 'fn_partir_cuenta_comanda('],
    ];
    for (const [fn, esperado] of checks) {
      const r = await c.query(`
        SELECT pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public' AND p.proname = $1;
      `, [fn]);
      if (r.rows.length !== 1) throw new Error(fn + ': esperaba 1 def, hay ' + r.rows.length);
      if (!r.rows[0].def.includes(esperado)) throw new Error(fn + ': el cuerpo NO contiene "' + esperado + '"');
      console.log('OK ' + fn + ' → ' + esperado.split('(')[0]);
    }

    await c.query('COMMIT');
    console.log('\nMIGRACION APLICADA Y VERIFICADA ✅');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLBACK:', e.message);
    process.exit(1);
  } finally {
    await c.end();
  }
})();
