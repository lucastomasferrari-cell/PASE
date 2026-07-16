-- Menú maestro por marca + importar por local.
-- Modelo: el MAESTRO de una marca son los items/grupos con local_id IS NULL.
-- Cada sucursal IMPORTA una copia (local_id = la sucursal) y edita sobre eso.
-- Esta RPC copia el maestro de la marca del local → la sucursal, remapeando
-- ids de grupos, items, modifier_groups, precios por canal y links item↔modif.
--   modo 'reemplazar': soft-delete lo actual de la sucursal + copia todo.
--   modo 'novedades' : agrega solo los items del maestro que la sucursal no
--                       tiene (por nombre); reutiliza sus grupos por nombre.
-- Seguridad: SECURITY DEFINER + chequeo de tenant en las primeras líneas (C11).
CREATE OR REPLACE FUNCTION public.fn_importar_menu_marca(p_local_id integer, p_modo text DEFAULT 'reemplazar')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid := auth_tenant_id();
  v_ltenant uuid;
  v_marca integer;
  r record;
  v_new integer;
  v_items integer := 0;
  v_grupos integer := 0;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF p_modo NOT IN ('reemplazar', 'novedades') THEN RAISE EXCEPTION 'MODO_INVALIDO'; END IF;

  SELECT tenant_id, marca_id INTO v_ltenant, v_marca FROM locales WHERE id = p_local_id;
  IF v_ltenant IS NULL THEN RAISE EXCEPTION 'LOCAL_NO_ENCONTRADO'; END IF;
  IF v_ltenant <> v_tenant THEN RAISE EXCEPTION 'NO_AUTORIZADO'; END IF;
  IF v_marca IS NULL THEN RAISE EXCEPTION 'LOCAL_SIN_MARCA'; END IF;

  IF NOT EXISTS (SELECT 1 FROM items WHERE marca_id = v_marca AND local_id IS NULL AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'MAESTRO_VACIO';
  END IF;

  CREATE TEMP TABLE _mg (old_id integer, new_id integer) ON COMMIT DROP;
  CREATE TEMP TABLE _mi (old_id integer, new_id integer) ON COMMIT DROP;
  CREATE TEMP TABLE _mmg (old_id integer, new_id integer) ON COMMIT DROP;

  IF p_modo = 'reemplazar' THEN
    DELETE FROM item_modifier_groups WHERE item_id IN (SELECT id FROM items WHERE local_id = p_local_id);
    UPDATE item_precios_canal SET deleted_at = now() WHERE local_id = p_local_id AND deleted_at IS NULL;
    UPDATE items SET deleted_at = now() WHERE local_id = p_local_id AND deleted_at IS NULL;
    UPDATE item_grupos SET deleted_at = now() WHERE local_id = p_local_id AND deleted_at IS NULL;
    UPDATE modifier_groups SET deleted_at = now() WHERE local_id = p_local_id AND deleted_at IS NULL;
  END IF;

  -- 1) Grupos (en 'novedades' reutiliza el grupo local con el mismo nombre)
  FOR r IN SELECT * FROM item_grupos WHERE marca_id = v_marca AND local_id IS NULL AND deleted_at IS NULL ORDER BY orden, id LOOP
    IF p_modo = 'novedades' THEN
      SELECT id INTO v_new FROM item_grupos WHERE local_id = p_local_id AND deleted_at IS NULL AND lower(nombre) = lower(r.nombre) LIMIT 1;
      IF v_new IS NOT NULL THEN INSERT INTO _mg VALUES (r.id, v_new); CONTINUE; END IF;
    END IF;
    INSERT INTO item_grupos (tenant_id, local_id, marca_id, nombre, color, emoji, orden, tax_rate_id, estacion_default, color_ramp)
    VALUES (v_tenant, p_local_id, v_marca, r.nombre, r.color, r.emoji, r.orden, r.tax_rate_id, r.estacion_default, r.color_ramp)
    RETURNING id INTO v_new;
    INSERT INTO _mg VALUES (r.id, v_new);
    v_grupos := v_grupos + 1;
  END LOOP;

  -- 2) Modifier groups
  FOR r IN SELECT * FROM modifier_groups WHERE marca_id = v_marca AND local_id IS NULL AND deleted_at IS NULL LOOP
    INSERT INTO modifier_groups (tenant_id, local_id, marca_id, nombre, descripcion, requerido, min_seleccion, max_seleccion, tipo)
    VALUES (v_tenant, p_local_id, v_marca, r.nombre, r.descripcion, r.requerido, r.min_seleccion, r.max_seleccion, r.tipo)
    RETURNING id INTO v_new;
    INSERT INTO _mmg VALUES (r.id, v_new);
  END LOOP;

  -- 3) Items (en 'novedades' salta los que ya existen por nombre)
  FOR r IN SELECT * FROM items WHERE marca_id = v_marca AND local_id IS NULL AND deleted_at IS NULL ORDER BY orden, id LOOP
    IF p_modo = 'novedades' AND EXISTS (SELECT 1 FROM items WHERE local_id = p_local_id AND deleted_at IS NULL AND lower(nombre) = lower(r.nombre)) THEN
      CONTINUE;
    END IF;
    INSERT INTO items (tenant_id, local_id, marca_id, nombre, descripcion, emoji, foto_url, codigo,
      grupo_id, orden, precio_madre, costo_actual, tax_rate_id, estacion, estado,
      es_combo, visible_pos, visible_qr, visible_tienda, es_open_item, tiempo_prep_min,
      sku_rappi, sku_pedidosya, sku_deliverect, sku_externos, es_prep_item, es_cubierto, modos_pos_visibles)
    VALUES (v_tenant, p_local_id, v_marca, r.nombre, r.descripcion, r.emoji, r.foto_url, r.codigo,
      (SELECT new_id FROM _mg WHERE old_id = r.grupo_id), r.orden, r.precio_madre, r.costo_actual, r.tax_rate_id, r.estacion, r.estado,
      r.es_combo, r.visible_pos, r.visible_qr, r.visible_tienda, r.es_open_item, r.tiempo_prep_min,
      r.sku_rappi, r.sku_pedidosya, r.sku_deliverect, r.sku_externos, r.es_prep_item, r.es_cubierto, r.modos_pos_visibles)
    RETURNING id INTO v_new;
    INSERT INTO _mi VALUES (r.id, v_new);
    v_items := v_items + 1;
  END LOOP;

  -- 4) Precios por canal de los items copiados
  INSERT INTO item_precios_canal (tenant_id, local_id, item_id, canal_id, precio, edicion_manual, vendible)
  SELECT v_tenant, p_local_id, mi.new_id, ipc.canal_id, ipc.precio, ipc.edicion_manual, ipc.vendible
    FROM item_precios_canal ipc JOIN _mi mi ON mi.old_id = ipc.item_id
   WHERE ipc.local_id IS NULL AND ipc.deleted_at IS NULL;

  -- 5) Links item↔modifier de los items copiados
  INSERT INTO item_modifier_groups (tenant_id, item_id, modifier_group_id, orden, requerido_override, min_seleccion_override, max_seleccion_override)
  SELECT v_tenant, mi.new_id, mmg.new_id, img.orden, img.requerido_override, img.min_seleccion_override, img.max_seleccion_override
    FROM item_modifier_groups img
    JOIN _mi mi ON mi.old_id = img.item_id
    JOIN _mmg mmg ON mmg.old_id = img.modifier_group_id;

  RETURN jsonb_build_object('items', v_items, 'grupos', v_grupos, 'modo', p_modo);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_importar_menu_marca(integer, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
