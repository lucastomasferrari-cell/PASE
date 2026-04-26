-- ═══════════════════════════════════════════════════════════════════════════
-- Auditoría append-only: defense-in-depth.
--
-- Las policies actuales (aud_admin_read SELECT, aud_write INSERT) ya impiden
-- UPDATE/DELETE bajo RLS. Esta migration agrega dos capas extra para que
-- siga inmutable aunque alguien deshabilite RLS o use service_role:
--   1. REVOKE UPDATE, DELETE a nivel GRANT para authenticated/anon.
--   2. Trigger BEFORE UPDATE/DELETE que RAISE EXCEPTION sin distinguir
--      rol — fuerza inmutabilidad incluso para superuser/service_role.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. REVOKE a nivel tabla.
--    service_role NO se le revoca: bypasea permisos por diseño. La capa
--    de defensa para service_role es el trigger del paso 2.
REVOKE UPDATE, DELETE ON public.auditoria FROM authenticated;
REVOKE UPDATE, DELETE ON public.auditoria FROM anon;

-- 2. Trigger función + triggers BEFORE UPDATE/DELETE.
CREATE OR REPLACE FUNCTION auditoria_no_modify()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AUDITORIA_INMUTABLE: la tabla auditoria es append-only por diseño';
END;
$$;

DROP TRIGGER IF EXISTS trg_auditoria_no_update ON public.auditoria;
CREATE TRIGGER trg_auditoria_no_update
  BEFORE UPDATE ON public.auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_no_modify();

DROP TRIGGER IF EXISTS trg_auditoria_no_delete ON public.auditoria;
CREATE TRIGGER trg_auditoria_no_delete
  BEFORE DELETE ON public.auditoria
  FOR EACH ROW EXECUTE FUNCTION auditoria_no_modify();
