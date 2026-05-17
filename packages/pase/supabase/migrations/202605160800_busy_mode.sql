-- ─── Busy Mode: bump global de tiempos de prep cuando la cocina está saturada ─
-- Sprint 16/05 — botón pánico en POS que extiende el tiempo informado al
-- cliente (retiro + delivery) sin cerrar el local. Estilo Deliverect/Otter.
--
-- Implementación: dos campos nuevos en comanda_local_settings:
--   - busy_extra_min: cuántos minutos extra sumar a los tiempos
--   - busy_hasta: hasta cuándo está activo (NULL = no activo)
--
-- Cuando busy_hasta > NOW(), la tienda online y el marketplace muestran
-- tiempo + extra. Una vez vencido, vuelve a normal automático.
--
-- En el POS, un botón rápido permite activar "+10 / +20 / +30 min por 1h".

ALTER TABLE comanda_local_settings ADD COLUMN IF NOT EXISTS busy_extra_min INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comanda_local_settings ADD COLUMN IF NOT EXISTS busy_hasta TIMESTAMPTZ NULL;

COMMENT ON COLUMN comanda_local_settings.busy_extra_min IS 'Minutos extra que se suman al tiempo de prep informado al cliente. 0 = normal.';
COMMENT ON COLUMN comanda_local_settings.busy_hasta IS 'Hasta cuándo está activo Busy Mode. NULL o < NOW() = inactivo (vuelve a tiempos normales).';

-- Vista pública: extender v_locales_publicos con tiempos efectivos
-- (= tiempo_retiro_min + busy_extra_min si busy_hasta > NOW()).
CREATE OR REPLACE VIEW v_locales_publicos AS
SELECT
  cls.local_id,
  cls.slug,
  l.nombre,
  cls.direccion,
  cls.telefono,
  cls.instagram,
  cls.web,
  cls.mp_qr_url,
  cls.costo_envio_default,
  -- Tiempos EFECTIVOS (con bump si busy mode activo)
  CASE
    WHEN cls.busy_hasta IS NOT NULL AND cls.busy_hasta > NOW()
    THEN cls.tiempo_retiro_min + cls.busy_extra_min
    ELSE cls.tiempo_retiro_min
  END AS tiempo_retiro_min,
  CASE
    WHEN cls.busy_hasta IS NOT NULL AND cls.busy_hasta > NOW()
    THEN cls.tiempo_delivery_min + cls.busy_extra_min
    ELSE cls.tiempo_delivery_min
  END AS tiempo_delivery_min,
  cls.tienda_activa,
  cls.acepta_delivery,
  cls.features_pos_modos,
  l.provincia,
  l.localidad,
  l.lat,
  l.lon,
  -- Exponer estado busy para que la tienda muestre badge "Demoramos un poco más"
  (cls.busy_hasta IS NOT NULL AND cls.busy_hasta > NOW()) AS busy_mode_activo,
  cls.busy_extra_min,
  cls.busy_hasta
FROM comanda_local_settings cls
JOIN locales l ON l.id = cls.local_id
WHERE cls.deleted_at IS NULL
  AND cls.tienda_activa = TRUE;

-- RPC para activar/desactivar busy mode desde POS — autenticada.
CREATE OR REPLACE FUNCTION fn_set_busy_mode(
  p_local_id INTEGER,
  p_extra_min INTEGER,
  p_minutos_duracion INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth_tenant_id() IS NULL THEN RAISE EXCEPTION 'SIN_TENANT'; END IF;
  PERFORM fn_assert_local_autorizado(p_local_id);
  IF p_extra_min < 0 OR p_extra_min > 120 THEN RAISE EXCEPTION 'EXTRA_MIN_INVALIDO (0-120)'; END IF;
  IF p_minutos_duracion < 0 OR p_minutos_duracion > 480 THEN RAISE EXCEPTION 'DURACION_INVALIDA (0-480)'; END IF;

  UPDATE comanda_local_settings
     SET busy_extra_min = p_extra_min,
         busy_hasta = CASE WHEN p_extra_min = 0 OR p_minutos_duracion = 0 THEN NULL
                           ELSE NOW() + (p_minutos_duracion || ' minutes')::INTERVAL END,
         updated_at = NOW()
   WHERE local_id = p_local_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_set_busy_mode(INTEGER, INTEGER, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
