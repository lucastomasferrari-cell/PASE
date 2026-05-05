-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 3 — Navegación Toast-style
--
-- Schema changes mínimos para soportar la nueva UX:
--   - item_grupos.color_ramp para tiles coloreados por categoría
--   - comanda_local_settings.features_pos_modos para que cada local elija
--     qué modos del POS habilitar (foodtruck = solo mostrador, etc.)
--   - fn_cambiar_pin_pos: permite a un empleado cambiar su propio PIN
--     verificando el actual.
--
-- Reuso fn_unaccent_immutable creada en Sprint 1.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. item_grupos.color_ramp ────────────────────────────────────────────
ALTER TABLE item_grupos ADD COLUMN IF NOT EXISTS color_ramp TEXT NULL
  CHECK (color_ramp IS NULL OR color_ramp IN (
    'amber', 'pink', 'purple', 'blue', 'gray', 'coral', 'teal', 'green'
  ));

COMMENT ON COLUMN item_grupos.color_ramp IS
  'Identificador de la rampa de color del grupo. Mapea a clases Tailwind en el frontend (amber-100/amber-900, pink-100/pink-900, etc.). NULL = usar gray como fallback.';

-- ─── 2. comanda_local_settings.features_pos_modos ─────────────────────────
ALTER TABLE comanda_local_settings ADD COLUMN IF NOT EXISTS features_pos_modos TEXT[] NOT NULL
  DEFAULT ARRAY['salon', 'mostrador', 'pedidos']::TEXT[];

COMMENT ON COLUMN comanda_local_settings.features_pos_modos IS
  'Lista de modos POS habilitados para este local. Default los 3. Frontend filtra el sidebar según este array.';

-- Validación: cada string del array debe ser un modo válido
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_features_pos_modos_valid'
  ) THEN
    ALTER TABLE comanda_local_settings ADD CONSTRAINT chk_features_pos_modos_valid
      CHECK (features_pos_modos <@ ARRAY['salon', 'mostrador', 'pedidos']::TEXT[]);
  END IF;
END $$;

-- ─── 3. Backfill: heurística por nombre del grupo ─────────────────────────
-- best-effort; el manager puede editar después desde UI.
-- Reuso fn_unaccent_immutable() creada en Sprint 1.

UPDATE item_grupos SET color_ramp = 'amber'
  WHERE color_ramp IS NULL
    AND (LOWER(fn_unaccent_immutable(nombre)) LIKE '%cerveza%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%cafe%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%desayuno%');

UPDATE item_grupos SET color_ramp = 'pink'
  WHERE color_ramp IS NULL
    AND (LOWER(fn_unaccent_immutable(nombre)) LIKE '%vino%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%postre%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%dulce%');

UPDATE item_grupos SET color_ramp = 'purple'
  WHERE color_ramp IS NULL
    AND (LOWER(fn_unaccent_immutable(nombre)) LIKE '%coctel%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%trago%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%aperitivo%');

UPDATE item_grupos SET color_ramp = 'blue'
  WHERE color_ramp IS NULL
    AND (LOWER(fn_unaccent_immutable(nombre)) LIKE '%agua%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%gaseosa%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%jugo%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%sin alcohol%');

UPDATE item_grupos SET color_ramp = 'coral'
  WHERE color_ramp IS NULL
    AND (LOWER(fn_unaccent_immutable(nombre)) LIKE '%hamburg%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%carne%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%parrilla%'
         OR LOWER(fn_unaccent_immutable(nombre)) LIKE '%principal%');

-- Resto queda gray (default sin match)
UPDATE item_grupos SET color_ramp = 'gray' WHERE color_ramp IS NULL;

-- ─── 4. fn_cambiar_pin_pos ────────────────────────────────────────────────
-- Permite al propio empleado cambiar su PIN (verifica el actual primero).
-- Distinto a fn_set_pin_pos (Sprint 2) que requiere permiso de admin
-- "comanda.empleados.editar_pos" y NO verifica PIN actual.
CREATE OR REPLACE FUNCTION fn_cambiar_pin_pos(
  p_empleado_id UUID,
  p_pin_actual TEXT,
  p_pin_nuevo TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF NOT (p_pin_nuevo ~ '^\d{4}$') THEN
    RAISE EXCEPTION 'PIN_INVALIDO: debe ser exactamente 4 dígitos';
  END IF;

  -- Verificar PIN actual (bcrypt compare)
  IF NOT EXISTS (
    SELECT 1 FROM rrhh_empleados
     WHERE id = p_empleado_id
       AND pin_pos IS NOT NULL
       AND pin_pos = crypt(p_pin_actual, pin_pos)
  ) THEN
    RAISE EXCEPTION 'PIN_ACTUAL_INCORRECTO';
  END IF;

  -- Cambiar
  UPDATE rrhh_empleados SET
    pin_pos = crypt(p_pin_nuevo, gen_salt('bf')),
    pin_actualizado_at = NOW()
  WHERE id = p_empleado_id;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_cambiar_pin_pos(UUID, TEXT, TEXT) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN COMANDA Sprint 3
-- ═══════════════════════════════════════════════════════════════════════════
