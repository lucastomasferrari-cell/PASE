// api/backup-tenants.js — TASK 0.17 ETAPA 1.
//
// Cron diario (07:00 UTC = 04:00 ART) que exporta cada tenant activo a un
// archivo JSON gzipped en el bucket 'tenant-backups'. Path final:
// <tenant_id>/<YYYY-MM-DD>.json.gz (idempotente con upsert).
//
// Usa SUPABASE_SERVICE_KEY (bypassa RLS) porque tiene que leer todas las
// tablas de TODOS los tenants en una sola pasada y escribir al bucket.
//
// El restore selectivo lo hace la RPC restore_tenant (etapa 3) +
// la UI de superadmin (etapa 4).

import { gzipSync } from 'node:zlib';

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
  'caja_efectivo',
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

export default async function handler(req, res) {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars',
      });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

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

    return res.status(200).json({ ok: true, fecha: today, resumen });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
