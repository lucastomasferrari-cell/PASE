-- 202606161400_gasto_mano_obra.sql
-- Lucas 16-jun: "lo viejo dejémoslo atrás, pero necesitamos poder poner los
-- próximos gastos como costo laboral".
--
-- Problema: el tipo `empleado` que ya existe obliga a elegir un empleado
-- registrado (va por crear_gasto_empleado, ligado a rrhh_adelantos). No sirve
-- para mano de obra suelta (repartidores, sueldo del día, eventos, personal sin
-- legajo). Solución: nuevo tipo de gasto `mano_obra` que cae en Costo Laboral
-- del EERR (junto a sueldos + cargas + boletas) SIN pedir empleado.
--
-- Cambios:
--   1. gastos_tipo_check: sumar 'mano_obra' a los valores válidos.
--   2. crear_gasto: reconocer la etiqueta "Mano de Obra" / "Costo Laboral" → 'mano_obra'.
-- El EERR (frontend) suma tipo IN ('empleado','mano_obra') al Costo Laboral.

ALTER TABLE gastos DROP CONSTRAINT IF EXISTS gastos_tipo_check;
ALTER TABLE gastos ADD CONSTRAINT gastos_tipo_check CHECK (
  tipo = ANY (ARRAY[
    'fijo','variable','publicidad','comision','impuesto',
    'retiro_socio','empleado','juicios_demandas','mano_obra'
  ])
);

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

  -- 1) Por el grupo de la categoría (fuente preferida).
  SELECT grupo INTO v_grupo FROM config_categorias
   WHERE nombre = p_categoria AND tipo LIKE 'gasto_%' AND activo = true LIMIT 1;
  v_tipo_final := CASE v_grupo
    WHEN 'Gastos Fijos'     THEN 'fijo'
    WHEN 'Gastos Variables' THEN 'variable'
    WHEN 'Publicidad y MKT' THEN 'publicidad'
    WHEN 'Comisiones'       THEN 'comision'
    WHEN 'Impuestos'        THEN 'impuesto'
    WHEN 'Mano de Obra'     THEN 'mano_obra'
    ELSE NULL
  END;

  -- 2) Fallback: normalizar la ETIQUETA p_tipo a un valor del enum.
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
      WHEN 'mano de obra'     THEN 'mano_obra'
      WHEN 'mano_obra'        THEN 'mano_obra'
      WHEN 'costo laboral'    THEN 'mano_obra'
      WHEN 'juicios_demandas' THEN 'juicios_demandas'
      WHEN 'juicios y demandas' THEN 'juicios_demandas'
      WHEN 'otros'            THEN 'variable'
      ELSE NULL
    END;
  END IF;

  -- 3) Si sigue sin resolver, error claro en vez del "violates check" crudo.
  IF v_tipo_final IS NULL OR v_tipo_final NOT IN
     ('fijo','variable','publicidad','comision','impuesto','retiro_socio','empleado','juicios_demandas','mano_obra') THEN
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
