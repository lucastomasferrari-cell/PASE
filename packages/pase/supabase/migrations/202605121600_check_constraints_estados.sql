-- ═══════════════════════════════════════════════════════════════════════════
-- CHECK constraints en columnas `estado` de tablas financieras.
--
-- Bug que motivó esta migration: las NCs nuevas se insertaban con
-- estado='pagada' en Compras.tsx por hardcode, lo cual la lógica del modal
-- pagar interpretaba como "consumida" y las filtraba. Pasó silencioso 2
-- semanas hasta que Lucas reportó "no veo las NCs". Si la columna hubiera
-- tenido CHECK constraint, el INSERT con valor incoherente habría fallado
-- al cargar, no semanas después en una operación lateral.
--
-- Esta migration agrega CHECK constraints a las 4 tablas financieras más
-- visibles. Los valores aceptados están alineados con los usos reales
-- documentados en types/finanzas.ts y los RPCs.
--
-- NO se valida si EXISTE alguna fila que viole los CHECK antes de crear
-- el constraint (Postgres lo hace automáticamente como NOT VALID seguido
-- de VALIDATE — ALTER TABLE ADD CHECK con NOT VALID es lo defensive). Si
-- la verificación falla en producción al aplicar, hay datos inválidos
-- pre-existentes que hay que limpiar antes.
-- ═══════════════════════════════════════════════════════════════════════════

-- facturas.estado: pendiente | vencida | pagada | anulada
-- Nota: en práctica 'vencida' rara vez se persiste (suele computarse runtime
-- comparando venc vs hoy), pero está en types/finanzas.ts así que la aceptamos.
ALTER TABLE facturas
  ADD CONSTRAINT facturas_estado_check
  CHECK (estado IN ('pendiente', 'vencida', 'pagada', 'anulada'));

-- ventas.estado: activa | anulada (las ventas son atómicas, no tienen
-- estados intermedios). Validar con NOT VALID primero por si hay legacy.
-- Si la columna no existe o tiene otro nombre, esto fallará y hay que
-- ajustar. Asumido por el filtro en EERR/Dashboard ("VENTA_ANULADA" en
-- errors.ts).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name='ventas' AND column_name='estado') THEN
    ALTER TABLE ventas
      ADD CONSTRAINT ventas_estado_check
      CHECK (estado IN ('activa', 'anulada'));
  END IF;
END $$;

-- remitos.estado: sin_factura | pagado | facturado | anulado
-- Visto en Compras.tsx + types/finanzas.ts.
ALTER TABLE remitos
  ADD CONSTRAINT remitos_estado_check
  CHECK (estado IN ('sin_factura', 'pagado', 'facturado', 'anulado'));

-- gastos.tipo: fijo | variable | publicidad | comision | impuesto | retiro_socio
-- Esto es la columna 'tipo' del gasto (qué tipo de gasto operativo), separado
-- del 'tipo' de comprobante en facturas. Visto en Gastos.tsx TIPOS array.
ALTER TABLE gastos
  ADD CONSTRAINT gastos_tipo_check
  CHECK (tipo IN ('fijo', 'variable', 'publicidad', 'comision', 'impuesto', 'retiro_socio'));
