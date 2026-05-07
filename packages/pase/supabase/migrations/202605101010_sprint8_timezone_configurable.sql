-- ═══════════════════════════════════════════════════════════════════════════
-- COMANDA Sprint 8 — Tarea 3
--
-- Timezone configurable por local. Default Buenos Aires.
--
-- Hoy formatFechaAR/formatHoraAR hardcodean
-- 'America/Argentina/Buenos_Aires'. Cuando entre el primer cliente
-- fuera de Argentina, el frontend tiene que leer este campo.
--
-- NOTA: la migración de los call sites de formatFechaAR/formatHoraAR
-- legacy a formatFecha/formatHora con useTimezone() queda como deuda
-- (mucho refactor mecánico). El default Buenos Aires está bien para
-- todos los clientes actuales.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires';

COMMENT ON COLUMN comanda_local_settings.timezone IS
  'Zona horaria IANA del local. Default Buenos Aires. Configurable por local cuando entren clientes en otras zonas.';

-- Validación: lista de zonas comunes en LATAM + algunas globales.
-- Extender el CHECK a medida que se necesite.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_comanda_local_settings_timezone_valido'
  ) THEN
    ALTER TABLE comanda_local_settings ADD CONSTRAINT chk_comanda_local_settings_timezone_valido
      CHECK (timezone IN (
        'America/Argentina/Buenos_Aires',
        'America/Argentina/Cordoba',
        'America/Argentina/Mendoza',
        'America/Argentina/Salta',
        'America/Argentina/Ushuaia',
        'America/Montevideo',
        'America/Santiago',
        'America/Sao_Paulo',
        'America/Lima',
        'America/Bogota',
        'America/Mexico_City',
        'America/New_York',
        'Europe/Madrid',
        'UTC'
      ));
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- FIN sprint 8 tarea 3
-- ═══════════════════════════════════════════════════════════════════════════
