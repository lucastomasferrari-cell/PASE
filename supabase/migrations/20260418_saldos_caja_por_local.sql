-- saldos_caja por local: cada local tiene sus propias cajas

ALTER TABLE saldos_caja ADD COLUMN IF NOT EXISTS local_id INTEGER;

-- Unique (cuenta, local_id) para que el ON CONFLICT funcione y no haya duplicados
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'saldos_caja'::regclass
      AND conname = 'saldos_caja_cuenta_local_id_key'
  ) THEN
    ALTER TABLE saldos_caja ADD CONSTRAINT saldos_caja_cuenta_local_id_key UNIQUE (cuenta, local_id);
  END IF;
END $$;

-- Crear registros por local para cada cuenta (saldo inicial 0)
INSERT INTO saldos_caja (cuenta, saldo, local_id)
SELECT c.cuenta, 0, l.id
FROM (VALUES ('Caja Chica'), ('Caja Mayor'), ('Caja Efectivo'), ('MercadoPago'), ('Banco')) AS c(cuenta)
CROSS JOIN locales l
ON CONFLICT (cuenta, local_id) DO NOTHING;
