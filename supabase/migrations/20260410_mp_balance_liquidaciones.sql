-- Per-credential balance snapshot (updated every sync).
alter table mp_credenciales
  add column if not exists saldo_disponible numeric,
  add column if not exists saldo_pendiente numeric,
  add column if not exists saldo_no_disponible numeric,
  add column if not exists saldo_total numeric,
  add column if not exists balance_at timestamptz;

-- Upcoming / recent money releases (liquidaciones).
create table if not exists mp_liquidaciones (
  id text primary key,
  local_id integer not null,
  amount numeric,
  currency text default 'ARS',
  release_date timestamptz,
  date_created timestamptz,
  concept text,
  estado text,
  descripcion text,
  synced_at timestamptz default now()
);

create index if not exists mp_liquidaciones_local_release_idx
  on mp_liquidaciones (local_id, release_date);
