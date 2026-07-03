-- ============================================================
-- 202607022200_reservas_accion_solo_por_funcion.sql
-- Cierra las acciones públicas POR TELÉFONO (cancelar / reseñar): se revoca
-- anon de fn_cancelar_reserva_publica y fn_crear_review_reserva para que TODA
-- acción pública por teléfono pase por la función serverless /api/reserva-accion
-- (que aplica el rate limit por IP). service_role queda intacto (es quien
-- ejecuta desde el endpoint).
--
-- Las acciones POR TOKEN (fn_cancelar_reserva_token / fn_crear_review_token) NO
-- se tocan: usan un UUID secreto del link y siguen siendo anon (ya seguras).
--
-- ⚠️ APLICAR SÓLO cuando /api/reserva-accion ya esté deployada en pase-yndx y el
-- bundle nuevo de MESA (que pega a /api/reserva-accion en vez de la RPC directa)
-- ya esté publicado. Si se aplica antes, el widget viejo (llamada anónima
-- directa) deja de poder cancelar/reseñar hasta el deploy.
-- ============================================================

-- OJO (lección de 202607022010): las funciones tienen EXECUTE para PUBLIC (=X en
-- el ACL, default al crearlas) → revocar sólo de anon NO alcanza (sigue llegando
-- vía PUBLIC). Hay que revocar de PUBLIC y de anon. Primero nos aseguramos de
-- que service_role tenga un grant EXPLÍCITO (por si sólo lo tenía vía PUBLIC),
-- así el backend serverless sigue intacto tras el revoke.

-- ─── fn_cancelar_reserva_publica(bigint, text, text) ────────────────────────
GRANT EXECUTE ON FUNCTION public.fn_cancelar_reserva_publica(
  bigint, text, text
) TO service_role;
REVOKE EXECUTE ON FUNCTION public.fn_cancelar_reserva_publica(
  bigint, text, text
) FROM PUBLIC, anon;

-- ─── fn_crear_review_reserva(bigint, text, smallint, text, text, smallint, smallint) ───
GRANT EXECUTE ON FUNCTION public.fn_crear_review_reserva(
  bigint, text, smallint, text, text, smallint, smallint
) TO service_role;
REVOKE EXECUTE ON FUNCTION public.fn_crear_review_reserva(
  bigint, text, smallint, text, text, smallint, smallint
) FROM PUBLIC, anon;
