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

REVOKE EXECUTE ON FUNCTION public.fn_crear_reserva_publica(
  text, text, text, text, timestamptz, integer, text, text, text
) FROM anon;
