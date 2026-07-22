-- LISTAS DE PRECIOS — Fase 2 (el switch del cobro, vía compatibilidad total)
-- ═════════════════════════════════════════════════════════════════════════
-- Convierte `item_precios_canal` (tabla) en un VIEW sobre `lista_precio_items`
-- resuelto por `canales.lista_precio_id`. Resultado: TODO lo que hoy lee o
-- escribe item_precios_canal (cobro fn_agregar_item_comanda, tienda
-- v_catalogo_publico, POS useVentaData, editor de precios, aumentos masivos)
-- sigue funcionando SIN cambios — pero ahora la fuente de verdad son las
-- listas. Compartir una lista entre 2 canales = ambos ven el mismo precio.
--
-- SEGURIDAD RLS: el view es `security_invoker = true` → un usuario autenticado
-- que lo lee queda scopeado por su tenant (RLS de lista_precio_items). La
-- tienda pública sigue andando porque v_catalogo_publico es un view definer
-- (corre como owner → bypassa RLS), y al leer el view invoker desde adentro,
-- el "usuario" es el owner postgres → ve todo. Verificado en PG 17.6.
--
-- REVERSIBLE: la tabla original se RENOMBRA a item_precios_canal_legacy (no se
-- borra). Rollback = DROP VIEW + los 3 INSTEAD OF + rename legacy de vuelta.
-- Rollback exacto al final de este archivo (comentado).
-- ═════════════════════════════════════════════════════════════════════════

-- 0. Guard: sólo migrar si ipc y lpi están 100% consistentes (deben estarlo
--    tras Fase 1). Si no, abortar sin tocar nada.
DO $guard$
DECLARE v_sin_match int; v_distintos int;
BEGIN
  SELECT count(*) INTO v_sin_match FROM (
    SELECT ipc.id FROM item_precios_canal ipc
    JOIN canales c ON c.id = ipc.canal_id AND c.deleted_at IS NULL
    LEFT JOIN lista_precio_items lpi
      ON lpi.lista_precio_id = c.lista_precio_id AND lpi.item_id = ipc.item_id
     AND lpi.deleted_at IS NULL AND (lpi.local_id IS NOT DISTINCT FROM ipc.local_id)
    WHERE ipc.deleted_at IS NULL AND lpi.id IS NULL
  ) t;
  SELECT count(*) INTO v_distintos FROM item_precios_canal ipc
    JOIN canales c ON c.id = ipc.canal_id AND c.deleted_at IS NULL
    JOIN lista_precio_items lpi
      ON lpi.lista_precio_id = c.lista_precio_id AND lpi.item_id = ipc.item_id
     AND lpi.deleted_at IS NULL AND (lpi.local_id IS NOT DISTINCT FROM ipc.local_id)
    WHERE ipc.deleted_at IS NULL AND ipc.precio <> lpi.precio;
  IF v_sin_match > 0 OR v_distintos > 0 THEN
    RAISE EXCEPTION 'FASE2_ABORT: inconsistencia ipc/lpi (sin_match=%, distintos=%). Correr Fase 1 backfill antes.', v_sin_match, v_distintos;
  END IF;
END $guard$;

-- 1. Único en lpi que replica uniq_item_precio_canal(item_id, canal_id).
--    Como cada canal apunta a UNA lista, (lista, item) único ⟹ (canal, item) único.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_lpi_lista_item
  ON lista_precio_items (lista_precio_id, item_id) WHERE deleted_at IS NULL;

-- 2. Sacar la tabla de la publicación realtime (un view no puede estar en una
--    publicación). No hay suscriptores en el front (verificado) → inocuo.
ALTER PUBLICATION supabase_realtime DROP TABLE item_precios_canal;

-- 3. Recrear la auditoría de cambios de precio sobre lista_precio_items
--    (el trg_ipc_audit de la tabla se pierde al pasar a view).
CREATE OR REPLACE FUNCTION public.fn_lpi_audit()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO item_precios_canal_history (ipc_id, operation, changed_by, old_data, new_data)
    VALUES (NEW.id::int, 'UPDATE', NEW.updated_by, to_jsonb(OLD), to_jsonb(NEW));
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS trg_lpi_audit ON lista_precio_items;
CREATE TRIGGER trg_lpi_audit AFTER UPDATE ON lista_precio_items
  FOR EACH ROW EXECUTE FUNCTION fn_lpi_audit();

-- 4. Renombrar la tabla original a _legacy (backup inerte, reversible).
--    Índices, constraints, triggers y policies viajan con el rename.
ALTER TABLE item_precios_canal RENAME TO item_precios_canal_legacy;

-- 5. El VIEW que reemplaza a item_precios_canal. Mismas columnas y nombres que
--    la tabla original → transparente para todo el código existente.
CREATE VIEW public.item_precios_canal
  WITH (security_invoker = true) AS
SELECT
  lpi.id             AS id,
  lpi.tenant_id      AS tenant_id,
  lpi.local_id       AS local_id,
  lpi.created_at     AS created_at,
  lpi.updated_at     AS updated_at,
  lpi.deleted_at     AS deleted_at,
  lpi.created_by     AS created_by,
  lpi.updated_by     AS updated_by,
  lpi.item_id        AS item_id,
  c.id               AS canal_id,
  lpi.precio         AS precio,
  lpi.edicion_manual AS edicion_manual,
  lpi.vendible       AS vendible
FROM lista_precio_items lpi
JOIN canales c ON c.lista_precio_id = lpi.lista_precio_id AND c.deleted_at IS NULL;

-- Mismos grants que tenía la tabla (RLS + triggers gatean igual).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.item_precios_canal TO anon, authenticated, service_role;

-- 6. INSTEAD OF triggers: mapean escrituras del view → lista_precio_items.

-- INSERT: canal_id → lista_precio_id; upsert por (lista, item).
CREATE OR REPLACE FUNCTION public.fn_ipc_view_insert()
 RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_lista bigint; v_id bigint;
BEGIN
  SELECT lista_precio_id INTO v_lista FROM canales WHERE id = NEW.canal_id;
  IF v_lista IS NULL THEN
    RAISE EXCEPTION 'CANAL_SIN_LISTA: el canal % no tiene lista_precio_id asignada', NEW.canal_id;
  END IF;
  INSERT INTO lista_precio_items (
    tenant_id, lista_precio_id, item_id, local_id, precio, vendible,
    edicion_manual, created_by, updated_by, created_at, updated_at
  ) VALUES (
    NEW.tenant_id, v_lista, NEW.item_id, NEW.local_id, NEW.precio,
    COALESCE(NEW.vendible, true), COALESCE(NEW.edicion_manual, false),
    NEW.created_by, NEW.updated_by, COALESCE(NEW.created_at, now()), COALESCE(NEW.updated_at, now())
  )
  ON CONFLICT (lista_precio_id, item_id) WHERE deleted_at IS NULL
  DO UPDATE SET
    precio = EXCLUDED.precio,
    vendible = EXCLUDED.vendible,
    edicion_manual = EXCLUDED.edicion_manual,
    updated_at = now(),
    updated_by = EXCLUDED.updated_by
  RETURNING id INTO v_id;
  NEW.id := v_id;
  RETURN NEW;
END $fn$;

-- UPDATE: por id (id del view = id de lpi).
CREATE OR REPLACE FUNCTION public.fn_ipc_view_update()
 RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE lista_precio_items SET
    precio         = NEW.precio,
    vendible       = NEW.vendible,
    edicion_manual = NEW.edicion_manual,
    local_id       = NEW.local_id,
    deleted_at     = NEW.deleted_at,
    updated_by     = NEW.updated_by,
    updated_at     = now()
  WHERE id = OLD.id;
  RETURN NEW;
END $fn$;

-- DELETE: (no usado por el front, pero por completitud) borra la fila lpi.
CREATE OR REPLACE FUNCTION public.fn_ipc_view_delete()
 RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  DELETE FROM lista_precio_items WHERE id = OLD.id;
  RETURN OLD;
END $fn$;

CREATE TRIGGER trg_ipc_view_insert INSTEAD OF INSERT ON public.item_precios_canal
  FOR EACH ROW EXECUTE FUNCTION fn_ipc_view_insert();
CREATE TRIGGER trg_ipc_view_update INSTEAD OF UPDATE ON public.item_precios_canal
  FOR EACH ROW EXECUTE FUNCTION fn_ipc_view_update();
CREATE TRIGGER trg_ipc_view_delete INSTEAD OF DELETE ON public.item_precios_canal
  FOR EACH ROW EXECUTE FUNCTION fn_ipc_view_delete();

-- 7. Recrear v_catalogo_publico para que ligue al VIEW nuevo (antes ligaba por
--    OID a la tabla, que ahora es _legacy). Cuerpo idéntico al original.
--    Queda como view DEFINER (sin security_invoker) → la tienda pública (anon)
--    sigue viendo el catálogo (corre como owner, bypassa RLS).
DROP VIEW IF EXISTS public.v_catalogo_publico;
CREATE VIEW public.v_catalogo_publico AS
SELECT i.id AS item_id,
    i.nombre,
    i.descripcion,
    i.emoji,
    i.foto_url,
    ipc.precio,
    ipc.canal_id,
    g.id AS grupo_id,
    g.nombre AS grupo_nombre,
    g.emoji AS grupo_emoji,
    g.color_ramp AS grupo_color_ramp,
    cls.local_id,
    cls.slug AS local_slug,
    (EXISTS ( SELECT 1
           FROM item_modifier_groups img
             JOIN modifier_groups mg ON mg.id = img.modifier_group_id AND mg.deleted_at IS NULL
          WHERE img.item_id = i.id)) AS tiene_modificadores
   FROM items i
     LEFT JOIN item_grupos g ON i.grupo_id = g.id AND g.deleted_at IS NULL
     JOIN item_precios_canal ipc ON ipc.item_id = i.id AND ipc.deleted_at IS NULL AND ipc.vendible = true
     JOIN canales c ON ipc.canal_id = c.id AND c.deleted_at IS NULL AND c.activo = true AND c.slug = 'tienda-propia'::text
     JOIN comanda_local_settings cls ON cls.tenant_id = i.tenant_id AND (c.local_id IS NULL OR c.local_id = cls.local_id) AND cls.tienda_activa = true AND cls.deleted_at IS NULL
  WHERE i.deleted_at IS NULL AND i.estado = 'disponible'::text AND i.visible_tienda = true;
GRANT SELECT ON public.v_catalogo_publico TO anon, authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- ROLLBACK (pegar y correr si algo sale mal):
--   DROP VIEW public.v_catalogo_publico;
--   DROP VIEW public.item_precios_canal CASCADE;   -- borra los 3 INSTEAD OF
--   ALTER TABLE item_precios_canal_legacy RENAME TO item_precios_canal;
--   ALTER PUBLICATION supabase_realtime ADD TABLE item_precios_canal;
--   DROP TRIGGER trg_lpi_audit ON lista_precio_items;
--   -- luego recrear v_catalogo_publico con el mismo CREATE VIEW de arriba
--   --   (ya ligará a la tabla restaurada) + GRANT SELECT.
-- ═════════════════════════════════════════════════════════════════════════
