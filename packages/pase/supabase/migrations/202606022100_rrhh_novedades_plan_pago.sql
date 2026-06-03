-- 202606022100_rrhh_novedades_plan_pago.sql
-- Pedido Anto/Lucas 02-jun: en la card del sueldo, ANTES de pagar,
-- Anto carga cuánto va en efectivo y cuánto en MP. Cuando aprieta
-- "Confirmar" se bloquea el plan. Después "Pagar" ejecuta los
-- movimientos en caja usando ese plan como pre-llenado.
--
-- 2 columnas nuevas en `rrhh_novedades`:
--   - `monto_efectivo NUMERIC` (default NULL): monto que va a salir
--     del cajón de efectivo del local.
--   - `monto_mp NUMERIC` (default NULL): monto que va a salir de
--     Mercado Pago / transferencia.
--
-- NULL en ambas = no se cargó plan todavía (retro-compatible para
-- novedades viejas y para casos donde Anto no carga plan y va
-- directo al modal Pagar como antes).
--
-- Cuando ambas tienen valor: `monto_efectivo + monto_mp` debe ser
-- igual al total a pagar de la liquidación. La validación se hace
-- client-side (Confirmar disabled si no coincide) y NO en DB porque
-- el total depende de novedades + adelantos tildados que varían
-- entre el momento de cargar y el de pagar.
--
-- Sin RPC. El UPDATE se hace directo desde el cliente con auth
-- de Supabase (RLS de rrhh_novedades ya existe — solo el tenant
-- del empleado puede editar la novedad).

ALTER TABLE rrhh_novedades
  ADD COLUMN IF NOT EXISTS monto_efectivo NUMERIC(14, 2) NULL,
  ADD COLUMN IF NOT EXISTS monto_mp       NUMERIC(14, 2) NULL;

COMMENT ON COLUMN rrhh_novedades.monto_efectivo IS
  'Plan de pago: monto a pagar en efectivo. NULL = no se cargó plan.';
COMMENT ON COLUMN rrhh_novedades.monto_mp IS
  'Plan de pago: monto a pagar via MP / transferencia. NULL = no se cargó plan.';

NOTIFY pgrst, 'reload schema';
