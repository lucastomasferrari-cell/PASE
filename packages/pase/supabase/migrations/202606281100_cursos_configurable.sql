-- ═══════════════════════════════════════════════════════════════════════════
-- Cursos del POS configurables por local
-- 28-jun-2026
--
-- Algunos restaurantes (sushi, fast casual, hamburgueserías, café) no usan
-- cursos: todo va a la cocina al mismo tiempo. Para esos locales, el sistema
-- de cursos solo complica la UI con tabs "Curso 1/2/3" + acciones "Stay"
-- y "Enviar solo".
--
-- Esta migración agrega un toggle por local. Cuando usar_cursos=false, el
-- frontend oculta la franja de cursos y manda TODO en una sola tanda al
-- cobrar. Cuando es true (default para back-compat), se mantiene el flow
-- actual.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE comanda_local_settings
  ADD COLUMN IF NOT EXISTS usar_cursos BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN comanda_local_settings.usar_cursos IS
  'Si TRUE, el POS muestra tabs Curso 1/2/3/N+ y permite asignar items a cursos. Si FALSE, todo va a una sola tanda (oculta UI de cursos). Default TRUE para back-compat — apagar solo si el restaurante no usa cursos (sushi, fast casual, etc.).';

COMMIT;

DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'comanda_local_settings' AND column_name = 'usar_cursos') = 1,
         'usar_cursos no creada';
  RAISE NOTICE '✓ usar_cursos listo';
END $$;
