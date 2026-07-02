-- Aggregator: exponer reservas.email_obligatorio en el perfil público.
CREATE OR REPLACE FUNCTION public.fn_get_perfil_publico_local(p_local_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cls comanda_local_settings%ROWTYPE;
  v_local_nombre text;
  v_tenant uuid;
  v_populares jsonb;
  v_reviews jsonb;
  v_reviews_resumen jsonb;
  v_eventos jsonb;
  v_giftcards jsonb;
  v_hermanos jsonb;
  v_hay_mesa boolean := NULL;
BEGIN
  SELECT cls.* INTO v_cls FROM comanda_local_settings cls
   WHERE cls.slug = p_local_slug AND cls.deleted_at IS NULL;
  IF v_cls.id IS NULL THEN RETURN NULL; END IF;

  SELECT l.nombre, l.tenant_id INTO v_local_nombre, v_tenant
    FROM locales l WHERE l.id = v_cls.local_id;

  -- "Qué pedir": top 6 items por unidades vendidas en 30 días (ventas cobradas).
  SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) INTO v_populares FROM (
    SELECT i.nombre, i.foto_url, i.precio_madre AS precio,
           SUM(vpi.cantidad)::numeric AS vendidos
      FROM ventas_pos_items vpi
      JOIN ventas_pos v ON v.id = vpi.venta_id
      JOIN items i ON i.id = vpi.item_id
     WHERE v.local_id = v_cls.local_id
       AND v.estado = 'cobrada'
       AND v.cobrada_at > NOW() - INTERVAL '30 days'
       AND vpi.deleted_at IS NULL AND vpi.estado <> 'anulado'
       AND i.deleted_at IS NULL
     GROUP BY i.id, i.nombre, i.foto_url, i.precio_madre
     ORDER BY SUM(vpi.cantidad) DESC
     LIMIT 6
  ) p;

  -- Reseñas: resumen + últimas 3 (reusa la RPC pública existente). La RPC
  -- exige tienda_activa y explota si no — para el perfil, sin tienda activa
  -- simplemente no mostramos reviews.
  BEGIN
    SELECT jsonb_build_object(
             'promedio', MAX(r.rating_promedio),
             'total', MAX(r.total_reviews)
           ),
           COALESCE(jsonb_agg(jsonb_build_object(
             'autor', r.autor_nombre, 'rating', r.rating,
             'comentario', r.comentario, 'fecha', r.created_at
           )) FILTER (WHERE r.rn <= 3), '[]'::jsonb)
      INTO v_reviews_resumen, v_reviews
      FROM (
        SELECT x.*, row_number() OVER (ORDER BY x.created_at DESC) rn
          FROM fn_listar_reviews_publicas(p_local_slug) x
      ) r;
  EXCEPTION WHEN OTHERS THEN
    v_reviews_resumen := NULL;
    v_reviews := '[]'::jsonb;
  END;

  -- Eventos publicados futuros + giftcards activas (RPCs públicas existentes).
  SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb) INTO v_eventos
    FROM fn_eventos_publicos(p_local_slug) e;
  SELECT COALESCE(jsonb_agg(to_jsonb(g)), '[]'::jsonb) INTO v_giftcards
    FROM fn_giftcards_publicas(p_local_slug) g;

  -- Locales hermanos del grupo (con página propia).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', h.slug, 'nombre', h.nombre, 'direccion', h.direccion)), '[]'::jsonb)
    INTO v_hermanos
    FROM (
      SELECT cls2.slug, l2.nombre, cls2.direccion
        FROM comanda_local_settings cls2
        JOIN locales l2 ON l2.id = cls2.local_id
       WHERE l2.tenant_id = v_tenant
         AND cls2.slug IS NOT NULL
         AND cls2.deleted_at IS NULL
         AND cls2.local_id != v_cls.local_id
         AND cls2.reservas_activas = true
       ORDER BY l2.nombre
    ) h;

  -- "¿Hay mesa ahora?" v1 — capacidad configurada (v2: motor en vivo del POS).
  IF COALESCE(v_cls.reservas_activas, false) THEN
    BEGIN
      SELECT d.disponible INTO v_hay_mesa
        FROM fn_check_disponibilidad_reserva(p_local_slug, NOW(), 2) d;
    EXCEPTION WHEN OTHERS THEN
      v_hay_mesa := NULL;  -- fuera de horario / config incompleta → no mostrar
    END;
  END IF;

  RETURN jsonb_build_object(
    'local', jsonb_build_object(
      'nombre', v_local_nombre,
      'slug', v_cls.slug,
      'direccion', v_cls.direccion,
      'telefono', v_cls.telefono,
      'instagram', v_cls.instagram,
      'web', v_cls.web,
      'descripcion', v_cls.mesa_descripcion,
      'fotos', v_cls.mesa_fotos,
      'horarios', jsonb_build_object(
        'lun', v_cls.horario_lun, 'mar', v_cls.horario_mar, 'mie', v_cls.horario_mie,
        'jue', v_cls.horario_jue, 'vie', v_cls.horario_vie, 'sab', v_cls.horario_sab,
        'dom', v_cls.horario_dom
      )
    ),
    'reservas', jsonb_build_object(
      'activas', COALESCE(v_cls.reservas_activas, false),
      'anticipacion_min_hs', v_cls.reservas_anticipacion_min_hs,
      'anticipacion_max_dias', v_cls.reservas_anticipacion_max_dias,
      'telefono_obligatorio', COALESCE(v_cls.reservas_telefono_obligatorio, true),
      'email_obligatorio', COALESCE(v_cls.reservas_email_obligatorio, false)
    ),
    'hay_mesa_ahora', v_hay_mesa,
    'populares', v_populares,
    'reviews', jsonb_build_object('resumen', COALESCE(v_reviews_resumen, '{}'::jsonb), 'ultimas', COALESCE(v_reviews, '[]'::jsonb)),
    'eventos', v_eventos,
    'giftcards', v_giftcards,
    'hermanos', v_hermanos
  );
END;
$function$
;
