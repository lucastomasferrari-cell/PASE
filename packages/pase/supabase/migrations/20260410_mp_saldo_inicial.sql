-- Punto de partida del saldo MP por credencial / local + columnas
-- derivadas que actualiza /api/mp-sync en cada corrida.
--
-- El sync calcula:
--   saldo_disponible = saldo_inicial + SUM(monto) de mp_movimientos
--                      con estado='approved' y fecha >= saldo_inicial_at
--   por_acreditar    = SUM(monto) de mp_movimientos con estado in
--                      ('in_process','pending') y monto > 0
alter table mp_credenciales
  add column if not exists saldo_inicial numeric not null default 0,
  add column if not exists saldo_inicial_at timestamptz,
  add column if not exists saldo_disponible numeric,
  add column if not exists por_acreditar numeric,
  add column if not exists balance_at timestamptz;
