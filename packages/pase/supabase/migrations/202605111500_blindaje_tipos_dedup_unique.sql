-- Limpiar duplicados de blindaje_tipos_documento (mismo nombre repetido
-- por tenant) y prevenir futuros con UNIQUE constraint.
--
-- Causa: el seed inicial parece haber corrido 2 veces sobre Neko (IDs
-- bajos 1-5 = original, 6-10 = duplicado), sin UNIQUE constraint que lo
-- bloqueara. Lucas reportó "no deja modificar los nombres y eso en
-- blindaje" — la causa real es que al editar uno, el duplicado queda
-- con el nombre viejo y parece que el cambio no se aplicó.
--
-- Safety: blindaje_documentos.tipo_id NO referencia FK a ningún tipo
-- duplicado (la tabla blindaje_documentos está vacía al 2026-05-11).
-- Aún así usamos NOT EXISTS para no borrar nada si alguien insertó.

-- 1. Borrar duplicados conservando el id mínimo por (tenant_id, nombre).
DELETE FROM blindaje_tipos_documento bt
WHERE EXISTS (
  SELECT 1 FROM blindaje_tipos_documento bt2
  WHERE bt2.tenant_id = bt.tenant_id
    AND bt2.nombre = bt.nombre
    AND bt2.id < bt.id
)
AND NOT EXISTS (
  SELECT 1 FROM blindaje_documentos bd WHERE bd.tipo_id = bt.id
);

-- 2. Prevenir futuros duplicados con UNIQUE (case-sensitive). Si en algún
-- momento se quiere case-insensitive, cambiar a UNIQUE INDEX en
-- LOWER(nombre).
ALTER TABLE blindaje_tipos_documento
  ADD CONSTRAINT blindaje_tipos_documento_tenant_nombre_unique
  UNIQUE (tenant_id, nombre);
