-- ════════════════════════════════════════════════════════════════════════
-- Fix: triggers de historial sin SECURITY DEFINER rompían TODO update directo
-- (09-jun, endurecimiento pre-piloto COMANDA).
--
-- SÍNTOMA: cualquier UPDATE directo del cliente (aún dueño) sobre mesas,
-- ventas_pos, ventas_pos_items o turnos_caja fallaba con "new row violates
-- row-level security policy for table *_history". En producción esto rompe:
--   - el editor de plano de mesas (mover/editar/borrar mesa — mesasService
--     hace update directo),
--   - desasignar rider de una venta (ridersService.update ventas_pos),
--   - todo lo que toque esas tablas sin pasar por RPC.
--
-- CAUSA: la auditoría de mayo cerró el leak de las tablas *_history
-- habilitando RLS con política SOLO-SELECT (INSERT = default deny). Las
-- funciones de trigger fn_canales_audit / fn_items_audit / fn_ipc_audit ya
-- eran SECURITY DEFINER (bypassean RLS al insertar el snapshot), pero
-- fn_mesas_audit, fn_ventas_pos_audit, fn_vpi_audit y fn_turnos_caja_audit
-- quedaron como INVOKER → el INSERT del snapshot corre como el usuario y
-- choca contra el default-deny.
--
-- FIX: alinear las 4 funciones al patrón de las otras (SECURITY DEFINER).
-- Las tablas history siguen cerradas a escritura directa del cliente;
-- solo el trigger (sistema) puede insertar.
-- ════════════════════════════════════════════════════════════════════════

ALTER FUNCTION public.fn_mesas_audit() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION public.fn_ventas_pos_audit() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION public.fn_vpi_audit() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION public.fn_turnos_caja_audit() SECURITY DEFINER SET search_path = public;
