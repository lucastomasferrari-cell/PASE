-- 202606161200_crear_gasto_tipo_robusto.sql
-- Bug Anto (jun-2026): "crear como gasto" tiraba "violates row-level..." /
-- "violates check constraint gastos_tipo_check".
--
-- Causa raíz: crear_gasto traducía el tipo mirando SOLO el grupo de la
-- categoría en config_categorias. Si la categoría elegida no matcheaba exacto
-- (muy común: el cache de categorías o nombres distintos por tenant), v_grupo
-- quedaba NULL y caía al fallback `v_tipo_final := p_tipo`, metiendo la
-- ETIQUETA cruda ("Impuesto", "Otros", "Gasto Fijo") en gastos.tipo — que solo
-- acepta el enum fijo/variable/publicidad/comision/impuesto/retiro_socio/
-- empleado/juicios_demandas → violaba el CHECK. Con tipo "Otros" fallaba SIEMPRE.
--
-- Fix: resolver el tipo canónico de forma robusta en 3 pasos:
--   1) Por el grupo de la categoría (preferido).
--   2) Fallback: normalizar la ETIQUETA p_tipo a un valor del enum.
--   3) Si sigue sin resolver, error CLARO (TIPO_GASTO_INVALIDO) en vez del
--      "violates row" feo de Postgres.
--
-- COMPAT módulo Utilidades: registrar_reparto llama
-- crear_gasto(..., 'Retiro socio', 'retiro_socio', ...) y depende de que el
-- fallback respete p_tipo='retiro_socio' (su grupo 'Retiros Socios' no está
-- entre los 5 grupos gasto_). El paso 2 incluye 'retiro_socio' → mismo
-- resultado que antes, sin regresión.
--
-- Resto de la función IDÉNTICO a 202605112000 (idempotency, validaciones,
-- inserts, auditoría). Solo cambia el bloque de resolución de v_tipo_final.

CREATE OR REPLACE FUNCTION crear_gasto(
  p_fecha date, p_local_id integer, p_categoria text, p_tipo text,
  p_monto numeric, p_detalle text, p_cuenta text,
  p_plantilla_id integer DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_gasto_id text; v_mov_id text; v_grupo text; v_tipo_final text;
  v_tenant uuid;
  v_existing_mov RECORD;
BEGIN
  -- Idempotency: si ya hay un movimiento con esta key y gasto_id_ref, replay.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT id, gasto_id_ref INTO v_existing_mov FROM movimientos
     WHERE idempotency_key = p_idempotency_key
       AND tipo LIKE 'Gasto %'
       AND gasto_id_ref IS NOT NULL;
    IF v_existing_mov.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'gasto_id', v_existing_mov.gasto_id_ref,
        'mov_id',   v_existing_mov.id,
        'idempotent_replay', true
      );
    END IF;
  END IF;

  IF p_monto IS NULL OR p_monto <= 0 THEN RAISE EXCEPTION 'MONTO_INVALIDO'; END IF;
  IF p_cuenta IS NULL OR p_cuenta = '' THEN RAISE EXCEPTION 'CUENTA_INVALIDA'; END IF;
  IF p_categoria IS NULL OR p_categoria = '' THEN RAISE EXCEPTION 'CATEGORIA_REQUERIDA'; END IF;

  PERFORM _validar_local_autorizado(p_local_id);
  IF p_local_id IS NOT NULL THEN
    SELECT tenant_id INTO v_tenant FROM locales WHERE id = p_local_id;
  ELSE
    v_tenant := auth_tenant_id();
    IF v_tenant IS NULL THEN
      SELECT id INTO v_tenant FROM tenants WHERE slug='neko' LIMIT 1;
    END IF;
  END IF;

  -- ── Resolver tipo canónico (enum gastos_tipo_check) ──────────────────────
  -- 1) Por el grupo de la categoría (fuente preferida).
  SELECT grupo INTO v_grupo FROM config_categorias
   WHERE nombre = p_categoria AND tipo LIKE 'gasto_%' AND activo = true LIMIT 1;
  v_tipo_final := CASE v_grupo
    WHEN 'Gastos Fijos'     THEN 'fijo'
    WHEN 'Gastos Variables' THEN 'variable'
    WHEN 'Publicidad y MKT' THEN 'publicidad'
    WHEN 'Comisiones'       THEN 'comision'
    WHEN 'Impuestos'        THEN 'impuesto'
    ELSE NULL
  END;

  -- 2) Fallback: normalizar la ETIQUETA p_tipo a un valor del enum. Cubre el
  --    caso en que la categoría no matchea config_categorias.
  IF v_tipo_final IS NULL THEN
    v_tipo_final := CASE lower(trim(unaccent(coalesce(p_tipo, ''))))
      WHEN 'fijo'             THEN 'fijo'
      WHEN 'gasto fijo'       THEN 'fijo'
      WHEN 'variable'         THEN 'variable'
      WHEN 'gasto variable'   THEN 'variable'
      WHEN 'publicidad'       THEN 'publicidad'
      WHEN 'comision'         THEN 'comision'
      WHEN 'impuesto'         THEN 'impuesto'
      WHEN 'retiro socio'     THEN 'retiro_socio'
      WHEN 'retiro_socio'     THEN 'retiro_socio'
      WHEN 'empleado'         THEN 'empleado'
      WHEN 'juicios_demandas' THEN 'juicios_demandas'
      WHEN 'juicios y demandas' THEN 'juicios_demandas'
      -- "Otros" no existe como tipo de gasto en el EERR → cae a 'variable'
      -- (el menos-malo; queda en Gastos Variables). Lucas jun-2026.
      WHEN 'otros'            THEN 'variable'
      ELSE NULL
    END;
  END IF;

  -- 3) Si sigue sin resolver, error claro en vez del "violates check" crudo.
  IF v_tipo_final IS NULL OR v_tipo_final NOT IN
     ('fijo','variable','publicidad','comision','impuesto','retiro_socio','empleado','juicios_demandas') THEN
    RAISE EXCEPTION 'TIPO_GASTO_INVALIDO';
  END IF;

  v_gasto_id := _gen_id('GASTO');
  INSERT INTO gastos (id, fecha, local_id, categoria, tipo, monto, detalle, cuenta, plantilla_id, tenant_id)
  VALUES (v_gasto_id, p_fecha, p_local_id, p_categoria, v_tipo_final, p_monto, p_detalle, p_cuenta, p_plantilla_id, v_tenant);

  IF p_local_id IS NOT NULL THEN
    PERFORM _actualizar_saldo_caja(p_cuenta, p_local_id, -p_monto);
  END IF;

  v_mov_id := _gen_id('MOV');
  INSERT INTO movimientos (
    id, fecha, cuenta, tipo, cat, importe, detalle, local_id, gasto_id_ref, tenant_id,
    idempotency_key
  ) VALUES (
    v_mov_id, p_fecha, p_cuenta, 'Gasto ' || COALESCE(v_tipo_final, ''),
    p_categoria, -p_monto, COALESCE(p_detalle, p_categoria), p_local_id, v_gasto_id, v_tenant,
    p_idempotency_key
  );

  PERFORM _auditar('gastos', 'CREAR', jsonb_build_object(
    'gasto_id', v_gasto_id, 'mov_id', v_mov_id, 'monto', p_monto,
    'categoria', p_categoria, 'tipo', v_tipo_final, 'grupo', v_grupo,
    'usuario_id', auth_usuario_id()
  ), v_tenant);

  RETURN jsonb_build_object('gasto_id', v_gasto_id, 'mov_id', v_mov_id, 'tipo', v_tipo_final);
END;
$$;

NOTIFY pgrst, 'reload schema';
