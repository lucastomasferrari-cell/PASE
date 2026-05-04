// Auditoría del bug Caja-1 — extendida (PR refactor-permisos-cuentas).
//
// Detección: movimientos cargados en los últimos 60 días donde la cuenta
// persistida NO estaba en cuentas_visibles del usuario que originó el
// movimiento. Cubre todos los path de carga:
//
//   path                     │ tabla auditada               │ FK movimiento
//   ─────────────────────────┼─────────────────────────────┼─────────────────
//   Caja "Nuevo Movimiento"  │ movimientos / CREAR         │ id directo
//   Gastos "Cargar Gasto"    │ gastos / CREAR              │ gasto_id_ref
//   Compras "Pagar factura"  │ facturas / PAGO             │ fact_id
//   Remitos "Pagar remito"   │ remitos / PAGO              │ remito_id_ref
//   RRHH adelanto            │ rrhh_adelantos / CREAR      │ adelanto_id_ref
//   RRHH pagar sueldo        │ rrhh_liquidaciones / PAGO   │ liquidacion_id
//   RRHHLegajo vacaciones    │ rrhh_pagos_especiales/VAC.  │ pago_especial_id_ref
//   RRHHLegajo aguinaldo     │ rrhh_pagos_especiales/AGU.  │ pago_especial_id_ref
//   RRHHLegajo liq.final     │ rrhh_empleados/LIQ_FINAL    │ pago_especial_id_ref
//   Transferencia            │ movimientos/TRANSFERENCIA   │ transferencia_id
//
// Todos los audits incluyen `usuario_id` en su JSON detalle. El script
// indexa `auditoria.detalle` por la FK del movimiento y mapea de vuelta.
//
// Solo lectura. NO modifica filas.

import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL || !KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en env.');
  process.exit(1);
}

const db = createClient(URL, KEY, { auth: { persistSession: false } });

const desde = new Date();
desde.setDate(desde.getDate() - 60);
const desdeIso = desde.toISOString().slice(0, 10);

// 1. Movimientos del periodo.
const { data: movimientos, error: e1 } = await db
  .from('movimientos')
  .select('id, fecha, cuenta, importe, detalle, local_id, tenant_id, tipo, anulado, fact_id, remito_id_ref, gasto_id_ref, adelanto_id_ref, liquidacion_id, pago_especial_id_ref, transferencia_id')
  .gte('fecha', desdeIso)
  .order('fecha', { ascending: false });
if (e1) { console.error('Error movimientos:', e1); process.exit(1); }

// 2. Gastos del periodo (por si hay gastos sin movimiento espejo, edge case).
const { data: gastos, error: e1b } = await db
  .from('gastos')
  .select('id, fecha, cuenta, monto, detalle, local_id')
  .gte('fecha', desdeIso)
  .order('fecha', { ascending: false });
if (e1b) { console.error('Error gastos:', e1b); process.exit(1); }

// 3. Auditoría: filas relevantes en una ventana extendida.
const desdeAudit = new Date();
desdeAudit.setDate(desdeAudit.getDate() - 67);
const TABLAS = [
  'movimientos','gastos','facturas','remitos',
  'rrhh_adelantos','rrhh_liquidaciones','rrhh_pagos_especiales','rrhh_empleados',
];
const { data: audits, error: e2 } = await db
  .from('auditoria')
  .select('id, tabla, accion, detalle, fecha')
  .in('tabla', TABLAS)
  .gte('fecha', desdeAudit.toISOString());
if (e2) { console.error('Error auditoria:', e2); process.exit(1); }

// 4. Usuarios. NOTA: cuentas_operables se agregó en migration
// 202605041700; si la migration no corrió todavía, omitimos la columna
// (este script tiene que poder correr en cualquier estado).
let usuarios;
{
  const { data, error } = await db
    .from('usuarios')
    .select('id, nombre, email, rol, activo, cuentas_visibles, cuentas_operables, tenant_id');
  if (error && /cuentas_operables/.test(error.message || '')) {
    const r2 = await db
      .from('usuarios')
      .select('id, nombre, email, rol, activo, cuentas_visibles, tenant_id');
    if (r2.error) { console.error('Error usuarios:', r2.error); process.exit(1); }
    usuarios = r2.data;
  } else if (error) { console.error('Error usuarios:', error); process.exit(1); }
  else { usuarios = data; }
}

const userById = new Map(usuarios.map(u => [Number(u.id), u]));

// 5. Indexar audits por FK del movimiento. Cada index maps "FK value → usuario_id".
const idx = {
  movId:          new Map(),  // auditoria('movimientos','CREAR').mov_id
  gastoId:        new Map(),  // auditoria('gastos','CREAR').gasto_id
  facturaId:      new Map(),  // auditoria('facturas','PAGO').factura_id
  remitoId:       new Map(),  // auditoria('remitos','PAGO').remito_id
  adelantoId:     new Map(),  // auditoria('rrhh_adelantos','CREAR').adelanto_id
  liqId:          new Map(),  // auditoria('rrhh_liquidaciones','PAGO').liq_id
  pagoEspId:      new Map(),  // auditoria('rrhh_pagos_especiales',{VACACIONES|AGUINALDO}).pago_id
  liqFinalEmpId:  new Map(),  // auditoria('rrhh_empleados','LIQUIDACION_FINAL').emp_id (si no hay pago_id directo)
  transferenciaId:new Map(),  // auditoria('movimientos','TRANSFERENCIA').transferencia_id
};
for (const a of audits) {
  let d;
  try { d = typeof a.detalle === 'string' ? JSON.parse(a.detalle) : a.detalle; } catch { continue; }
  if (!d || d.usuario_id == null) continue;
  const uid = Number(d.usuario_id);
  if (a.tabla === 'movimientos' && a.accion === 'CREAR' && d.mov_id)
    idx.movId.set(String(d.mov_id), uid);
  if (a.tabla === 'movimientos' && a.accion === 'TRANSFERENCIA' && d.transferencia_id)
    idx.transferenciaId.set(String(d.transferencia_id), uid);
  if (a.tabla === 'gastos' && a.accion === 'CREAR' && d.gasto_id)
    idx.gastoId.set(String(d.gasto_id), uid);
  if (a.tabla === 'facturas' && a.accion === 'PAGO' && d.factura_id)
    idx.facturaId.set(String(d.factura_id), uid);
  if (a.tabla === 'remitos' && a.accion === 'PAGO' && d.remito_id)
    idx.remitoId.set(String(d.remito_id), uid);
  if (a.tabla === 'rrhh_adelantos' && a.accion === 'CREAR' && d.adelanto_id)
    idx.adelantoId.set(String(d.adelanto_id), uid);
  if (a.tabla === 'rrhh_liquidaciones' && a.accion === 'PAGO' && d.liq_id)
    idx.liqId.set(String(d.liq_id), uid);
  if (a.tabla === 'rrhh_pagos_especiales' && (a.accion === 'VACACIONES' || a.accion === 'AGUINALDO') && d.pago_id)
    idx.pagoEspId.set(String(d.pago_id), uid);
  if (a.tabla === 'rrhh_empleados' && a.accion === 'LIQUIDACION_FINAL') {
    if (d.pago_id) idx.pagoEspId.set(String(d.pago_id), uid);
    if (d.emp_id)  idx.liqFinalEmpId.set(String(d.emp_id), uid);
  }
}

// 6. Resolver el usuario_id de cada movimiento por orden de prioridad de FK.
const resolveUserId = (m) => {
  // Movimientos creados por crear_movimiento_caja: el detalle de auditoria
  // ('movimientos', 'CREAR') indexa por mov_id (= m.id).
  if (idx.movId.has(String(m.id))) return idx.movId.get(String(m.id));
  if (m.gasto_id_ref && idx.gastoId.has(String(m.gasto_id_ref))) return idx.gastoId.get(String(m.gasto_id_ref));
  if (m.fact_id && idx.facturaId.has(String(m.fact_id))) return idx.facturaId.get(String(m.fact_id));
  if (m.remito_id_ref && idx.remitoId.has(String(m.remito_id_ref))) return idx.remitoId.get(String(m.remito_id_ref));
  if (m.adelanto_id_ref && idx.adelantoId.has(String(m.adelanto_id_ref))) return idx.adelantoId.get(String(m.adelanto_id_ref));
  if (m.liquidacion_id && idx.liqId.has(String(m.liquidacion_id))) return idx.liqId.get(String(m.liquidacion_id));
  if (m.pago_especial_id_ref && idx.pagoEspId.has(String(m.pago_especial_id_ref))) return idx.pagoEspId.get(String(m.pago_especial_id_ref));
  if (m.transferencia_id && idx.transferenciaId.has(String(m.transferencia_id))) return idx.transferenciaId.get(String(m.transferencia_id));
  return null;
};

// 7. Clasificar cada movimiento por path (para breakdown).
const pathDeMov = (m) => {
  if (m.gasto_id_ref) return 'Gastos (cargar)';
  if (m.fact_id) return 'Compras (pagar factura)';
  if (m.remito_id_ref) return 'Remitos (pagar remito)';
  if (m.adelanto_id_ref) return 'RRHH (adelanto)';
  if (m.liquidacion_id) return 'RRHH (sueldo)';
  if (m.pago_especial_id_ref) return 'RRHHLegajo (vac/agu/liq.final)';
  if (m.transferencia_id) return 'Caja (transferencia)';
  return 'Caja (movimiento manual)';
};

// 8. Filtrar sospechosos: cuenta del movimiento NO está en cuentas_visibles
//    del usuario que lo cargó. Excluimos roles dueno/admin/superadmin (no
//    tienen restricción).
const userCantVer = (u, cuenta) => {
  if (!u) return null;
  if (u.rol === 'dueno' || u.rol === 'admin' || u.rol === 'superadmin') return false;
  if (u.cuentas_visibles == null) return false;
  return Array.isArray(u.cuentas_visibles) && !u.cuentas_visibles.includes(cuenta);
};

const sospechosos = [];
const sinAudit = [];
for (const m of movimientos) {
  if (m.anulado) continue;
  const userId = resolveUserId(m);
  if (userId == null) { sinAudit.push(m); continue; }
  const u = userById.get(Number(userId));
  if (!u) continue;
  if (userCantVer(u, m.cuenta)) {
    sospechosos.push({ mov: m, usuario: u, path: pathDeMov(m) });
  }
}

// 9. Stats.
const totalMovs = movimientos.filter(m => !m.anulado).length;
const totalSospechosos = sospechosos.length;
const totalSinAudit = sinAudit.length;
const breakdownPorPath = {};
const breakdownPorUsuario = {};
const breakdownPorCuenta = {};
let montoTotalAfectado = 0;
for (const { mov, usuario, path: pth } of sospechosos) {
  breakdownPorPath[pth] = (breakdownPorPath[pth] || 0) + 1;
  const uk = `${usuario.nombre || usuario.email || 'usuario_' + usuario.id} (${usuario.rol})`;
  breakdownPorUsuario[uk] = (breakdownPorUsuario[uk] || 0) + 1;
  breakdownPorCuenta[mov.cuenta] = (breakdownPorCuenta[mov.cuenta] || 0) + 1;
  montoTotalAfectado += Math.abs(Number(mov.importe || 0));
}

// 10. Movimientos legacy con local_id NULL (Bug 1B del prompt).
const movsLocalIdNull = movimientos.filter(m => m.local_id == null);

// 11. Render del MD.
const fmt$ = n => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const sortedPaths = Object.entries(breakdownPorPath).sort((a, b) => b[1] - a[1]);
const sortedUsers = Object.entries(breakdownPorUsuario).sort((a, b) => b[1] - a[1]);
const sortedCuentas = Object.entries(breakdownPorCuenta).sort((a, b) => b[1] - a[1]);

let md = '';
md += `# Auditoría — Bug Caja-1 (extendida a Compras / Remitos / RRHH)\n\n`;
md += `**Generado**: ${new Date().toISOString()}\n`;
md += `**Ventana**: movimientos desde ${desdeIso} hasta hoy (60 días)\n`;
md += `**Método**: cruce de \`movimientos\` × \`auditoria\` (detalle JSON, indexado por FK) × \`usuarios.cuentas_visibles\`\n\n`;
md += `## Resultado global\n\n`;
md += `- Total movimientos no-anulados en el período: **${totalMovs}**\n`;
md += `- Gastos en el período (puede haber doble-conteo con movimientos): ${gastos.length}\n`;
md += `- **Movimientos potencialmente mal cargados: ${totalSospechosos}**\n`;
md += `- Movimientos sin fila de auditoría asociada: ${totalSinAudit}\n`;
md += `- Monto absoluto total afectado: **${fmt$(montoTotalAfectado)}**\n\n`;
md += `> Esto es **estimativo**. Algunos casos pueden ser legítimos: cuentas otorgadas y luego revocadas, usuarios con scope cambiado entre carga y auditoría, etc. Lucas decide caso por caso.\n\n`;

md += `## Breakdown por path de carga\n\n`;
if (sortedPaths.length === 0) md += `_Sin sospechosos._\n\n`;
else {
  md += `| Path (módulo de carga) | Cantidad |\n|---|---:|\n`;
  for (const [p, n] of sortedPaths) md += `| ${p} | ${n} |\n`;
  md += `\n`;
}

md += `## Breakdown por usuario\n\n`;
if (sortedUsers.length === 0) md += `_Sin usuarios afectados._\n\n`;
else {
  md += `| Usuario | Cantidad |\n|---|---:|\n`;
  for (const [u, n] of sortedUsers) md += `| ${u} | ${n} |\n`;
  md += `\n`;
}

md += `## Breakdown por cuenta destino persistida\n\n`;
if (sortedCuentas.length === 0) md += `_Sin cuentas afectadas._\n\n`;
else {
  md += `| Cuenta persistida | Cantidad |\n|---|---:|\n`;
  for (const [c, n] of sortedCuentas) md += `| ${c} | ${n} |\n`;
  md += `\n`;
}

md += `## Lista detallada de movimientos sospechosos\n\n`;
if (sospechosos.length === 0) md += `_Ninguno._\n\n`;
else {
  md += `| Mov ID | Path | Fecha | Cuenta | Importe | Usuario | cuentas_visibles | Detalle |\n`;
  md += `|---|---|---|---|---:|---|---|---|\n`;
  for (const { mov, usuario, path: pth } of sospechosos) {
    const visible = Array.isArray(usuario.cuentas_visibles) ? usuario.cuentas_visibles.join(', ') : '(null)';
    const detalle = (mov.detalle || '').replace(/\|/g, '\\|').slice(0, 60);
    const fecha = (mov.fecha || '').slice(0, 10);
    md += `| \`${mov.id}\` | ${pth} | ${fecha} | ${mov.cuenta} | ${fmt$(mov.importe)} | ${usuario.nombre || usuario.email} (${usuario.rol}) | ${visible} | ${detalle} |\n`;
  }
  md += `\n`;
}

md += `## Movimientos legacy con local_id NULL\n\n`;
md += `Reportar (no tocar). Nota del prompt: hay un movimiento legacy con local_id=NULL contra MercadoPago. Listamos los del período por si aparecen más.\n\n`;
if (movsLocalIdNull.length === 0) md += `_Ninguno en el período._\n\n`;
else {
  md += `| Mov ID | Fecha | Cuenta | Importe | Tipo | Detalle |\n`;
  md += `|---|---|---|---:|---|---|\n`;
  for (const m of movsLocalIdNull) {
    const detalle = (m.detalle || '').replace(/\|/g, '\\|').slice(0, 60);
    md += `| \`${m.id}\` | ${(m.fecha || '').slice(0,10)} | ${m.cuenta} | ${fmt$(m.importe)} | ${m.tipo} | ${detalle} |\n`;
  }
  md += `\n`;
}

md += `## Notas\n\n`;
md += `- La auditoría **NO modifica ninguna fila**. Solo lee.\n`;
md += `- El refactor de permisos (PR refactor-permisos-cuentas) previene que el bug aparezca con el patrón controlled-select-value-not-in-options. NO corrige los movimientos ya mal cargados.\n`;
md += `- Para cada caso sospechoso, Lucas decide:\n`;
md += `  - Si la cuenta persistida es la equivocada → corregir vía edición de movimiento (Caja.tsx → Editar Movimiento, con justificativo).\n`;
md += `  - Si era legítimo (permiso especial, cuenta antes-visible) → ignorar.\n`;
md += `- ${totalSinAudit} movimientos sin fila de auditoría: pueden ser anteriores a la migración \`20260418_auditoria.sql\`, INSERT directo desde código (no vía RPC), o haber fallado el INSERT en auditoria por algún motivo.\n`;

const outDir = path.resolve(process.cwd(), '../../docs');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'AUDITORIA_BUG_CAJA1.md');
fs.writeFileSync(outPath, md, 'utf-8');
console.log('Escrito:', outPath);
console.log('Total movimientos en periodo:', totalMovs);
console.log('Total sospechosos:', totalSospechosos);
console.log('Movimientos sin audit:', totalSinAudit);
console.log('Movimientos local_id=NULL en periodo:', movsLocalIdNull.length);
console.log('Monto absoluto afectado:', fmt$(montoTotalAfectado));
