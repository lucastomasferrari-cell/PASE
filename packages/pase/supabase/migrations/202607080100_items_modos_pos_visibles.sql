-- 202607080100 · Visibilidad de items por modo POS
--
-- Neko Devoto (Lucas 2026-07-08) tiene 2 menús distintos: uno para salón
-- y otro para delivery/mostrador. Necesitamos que al abrir una venta por
-- canal X, solo se vean los items visibles en el modo de ese canal.
--
-- Añadimos items.modos_pos_visibles como TEXT[]:
--   NULL o vacío → visible en TODOS los modos (backwards-compatible).
--   Con valores → solo en los modos listados. Valores válidos: 'salon',
--   'mostrador', 'pedidos'.
--
-- El frontend filtra el catálogo según venta.modo (VentaScreen) o
-- canal.modo_pos (NuevoPedidoDialog). No hay filtro server-side por ahora.

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS modos_pos_visibles text[] NULL;

COMMENT ON COLUMN items.modos_pos_visibles IS
  'Modos POS en los que el item aparece en el catálogo. NULL = todos. Valores: salon / mostrador / pedidos.';

-- Backfill: los 53 items existentes de Neko son el menú de delivery/mostrador.
-- Los restringimos a esos modos (sacándolos del salón).
UPDATE items
   SET modos_pos_visibles = ARRAY['mostrador', 'pedidos']
 WHERE tenant_id = '5841143c-5594-4728-99c6-a313d40618e6'
   AND marca_id = 1
   AND deleted_at IS NULL
   AND modos_pos_visibles IS NULL;
