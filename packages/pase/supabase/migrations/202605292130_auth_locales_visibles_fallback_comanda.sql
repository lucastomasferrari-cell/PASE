-- ─────────────────────────────────────────────────────────────────────────
-- BUG REAL DEL PRODUCTO (mismo patrón que auth_tenant_id fix de antes):
-- auth_locales_visibles() solo busca en `usuario_locales` (tabla de PASE).
-- Cajeros solo-COMANDA (sin previo usuario PASE) tienen array vacío →
-- todas las RPCs que validan visibilidad de local tiran LOCAL_NO_VISIBLE.
--
-- En la práctica: cualquier cajero/mozo COMANDA creado vía API auth-admin
-- sin haber existido antes en PASE → no podía operar ningún local aunque
-- su comanda_usuarios.locales contuviera el ID correcto.
--
-- Fix: cuando no hay match en usuario_locales (PASE), fallback a
-- comanda_usuarios.locales (COMANDA-only). Comparte la misma estructura
-- (array de IDs de locales accesibles).
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.auth_locales_visibles()
RETURNS integer[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN auth_es_superadmin() THEN NULL::integer[]
    WHEN auth_es_dueno_o_admin() THEN
      COALESCE(
        (SELECT array_agg(l.id) FROM locales l WHERE l.tenant_id = auth_tenant_id()),
        ARRAY[]::integer[]
      )
    ELSE COALESCE(
      -- Primero buscar en usuario_locales (PASE)
      (SELECT array_agg(ul.local_id) FROM usuario_locales ul
        WHERE ul.usuario_id = auth_usuario_id()),
      -- Fallback: buscar en comanda_usuarios.locales (cajeros solo-COMANDA)
      (SELECT locales FROM comanda_usuarios
        WHERE auth_id = auth.uid() AND activo = true LIMIT 1),
      ARRAY[]::integer[]
    )
  END;
$function$;

COMMENT ON FUNCTION public.auth_locales_visibles IS
  'Locales visibles para el user logueado. Fix 29-may: agregar fallback a '
  'comanda_usuarios.locales para cajeros solo-COMANDA (creados via API '
  'sin previo usuario PASE). Antes esos cajeros recibían array vacío y '
  'no podían operar ningún local.';
