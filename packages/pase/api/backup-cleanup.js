// api/backup-cleanup.js — TASK 0.17 ETAPA 2.
//
// Cron semanal (domingos 05:00 UTC = 02:00 ART). Recorre el bucket
// tenant-backups, parsea la fecha del path y borra los archivos con
// más de 30 días.
//
// Path esperado: <tenant_id>/<YYYY-MM-DD>.json.gz. Archivos cuyo path
// no parsee (estructura inesperada, backups manuales) los IGNORA — no
// los borra. Defensive: evita borrar accidentalmente.

const RETENTION_DAYS = 30;
const PATH_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d{4}-\d{2}-\d{2})\.json\.gz$/;

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
      retention_days: RETENTION_DAYS,
      cutoff: cutoffISO,
      borrados,
      ignorados: ignorados.length,
      error: errorBorrado,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
