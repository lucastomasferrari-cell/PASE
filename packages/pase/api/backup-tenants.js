// api/backup-tenants.js — TASK 0.17 ETAPAS 1 + 2 consolidadas.
//
// Endpoint UNIFICADO para backup operations. Dispatch por query param:
//   GET  /api/backup-tenants?action=export   → exporta cada tenant a JSON gzipped (default)
//   GET  /api/backup-tenants?action=cleanup  → borra archivos >365 días del bucket
//
// Antes había 2 endpoints separados (backup-tenants.js + backup-cleanup.js).
// Consolidados 2026-05-27 (sprint #11 post-audit grande) para liberar 1
// función Vercel Hobby — pasamos de 12/12 (al límite) a 11/12 con margen
// para 1 endpoint nuevo. Misma lógica, mismo auth, mismo cron schedule
// (mp-cron-weekly.yml dispara los dos pasos seguidos).
//
// Cron semanal — domingos 08:00 UTC (= 05:00 ART):
//   1. action=export  → snapshot de la semana
//   2. action=cleanup → purga snapshots viejos
//
// Política decidida 2026-05-12: backup semanal con retención 1 año
// = 52 snapshots por tenant. Storage estimado por tenant: ~250-500 MB.
//
// Usa SUPABASE_SERVICE_KEY (bypassa RLS) porque tiene que leer todas las
// tablas de TODOS los tenants en una sola pasada y escribir al bucket.
//
// El restore selectivo lo hace la RPC restore_tenant (etapa 3) +
// la UI de superadmin (etapa 4).

import { gzipSync } from 'node:zlib';
import { checkCronAuth } from './_cron-auth.js';

// 35 tablas con tenant_id + tenant_admins + empleado_archivos legacy, en orden
// topológico (parents primero). Las marcadas como condicionales pueden no
// existir en algunas DBs; el handler las maneja con try/catch tabla por tabla.
const TABLAS_BACKUP = [
  // Capa 1 — raíces
  'usuarios',
  'locales',
  // Capa 2 — vínculos usuario↔tenant
  'usuario_locales',
  'usuario_permisos',
  'tenant_admins',
  // Capa 3 — catálogos sin local_id
  'proveedores',
  'insumos',
  'config_categorias',
  'rrhh_valores_doble',
  'blindaje_tipos_documento',
  'medios_cobro',
  // Capa 4 — recetas + items
  'recetas',
  'receta_items',
  // Capa 5 — operativas con local_id (parents independientes)
  'mp_credenciales',
  'rrhh_empleados',
  'ventas',
  'gastos',
  'gastos_plantillas',
  'saldos_caja',
  'mp_movimientos',
  'mp_liquidaciones',
  'blindaje_documentos',
  // Capa 6 — facturas + items
  'facturas',
  'factura_items',
  'factura_items_stock',
  // Capa 7 — remitos + items
  'remitos',
  'remito_items',
  // Capa 8 — RRHH child tables
  'rrhh_novedades',
  'rrhh_liquidaciones',
  'rrhh_documentos',
  'rrhh_historial_sueldos',
  'rrhh_pagos_especiales',
  'rrhh_adelantos',
  // Capa 9 — movimientos (depende de varias parents operativas)
  'movimientos',
  // Capa 10 — auditoria + legacy
  'auditoria',
  'empleado_archivos',
];

const BUCKETS_CON_ARCHIVOS = ['facturas', 'blindaje', 'rrhh-documentos', 'empleados'];

const RETENTION_DAYS = 365;
const PATH_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d{4}-\d{2}-\d{2})\.json\.gz$/;

export default async function handler(req, res) {
  // Fix auditoría 2026-05-21 CRIT-2: checkCronAuth es async, sin await
  // !Promise era siempre false → guardia nunca disparaba → endpoint abierto.
  if (!(await checkCronAuth(req, res))) return;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars',
    });
  }

  // Dispatch por query param. Default = 'export' para preservar comportamiento
  // anterior (cuando este endpoint era solo backup-tenants).
  const action = (req.query?.action || 'export').toString().toLowerCase();
  if (action !== 'export' && action !== 'cleanup') {
    return res.status(400).json({ ok: false, error: 'action_invalida', accepted: ['export', 'cleanup'] });
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    if (action === 'cleanup') {
      return await runCleanup(db, res);
    }
    return await runExport(db, res);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}

// ─── action=export ────────────────────────────────────────────────────
async function runExport(db, res) {
  const { data: tenants, error: errT } = await db
    .from('tenants')
    .select('id, slug, nombre')
    .eq('activo', true);

  if (errT) {
    return res.status(500).json({ ok: false, error: 'tenants_fetch_failed', detail: errT.message });
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const resumen = [];

  for (const tenant of tenants || []) {
    const tablas = {};
    let totalFilas = 0;
    const errores = [];

    for (const tabla of TABLAS_BACKUP) {
      const { data, error } = await db.from(tabla).select('*').eq('tenant_id', tenant.id);
      if (error) {
        // 42P01 = tabla no existe (esperable para tablas condicionales).
        // PostgREST devuelve { code: '42P01' } o un mensaje genérico.
        if (error.code === '42P01' || /does not exist/i.test(error.message || '')) {
          continue;
        }
        errores.push({ tabla, error: error.message });
        continue;
      }
      tablas[tabla] = data || [];
      totalFilas += (data || []).length;
    }

    const storagePaths = {};
    let totalArchivos = 0;
    for (const bucket of BUCKETS_CON_ARCHIVOS) {
      const { data: files, error: errL } = await db.storage
        .from(bucket)
        .list(tenant.id, { limit: 1000 });
      if (errL) {
        // Bucket no existe → skip silencioso.
        if (/Bucket not found/i.test(errL.message || '')) continue;
        errores.push({ bucket, error: errL.message });
        continue;
      }
      // En supabase-js, list() devuelve carpetas con id=null y archivos con id!=null.
      const paths = (files || [])
        .filter((f) => f && f.id !== null && f.name)
        .map((f) => `${tenant.id}/${f.name}`);
      if (paths.length) storagePaths[bucket] = paths;
      totalArchivos += paths.length;
    }

    const payload = {
      version: 1,
      tenant_id: tenant.id,
      tenant_slug: tenant.slug,
      tenant_nombre: tenant.nombre,
      created_at: new Date().toISOString(),
      stats: {
        total_filas: totalFilas,
        total_archivos_storage: totalArchivos,
        compresion: 'gzip',
      },
      tablas,
      storage_paths: storagePaths,
    };

    const json = JSON.stringify(payload);
    const gz = gzipSync(Buffer.from(json, 'utf-8'));
    const path = `${tenant.id}/${today}.json.gz`;

    const { error: errU } = await db.storage
      .from('tenant-backups')
      .upload(path, gz, {
        contentType: 'application/gzip',
        upsert: true,
      });

    if (errU) {
      resumen.push({ tenant_id: tenant.id, ok: false, error: errU.message });
      continue;
    }

    // Auditoría — accion='BACKUP_TENANT', detalle como JSON serializado a text.
    await db.from('auditoria').insert({
      tabla: 'backup',
      accion: 'BACKUP_TENANT',
      detalle: JSON.stringify({
        path,
        bytes: gz.byteLength,
        filas: totalFilas,
        archivos: totalArchivos,
        errores: errores.length ? errores : undefined,
      }),
      fecha: new Date().toISOString(),
      tenant_id: tenant.id,
    });

    resumen.push({
      tenant_id: tenant.id,
      slug: tenant.slug,
      path,
      bytes: gz.byteLength,
      filas: totalFilas,
      archivos: totalArchivos,
      errores_no_fatales: errores.length,
    });
  }

  // Cleanup oportunista de idempotency_keys (regla A-11 de la auditoría):
  // borra keys con created_at > 30 días. No es bloqueante — si falla, el
  // backup sigue siendo exitoso. Se hace acá para evitar gastar un slot
  // dedicado de Vercel Function.
  let idempotencyCleanup = null;
  try {
    const corte = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { error: errCleanup, count } = await db
      .from('idempotency_keys')
      .delete({ count: 'exact' })
      .lt('created_at', corte);
    if (errCleanup) {
      idempotencyCleanup = { ok: false, error: errCleanup.message };
    } else {
      idempotencyCleanup = { ok: true, borradas: count ?? 0, corte };
    }
  } catch (e) {
    idempotencyCleanup = { ok: false, error: e?.message || String(e) };
  }

  return res.status(200).json({ ok: true, action: 'export', fecha: today, resumen, idempotencyCleanup });
}

// ─── action=cleanup ───────────────────────────────────────────────────
//
// Recorre el bucket tenant-backups, parsea la fecha del path y borra
// archivos > RETENTION_DAYS días. Path esperado:
// <tenant_id>/<YYYY-MM-DD>.json.gz. Archivos cuyo path no parsee
// (estructura inesperada, backups manuales) los IGNORA — no los borra.
// Defensive: evita borrar accidentalmente.
async function runCleanup(db, res) {
  // 1. Listar tenants (las "carpetas" del bucket).
  const { data: rootEntries, error: errRoot } = await db.storage
    .from('tenant-backups')
    .list('', { limit: 1000 });

  if (errRoot) {
    return res.status(500).json({ ok: false, error: 'list_root_failed', detail: errRoot.message });
  }

  const tenantFolders = (rootEntries || [])
    .filter((e) => e && e.id === null && e.name) // carpetas (id=null en supabase-js)
    .map((e) => e.name);

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const pathsABorrar = [];
  const ignorados = [];

  for (const tenantFolder of tenantFolders) {
    const { data: files, error: errL } = await db.storage
      .from('tenant-backups')
      .list(tenantFolder, { limit: 1000 });
    if (errL) {
      ignorados.push({ tenantFolder, error: errL.message });
      continue;
    }
    for (const f of files || []) {
      if (!f || f.id === null) continue; // skip subcarpetas
      const fullPath = `${tenantFolder}/${f.name}`;
      const m = PATH_REGEX.exec(fullPath);
      if (!m) {
        ignorados.push({ path: fullPath, motivo: 'path_no_parsea' });
        continue;
      }
      const fileDate = m[2]; // YYYY-MM-DD
      if (fileDate < cutoffISO) {
        pathsABorrar.push(fullPath);
      }
    }
  }

  let borrados = 0;
  let errorBorrado = null;

  if (pathsABorrar.length > 0) {
    // storage.remove acepta un array de paths.
    const { error: errR } = await db.storage.from('tenant-backups').remove(pathsABorrar);
    if (errR) {
      errorBorrado = errR.message;
    } else {
      borrados = pathsABorrar.length;
    }
  }

  // Auditoría — accion='BACKUP_CLEANUP'. tenant_id NULL no se permite por
  // el constraint multi-tenant, así que usamos el tenant Neko como
  // contenedor del log de mantenimiento (decisión: este audit es global,
  // no pertenece a ningún tenant en particular, pero la columna es NOT
  // NULL — Neko es el tenant operativo histórico).
  const { data: nekoRow } = await db.from('tenants').select('id').eq('slug', 'neko').single();
  const auditTenant = nekoRow?.id || null;

  if (auditTenant) {
    await db.from('auditoria').insert({
      tabla: 'backup',
      accion: 'BACKUP_CLEANUP',
      detalle: JSON.stringify({
        retention_days: RETENTION_DAYS,
        cutoff: cutoffISO,
        borrados,
        paths: pathsABorrar,
        ignorados: ignorados.length ? ignorados : undefined,
        error: errorBorrado || undefined,
      }),
      fecha: new Date().toISOString(),
      tenant_id: auditTenant,
    });
  }

  return res.status(errorBorrado ? 500 : 200).json({
    ok: !errorBorrado,
    action: 'cleanup',
    retention_days: RETENTION_DAYS,
    cutoff: cutoffISO,
    borrados,
    ignorados: ignorados.length,
    error: errorBorrado,
  });
}
