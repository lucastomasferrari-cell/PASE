-- 202606021900_fn_aumento_canal_precios.sql
-- F6 Brainstorm #8 — chunk Pricing canal (2026-06-02).
--
-- La RPC existente `fn_aumento_masivo_precios` siempre sube el precio
-- madre Y recalcula los canales atados. Para el caso real "Rappi me
-- saca 25% de comisión, le subo 25% solo a ese canal sin tocar el
-- resto", no sirve — pisaría todos los canales atados.
--
-- Esta función nueva hace lo opuesto:
--   - NO toca `precio_madre`.
--   - Recibe `p_canal_id` obligatorio.
--   - Para cada item del scope (tenant + opcional local + opcional grupo),
--     actualiza SOLO ese canal:
--       - Si ya hay row en item_precios_canal → UPDATE precio + edicion_manual=TRUE.
--       - Si NO hay row → INSERT con precio derivado del madre + ajuste pct.
--   - Esto deja los demás canales intactos.
--
-- Convención: si el canal está `atado_madre=TRUE`, igual aceptamos el
-- bump y dejamos edicion_manual=TRUE (= próximo aumento masivo del madre
-- lo va a pisar, salvo que entre tanto se haga otro aumento por canal).
-- Si el dueño quiere bumpear Rappi sin riesgo de pisada, debe poner el
-- canal Rappi como `atado_madre=FALSE` (= Indep) — pero eso es elección
-- del usuario, no responsabilidad de esta RPC.

CREATE OR REPLACE FUNCTION fn_aumento_canal_precios(
  p_tenant_id   UUID,
  p_canal_id    INTEGER,
  p_local_id    INTEGER DEFAULT NULL,
  p_grupo_id    INTEGER DEFAULT NULL,
  p_porcentaje  NUMERIC DEFAULT 0,
  p_redondeo_a  INTEGER DEFAULT 1
)
RETURNS TABLE (
  items_afectados      INTEGER,
  precios_actualizados INTEGER,
  precios_creados      INTEGER
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_items_count    INTEGER := 0;
  v_updated_count  INTEGER := 0;
  v_inserted_count INTEGER := 0;
  v_canal_existe   BOOLEAN;
BEGIN
  IF NOT (auth_es_superadmin() OR auth_tiene_permiso('comanda.precios.aumento_masivo')) THEN
    RAISE EXCEPTION 'SIN_PERMISO_AUMENTO_MASIVO';
  END IF;

  IF p_redondeo_a IS NULL OR p_redondeo_a < 1 THEN
    RAISE EXCEPTION 'REDONDEO_INVALIDO';
  END IF;

  IF p_canal_id IS NULL THEN
    RAISE EXCEPTION 'CANAL_REQUERIDO';
  END IF;

  -- Verificar que el canal pertenezca al tenant (anti cross-tenant)
  SELECT EXISTS (
    SELECT 1 FROM canales
     WHERE id = p_canal_id AND tenant_id = p_tenant_id AND deleted_at IS NULL
  ) INTO v_canal_existe;

  IF NOT v_canal_existe THEN
    RAISE EXCEPTION 'CANAL_NO_VALIDO';
  END IF;

  -- 1) UPDATE para los ipc existentes en este canal
  WITH upd AS (
    UPDATE item_precios_canal ipc SET
      precio = ROUND(ipc.precio * (1 + p_porcentaje / 100.0) / p_redondeo_a) * p_redondeo_a,
      edicion_manual = TRUE,
      updated_at = NOW(),
      updated_by = auth_usuario_id()
    FROM items i
    WHERE ipc.item_id = i.id
      AND ipc.canal_id = p_canal_id
      AND ipc.tenant_id = p_tenant_id
      AND (p_local_id IS NULL OR ipc.local_id = p_local_id OR ipc.local_id IS NULL)
      AND (p_grupo_id IS NULL OR i.grupo_id = p_grupo_id)
      AND ipc.deleted_at IS NULL
      AND i.deleted_at IS NULL
    RETURNING ipc.id, ipc.item_id
  )
  SELECT COUNT(*)::INTEGER INTO v_updated_count FROM upd;

  -- 2) INSERT para items que NO tenían row en este canal — usamos el
  --    precio derivado: precio_madre × (1 + ajuste_canal/100) × (1 + p_pct/100)
  WITH ins AS (
    INSERT INTO item_precios_canal (
      item_id, canal_id, precio, edicion_manual, vendible,
      tenant_id, local_id
    )
    SELECT
      i.id,
      p_canal_id,
      ROUND(
        i.precio_madre * (1 + c.ajuste_madre_pct / 100.0) * (1 + p_porcentaje / 100.0) / p_redondeo_a
      ) * p_redondeo_a,
      TRUE,
      TRUE,
      i.tenant_id,
      i.local_id
    FROM items i
    CROSS JOIN canales c
    WHERE c.id = p_canal_id
      AND i.tenant_id = p_tenant_id
      AND (p_local_id IS NULL OR i.local_id = p_local_id OR i.local_id IS NULL)
      AND (p_grupo_id IS NULL OR i.grupo_id = p_grupo_id)
      AND i.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM item_precios_canal ipc2
         WHERE ipc2.item_id = i.id
           AND ipc2.canal_id = p_canal_id
           AND ipc2.deleted_at IS NULL
      )
    RETURNING id
  )
  SELECT COUNT(*)::INTEGER INTO v_inserted_count FROM ins;

  v_items_count := v_updated_count + v_inserted_count;

  RETURN QUERY SELECT v_items_count, v_updated_count, v_inserted_count;
END;
$$;

REVOKE ALL ON FUNCTION fn_aumento_canal_precios(UUID, INTEGER, INTEGER, INTEGER, NUMERIC, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_aumento_canal_precios(UUID, INTEGER, INTEGER, INTEGER, NUMERIC, INTEGER) TO authenticated;

COMMENT ON FUNCTION fn_aumento_canal_precios(UUID, INTEGER, INTEGER, INTEGER, NUMERIC, INTEGER) IS
  'Aumento por canal específico (Rappi/PeYa/etc). NO toca precio_madre. ' ||
  'Marca todos los precios afectados como edicion_manual=TRUE. ' ||
  'INSERT para items sin ipc en este canal (deriva del madre + ajustes acumulados).';

NOTIFY pgrst, 'reload schema';
