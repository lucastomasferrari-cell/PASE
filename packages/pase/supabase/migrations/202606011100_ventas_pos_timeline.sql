-- 202606011100_ventas_pos_timeline.sql
-- Brainstorm #8 Fase 1 (revisada 2026-06-01): timeline visual para pedidos.
--
-- Decisión final: EXTENDER ventas_pos en vez de crear tabla `pedidos`
-- separada. Razón: las pantallas PedidosHub.tsx (552 LOC) y PedidoDetalle.tsx
-- (477 LOC) + servicios + componentes ya operan sobre ventas_pos. Reescribir
-- todo eso para una tabla nueva = 3-5 días de refactor sin valor visible.
-- Esta migration es ~1 día y mantiene compatibilidad total.
--
-- Cambios:
--   1. Agrega 4 timestamps que faltaban en ventas_pos:
--      - listo_at         (cocina terminó)
--      - entregada_at     (cajero/rider marcó entregado)
--      - asignado_rider_at (rider acepta el pedido)
--      - en_camino_at     (rider sale del local)
--   2. Agrega rider_id (FK a delivery_riders) para tracking dispatch
--   3. Actualiza fn_marcar_listo_comanda + fn_marcar_entregado_comanda
--      para setear los nuevos timestamps
--   4. Agrega 2 RPCs nuevas para los estados de dispatch:
--      - fn_asignar_rider_comanda(venta_id, rider_id)
--      - fn_marcar_en_camino_comanda(venta_id)
--
-- Todas las migrations son ADDITIVE: no rompen el código existente.
-- enviada_at y cobrada_at YA existían desde Sprint 2.

-- ─── 1. Nuevas columnas de timeline ──────────────────────────────────────────
ALTER TABLE ventas_pos ADD COLUMN IF NOT EXISTS listo_at         TIMESTAMPTZ NULL;
ALTER TABLE ventas_pos ADD COLUMN IF NOT EXISTS entregada_at     TIMESTAMPTZ NULL;
ALTER TABLE ventas_pos ADD COLUMN IF NOT EXISTS asignado_rider_at TIMESTAMPTZ NULL;
ALTER TABLE ventas_pos ADD COLUMN IF NOT EXISTS en_camino_at     TIMESTAMPTZ NULL;
ALTER TABLE ventas_pos ADD COLUMN IF NOT EXISTS rider_id         BIGINT NULL REFERENCES delivery_riders(id);

-- Backfill timestamps para ventas históricas que YA están en estado lista/entregada/cobrada
-- (para que el timeline las muestre correctas — usamos updated_at como proxy).
UPDATE ventas_pos
   SET listo_at     = updated_at
 WHERE listo_at     IS NULL
   AND estado IN ('lista','entregada','cobrada');

UPDATE ventas_pos
   SET entregada_at = updated_at
 WHERE entregada_at IS NULL
   AND estado IN ('entregada','cobrada');

CREATE INDEX IF NOT EXISTS idx_vp_rider
  ON ventas_pos(local_id, rider_id) WHERE rider_id IS NOT NULL AND deleted_at IS NULL;

-- ─── 2. Update fn_marcar_listo_comanda para setear listo_at ──────────────────
CREATE OR REPLACE FUNCTION fn_marcar_listo_comanda(p_venta_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE ventas_pos SET
    estado = 'lista',
    listo_at = COALESCE(listo_at, NOW()),  -- idempotente: no sobrescribe si ya estaba
    updated_at = NOW()
   WHERE id = p_venta_id AND estado IN ('enviada', 'abierta');
  UPDATE ventas_pos_items SET estado = 'listo', listo_at = NOW()
   WHERE venta_id = p_venta_id AND estado = 'enviado';
END;
$$;
GRANT EXECUTE ON FUNCTION fn_marcar_listo_comanda(BIGINT) TO authenticated;

-- ─── 3. Update fn_marcar_entregado_comanda para setear entregada_at ──────────
CREATE OR REPLACE FUNCTION fn_marcar_entregado_comanda(p_venta_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE ventas_pos SET
    estado = 'entregada',
    entregada_at = COALESCE(entregada_at, NOW()),  -- idempotente
    updated_at = NOW()
   WHERE id = p_venta_id AND estado IN ('lista', 'enviada', 'en_camino');
  UPDATE ventas_pos_items SET estado = 'entregado'
   WHERE venta_id = p_venta_id AND estado IN ('listo','enviado');
END;
$$;
GRANT EXECUTE ON FUNCTION fn_marcar_entregado_comanda(BIGINT) TO authenticated;

-- ─── 4. RPC nueva: asignar rider (estado intermedio entre lista y en_camino) ─
CREATE OR REPLACE FUNCTION fn_asignar_rider_comanda(
  p_venta_id BIGINT,
  p_rider_id BIGINT
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tenant_actual UUID := auth_tenant_id();
  v_venta_tenant UUID;
  v_rider_tenant UUID;
BEGIN
  -- Cross-tenant check explícito (defensa además de RLS)
  SELECT tenant_id INTO v_venta_tenant FROM ventas_pos WHERE id = p_venta_id;
  IF v_venta_tenant IS NULL THEN
    RAISE EXCEPTION 'VENTA_NO_ENCONTRADA';
  END IF;
  IF v_venta_tenant != v_tenant_actual THEN
    RAISE EXCEPTION 'VENTA_OTRO_TENANT';
  END IF;

  SELECT tenant_id INTO v_rider_tenant FROM delivery_riders WHERE id = p_rider_id;
  IF v_rider_tenant IS NULL THEN
    RAISE EXCEPTION 'RIDER_NO_ENCONTRADO';
  END IF;
  IF v_rider_tenant != v_tenant_actual THEN
    RAISE EXCEPTION 'RIDER_OTRO_TENANT';
  END IF;

  -- Solo se puede asignar rider si la venta es delivery y está lista
  UPDATE ventas_pos SET
    rider_id = p_rider_id,
    asignado_rider_at = COALESCE(asignado_rider_at, NOW()),  -- idempotente
    updated_at = NOW()
   WHERE id = p_venta_id
     AND tipo_entrega = 'delivery'
     AND estado IN ('lista','enviada');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VENTA_NO_DELIVERY_O_ESTADO_INVALIDO';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_asignar_rider_comanda(BIGINT, BIGINT) TO authenticated;

-- ─── 5. RPC nueva: marcar "en camino" (rider con el pedido afuera) ───────────
CREATE OR REPLACE FUNCTION fn_marcar_en_camino_comanda(p_venta_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tenant_actual UUID := auth_tenant_id();
  v_venta_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_venta_tenant FROM ventas_pos WHERE id = p_venta_id;
  IF v_venta_tenant IS NULL THEN
    RAISE EXCEPTION 'VENTA_NO_ENCONTRADA';
  END IF;
  IF v_venta_tenant != v_tenant_actual THEN
    RAISE EXCEPTION 'VENTA_OTRO_TENANT';
  END IF;

  UPDATE ventas_pos SET
    en_camino_at = COALESCE(en_camino_at, NOW()),  -- idempotente
    estado = 'en_camino',
    updated_at = NOW()
   WHERE id = p_venta_id
     AND tipo_entrega = 'delivery'
     AND rider_id IS NOT NULL
     AND estado = 'lista';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VENTA_NO_LISTA_PARA_SALIR (requiere rider asignado + estado lista)';
  END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION fn_marcar_en_camino_comanda(BIGINT) TO authenticated;

-- ─── 6. Update CHECK constraint del estado para aceptar 'en_camino' ──────────
-- Estado nuevo "en_camino" entre 'lista' y 'entregada' para delivery.
-- Necesita drop + recreate del constraint porque PG no soporta ALTER CHECK.
ALTER TABLE ventas_pos DROP CONSTRAINT IF EXISTS ventas_pos_estado_check;
ALTER TABLE ventas_pos ADD CONSTRAINT ventas_pos_estado_check CHECK (estado IN (
  'abierta', 'enviada', 'lista', 'entregada',
  'cobrada', 'anulada', 'necesita_aprobacion', 'programada',
  'en_camino'  -- nuevo Plan Fase 1 Brainstorm #8
));

COMMENT ON COLUMN ventas_pos.listo_at IS 'Timestamp cuando cocina marcó listo (Plan Fase 1 2026-06-01)';
COMMENT ON COLUMN ventas_pos.entregada_at IS 'Timestamp cuando se entregó al cliente (Plan Fase 1)';
COMMENT ON COLUMN ventas_pos.asignado_rider_at IS 'Timestamp cuando se asignó rider para delivery (Plan Fase 1)';
COMMENT ON COLUMN ventas_pos.en_camino_at IS 'Timestamp cuando el rider salió del local con el pedido (Plan Fase 1)';
COMMENT ON COLUMN ventas_pos.rider_id IS 'FK a delivery_riders cuando se asigna para delivery (Plan Fase 1)';
