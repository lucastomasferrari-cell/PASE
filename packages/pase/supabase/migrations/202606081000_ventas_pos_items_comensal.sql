-- 202606081000_ventas_pos_items_comensal.sql
--
-- Order-by-seat (estándar Toast/SevenRooms): permitir asignar cada ítem de una
-- venta a un "comensal" (seat) específico, para después dividir la cuenta por
-- persona desde el inicio.
--
-- Diseño aditivo y retro-compatible:
--   - `comensal` es NULL por default = ítem compartido / sin asignar.
--     Las ventas que NO usan order-by-seat quedan con todos los ítems en NULL
--     → se comportan igual que hoy (una sola cuenta). Cero impacto.
--   - 1, 2, 3, ... = número de comensal en esa mesa.
--   - `ventas_pos.comensales` (opcional) = cantidad de comensales de la mesa,
--     para que el POS sepa cuántos "asientos" ofrecer.
--
-- No toca RLS (heredan de la tabla) ni rompe RPCs existentes.

ALTER TABLE ventas_pos_items
  ADD COLUMN IF NOT EXISTS comensal INTEGER NULL
    CHECK (comensal IS NULL OR (comensal >= 1 AND comensal <= 50));

COMMENT ON COLUMN ventas_pos_items.comensal IS
  'Order-by-seat: nro de comensal/asiento al que se asigna el ítem. NULL = compartido / sin asignar (default, comportamiento legacy).';

ALTER TABLE ventas_pos
  ADD COLUMN IF NOT EXISTS comensales INTEGER NULL
    CHECK (comensales IS NULL OR (comensales >= 1 AND comensales <= 50));

COMMENT ON COLUMN ventas_pos.comensales IS
  'Order-by-seat: cantidad de comensales en la mesa (cuántos asientos ofrece el POS). NULL = no se usa order-by-seat en esta venta.';

NOTIFY pgrst, 'reload schema';
