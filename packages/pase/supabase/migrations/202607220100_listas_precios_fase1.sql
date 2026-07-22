-- LISTAS DE PRECIOS — Fase 1 (schema + migración de datos)
-- ─────────────────────────────────────────────────────────────────────────
-- Concepto: una "lista de precios" con nombre propio ("Lista Salón", "Lista
-- Delivery"…). Cada canal apunta a una lista (canales.lista_precio_id).
-- Compartir = dos canales apuntando a la misma lista.
--
-- Esta fase es ADITIVA y SEGURA: crea las tablas y copia lo que ya existe
-- (item_precios_canal) a una lista por canal. NO toca lectores/escritores
-- todavía — POS, tienda y cobro siguen leyendo item_precios_canal. El switch
-- a las listas se hace en la Fase 2/3 (con test de cobro).

-- 1. listas_precios (mismo patrón RLS que canales/item_precios_canal)
CREATE TABLE IF NOT EXISTS public.listas_precios (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  local_id         integer,
  nombre           text NOT NULL,
  atado_madre      boolean NOT NULL DEFAULT true,
  ajuste_madre_pct numeric(6,2) NOT NULL DEFAULT 0,
  redondeo_a       numeric,
  activa           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  created_by       integer,
  updated_by       integer
);
ALTER TABLE public.listas_precios ENABLE ROW LEVEL SECURITY;
CREATE POLICY listas_precios_select ON public.listas_precios FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())))));
CREATE POLICY listas_precios_write ON public.listas_precios FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND auth_tiene_permiso('comanda.precios.editar')))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND auth_tiene_permiso('comanda.precios.editar')));

-- 2. lista_precio_items (la matriz de precios, ahora por LISTA en vez de por canal)
CREATE TABLE IF NOT EXISTS public.lista_precio_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  lista_precio_id  bigint NOT NULL REFERENCES public.listas_precios(id) ON DELETE CASCADE,
  item_id          bigint NOT NULL,
  local_id         integer,
  precio           numeric(14,2) NOT NULL DEFAULT 0,
  vendible         boolean NOT NULL DEFAULT true,
  edicion_manual   boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  created_by       integer,
  updated_by       integer
);
CREATE INDEX IF NOT EXISTS idx_lpi_lista ON public.lista_precio_items(lista_precio_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lpi_item  ON public.lista_precio_items(item_id) WHERE deleted_at IS NULL;
ALTER TABLE public.lista_precio_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY lpi_select ON public.lista_precio_items FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())))));
CREATE POLICY lpi_write ON public.lista_precio_items FOR ALL TO authenticated
  USING (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND auth_tiene_permiso('comanda.precios.editar')))
  WITH CHECK (auth_es_superadmin() OR (tenant_id = auth_tenant_id() AND (auth_es_dueno_o_admin() OR local_id IS NULL OR local_id = ANY(auth_locales_visibles())) AND auth_tiene_permiso('comanda.precios.editar')));

-- updated_at automático
DROP TRIGGER IF EXISTS trg_lp_updated ON public.listas_precios;
CREATE TRIGGER trg_lp_updated BEFORE UPDATE ON public.listas_precios FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
DROP TRIGGER IF EXISTS trg_lpi_updated ON public.lista_precio_items;
CREATE TRIGGER trg_lpi_updated BEFORE UPDATE ON public.lista_precio_items FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- 3. canales.lista_precio_id (qué lista usa cada canal; compartible)
ALTER TABLE public.canales ADD COLUMN IF NOT EXISTS lista_precio_id bigint REFERENCES public.listas_precios(id) ON DELETE SET NULL;

-- 4. Backfill: una lista por canal (con sus atributos de precio) + copiar sus
--    precios de item_precios_canal + linkear el canal a su lista.
DO $$
DECLARE r RECORD; v_lista bigint;
BEGIN
  FOR r IN SELECT * FROM canales WHERE deleted_at IS NULL AND lista_precio_id IS NULL LOOP
    INSERT INTO listas_precios (tenant_id, local_id, nombre, atado_madre, ajuste_madre_pct, redondeo_a, activa, created_by)
    VALUES (r.tenant_id, r.local_id, r.nombre, COALESCE(r.atado_madre, true), COALESCE(r.ajuste_madre_pct, 0), r.redondeo_a, COALESCE(r.activo, true), r.created_by)
    RETURNING id INTO v_lista;

    INSERT INTO lista_precio_items (tenant_id, lista_precio_id, item_id, local_id, precio, vendible, edicion_manual, created_by)
    SELECT ipc.tenant_id, v_lista, ipc.item_id, ipc.local_id, ipc.precio, ipc.vendible, COALESCE(ipc.edicion_manual, false), ipc.created_by
    FROM item_precios_canal ipc
    WHERE ipc.canal_id = r.id AND ipc.deleted_at IS NULL;

    UPDATE canales SET lista_precio_id = v_lista WHERE id = r.id;
  END LOOP;
END $$;
