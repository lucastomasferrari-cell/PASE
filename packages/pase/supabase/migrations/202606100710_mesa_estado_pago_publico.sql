-- ════════════════════════════════════════════════════════════════════════
-- MESA — estado de pago para la página de confirmación post-MP (09-jun).
-- El comprador vuelve de MercadoPago a /r/confirmacion/<tipo>/<id> y la página
-- pollea esta RPC hasta que el webhook confirme. Devuelve SOLO lo necesario.
--
-- Nota de seguridad (v1): el id es secuencial → un tercero podría consultar el
-- estado/código de otra compra adivinando ids. Mitigación v2: token aleatorio
-- por compra en la URL. Riesgo aceptado para v1 (el código igual solo sirve
-- canjeado en persona y se invalida al primer uso).
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_estado_pago_publico(p_tipo text, p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v jsonb;
BEGIN
  IF p_tipo = 'evento' THEN
    SELECT jsonb_build_object(
      'estado', i.estado,
      'titulo', e.titulo,
      'cantidad', i.cantidad,
      'monto', i.monto_total,
      'fecha', e.fecha_inicio
    ) INTO v
    FROM evento_inscripciones i JOIN eventos e ON e.id = i.evento_id
    WHERE i.id = p_id;
  ELSIF p_tipo = 'gift' THEN
    SELECT jsonb_build_object(
      'estado', c.estado,
      'titulo', g.nombre,
      'monto', c.monto,
      'codigo', CASE WHEN c.estado IN ('pagada','canjeada') THEN c.codigo ELSE NULL END,
      'para', c.para_nombre
    ) INTO v
    FROM giftcard_compras c JOIN giftcards g ON g.id = c.giftcard_id
    WHERE c.id = p_id;
  ELSE
    RAISE EXCEPTION 'TIPO_INVALIDO';
  END IF;
  RETURN v;  -- NULL si no existe
END;
$$;
