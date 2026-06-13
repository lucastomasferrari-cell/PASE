-- 202606130600_agregar_pago_offline_wrapper.sql
-- Tier 2 (cobro offline): wrapper _offline para fn_agregar_pago_venta_comanda.
-- PaymentDialog/ComensalSplitDialog cobran incremental (un pago a la vez) y
-- hoy llaman la RPC directa (online-only). Este wrapper permite que la cola
-- offline replay-ee cada pago: resuelve la venta por UUID (puede ser tempId no
-- sincronizado) y delega en la inner, que ya es idempotente por idempotency_key.
--
-- Orden de params de la inner (verificado en 202605270800:148):
--   fn_agregar_pago_venta_comanda(
--     p_venta_id bigint, p_metodo text, p_monto numeric, p_idempotency_key text,
--     p_cobrado_por uuid, p_vuelto numeric, p_propina_incluida numeric, p_cuotas integer)
--
-- El dedup real lo hace la inner por idempotency_key (per-pago):
--   SELECT id FROM ventas_pos_pagos WHERE idempotency_key = p_idempotency_key -> return si existe.
-- Por eso el wrapper NO necesita su propio check de idempotency_uuid; p_idempotency_uuid
-- queda como trailing param solo por consistencia con los otros wrappers _offline (lo
-- pasa pushQueue) — no se usa adentro.
--
-- REVOKE FROM PUBLIC, anon (leccion 11-jun: los default privileges de Supabase dan
-- EXECUTE a anon en toda funcion nueva via PUBLIC) + GRANT a authenticated, service_role.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_agregar_pago_venta_comanda_offline(
  p_venta_id bigint,
  p_venta_idempotency_uuid uuid,
  p_metodo text,
  p_monto numeric,
  p_idempotency_key text,                       -- per-pago dedup (lo usa la inner)
  p_cobrado_por uuid DEFAULT NULL,
  p_vuelto numeric DEFAULT NULL,
  p_propina_incluida numeric DEFAULT 0,
  p_cuotas integer DEFAULT NULL,
  p_idempotency_uuid uuid DEFAULT NULL           -- op-level (consistencia con otros wrappers; no se usa)
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_venta_id bigint;
BEGIN
  v_venta_id := fn_resolver_venta_id_por_uuid(p_venta_id, p_venta_idempotency_uuid);
  RETURN fn_agregar_pago_venta_comanda(
    v_venta_id, p_metodo, p_monto, p_idempotency_key,
    p_cobrado_por, p_vuelto, p_propina_incluida, p_cuotas
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_agregar_pago_venta_comanda_offline(
  bigint, uuid, text, numeric, text, uuid, numeric, numeric, integer, uuid
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_agregar_pago_venta_comanda_offline(
  bigint, uuid, text, numeric, text, uuid, numeric, numeric, integer, uuid
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
