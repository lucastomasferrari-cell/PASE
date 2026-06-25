-- ═══════════════════════════════════════════════════════════════════════════
-- MESA: tags / segmentos en reservas y comensales — 25-jun-2026
--
-- Habilita etiquetar reservas y clientes (cumpleaños, VIP, alergia, aniversario,
-- ventana, alérgico, etc.) — feature MVP de OpenTable / Tableo (Smart Segments).
-- Arrays de texto + índice GIN para filtrar por tag.
--
-- Sin esta migración, el panel MESA NO muestra tags (la UI se activa cuando la
-- columna existe). Es aditiva y segura (IF NOT EXISTS + default '{}').
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE reservas ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS reservas_tags_idx ON reservas USING GIN (tags);
CREATE INDEX IF NOT EXISTS clientes_tags_idx ON clientes USING GIN (tags);

-- Verificación
DO $$
BEGIN
  ASSERT (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'reservas' AND column_name = 'tags') = 1,
         'reservas.tags no creada';
  ASSERT (SELECT COUNT(*) FROM information_schema.columns
          WHERE table_name = 'clientes' AND column_name = 'tags') = 1,
         'clientes.tags no creada';
END;
$$;
