-- ═══════════════════════════════════════════════════════════════════════════
-- Mermas one-tap + Categoría P&L
--
-- Visión PASE original (doc Lucas):
--   "Función One-Tap: Una lista de los 10 insumos que más se tiran. El
--    cocinero toca el ítem, pone la cantidad y selecciona el motivo:
--      - Desperdicio técnico (piel, espinas)
--      - Error de cocina (plato quemado)
--      - Vencimiento
--      - Consumo de personal"
--
-- Hoy: el campo `motivo` en insumo_movimientos es texto libre. El usuario
-- escribe lo que quiere. Eso impide agregar por motivo (¿cuánto se pierde
-- por vencimiento? ¿cuánto por consumo personal?).
--
-- Fix: catálogo `mermas_motivos` con los 4 oficiales del doc + más. Cada
-- motivo tiene un tipo de movimiento asociado (merma / robo / donacion).
-- El dialog one-tap muestra solo los activos del tenant.
--
-- También agregamos categoría P&L en insumos (Alimentos / Bebidas / etc.)
-- para que los reportes puedan agrupar por categoría como pidió el doc:
-- "Una tabla dinámica con filtros por categoría de P&L".
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Catálogo de motivos de merma ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS mermas_motivos (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  nombre          TEXT NOT NULL,
  descripcion     TEXT,
  -- Qué tipo de movimiento de insumo_movimientos generan
  tipo_movimiento TEXT NOT NULL DEFAULT 'merma'
                  CHECK (tipo_movimiento IN ('merma', 'robo', 'donacion', 'salida_ajuste')),
  -- Display
  orden           INTEGER DEFAULT 0,
  activo          BOOLEAN DEFAULT TRUE,
  emoji           TEXT,
  -- Audit
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  UNIQUE (tenant_id, nombre)
);

CREATE INDEX IF NOT EXISTS idx_mermas_motivos_tenant_activos
  ON mermas_motivos(tenant_id, orden)
  WHERE activo = TRUE AND deleted_at IS NULL;

ALTER TABLE mermas_motivos ENABLE ROW LEVEL SECURITY;
CREATE POLICY mermas_motivos_read ON mermas_motivos FOR SELECT TO authenticated
  USING (tenant_id = auth_tenant_id());
CREATE POLICY mermas_motivos_write ON mermas_motivos FOR ALL TO authenticated
  USING (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin())
  WITH CHECK (tenant_id = auth_tenant_id() AND auth_es_dueno_o_admin());

-- Updated_at
CREATE OR REPLACE FUNCTION trg_mermas_motivos_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END;
$$;
DROP TRIGGER IF EXISTS mermas_motivos_updated_at ON mermas_motivos;
CREATE TRIGGER mermas_motivos_updated_at BEFORE UPDATE ON mermas_motivos
  FOR EACH ROW EXECUTE FUNCTION trg_mermas_motivos_updated_at();

-- Seed: los 4 motivos oficiales del doc + algunos extra. Se crean para
-- CADA tenant existente. Tenants nuevos los reciben en el setup (fuera
-- de esta migration; agregar al onboarding script si hace falta).
INSERT INTO mermas_motivos (tenant_id, nombre, descripcion, tipo_movimiento, orden, emoji)
SELECT t.id, m.nombre, m.descripcion, m.tipo, m.orden, m.emoji
FROM tenants t
CROSS JOIN (VALUES
  ('Desperdicio técnico', 'Piel, espinas, recortes propios del producto', 'merma',         10, '🐟'),
  ('Error de cocina',     'Plato quemado, mal armado, devuelto',           'merma',         20, '🔥'),
  ('Vencimiento',         'Insumo que pasó la fecha de caducidad',         'merma',         30, '📅'),
  ('Consumo de personal', 'Comida del staff (cubre LCT art. 105)',         'donacion',      40, '👨‍🍳'),
  ('Cortesía cliente',    'Regalo al cliente (cumple, queja, etc.)',       'donacion',      50, '🎁'),
  ('Ajuste por conteo',   'Diferencia detectada en inventario',            'salida_ajuste', 60, '📋'),
  ('Sospecha de robo',    'No se encuentra. Carga manager con TOTP.',      'robo',          90, '⚠️')
) AS m(nombre, descripcion, tipo, orden, emoji)
ON CONFLICT (tenant_id, nombre) DO NOTHING;

-- ─── 2. Categoría P&L en insumos ─────────────────────────────────────────
-- Permite agrupar insumos por familia para los reportes ("¿cuánto se gasta
-- en bebidas vs alimentos vs limpieza?"). Default NULL para los existentes;
-- el dueño los va categorizando a medida que abre cada insumo.
ALTER TABLE insumos
  ADD COLUMN IF NOT EXISTS categoria_pl TEXT
  CHECK (categoria_pl IS NULL OR categoria_pl IN (
    'alimentos',
    'bebidas',
    'limpieza',
    'descartables',
    'condimentos',
    'otros'
  ));

CREATE INDEX IF NOT EXISTS idx_insumos_categoria_pl
  ON insumos(tenant_id, categoria_pl)
  WHERE categoria_pl IS NOT NULL AND deleted_at IS NULL;

COMMENT ON COLUMN insumos.categoria_pl IS
  'Categoría contable para reportes P&L. NULL = sin categorizar.';

-- ─── 3. View: top 10 insumos más mermados (últimos 30 días) ──────────────
-- Para la sección "Lista de los 10 insumos que más se tiran" del doc.
-- Excluye consumo de personal porque es legítimo, no es merma real.
CREATE OR REPLACE VIEW v_mermas_top10
WITH (security_invoker = on) AS
SELECT
  im.tenant_id,
  im.local_id,
  im.insumo_id,
  i.nombre AS insumo_nombre,
  i.unidad,
  i.categoria_pl,
  COUNT(*) AS veces_mermado,
  SUM(ABS(im.cantidad)) AS cantidad_total,
  SUM(ABS(im.cantidad) * COALESCE(im.costo_unitario, i.costo_actual, 0)) AS valor_total,
  -- Para mostrar al lado en la UI: cuánto se mermó cada uno los últimos 30d
  MAX(im.created_at) AS ultima_merma
FROM insumo_movimientos im
INNER JOIN insumos i ON i.id = im.insumo_id
WHERE im.tipo IN ('merma', 'salida_ajuste')  -- robo y donacion excluidos (no son merma de stock real)
  AND im.cantidad < 0
  AND im.deleted_at IS NULL
  AND i.deleted_at IS NULL
  AND im.created_at > NOW() - INTERVAL '30 days'
GROUP BY im.tenant_id, im.local_id, im.insumo_id, i.nombre, i.unidad, i.categoria_pl
ORDER BY valor_total DESC;

GRANT SELECT ON v_mermas_top10 TO authenticated;

-- ─── 4. RPC: cargar merma con motivo del catálogo ─────────────────────────
-- Reemplaza a fn_ajustar_stock_insumo cuando el motivo viene del catálogo.
-- Si el motivo requiere manager (tipo='robo'), el caller debe pasar manager_id
-- ya validado por Manager Override TOTP. El RPC valida que el motivo exista
-- y use el tipo correcto.

CREATE OR REPLACE FUNCTION fn_registrar_merma(
  p_insumo_id BIGINT,
  p_local_id INTEGER,
  p_cantidad NUMERIC,
  p_motivo_id BIGINT,
  p_notas TEXT DEFAULT NULL,
  p_manager_id INTEGER DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID;
  v_motivo RECORD;
  v_insumo RECORD;
  v_mov_id BIGINT;
  v_user_id INTEGER;
BEGIN
  v_tenant_id := auth_tenant_id();
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'NO_AUTH'; END IF;

  -- Lookup del id INTEGER del usuario logueado (patrón canónico del proyecto)
  SELECT id INTO v_user_id FROM usuarios WHERE auth_id = auth.uid() AND activo LIMIT 1;

  -- Validar permisos sobre el local
  IF NOT (auth_es_dueno_o_admin() OR p_local_id = ANY(auth_locales_visibles())) THEN
    RAISE EXCEPTION 'PERMISO_DENEGADO';
  END IF;

  -- Validar cantidad
  IF p_cantidad IS NULL OR p_cantidad <= 0 THEN
    RAISE EXCEPTION 'CANTIDAD_INVALIDA';
  END IF;

  -- Cargar motivo y validar
  SELECT * INTO v_motivo FROM mermas_motivos
    WHERE id = p_motivo_id
      AND tenant_id = v_tenant_id
      AND activo = TRUE
      AND deleted_at IS NULL;
  IF v_motivo IS NULL THEN RAISE EXCEPTION 'MOTIVO_NO_ENCONTRADO'; END IF;

  -- Robo requiere manager
  IF v_motivo.tipo_movimiento = 'robo' AND p_manager_id IS NULL THEN
    RAISE EXCEPTION 'ROBO_REQUIERE_MANAGER';
  END IF;

  -- Cargar insumo (para costo y unidad)
  SELECT * INTO v_insumo FROM insumos
    WHERE id = p_insumo_id
      AND tenant_id = v_tenant_id
      AND deleted_at IS NULL;
  IF v_insumo IS NULL THEN RAISE EXCEPTION 'INSUMO_NO_ENCONTRADO'; END IF;

  -- Insertar movimiento (cantidad NEGATIVA por convención de salida)
  INSERT INTO insumo_movimientos (
    tenant_id, local_id, insumo_id, tipo, cantidad, costo_unitario,
    motivo, fuente_tipo, fuente_id, usuario_id, manager_id
  ) VALUES (
    v_tenant_id, p_local_id, p_insumo_id, v_motivo.tipo_movimiento,
    -p_cantidad, COALESCE(v_insumo.costo_actual, 0),
    v_motivo.nombre || COALESCE(' — ' || p_notas, ''),
    'merma_motivo', p_motivo_id,
    v_user_id, p_manager_id
  ) RETURNING id INTO v_mov_id;

  RETURN v_mov_id;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_registrar_merma(BIGINT, INTEGER, NUMERIC, BIGINT, TEXT, INTEGER) TO authenticated;

NOTIFY pgrst, 'reload schema';
