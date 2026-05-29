-- ─────────────────────────────────────────────────────────────────────────
-- Auto-lock POS: default 3 → 60 minutos (queja Lucas 29-may)
-- ─────────────────────────────────────────────────────────────────────────
--
-- Los cajeros de Neko se quejaban: "la sesión POS dura muy poco, tenemos
-- que reponer el PIN cada rato". Causa: DEFAULT_AUTOLOCK_MIN=3 en el
-- frontend + `autolock_minutos INTEGER DEFAULT 3` en DB.
--
-- 3 minutos sin tocar el POS es absurdo para un restaurant — el cajero
-- atiende mesas, va a cocina, vuelve, ya pasó el timer. Cambio a 60 min
-- (1 hora) que cubre un turno de servicio completo.
--
-- Side effect: este es el 4to trigger de "feature half-implemented"
-- relacionado a comanda_local_settings.autolock_minutos. La columna
-- existía + el input en Settings existía, pero el AuthPosProvider NO la
-- leía (commit a este mismo PR la conecta).
--
-- ## Cambios
--
-- 1. ALTER COLUMN SET DEFAULT 60 — afecta inserts futuros de
--    comanda_local_settings (tenants nuevos al crear settings).
--
-- 2. UPDATE de filas existentes con valor 3 (default viejo) a 60.
--    NO toca filas con valor != 3 (significa que el dueño lo configuró
--    explícitamente y respetamos su elección).
--
-- 3. CHECK constraint: aceptar 0 (= sin auto-lock, "no se cierra nunca").
--    Antes no había constraint, pero documentamos que 0 es válido.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE comanda_local_settings
  ALTER COLUMN autolock_minutos SET DEFAULT 60;

UPDATE comanda_local_settings
SET autolock_minutos = 60
WHERE autolock_minutos = 3;

-- Validación post-cambio: ningún tenant quedó con valor mayor a 240
-- (4 horas — el input nuevo lo limita). Si alguno aparece, ALERT.
DO $$
DECLARE
  v_alto INT;
BEGIN
  SELECT count(*) INTO v_alto FROM comanda_local_settings WHERE autolock_minutos > 240;
  IF v_alto > 0 THEN
    RAISE WARNING 'WARN: % filas en comanda_local_settings con autolock_minutos > 240', v_alto;
  END IF;
END $$;

COMMENT ON COLUMN comanda_local_settings.autolock_minutos IS
  'Minutos sin actividad antes de pedir PIN otra vez en el POS. 0 = sin '
  'bloqueo automático (cajero queda logueado hasta cerrar pestaña). Default '
  '60 (cambiado de 3 el 29-may por queja de cajeros). Configurable por local '
  'desde Settings → Local → "Auto-lock POS".';
