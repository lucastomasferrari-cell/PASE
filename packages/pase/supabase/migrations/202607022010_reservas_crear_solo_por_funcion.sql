-- ============================================================
-- 202607022010_reservas_crear_solo_por_funcion.sql
-- Cierra el alta pública directa: se revoca anon de fn_crear_reserva_publica
-- para que TODA reserva pública pase por la función serverless /api/reservar
-- (que aplica el rate limit por IP de 202607022000). authenticated (staff) y
-- service_role quedan intactos.
--
-- ⚠️ APLICAR SÓLO cuando /api/reservar ya esté deployada en pase-yndx y el
-- bundle nuevo de MESA (que pega a /api/reservar en vez de la RPC directa) ya
-- esté publicado. Si se aplica antes, el widget viejo (llamada anónima directa)
-- deja de poder reservar hasta el deploy.
-- ============================================================

-- OJO: la función tiene EXECUTE para PUBLIC (=X en el ACL, default al crearla)
-- → revocar sólo de anon NO alcanza (sigue llegando vía PUBLIC). Hay que
-- revocar de PUBLIC y de anon. authenticated y service_role mantienen su grant
-- EXPLÍCITO (de 202607021900), así que el staff y el backend siguen intactos.
REVOKE EXECUTE ON FUNCTION public.fn_crear_reserva_publica(
  text, text, text, text, timestamptz, integer, text, text, text
) FROM PUBLIC, anon;
