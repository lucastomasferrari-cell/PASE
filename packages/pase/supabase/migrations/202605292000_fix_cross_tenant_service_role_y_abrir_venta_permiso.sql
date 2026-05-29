-- ─────────────────────────────────────────────────────────────────────────
-- 2 fixes descubiertos corriendo E2E full el 29-may:
--
-- ## Fix #1: fn_recalcular_* permitir service_role
--
-- Síntoma E2E: test 34 marketplace falla al insertar materia_prima con
--   "Insert materia_prima: INSUMO_CROSS_TENANT"
--
-- Causa: el trigger AFTER INSERT en materias_primas dispara
-- fn_recalcular_costo_promedio_insumo(insumo_id). Esa función chequea:
--   IF NOT auth_es_superadmin() AND v_tenant_id IS DISTINCT FROM auth_tenant_id() THEN
--     RAISE EXCEPTION 'INSUMO_CROSS_TENANT';
--   END IF;
--
-- Cuando se invoca con service_role (sin auth.uid()), `auth_tenant_id()`
-- retorna NULL. `v_tenant_id IS DISTINCT FROM NULL` da TRUE → throw.
-- service_role ya bypassa RLS y es operación administrativa confiable.
-- El check debería permitir: superadmin O sin-sesión O mismo tenant.
--
-- ## Fix #2: fn_abrir_venta_comanda permite abrir con ventas.abrir
--
-- Síntoma E2E: test 32 falla "abrir mesa cajero limitado: SIN_PERMISO_VENTAS"
--
-- Causa: la RPC pide `comanda.ventas.cobrar` para abrir una mesa. Eso es
-- inconsistente — `comanda.ventas.abrir` es el slug semántico correcto.
-- En la práctica un mozo/cajero debería poder abrir mesas con solo `abrir`
-- y NO necesitar `cobrar` (que es para cerrar el ticket con plata).
--
-- Fix backward-compat: permite (abrir OR cobrar) — usuarios viejos que
-- solo tienen cobrar siguen funcionando.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Fix #1a: fn_recalcular_costo_promedio_insumo ────────────────────────
CREATE OR REPLACE FUNCTION public.fn_recalcular_costo_promedio_insumo(p_insumo_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_costo_promedio NUMERIC;
  v_tenant_id UUID;
BEGIN
  SELECT tenant_id INTO v_tenant_id FROM insumos WHERE id = p_insumo_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;
  -- Permitir: superadmin, service_role (sin sesión = NULL), o mismo tenant.
  IF NOT auth_es_superadmin()
     AND auth_tenant_id() IS NOT NULL
     AND v_tenant_id IS DISTINCT FROM auth_tenant_id() THEN
    RAISE EXCEPTION 'INSUMO_CROSS_TENANT';
  END IF;

  SELECT AVG(
    precio_actual / NULLIF(factor_conversion * (1 - merma_pct / 100.0), 0)
  )
  INTO v_costo_promedio
  FROM materias_primas
  WHERE insumo_id = p_insumo_id
    AND activa = TRUE
    AND deleted_at IS NULL
    AND precio_actual IS NOT NULL
    AND precio_actual > 0;

  IF v_costo_promedio IS NOT NULL THEN
    UPDATE insumos
      SET costo_actual = ROUND(v_costo_promedio::numeric, 2),
          costo_actualizado_at = NOW(),
          updated_at = NOW()
      WHERE id = p_insumo_id;
  END IF;
END;
$function$;

-- ── Fix #1b: fn_recalcular_stock_insumo (mismo patrón) ──────────────────
CREATE OR REPLACE FUNCTION public.fn_recalcular_stock_insumo(p_insumo_id bigint)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_total NUMERIC;
  v_tenant_id UUID;
BEGIN
  SELECT tenant_id INTO v_tenant_id FROM insumos WHERE id = p_insumo_id;
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;
  IF NOT auth_es_superadmin()
     AND auth_tenant_id() IS NOT NULL
     AND v_tenant_id IS DISTINCT FROM auth_tenant_id() THEN
    RAISE EXCEPTION 'INSUMO_CROSS_TENANT';
  END IF;

  SELECT COALESCE(SUM(cantidad), 0) INTO v_total
    FROM insumo_movimientos
   WHERE insumo_id = p_insumo_id AND deleted_at IS NULL;

  UPDATE insumos SET stock_actual = v_total, updated_at = NOW()
   WHERE id = p_insumo_id;

  RETURN v_total;
END;
$function$;

-- ── Fix #2: fn_abrir_venta_comanda — aceptar abrir OR cobrar ────────────
-- No reescribimos toda la función (muy larga); solo cambiamos el check de
-- permiso al inicio. Uso una RPC wrapper que hace el OR antes de invocar
-- la original. NO — la mejor opción es modificar la primera línea con un
-- string replace pero pg no soporta. Voy a regenerar la función completa
-- usando la última versión (migration 202605151920) con el OR cambiado.

-- Versión idéntica a 202605151920_abrir_venta_cliente_id.sql, SOLO cambia
-- el check de permisos (línea 34 vieja → OR de abrir/cobrar).
DROP FUNCTION IF EXISTS fn_abrir_venta_comanda(INTEGER, TEXT, INTEGER, BIGINT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, BIGINT);

CREATE OR REPLACE FUNCTION fn_abrir_venta_comanda(
  p_local_id INTEGER,
  p_modo TEXT,
  p_canal_id INTEGER,
  p_mesa_id BIGINT DEFAULT NULL,
  p_mozo_id UUID DEFAULT NULL,
  p_cajero_id UUID DEFAULT NULL,
  p_cliente_nombre TEXT DEFAULT NULL,
  p_cliente_telefono TEXT DEFAULT NULL,
  p_cliente_direccion TEXT DEFAULT NULL,
  p_covers INTEGER DEFAULT NULL,
  p_origen TEXT DEFAULT 'pos',
  p_tipo_entrega TEXT DEFAULT NULL,
  p_estado TEXT DEFAULT 'abierta',
  p_programada_para TIMESTAMPTZ DEFAULT NULL,
  p_cliente_id BIGINT DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_id BIGINT;
  v_numero INTEGER;
  v_turno_id BIGINT;
BEGIN
  -- Fix 29-may: aceptar 'comanda.ventas.abrir' OR 'comanda.ventas.cobrar'
  -- (antes solo .cobrar — inconsistente, un mozo con solo .abrir no podía
  -- abrir mesas). Backward-compat: cualquiera de los 2 permite abrir.
  IF p_origen = 'pos' AND NOT (
    fn_check_perm_comanda('comanda.ventas.abrir') OR
    fn_check_perm_comanda('comanda.ventas.cobrar')
  ) THEN
    RAISE EXCEPTION 'SIN_PERMISO_VENTAS';
  END IF;

  SELECT id INTO v_turno_id FROM turnos_caja
   WHERE local_id = p_local_id AND estado = 'abierto' LIMIT 1;

  IF v_turno_id IS NULL AND p_origen = 'pos' AND p_modo != 'pedidos' THEN
    RAISE EXCEPTION 'NO_HAY_TURNO_ABIERTO';
  END IF;

  v_numero := fn_next_ticket_number_comanda(p_local_id);

  INSERT INTO ventas_pos (
    tenant_id, local_id, numero_local, modo, canal_id, turno_caja_id,
    mesa_id, mozo_id, cajero_id, cliente_id, cliente_nombre, cliente_telefono,
    cliente_direccion, covers, origen, tipo_entrega, estado, programada_para
  ) VALUES (
    auth_tenant_id(), p_local_id, v_numero, p_modo, p_canal_id, v_turno_id,
    p_mesa_id, p_mozo_id, p_cajero_id, p_cliente_id, p_cliente_nombre, p_cliente_telefono,
    p_cliente_direccion, p_covers, p_origen, p_tipo_entrega, p_estado, p_programada_para
  ) RETURNING id INTO v_id;

  IF p_mesa_id IS NOT NULL AND p_estado = 'abierta' THEN
    UPDATE mesas SET estado = 'ocupada' WHERE id = p_mesa_id AND estado = 'libre';
  END IF;
  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_abrir_venta_comanda(INTEGER, TEXT, INTEGER, BIGINT, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ, BIGINT) TO authenticated;

COMMENT ON FUNCTION public.fn_recalcular_costo_promedio_insumo IS
  'Recalcula costo_actual del insumo como promedio de sus MPs activas. '
  'Fix 29-may: permitir service_role (sin sesión) además de superadmin y '
  'mismo tenant. Antes tiraba INSUMO_CROSS_TENANT a triggers automatizados.';

COMMENT ON FUNCTION public.fn_recalcular_stock_insumo IS
  'Recalcula stock_actual sumando insumo_movimientos. Fix 29-may: permitir '
  'service_role además de superadmin/mismo tenant.';

COMMENT ON FUNCTION public.fn_abrir_venta_comanda IS
  'Abre una venta POS. Fix 29-may: ahora acepta permiso comanda.ventas.abrir '
  'OR comanda.ventas.cobrar (antes solo cobrar — inconsistente con el slug '
  'semántico). Mozos con solo "abrir" ahora pueden abrir mesas sin tener "cobrar".';
