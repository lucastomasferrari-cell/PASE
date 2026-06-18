-- 202606182300_conciliacion_borradores.sql
-- Borrador de conciliación persistido en la BASE (antes solo en localStorage,
-- por eso el progreso no aparecía si entrabas desde otra compu). Un borrador
-- por (tenant, local). El frontend hace upsert mientras trabajás y lo lee al
-- entrar desde cualquier dispositivo. Se borra al cerrar la conciliación o al
-- "empezar de cero".

CREATE TABLE IF NOT EXISTS public.conciliacion_borradores (
  tenant_id  uuid        NOT NULL DEFAULT auth_tenant_id(),
  local_id   integer     NOT NULL,
  data       jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer     DEFAULT auth_usuario_id(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, local_id)
);

ALTER TABLE public.conciliacion_borradores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conciliacion_borradores_rls ON public.conciliacion_borradores;
CREATE POLICY conciliacion_borradores_rls ON public.conciliacion_borradores
  FOR ALL TO authenticated
  USING (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  )
  WITH CHECK (
    tenant_id = auth_tenant_id()
    AND (auth_es_dueno_o_admin() OR local_id = ANY(auth_locales_visibles()))
  );

NOTIFY pgrst, 'reload schema';
