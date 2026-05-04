// Auditoría del bug Caja-1 (4-mayo, reporte de Camilo).
//
// Detección: gastos cargados en los últimos 60 días donde la cuenta persistida
// NO está en cuentas_visibles del usuario que lo cargó. El usuario_id se
// deriva de auditoria.detalle (JSON) porque la tabla `gastos` no tiene
// created_by — la RPC crear_gasto registra en auditoria con
// _auditar('gastos','CREAR', { gasto_id, mov_id, monto, ..., usuario_id }).
//
// Solo lectura. NO modifica ninguna fila.

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

// Ventana de auditoría: 60 días hacia atrás desde hoy.
const desde = new Date();
desde.setDate(desde.getDate() - 60);
const desdeIso = desde.toISOString().slice(0, 10);

// 1. Gastos del periodo.
const { data: gastos, error: e1 } = await db
  .from('gastos')
  .select('id, fecha, cuenta, monto, detalle, local_id, tenant_id, categoria, tipo')
  .gte('fecha', desdeIso)
  .order('fecha', { ascending: false });
if (e1) { console.error('Error gastos:', e1); process.exit(1); }

// 2. Auditoría: filas de creación de gastos en el mismo periodo.
//    fecha del audit = ahora del INSERT. Tomamos un margen de 7 días previos
//    al gasto para cubrir cargas retroactivas (gasto fechado en el pasado).
const desdeAudit = new Date();
desdeAudit.setDate(desdeAudit.getDate() - 67);
const { data: audits, error: e2 } = await db
  .from('auditoria')
  .select('id, tabla, accion, detalle, fecha')
  .eq('tabla', 'gastos')
  .eq('accion', 'CREAR')
  .gte('fecha', desdeAudit.toISOString());
if (e2) { console.error('Error auditoria:', e2); process.exit(1); }

// 3. Usuarios con cuentas_visibles restringidas (NULL = todas las cuentas).
const { data: usuarios, error: e3 } = await db
  .from('usuarios')
  .select('id, nombre, email, rol, activo, cuentas_visibles, tenant_id');
if (e3) { console.error('Error usuarios:', e3); process.exit(1); }

// Index audits por gasto_id (parsea el JSON del detalle).
const auditByGasto = new Map();
for (const a of audits) {
  try {
    const d = typeof a.detalle === 'string' ? JSON.parse(a.detalle) : a.detalle;
    if (d?.gasto_id && d?.usuario_id) auditByGasto.set(String(d.gasto_id), Number(d.usuario_id));
  } catch { /* fila vieja con detalle no-JSON, ignorar */ }
}
const userById = new Map(usuarios.map(u => [Number(u.id), u]));

// 4. Cruzar y filtrar.
//    Sospechoso = gasto cuya cuenta no está en cuentas_visibles del user que lo cargó,
//    excluyendo dueño/admin/superadmin (esos tienen cuentas_visibles=null por
//    convención y ven todas las cuentas; no aplica el bug).
const sospechosos = [];
const sinAudit = [];
const userVisible = (u, cuenta) => {
  if (!u) return null; // user inexistente
  if (u.rol === 'dueno' || u.rol === 'admin' || u.rol === 'superadmin') return true;
  if (u.cuentas_visibles == null) return true; // null = todas
  return Array.isArray(u.cuentas_visibles) && u.cuentas_visibles.includes(cuenta);
};

for (const g of gastos) {
  const userId = auditByGasto.get(String(g.id));
  if (userId == null) { sinAudit.push(g); continue; }
  const u = userById.get(Number(userId));
  const visible = userVisible(u, g.cuenta);
  if (visible === false) {
    sospechosos.push({ gasto: g, usuario: u });
  }
}

// 5. Estadísticas.
const totalGastosPeriodo = gastos.length;
const totalSospechosos = sospechosos.length;
const totalSinAudit = sinAudit.length;
const breakdownPorUsuario = {};
const breakdownPorCuenta = {};
let montoTotalAfectado = 0;
for (const { gasto, usuario } of sospechosos) {
  const k = `${usuario.nombre || usuario.email || 'usuario_' + usuario.id} (${usuario.rol})`;
  breakdownPorUsuario[k] = (breakdownPorUsuario[k] || 0) + 1;
  breakdownPorCuenta[gasto.cuenta] = (breakdownPorCuenta[gasto.cuenta] || 0) + 1;
  montoTotalAfectado += Number(gasto.monto || 0);
}

// 6. Render del MD.
const fmt$ = n => '$' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const sortedUsers = Object.entries(breakdownPorUsuario).sort((a, b) => b[1] - a[1]);
const sortedCuentas = Object.entries(breakdownPorCuenta).sort((a, b) => b[1] - a[1]);

let md = '';
md += `# Auditoría — Bug Caja-1 (cuenta mal cargada por value-not-in-options)\n\n`;
md += `**Generado**: ${new Date().toISOString()}\n`;
md += `**Ventana**: gastos desde ${desdeIso} hasta hoy (60 días)\n`;
md += `**Método**: cruce de \`gastos\` × \`auditoria\` (detalle JSON) × \`usuarios.cuentas_visibles\`\n\n`;
md += `## Resultado\n\n`;
md += `- Total gastos en el período: **${totalGastosPeriodo}**\n`;
md += `- **Gastos potencialmente mal cargados: ${totalSospechosos}**\n`;
md += `- Gastos sin fila de auditoría asociada (no se puede determinar quién los cargó): ${totalSinAudit}\n`;
md += `- Monto total afectado: **${fmt$(montoTotalAfectado)}**\n\n`;
md += `> Esto es **estimativo**. Algunos casos pueden ser legítimos: usuarios con permiso especial, cuentas otorgadas y luego revocadas, etc. Lucas decide caso por caso.\n\n`;

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

md += `## Lista detallada de gastos sospechosos\n\n`;
if (sospechosos.length === 0) md += `_Ninguno._\n\n`;
else {
  md += `| Gasto ID | Fecha | Cuenta persistida | Monto | Usuario | cuentas_visibles del usuario | Detalle |\n`;
  md += `|---|---|---|---:|---|---|---|\n`;
  for (const { gasto, usuario } of sospechosos) {
    const visible = Array.isArray(usuario.cuentas_visibles) ? usuario.cuentas_visibles.join(', ') : '(null)';
    const detalle = (gasto.detalle || '').replace(/\|/g, '\\|').slice(0, 80);
    md += `| ${gasto.id} | ${gasto.fecha} | ${gasto.cuenta} | ${fmt$(gasto.monto)} | ${usuario.nombre || usuario.email} (${usuario.rol}) | ${visible} | ${detalle} |\n`;
  }
  md += `\n`;
}

md += `## Notas\n\n`;
md += `- La auditoría **NO modifica ninguna fila**. Solo lee.\n`;
md += `- El fix de Caja-1 (commit en branch fix-bugs-camilo-caja) previene el bug a futuro pero **no corrige los gastos ya mal cargados**.\n`;
md += `- Para cada gasto sospechoso, Lucas decide:\n`;
md += `  - Si la cuenta persistida es la equivocada → corregir vía edición de movimiento (Caja.tsx ya tiene "Editar movimiento" con justificativo).\n`;
md += `  - Si era legítimo (permiso especial, cuenta antes-visible) → ignorar.\n`;
md += `- ${totalSinAudit} gastos sin auditoría: pueden ser anteriores a la migración \`20260418_auditoria.sql\` o haber fallado el INSERT en auditoria por algún motivo.\n`;

const outDir = path.resolve(process.cwd(), '../../docs');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'AUDITORIA_BUG_CAJA1.md');
fs.writeFileSync(outPath, md, 'utf-8');
console.log('Escrito:', outPath);
console.log('Total sospechosos:', totalSospechosos);
console.log('Monto afectado:', fmt$(montoTotalAfectado));
