-- Reconciliation columns for MP outflows.
-- Every negative-amount mp_movimientos row (fee, refund, withdrawal, etc.)
-- must be linked to a justified factura or gasto.

alter table mp_movimientos
  add column if not exists conciliado boolean not null default false,
  add column if not exists vinculo_tipo text,
  add column if not exists vinculo_id text,
  add column if not exists conciliado_at timestamptz,
  add column if not exists conciliado_por text;

create index if not exists mp_movimientos_conciliado_idx
  on mp_movimientos (conciliado) where conciliado = false;
