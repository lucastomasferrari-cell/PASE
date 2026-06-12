-- ============================================================
-- 202606122020_medios_clones_tenants.sql
-- Seguimiento de 202606122000: el backfill clonaba filas con
-- tenant NULL, pero tenant_id existía desde 202604281201 y las
-- 16 filas "globales" ya estaban asignadas a Neko → los demás
-- tenants (que antes las veían vía RLS USING(true)) quedaron con
-- catálogo VACÍO tras el tenant-scoping. Les clonamos el catálogo
-- base de Neko (las filas de alcance global, que eran el catálogo
-- compartido de facto) para preservar su operación.
-- El tenant E2E no necesita esto: su seed inserta los propios.
-- ============================================================

BEGIN;

INSERT INTO medios_cobro (tenant_id, local_id, nombre, slug, emoji, pide_vuelto, activo, orden, cuenta_destino)
SELECT t.id, NULL, g.nombre, g.slug, g.emoji, g.pide_vuelto, g.activo, g.orden, g.cuenta_destino
  FROM medios_cobro g
 CROSS JOIN tenants t
 WHERE g.tenant_id = (SELECT id FROM tenants WHERE nombre = 'Neko')
   AND g.local_id IS NULL
   AND g.deleted_at IS NULL
   AND t.activo = TRUE
   AND t.id <> g.tenant_id
   AND NOT EXISTS (
     SELECT 1 FROM medios_cobro x
      WHERE x.tenant_id = t.id AND x.local_id IS NULL
        AND upper(x.nombre) = upper(g.nombre)
   );

COMMIT;
