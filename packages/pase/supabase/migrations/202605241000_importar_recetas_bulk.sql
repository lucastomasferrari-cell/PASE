-- ─────────────────────────────────────────────────────────────────────────
-- Importador de recetas bulk desde CSV
-- ─────────────────────────────────────────────────────────────────────────
--
-- Acelera el onboarding inicial. Hoy cargar 100 recetas a mano lleva un
-- día completo entre crear items, insumos y vincularlos uno por uno.
-- Esta RPC permite cargar todo desde un Excel/CSV en un click.
--
-- Formato CSV esperado (columnas):
--   plato, ingrediente, cantidad, unidad, merma_pct, precio_plato
-- Una fila por ingrediente. El `precio_plato` solo va en la primera fila
-- de cada plato (sino se ignora). El sistema agrupa por `plato`.
--
-- Modo de uso:
--   - dry_run=TRUE: valida + devuelve reporte (qué se crearía / qué falla)
--                   NO toca DB. Pensado para preview antes de aplicar.
--   - dry_run=FALSE: aplica todo en transacción única. Si hay 1 error,
--                    rollback completo (no deja recetas a medias).
--
-- Crea entidades faltantes al vuelo (con valores mínimos):
--   - Insumo nuevo: costo_actual=0 (vacío, completar después)
--   - Item nuevo:   precio_madre = precio_plato del CSV, estado='disponible'
--
-- Idempotente: si el item ya tiene receta activa, la marca como inactiva
-- (activa=FALSE) y crea una nueva con la versión del CSV. Permite
-- reimportar el mismo CSV sin duplicar.
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_importar_recetas_bulk(
  p_recetas JSONB,   -- array de { plato, ingrediente, cantidad, unidad, merma_pct, precio_plato }
  p_dry_run BOOLEAN DEFAULT TRUE,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_local_id INTEGER;
  v_unidades_validas TEXT[] := ARRAY['kg','g','L','ml','un','porcion'];
  v_filas_count INTEGER;
  v_plato TEXT;
  v_ingrediente TEXT;
  v_cantidad NUMERIC;
  v_unidad TEXT;
  v_merma_pct NUMERIC;
  v_precio_plato NUMERIC;
  v_fila JSONB;
  v_idx INTEGER := 0;
  v_errors JSONB := '[]'::JSONB;
  v_recetas_a_crear INTEGER := 0;
  v_insumos_a_crear INTEGER := 0;
  v_items_a_crear INTEGER := 0;
  v_items_nuevos JSONB := '[]'::JSONB;
  v_insumos_nuevos JSONB := '[]'::JSONB;
  v_platos_unicos JSONB := '{}'::JSONB;
  v_item_id INTEGER;
  v_insumo_id BIGINT;
  v_receta_id BIGINT;
  v_cached_result JSONB;
  v_existing_receta_id BIGINT;
BEGIN
  -- Auth + tenant
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  -- Solo dueño/admin pueden importar recetas (operación masiva crítica)
  IF NOT (auth_es_dueno_o_admin() OR auth_es_superadmin()) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- Idempotency en modo commit (dry_run no se cachea)
  IF NOT p_dry_run AND p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_cached_result FROM idempotency_keys
     WHERE rpc_name = 'fn_importar_recetas_bulk' AND key = p_idempotency_key;
    IF v_cached_result IS NOT NULL THEN
      RETURN v_cached_result;
    END IF;
  END IF;

  -- Validar input
  IF jsonb_typeof(p_recetas) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'INPUT_INVALIDO: p_recetas debe ser un array JSONB';
  END IF;

  v_filas_count := jsonb_array_length(p_recetas);
  IF v_filas_count = 0 THEN
    RAISE EXCEPTION 'INPUT_VACIO: no hay filas para importar';
  END IF;

  IF v_filas_count > 5000 THEN
    RAISE EXCEPTION 'INPUT_DEMASIADO_GRANDE: máx 5000 filas por importación';
  END IF;

  -- ─── PASO 1: validar cada fila + agrupar por plato ────────────────────
  FOR v_fila IN SELECT * FROM jsonb_array_elements(p_recetas) LOOP
    v_idx := v_idx + 1;
    v_plato := trim(COALESCE(v_fila->>'plato', ''));
    v_ingrediente := trim(COALESCE(v_fila->>'ingrediente', ''));
    v_cantidad := NULLIF(v_fila->>'cantidad','')::NUMERIC;
    v_unidad := trim(COALESCE(v_fila->>'unidad', ''));
    v_merma_pct := COALESCE(NULLIF(v_fila->>'merma_pct','')::NUMERIC, 0);
    v_precio_plato := NULLIF(v_fila->>'precio_plato','')::NUMERIC;

    -- Validaciones
    IF v_plato = '' THEN
      v_errors := v_errors || jsonb_build_object('linea', v_idx, 'error', 'plato_vacio');
      CONTINUE;
    END IF;
    IF v_ingrediente = '' THEN
      v_errors := v_errors || jsonb_build_object('linea', v_idx, 'plato', v_plato, 'error', 'ingrediente_vacio');
      CONTINUE;
    END IF;
    IF v_cantidad IS NULL OR v_cantidad <= 0 THEN
      v_errors := v_errors || jsonb_build_object('linea', v_idx, 'plato', v_plato, 'ingrediente', v_ingrediente, 'error', 'cantidad_invalida');
      CONTINUE;
    END IF;
    IF v_unidad = '' OR NOT (v_unidad = ANY(v_unidades_validas)) THEN
      v_errors := v_errors || jsonb_build_object('linea', v_idx, 'plato', v_plato, 'ingrediente', v_ingrediente, 'error', 'unidad_invalida', 'recibido', v_unidad, 'validas', v_unidades_validas);
      CONTINUE;
    END IF;
    IF v_merma_pct < 0 OR v_merma_pct > 100 THEN
      v_errors := v_errors || jsonb_build_object('linea', v_idx, 'plato', v_plato, 'ingrediente', v_ingrediente, 'error', 'merma_pct_fuera_rango', 'recibido', v_merma_pct);
      CONTINUE;
    END IF;

    -- Trackeo de platos únicos + acumulación del precio_plato (primera no-NULL gana)
    IF NOT (v_platos_unicos ? v_plato) THEN
      v_platos_unicos := v_platos_unicos || jsonb_build_object(v_plato, jsonb_build_object('precio', v_precio_plato, 'ingredientes', '[]'::JSONB));
    ELSIF v_precio_plato IS NOT NULL AND (v_platos_unicos->v_plato->'precio') IS NULL THEN
      v_platos_unicos := jsonb_set(v_platos_unicos, ARRAY[v_plato, 'precio'], to_jsonb(v_precio_plato));
    END IF;
  END LOOP;

  -- Si hay errores, devolver el reporte y salir (no toca DB)
  IF jsonb_array_length(v_errors) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'dry_run', p_dry_run,
      'filas_total', v_filas_count,
      'errores', v_errors,
      'platos_unicos', jsonb_object_keys(v_platos_unicos)::TEXT
    );
  END IF;

  -- ─── PASO 2: identificar items + insumos faltantes ────────────────────
  FOR v_fila IN SELECT * FROM jsonb_array_elements(p_recetas) LOOP
    v_plato := trim(v_fila->>'plato');
    v_ingrediente := trim(v_fila->>'ingrediente');

    -- ¿Item ya existe? (match por nombre, case-insensitive, sin deleted)
    SELECT id INTO v_item_id FROM items
     WHERE tenant_id = v_tenant_id AND lower(nombre) = lower(v_plato)
       AND deleted_at IS NULL LIMIT 1;
    IF v_item_id IS NULL AND NOT (v_items_nuevos @> jsonb_build_array(v_plato)) THEN
      v_items_nuevos := v_items_nuevos || to_jsonb(v_plato);
      v_items_a_crear := v_items_a_crear + 1;
    END IF;

    -- ¿Insumo ya existe?
    SELECT id INTO v_insumo_id FROM insumos
     WHERE tenant_id = v_tenant_id AND lower(nombre) = lower(v_ingrediente)
       AND deleted_at IS NULL LIMIT 1;
    IF v_insumo_id IS NULL AND NOT (v_insumos_nuevos @> jsonb_build_array(v_ingrediente)) THEN
      v_insumos_nuevos := v_insumos_nuevos || to_jsonb(v_ingrediente);
      v_insumos_a_crear := v_insumos_a_crear + 1;
    END IF;
  END LOOP;

  v_recetas_a_crear := (SELECT COUNT(*) FROM jsonb_object_keys(v_platos_unicos));

  -- ─── PASO 3: si es dry_run, devolver reporte y salir ───────────────────
  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'filas_total', v_filas_count,
      'recetas_a_crear', v_recetas_a_crear,
      'items_a_crear', v_items_a_crear,
      'insumos_a_crear', v_insumos_a_crear,
      'items_nuevos', v_items_nuevos,
      'insumos_nuevos', v_insumos_nuevos,
      'errores', '[]'::JSONB
    );
  END IF;

  -- ─── PASO 4: COMMIT — crear items + insumos + recetas en transacción ──
  -- (la RPC entera es una transacción implícita; si algo falla, rollback)

  -- 4.a) Crear items nuevos
  FOR v_fila IN SELECT * FROM jsonb_array_elements(v_items_nuevos) LOOP
    v_plato := v_fila #>> '{}';
    v_precio_plato := COALESCE((v_platos_unicos->v_plato->'precio')::NUMERIC, 0);
    INSERT INTO items (tenant_id, nombre, precio_madre, estado, visible_pos)
    VALUES (v_tenant_id, v_plato, v_precio_plato, 'disponible', true);
  END LOOP;

  -- 4.b) Crear insumos nuevos (unidad la sacamos de la primera receta donde aparece)
  FOR v_fila IN SELECT * FROM jsonb_array_elements(v_insumos_nuevos) LOOP
    v_ingrediente := v_fila #>> '{}';
    -- Buscar la primera unidad usada para ese ingrediente en el CSV
    SELECT trim(x->>'unidad') INTO v_unidad
      FROM jsonb_array_elements(p_recetas) x
     WHERE lower(trim(x->>'ingrediente')) = lower(v_ingrediente)
     LIMIT 1;
    INSERT INTO insumos (tenant_id, nombre, unidad, costo_actual, activo, es_comprado, stock_disponible, stock_actual)
    VALUES (v_tenant_id, v_ingrediente, v_unidad, 0, true, true, true, 0);
  END LOOP;

  -- 4.c) Crear recetas (1 por plato único)
  FOR v_plato IN SELECT jsonb_object_keys(v_platos_unicos) LOOP
    -- Obtener item_id (existente o recién creado)
    SELECT id INTO v_item_id FROM items
     WHERE tenant_id = v_tenant_id AND lower(nombre) = lower(v_plato)
       AND deleted_at IS NULL LIMIT 1;
    IF v_item_id IS NULL THEN
      RAISE EXCEPTION 'IMPORT_INTERNAL: item % no encontrado post-creación', v_plato;
    END IF;

    -- Si ya hay receta activa para este item, desactivarla (versión nueva la reemplaza)
    SELECT id INTO v_existing_receta_id FROM recetas
     WHERE tenant_id = v_tenant_id AND item_id = v_item_id AND activa = TRUE
       AND deleted_at IS NULL LIMIT 1;
    IF v_existing_receta_id IS NOT NULL THEN
      UPDATE recetas SET activa = FALSE, updated_at = NOW() WHERE id = v_existing_receta_id;
    END IF;

    -- Crear receta nueva
    INSERT INTO recetas (tenant_id, item_id, nombre, rendimiento, activa)
    VALUES (v_tenant_id, v_item_id, 'Receta ' || v_plato, 1, true)
    RETURNING id INTO v_receta_id;

    -- Crear receta_insumos para todas las filas que matchean este plato
    FOR v_fila IN
      SELECT * FROM jsonb_array_elements(p_recetas)
       WHERE lower(trim(value->>'plato')) = lower(v_plato)
    LOOP
      v_ingrediente := trim(v_fila->>'ingrediente');
      v_cantidad := (v_fila->>'cantidad')::NUMERIC;
      v_merma_pct := COALESCE(NULLIF(v_fila->>'merma_pct','')::NUMERIC, 0);

      SELECT id INTO v_insumo_id FROM insumos
       WHERE tenant_id = v_tenant_id AND lower(nombre) = lower(v_ingrediente)
         AND deleted_at IS NULL LIMIT 1;
      IF v_insumo_id IS NULL THEN
        RAISE EXCEPTION 'IMPORT_INTERNAL: insumo % no encontrado post-creación', v_ingrediente;
      END IF;

      INSERT INTO receta_insumos (tenant_id, receta_id, insumo_id, cantidad, merma_pct, orden)
      VALUES (v_tenant_id, v_receta_id, v_insumo_id, v_cantidad, v_merma_pct, 0);
    END LOOP;
  END LOOP;

  -- ─── PASO 5: cachear idempotency + devolver reporte final ──────────────
  v_cached_result := jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'filas_total', v_filas_count,
    'recetas_creadas', v_recetas_a_crear,
    'items_creados', v_items_a_crear,
    'insumos_creados', v_insumos_a_crear,
    'errores', '[]'::JSONB
  );

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (rpc_name, key, tenant_id, result)
    VALUES ('fn_importar_recetas_bulk', p_idempotency_key, v_tenant_id, v_cached_result)
    ON CONFLICT (rpc_name, key) DO NOTHING;
  END IF;

  RETURN v_cached_result;
END;
$$;

COMMENT ON FUNCTION public.fn_importar_recetas_bulk IS
  'Importa recetas en bulk desde CSV. Modo dry_run=TRUE valida y devuelve '
  'reporte sin tocar DB. Modo commit aplica todo en transacción única. '
  'Crea items e insumos faltantes con valores mínimos. Idempotente '
  '(reimport del mismo CSV no duplica recetas).';
