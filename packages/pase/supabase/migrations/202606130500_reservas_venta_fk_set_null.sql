-- 202606130500_reservas_venta_fk_set_null.sql
--
-- FIX: la FK reservas.venta_id → ventas_pos(id) (agregada en 202606130100, modelo
-- de reservas v3) quedó con regla de borrado NO ACTION (RESTRICT). Cuando se borra
-- una venta_pos referenciada por una reserva sentada/finalizada (auto-link), el
-- borrado se bloquea. Esto rompió eliminar_tenant_completo (el cleanup del tenant
-- E2E borra ventas_pos antes que reservas → FK violation → tenant huérfano →
-- SLUG_DUPLICATED al re-seedear). También sería un problema real si algún día se
-- hard-deletea una venta.
--
-- Fix: ON DELETE SET NULL — semánticamente correcto: borrar un ticket no debe
-- bloquearse por el puntero de la reserva; la reserva sobrevive perdiendo el link.

BEGIN;

ALTER TABLE reservas DROP CONSTRAINT IF EXISTS reservas_venta_id_fkey;
ALTER TABLE reservas
  ADD CONSTRAINT reservas_venta_id_fkey
  FOREIGN KEY (venta_id) REFERENCES ventas_pos(id) ON DELETE SET NULL;

COMMIT;
