// TASK 0.15 — Tests RLS automáticos de aislamiento multi-tenant.
//
// IMPORTANTE — comportamiento esperado según la etapa de migración:
//
//   - Durante ETAPA 3a (dual policies): T2 pasa, T1/T3/T4 FALLAN
//     porque las policies viejas (sin filtro de tenant) siguen activas
//     en paralelo con las nuevas. Postgres aplica OR entre PERMISSIVE
//     policies → un usuario pasa si CUALQUIERA lo deja pasar. Esto es
//     POR DISEÑO (defensa para no romper sistema durante migración).
//
//   - Después de ETAPA 3b (DROP de viejas): TODOS los tests deben pasar.
//     Si fallan algún test post-3b → bug en RLS, NO hacer merge a main.
//
// Etapa 3b va a invocar este script ANTES y DESPUÉS de su DROP de
// policies viejas, para validar el delta esperado.
//
// Suite standalone (no vitest/playwright) que se conecta a la BD con
// POSTGRES_URL_NON_POOLING (service_role bypassa RLS, podemos crear datos
// de prueba) y simula JWTs con set_config('request.jwt.claims', ...) para
// validar que las RLS aplican el filtro de tenant correctamente.
//
// Uso (desde packages/pase/):
//   1. npx vercel env pull .env.local.tmp --environment=production --yes
//      (ejecutar desde la raíz del repo, no dentro de packages/pase)
//   2. node tests/rls_isolation.cjs
//
// Tests:
//   T1 — Lucas (dueño Neko) ve solo data de Neko (no de tenant temporal).
//   T2 — Encargado de Neko (id=6, locales=[1]) ve solo ventas de su local.
//   T3 — Cross-tenant write: Lucas no puede insertar en local de tenant ajeno.
//   T4 — Per-table sweep: para cada una de las 35 tablas con tenant_id,
//        validar que Lucas SOLO ve filas con tenant_id = Neko.
//
// Setup atómico: todo el suite corre dentro de UNA transacción que se
// ROLLBACK al final para no dejar data de prueba en la BD.

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const dbUrl = fs.readFileSync(path.join(__dirname, '..', '..', '..', '.env.local.tmp'), 'utf8')
  .match(/^POSTGRES_URL_NON_POOLING="?([^"\n]+)"?/m)[1];

// Lista de tablas con tenant_id que deben respetar el filtro.
const TABLAS_CON_TENANT = [
  'locales', 'ventas', 'gastos', 'facturas', 'movimientos', 'remitos',
  'saldos_caja', 'mp_credenciales', 'mp_movimientos',
  'rrhh_empleados', 'blindaje_documentos', 'medios_cobro',
  'proveedores', 'insumos', 'recetas', 'config_categorias',
  'rrhh_valores_doble', 'blindaje_tipos_documento',
  'usuario_locales', 'usuario_permisos',
  'factura_items', 'factura_items_stock', 'receta_items', 'remito_items',
  'mp_liquidaciones', 'rrhh_novedades', 'rrhh_liquidaciones',
  'rrhh_documentos', 'rrhh_historial_sueldos', 'rrhh_pagos_especiales',
  'rrhh_adelantos', 'empleado_archivos', 'auditoria',
];

const c = new Client({ connectionString: dbUrl });
let passed = 0, failed = 0;

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function selectAs(authId, query) {
  await c.query(`SELECT set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: authId, role: 'authenticated' })]);
  await c.query(`SET LOCAL ROLE authenticated`);
  try {
    const r = await c.query(query);
    return r.rows;
  } finally {
    await c.query(`RESET ROLE`);
  }
}

async function tableExists(t) {
  const r = await c.query(`SELECT to_regclass($1) AS oid`, [`public.${t}`]);
  return r.rows[0].oid !== null;
}

(async () => {
  await c.connect();
  console.log('═══ Tests RLS isolation multi-tenant ═══\n');

  await c.query('BEGIN');
  console.log('[setup] BEGIN — todo el suite va dentro de una transacción atómica.\n');

  try {
    // Setup: identificar Lucas (dueño Neko) y un encargado.
    const lucasRow = await c.query(`SELECT id, auth_id, tenant_id FROM usuarios WHERE id=1`);
    const lucasAuth = lucasRow.rows[0].auth_id;
    const nekoTenant = lucasRow.rows[0].tenant_id;

    const encRow = await c.query(`
      SELECT u.id, u.auth_id, u.tenant_id,
             array_agg(ul.local_id ORDER BY ul.local_id) AS locales
        FROM usuarios u
        JOIN usuario_locales ul ON ul.usuario_id = u.id
       WHERE u.id=6 AND u.rol='encargado' AND u.activo
       GROUP BY u.id, u.auth_id, u.tenant_id
    `);
    const encAuth = encRow.rows[0].auth_id;
    const encLocales = encRow.rows[0].locales;
    console.log(`[setup] Lucas (id=1, dueno): tenant=${nekoTenant?.slice(0,8)}...`);
    console.log(`[setup] Encargado (id=6): tenant=${encRow.rows[0].tenant_id?.slice(0,8)}..., locales=[${encLocales}]`);

    // Crear tenant temporal de prueba con 1 local + 1 venta.
    const fakeT = await c.query(`INSERT INTO tenants (nombre, slug, plan) VALUES ('TestRLS','test-rls','trial') RETURNING id`);
    const fakeTenantId = fakeT.rows[0].id;
    const fakeL = await c.query(`INSERT INTO locales (nombre, tenant_id) VALUES ('LocalTestRLS', $1) RETURNING id`, [fakeTenantId]);
    const fakeLocalId = fakeL.rows[0].id;
    await c.query(`INSERT INTO ventas (id, fecha, turno, medio, monto, local_id, tenant_id, origen)
                   VALUES ($1, CURRENT_DATE, 'Mediodía', 'TEST', 99999, $2, $3, 'test')`,
      [`V-TEST-${Date.now()}`, fakeLocalId, fakeTenantId]);
    console.log(`[setup] Tenant temporal '${fakeTenantId.slice(0,8)}...' con local ${fakeLocalId} y 1 venta de $99.999.\n`);

    // ─── T1: Lucas (dueño Neko) NO ve venta del tenant temporal ─────────
    console.log('T1 — Lucas (dueño Neko) ve solo data de Neko');
    const ventasLucas = await selectAs(lucasAuth, `SELECT COUNT(*)::int AS n FROM ventas WHERE tenant_id != '${nekoTenant}'`);
    check('Lucas no ve ventas de otro tenant', ventasLucas[0].n === 0, `count=${ventasLucas[0].n}`);

    const localesLucas = await selectAs(lucasAuth, `SELECT COUNT(*)::int AS n FROM locales WHERE tenant_id != '${nekoTenant}'`);
    check('Lucas no ve locales de otro tenant', localesLucas[0].n === 0, `count=${localesLucas[0].n}`);

    const totalVentasLucas = await selectAs(lucasAuth, `SELECT COUNT(*)::int AS n FROM ventas`);
    const realNeko = await c.query(`SELECT COUNT(*)::int AS n FROM ventas WHERE tenant_id = $1`, [nekoTenant]);
    check('Lucas ve TODAS las ventas de Neko', totalVentasLucas[0].n === realNeko.rows[0].n,
      `Lucas=${totalVentasLucas[0].n}, expected=${realNeko.rows[0].n}`);

    // ─── T2: Encargado solo ve sus locales ──────────────────────────────
    console.log('\nT2 — Encargado (id=6, locales=[1]) ve solo ventas de su local');
    const ventasEnc = await selectAs(encAuth, `SELECT COUNT(*)::int AS n FROM ventas`);
    const expectedEnc = await c.query(`SELECT COUNT(*)::int AS n FROM ventas WHERE local_id = ANY($1::int[])`, [encLocales]);
    check(`Encargado ve solo ventas de sus locales (${encLocales.length} locales)`,
      ventasEnc[0].n === expectedEnc.rows[0].n, `enc=${ventasEnc[0].n}, expected=${expectedEnc.rows[0].n}`);

    const ventasEncOtros = await selectAs(encAuth,
      `SELECT COUNT(*)::int AS n FROM ventas WHERE NOT (local_id = ANY(ARRAY[${encLocales.join(',')}]::int[]))`);
    check('Encargado NO ve ventas de otros locales', ventasEncOtros[0].n === 0, `count=${ventasEncOtros[0].n}`);

    // ─── T3: Cross-tenant write blocked ─────────────────────────────────
    console.log('\nT3 — Cross-tenant write attempt → blocked');
    await c.query('SAVEPOINT t3');
    let writeBlocked = false, writeDetail = '';
    try {
      // Lucas intenta insertar venta en local del tenant temporal.
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: lucasAuth, role: 'authenticated' })]);
      await c.query(`SET LOCAL ROLE authenticated`);
      await c.query(`INSERT INTO ventas (id, fecha, turno, medio, monto, local_id, tenant_id, origen)
                     VALUES ('V-CROSS-${Date.now()}', CURRENT_DATE, 'Noche', 'TEST', 1, $1, $2, 'test')`,
        [fakeLocalId, fakeTenantId]);
      writeDetail = 'INSERT pasó — FAIL';
      await c.query('RESET ROLE');
    } catch (e) {
      writeBlocked = (e.message || '').includes('row-level security') || (e.message || '').includes('violates');
      writeDetail = e.message;
      try { await c.query('RESET ROLE'); } catch (_) {}
    }
    await c.query('ROLLBACK TO SAVEPOINT t3');
    check('Lucas no puede insertar venta en local de otro tenant', writeBlocked, writeDetail.slice(0, 80));

    // ─── T4: Per-table sweep ────────────────────────────────────────────
    console.log('\nT4 — Per-table sweep: cada tabla solo devuelve filas del tenant Neko para Lucas');
    let tablasOk = 0, tablasFail = [];
    for (const tabla of TABLAS_CON_TENANT) {
      if (!(await tableExists(tabla))) continue;
      // Lucas ve TODAS las filas de la tabla? Debe ser igual al COUNT del tenant Neko (service_role).
      const lucasCount = await selectAs(lucasAuth, `SELECT COUNT(*)::int AS n FROM ${tabla}`);
      const realNekoCount = await c.query(`SELECT COUNT(*)::int AS n FROM ${tabla} WHERE tenant_id = $1`, [nekoTenant]);
      const otherCount = await selectAs(lucasAuth, `SELECT COUNT(*)::int AS n FROM ${tabla} WHERE tenant_id != '${nekoTenant}'`);

      const ok = lucasCount[0].n === realNekoCount.rows[0].n && otherCount[0].n === 0;
      if (ok) { tablasOk++; }
      else { tablasFail.push(`${tabla}(lucas=${lucasCount[0].n}, neko=${realNekoCount.rows[0].n}, otros=${otherCount[0].n})`); }
    }
    check(`Per-table sweep: ${tablasOk} tablas OK`, tablasFail.length === 0,
      tablasFail.length ? 'falladas: ' + tablasFail.join('; ') : `${tablasOk}/${TABLAS_CON_TENANT.length} verificadas`);

    // ─── Resumen ────────────────────────────────────────────────────────
    console.log(`\n═══ Resultado: ${passed} passed, ${failed} failed ═══`);
    if (failed > 0) {
      await c.query('ROLLBACK');
      console.log('\n✗ FAIL — ROLLBACK ejecutado, BD intacta.');
      process.exit(1);
    } else {
      await c.query('ROLLBACK'); // siempre rollback (tenant temporal de prueba)
      console.log('\n✓ TODOS los tests OK — ROLLBACK ejecutado (tenant temporal removido).');
    }
  } catch (e) {
    console.error('[setup] EXCEPTION:', e.message);
    try { await c.query('ROLLBACK'); } catch (_) {}
    process.exit(1);
  } finally {
    await c.end();
  }
})();
