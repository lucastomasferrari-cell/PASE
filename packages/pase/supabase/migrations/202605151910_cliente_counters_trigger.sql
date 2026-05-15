-- ═══════════════════════════════════════════════════════════════════════════
-- F1.2c — Trigger para actualizar contadores del cliente al cobrar venta
-- ═══════════════════════════════════════════════════════════════════════════
-- Hace funcionar el programa de fidelidad: cuando una venta pasa a 'cobrada'
-- y tiene cliente_id vinculado, suma 1 a total_pedidos y total al total_gastado
-- del cliente. También trackea primer_pedido_at + ultimo_pedido_at.

CREATE OR REPLACE FUNCTION fn_trg_actualizar_cliente_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo cuando transiciona a 'cobrada' DESDE otro estado.
  IF NEW.estado = 'cobrada' AND OLD.estado <> 'cobrada' AND NEW.cliente_id IS NOT NULL THEN
    UPDATE clientes c SET
      total_pedidos = COALESCE(c.total_pedidos, 0) + 1,
      total_gastado = COALESCE(c.total_gastado, 0) + COALESCE(NEW.total, 0),
      primer_pedido_at = COALESCE(c.primer_pedido_at, NOW()),
      ultimo_pedido_at = NOW(),
      updated_at = NOW()
    WHERE c.id = NEW.cliente_id;
  END IF;

  -- Si una venta cobrada se ANULA, descontar.
  IF NEW.estado = 'anulada' AND OLD.estado = 'cobrada' AND NEW.cliente_id IS NOT NULL THEN
    UPDATE clientes c SET
      total_pedidos = GREATEST(0, COALESCE(c.total_pedidos, 0) - 1),
      total_gastado = GREATEST(0, COALESCE(c.total_gastado, 0) - COALESCE(NEW.total, 0)),
      updated_at = NOW()
    WHERE c.id = NEW.cliente_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_actualizar_cliente_counters ON ventas_pos;
CREATE TRIGGER trg_actualizar_cliente_counters
  AFTER UPDATE OF estado ON ventas_pos
  FOR EACH ROW
  EXECUTE FUNCTION fn_trg_actualizar_cliente_counters();

COMMENT ON FUNCTION fn_trg_actualizar_cliente_counters IS
  'F1.2c: actualiza total_pedidos / total_gastado / ultimo_pedido_at del cliente cuando una venta vinculada se cobra o anula.';

-- Backfill: para ventas ya cobradas con cliente_id, actualizar contadores
-- desde cero. Si nunca corrió este trigger antes, los counters estaban en 0.
WITH agg AS (
  SELECT
    cliente_id,
    COUNT(*) FILTER (WHERE estado = 'cobrada') AS pedidos,
    COALESCE(SUM(total) FILTER (WHERE estado = 'cobrada'), 0) AS gastado,
    MIN(cobrada_at) FILTER (WHERE estado = 'cobrada') AS primer_at,
    MAX(cobrada_at) FILTER (WHERE estado = 'cobrada') AS ultimo_at
  FROM ventas_pos
  WHERE cliente_id IS NOT NULL AND deleted_at IS NULL
  GROUP BY cliente_id
)
UPDATE clientes c SET
  total_pedidos = a.pedidos,
  total_gastado = a.gastado,
  primer_pedido_at = COALESCE(c.primer_pedido_at, a.primer_at),
  ultimo_pedido_at = a.ultimo_at,
  updated_at = NOW()
FROM agg a
WHERE c.id = a.cliente_id;
