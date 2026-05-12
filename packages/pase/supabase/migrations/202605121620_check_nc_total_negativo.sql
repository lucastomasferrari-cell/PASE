-- ═══════════════════════════════════════════════════════════════════════════
-- CHECK constraint: NCs siempre tienen total < 0.
--
-- El frontend (Compras.tsx) carga NCs con `total = -Math.abs(totalAbs)`.
-- saldoProveedor.ts y el modal de pagar usan `Math.abs(total)` para
-- normalizar. El invariante es: tipo='nota_credito' → total < 0.
--
-- Hoy no está validado en DB. Si alguna RPC futura olvida el sign-flip o
-- una migration de datos lo rompe, los cálculos de saldo divergen sin
-- error visible.
--
-- IMPORTANTE: si alguna NC histórica tiene total >= 0, este ALTER falla.
-- En ese caso hay que limpiarla manualmente antes de re-correr la migration.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE facturas
  ADD CONSTRAINT facturas_nc_total_signo
  CHECK (tipo IS DISTINCT FROM 'nota_credito' OR total < 0);
