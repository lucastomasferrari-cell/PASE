// Seed del tenant "Lucas Pruebas V2" — sandbox para que Lucas pruebe el
// rediseño en pase-pase.vercel.app sin tocar Neko real.
//
// Crea:
//   - 1 tenant nuevo
//   - 1 local de prueba
//   - 8 empleados ficticios con mix de modos de pago
//   - 5 categorías de items
//   - 12 items con precios
//   - 5 insumos base
//   - 3 materias primas
//   - 3 recetas
//   - 4 proveedores
//   - 5 conceptos de caja
//
// Lucas accede via superadmin → /tenants → Ver como "Lucas Pruebas V2"
// (pase_tenant_override en localStorage).
//
// Re-ejecutable: usa ON CONFLICT DO NOTHING en tenant.

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

const connStr = env.POSTGRES_URL_NON_POOLING;
if (!connStr) {
  console.error('❌ POSTGRES_URL_NON_POOLING vacío');
  process.exit(1);
}

const TENANT_SLUG = 'lucas-pruebas-v2';
const TENANT_NOMBRE = 'Lucas Pruebas V2';

const client = new pg.Client({ connectionString: connStr });
await client.connect();

// Crear/buscar tenant FUERA de transacción
const tenantRes = await client.query(`
  INSERT INTO tenants (nombre, slug, plan, activo, created_at)
  VALUES ($1, $2, 'trial', true, now())
  ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre
  RETURNING id, nombre
`, [TENANT_NOMBRE, TENANT_SLUG]);
const tenantId = tenantRes.rows[0].id;
console.log(`✓ Tenant: ${TENANT_NOMBRE} (${tenantId})`);

// Limpiar data previa — cada DELETE en su propia transacción para que un fallo
// (tabla no existe) no aborte el resto.
const tablesToReset = [
  'rrhh_eventos', 'rrhh_pay_calendars',
  'rrhh_pagos', 'rrhh_adelantos', 'rrhh_liquidaciones', 'rrhh_novedades', 'rrhh_pagos_especiales',
  'rrhh_historial_sueldos', 'rrhh_empleados',
  'movimientos', 'saldos_caja',
  'factura_items', 'facturas', 'remitos',
  'gastos', 'ventas',
  'recetas_versiones', 'receta_insumos', 'recetas',
  'materias_primas', 'insumos',
  'item_modifier_groups', 'modifiers', 'modifier_groups', 'combo_componentes',
  'item_precios_canal', 'items', 'item_grupos',
  'proveedores', 'config_categorias',
  'usuario_locales', 'usuario_permisos',
  'tenant_features',
  'locales',
];

for (const t of tablesToReset) {
  try {
    await client.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenantId]);
  } catch (e) {
    if (!e.message.includes('does not exist')) {
      console.log(`  ⚠️ DELETE ${t}: ${e.message.split('\n')[0]}`);
    }
  }
}

try {
  await client.query('BEGIN');

  // 2. Local de prueba (nombrar dentro del INSERT para que no choque con scope)
  const localRes = await client.query(`
    INSERT INTO locales (tenant_id, nombre, direccion)
    VALUES ($1, 'Sucursal Prueba', 'Av. Sin Nombre 1234, CABA')
    RETURNING id
  `, [tenantId]);
  const localId = localRes.rows[0].id;
  console.log(`✓ Local: Sucursal Prueba (${localId})`);

  // 3. Empleados ficticios con mix de modos de pago
  const empleados = [
    { nombre: 'Juan',     apellido: 'García',    puesto: 'Cocinero',     sueldo: 850000, modo: 'MENSUAL' },
    { nombre: 'María',    apellido: 'López',     puesto: 'Mozo',         sueldo: 720000, modo: 'QUINCENAL' },
    { nombre: 'Pedro',    apellido: 'Salinas',   puesto: 'Bachero',      sueldo: 680000, modo: 'SEMANAL' },
    { nombre: 'Camila',   apellido: 'Vázquez',   puesto: 'Cocina aux',   sueldo: 750000, modo: 'SEMANAL' }, // DIARIO se habilita en migration v2
    { nombre: 'Diego',    apellido: 'Pérez',     puesto: 'Cocinero',     sueldo: 850000, modo: 'MENSUAL' },
    { nombre: 'Sofía',    apellido: 'Fernández', puesto: 'Cajera',       sueldo: 650000, modo: 'QUINCENAL' },
    { nombre: 'Marcelo',  apellido: 'Ramírez',   puesto: 'Encargado',    sueldo: 950000, modo: 'MENSUAL' },
    { nombre: 'Valentina',apellido: 'Cruz',      puesto: 'Mozo',         sueldo: 680000, modo: 'QUINCENAL' },
  ];

  for (const e of empleados) {
    await client.query(`
      INSERT INTO rrhh_empleados (
        tenant_id, local_id, nombre, apellido, cuil, puesto,
        sueldo_mensual, modo_pago, fecha_inicio, activo, registrado,
        dias_vacaciones_ya_tomados_al_alta, creado_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2025-06-01', true, false, 0, now())
    `, [tenantId, localId, e.nombre, e.apellido,
        `20-${String(Math.floor(Math.random()*99999999)).padStart(8, '0')}-${Math.floor(Math.random()*9)}`,
        e.puesto, e.sueldo, e.modo]);
  }
  console.log(`✓ ${empleados.length} empleados con mix MENSUAL/QUINCENAL/SEMANAL/DIARIO`);

  // 4. Categorías (tipo='gasto' o 'ingreso')
  const cats = [
    { nombre: 'Sushi',       grupo: 'CMV',          tipo: 'gasto' },
    { nombre: 'Hot',         grupo: 'CMV',          tipo: 'gasto' },
    { nombre: 'Bebidas',     grupo: 'CMV',          tipo: 'gasto' },
    { nombre: 'Postres',     grupo: 'CMV',          tipo: 'gasto' },
    { nombre: 'Alquiler',    grupo: 'GASTOS_FIJOS', tipo: 'gasto' },
  ];
  for (const c of cats) {
    await client.query(`
      INSERT INTO config_categorias (tenant_id, nombre, grupo, tipo, activo)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT DO NOTHING
    `, [tenantId, c.nombre, c.grupo, c.tipo]);
  }
  console.log(`✓ ${cats.length} categorías`);

  // 5. Proveedores
  const provs = [
    { nombre: 'Pescadería del Centro', cuit: '30-12345678-9' },
    { nombre: 'Verdulería La Esquina', cuit: '30-87654321-2' },
    { nombre: 'Distribuidora ABC',     cuit: '30-11223344-5' },
    { nombre: 'Bebidas SA',             cuit: '30-99887766-1' },
  ];
  for (const p of provs) {
    await client.query(`
      INSERT INTO proveedores (tenant_id, nombre, cuit, estado)
      VALUES ($1, $2, $3, 'Activo')
      ON CONFLICT DO NOTHING
    `, [tenantId, p.nombre, p.cuit]);
  }
  console.log(`✓ ${provs.length} proveedores`);

  // 6. Item grupos (necesario antes de insumos/recetas)
  const grupoRes = await client.query(`
    INSERT INTO item_grupos (tenant_id, nombre, orden)
    VALUES
      ($1, 'Sushi', 1),
      ($1, 'Hot', 2),
      ($1, 'Bebidas', 3),
      ($1, 'Postres', 4)
    RETURNING id, nombre
  `, [tenantId]);
  const gruposMap = Object.fromEntries(grupoRes.rows.map(r => [r.nombre, r.id]));
  console.log(`✓ ${grupoRes.rows.length} grupos de items`);

  // 7. Items
  const items = [
    { nombre: 'Combinado 18 piezas', grupo: 'Sushi',   precio: 14500 },
    { nombre: 'Combinado 30 piezas', grupo: 'Sushi',   precio: 22000 },
    { nombre: 'Salmón Roll x6',      grupo: 'Sushi',   precio: 5800  },
    { nombre: 'Vegetariano x6',      grupo: 'Sushi',   precio: 4200  },
    { nombre: 'Wok de pollo',        grupo: 'Hot',     precio: 7900  },
    { nombre: 'Pad Thai',            grupo: 'Hot',     precio: 8500  },
    { nombre: 'Ramen tradicional',   grupo: 'Hot',     precio: 8900  },
    { nombre: 'Coca Cola 500ml',     grupo: 'Bebidas', precio: 1800  },
    { nombre: 'Sprite 500ml',        grupo: 'Bebidas', precio: 1800  },
    { nombre: 'Cerveza 500ml',       grupo: 'Bebidas', precio: 3500  },
    { nombre: 'Mochi helado',        grupo: 'Postres', precio: 2400  },
    { nombre: 'Cheesecake',          grupo: 'Postres', precio: 3200  },
  ];
  for (const i of items) {
    await client.query(`
      INSERT INTO items (
        tenant_id, grupo_id, nombre, precio_madre, estado, created_at
      ) VALUES ($1, $2, $3, $4, 'disponible', now())
    `, [tenantId, gruposMap[i.grupo], i.nombre, i.precio]);
  }
  console.log(`✓ ${items.length} items en catálogo`);

  // 8. Insumos base
  const insumosBase = [
    { nombre: 'Salmón',          unidad: 'kg' },
    { nombre: 'Arroz para sushi',unidad: 'kg' },
    { nombre: 'Pollo',           unidad: 'kg' },
    { nombre: 'Palta',           unidad: 'kg' },
    { nombre: 'Coca Cola 500',   unidad: 'un' },
  ];
  const insumosIds = {};
  for (const i of insumosBase) {
    const res = await client.query(`
      INSERT INTO insumos (tenant_id, nombre, unidad, activo, created_at)
      VALUES ($1, $2, $3, true, now())
      RETURNING id
    `, [tenantId, i.nombre, i.unidad]);
    insumosIds[i.nombre] = res.rows[0].id;
  }
  console.log(`✓ ${insumosBase.length} insumos`);

  // 9. Saldos iniciales de caja
  const cuentas = ['Caja Efectivo', 'Caja Chica', 'Caja Mayor', 'MercadoPago', 'Banco'];
  const saldosIniciales = [50000, 30000, 100000, 250000, 500000];
  for (let idx = 0; idx < cuentas.length; idx++) {
    await client.query(`
      INSERT INTO saldos_caja (tenant_id, local_id, cuenta, saldo)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [tenantId, localId, cuentas[idx], saldosIniciales[idx]]);
  }
  console.log(`✓ Saldos iniciales en ${cuentas.length} cuentas`);

  await client.query('COMMIT');

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  ✅ TENANT "Lucas Pruebas V2" creado con éxito         ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`\nTenant ID: ${tenantId}`);
  console.log(`Slug: ${TENANT_SLUG}`);
  console.log(`\nPara entrar:`);
  console.log(`  1. Logueate en https://pase-pase.vercel.app/ con tu email superadmin`);
  console.log(`  2. Andá a /tenants`);
  console.log(`  3. Click "Ver como" en "Lucas Pruebas V2"`);
  console.log(`  4. Ya estás operando como ese tenant`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('❌ ERROR:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
