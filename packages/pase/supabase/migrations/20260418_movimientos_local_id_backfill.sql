-- Backfill de local_id en movimientos viejos usando gastos como fuente
-- Hasta hoy los inserts de movimientos desde Compras/Remitos/Gastos/RRHH/ConciliacionMP
-- no enviaban local_id; se empareja contra la tabla gastos por detalle+fecha+cuenta.

UPDATE movimientos m
SET local_id = g.local_id
FROM gastos g
WHERE m.local_id IS NULL
  AND m.tipo IN (
    'Pago Sueldo',
    'Pago Proveedor',
    'Gasto fijo',
    'Gasto variable',
    'Gasto publicidad',
    'Gasto comision',
    'Gasto impuesto'
  )
  AND m.fact_id IS NULL
  AND g.detalle = m.detalle
  AND g.fecha = m.fecha
  AND g.cuenta = m.cuenta;
